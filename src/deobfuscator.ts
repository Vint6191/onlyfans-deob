/* src/deobfuscator.ts */
import * as parser from "@babel/parser";
import traverse, { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import beautify from "js-beautify";
import { readFileSync, writeFile } from "fs";
import vm from "vm";

/* -------------------------------  Бинарные операторы  ------------------------------- */
const binop = [
  "+", "-", "/", "%", "*", "**", "&", "|", ">>", ">>>", "<<", "^",
  "==", "===", "!=", "!==", "in", "instanceof",
  ">", "<", ">=", "<=", "|>",
] as const;
type BinaryOperator = typeof binop[number];
const isBinaryOperator = (x: any): x is BinaryOperator => binop.includes(x);

/* -------------------------------  Утилита логов  ------------------------------- */
function log(...args: any[]) {
  console.error("[deobf]", ...args);
}

/* -------------------------------  VM‑контекст  ------------------------------- */
function makeContext(): vm.Context {
  return vm.createContext({
    parseInt, parseFloat, isNaN, isFinite,
    Math, String, Number, Boolean, Array, Object,
    RegExp, Error, TypeError, RangeError,
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    JSON, console,
  });
}

/* -------------------------------  Collector  ------------------------------- */
class SetupCollector {
  private snippets: string[] = [];
  private errCount = 0;
  readonly ctx: vm.Context;

  constructor(ctx: vm.Context) {
    this.ctx = ctx;
  }

  /** Add a piece of code – will be executed later */
  add(code: string) {
    this.snippets.push(code);
  }

  /** Execute everything that has been collected and clear the buffer */
  flush() {
    if (!this.snippets.length) return;
    const combined = this.snippets.join(";\n");
    this.snippets = [];
    try {
      vm.runInContext(combined, this.ctx);
      log("flush OK, snippets combined length:", combined.length);
    } catch (e: any) {
      log("flush error:", e?.message);
      log("code start:", combined.slice(0, 300));
    }
  }

  /** Execute a single piece of code and return its result (or undefined) */
  run(code: string): any {
    try {
      return vm.runInContext(code, this.ctx);
    } catch (e: any) {
      if (this.errCount < 5) {
        log("vm.run error:", e?.message, "| code:", code.slice(0, 200));
        this.errCount++;
      }
      return undefined;
    }
  }
}

/* -------------------------------------------------------------------------
 *  1️⃣ Find the function that returns the obfuscated string array
 * ------------------------------------------------------------------------- */
function findStringsArray(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
): string | undefined {
  if (!path.node) return;
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 0) return;
  if (body.length !== 2) return;

  // Look for `var <id> = [ "…", … ];`
  const varDecl = body.find(
    (stmt): stmt is t.VariableDeclaration => t.isVariableDeclaration(stmt)
  );
  if (!varDecl) return;
  const decl = varDecl.declarations[0];
  if (!decl || !t.isArrayExpression(decl.init)) return;
  if (!decl.init.elements.every((el) => t.isStringLiteral(el))) return;
  if (!node.id) return;

  const arraySize = (decl.init as t.ArrayExpression).elements.length;

  // -----------------------------------------------------------------
  // The obfuscator often re‑uses the identifier `i` for a thin wrapper.
  // If we keep that name the wrapper will overwrite the array‑function
  // in the VM, breaking all later calls.  We therefore rename it to a
  // guaranteed‑unique identifier.
  // -----------------------------------------------------------------
  const oldName = node.id.name;
  const newName = "__obfStrArray";
  path.scope.rename(oldName, newName);

  log(
    "findStringsArray ->",
    newName,
    "array‑var:",
    (decl.id as t.Identifier).name,
    "elements:",
    arraySize,
  );

  collector.add(generate(node).code);   // add the renamed function to the VM
  path.remove();                      // remove it from the final AST
  return newName;
}

/* -------------------------------------------------------------------------
 *  2️⃣ Find the base decryption function (`k` / `f`)
 * ------------------------------------------------------------------------- */
function findBaseDecryptFunction(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
  funcObfStrings: string,
): string | undefined {
  if (!path.node) return;
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 2) return;
  if (!node.id) return;

  // The base function calls the string‑array function at least once.
  const usesObfStrings = body.some((stmt) => {
    return t.isVariableDeclaration(stmt) && stmt.declarations.some((d) => {
      return (
        t.isCallExpression(d.init) &&
        t.isIdentifier((d.init as t.CallExpression).callee, { name: funcObfStrings })
      );
    });
  });
  if (!usesObfStrings) return;

  log("findBaseDecryptFunction -> accepted:", node.id.name, "stmts:", body.length);
  collector.add(generate(node).code);
  path.remove();
  return node.id.name;
}

/* -------------------------------------------------------------------------
 *  3️⃣ Find a thin‑wrapper function declared as a FunctionDeclaration
 * ------------------------------------------------------------------------- */
function findDecryptFunction(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
  baseDecryptFunc: string,
): Binding | undefined {
  if (!path.node) return;
  const node = path.node;
  if (node.params.length !== 2) return;
  if (node.body.body.length !== 1) return;
  const ret = node.body.body[0];
  if (!t.isReturnStatement(ret) || !ret.argument) return;
  if (!t.isCallExpression(ret.argument)) return;
  const call = ret.argument as t.CallExpression;
  if (!t.isIdentifier(call.callee, { name: baseDecryptFunc })) return;
  if (!node.id) return;

  log("findDecryptFunction -> accepted:", node.id.name);
  collector.add(generate(node).code);
  const binding = path.scope.getBinding(node.id.name);
  if (!binding) {
    log("no binding for", node.id.name);
    return;
  }
  path.remove();
  log("  refs:", binding.referencePaths.length);
  return binding;
}

/* -------------------------------------------------------------------------
 *  3b️⃣ Find a thin‑wrapper declared through a variable (var r = function…)
 * ------------------------------------------------------------------------- */
function findDecryptFunctionFromDeclarator(
  path: NodePath<t.VariableDeclarator>,
  collector: SetupCollector,
  baseDecryptFunc: string,
): Binding | undefined {
  if (!path.node) return;
  const node = path.node;
  if (!t.isIdentifier(node.id) || !node.init) return;

  const init = node.init;
  if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
  if (init.params.length !== 2) return;

  // Normalise the body to a single ReturnStatement
  let stmt: t.Statement | undefined;
  if (t.isBlockStatement(init.body)) {
    if (init.body.body.length !== 1) return;
    stmt = init.body.body[0];
  } else {
    stmt = t.returnStatement(init.body as t.Expression);
  }
  if (!t.isReturnStatement(stmt) || !stmt.argument) return;
  if (!t.isCallExpression(stmt.argument)) return;
  const call = stmt.argument as t.CallExpression;
  if (!t.isIdentifier(call.callee, { name: baseDecryptFunc })) return;

  const funcName = node.id.name;
  log("findDecryptFunctionFromDeclarator -> accepted:", funcName);

  // Store the wrapper in the VM (e.g. `r = function(a,b){…}`)
  collector.add(`${funcName} = ${generate(init).code}`);

  const binding = path.scope.getBinding(funcName);
  if (!binding) {
    log("no binding for", funcName);
    return;
  }

  // Remove the declarator from the AST – we already added it to the VM.
  path.remove();
  log("  refs:", binding.referencePaths.length);
  return binding;
}

/* -------------------------------------------------------------------------
 *  4️⃣ Shuffle the string array (shuffle)
 * ------------------------------------------------------------------------- */
function shuffleObfuscatedStrings(
  path: NodePath<t.CallExpression>,
  collector: SetupCollector,
  funcObfStrings: string,
): boolean | undefined {
  if (!path.node) return;
  const node = path.node;
  if (node.arguments.length !== 2) return;
  if (!t.isIdentifier(node.arguments[0], { name: funcObfStrings })) return;
  if (!t.isNumericLiteral(node.arguments[1])) return;

  const seed = (node.arguments[1] as t.NumericLiteral).value;
  log("shuffleObfuscatedStrings -> seed:", seed);

  collector.add(generate(t.expressionStatement(node)).code);
  collector.flush();

  // Remove the call from the AST – it has already been executed.
  if (t.isUnaryExpression(path.parentPath.node)) {
    path.parentPath.remove();
  } else {
    path.remove();
  }
  return true;
}

/* -------------------------------------------------------------------------
 *  5️⃣ Decrypt calls to the thin‑wrapper functions (e.g. i(…))
 * ------------------------------------------------------------------------- */
function decryptMapKeys(binding: Binding, collector: SetupCollector) {
  log(
    "decryptMapKeys ->",
    binding.identifier.name,
    "refs:",
    binding.referencePaths.length,
  );
  let replaced = 0;
  let skipped = 0;

  for (const ref of binding.referencePaths) {
    const callPath = ref.parentPath as NodePath<t.CallExpression>;
    if (!callPath || !callPath.node) { skipped++; continue; }
    // Skip the `return i(...);` that belongs to the wrapper itself.
    if (t.isReturnStatement(callPath.parentPath?.node)) { skipped++; continue; }
    if (!t.isCallExpression(callPath.node)) { skipped++; continue; }

    // -------------------------------------------------------------
    // Try to evaluate every argument statically.  When we can,
    // we pass the literal JSON value to the VM; otherwise we fall
    // back to executing the raw code (the VM already has all needed
    // helpers in its context).
    // -------------------------------------------------------------
    const argCodes: string[] = [];
    let allConfident = true;
    callPath.get("arguments").forEach((arg) => {
      const ev = arg.evaluate();
      if (ev.confident) {
        argCodes.push(JSON.stringify(ev.value));
      } else {
        allConfident = false;
        argCodes.push(generate(arg.node).code);
      }
    });

    const src = allConfident
      ? `${binding.identifier.name}(${argCodes.join(",")})`
      : generate(callPath.node).code;

    const value = collector.run(src);
    // Accept strings, numbers, booleans, null (not undefined/objects/functions)
    if (
      value !== undefined &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null)
    ) {
      callPath.replaceWith(t.valueToNode(value));
      replaced++;
    } else {
      skipped++;
    }
  }
  log("decryptMapKeys -> replaced:", replaced, "skipped:", skipped);
}

/* -------------------------------------------------------------------------
 *  6️⃣ Map of operator helpers
 * ------------------------------------------------------------------------- */
enum MapFuncType { CallOneArg, CallThreeArg }

class MapReplacer {
  decryptionMap: { [key: string]: BinaryOperator | MapFuncType | string } = {};
  mapName: string | undefined;
  scope: Scope | undefined;

  /** Analyse `var o = { … }` and keep only the entries that encode something */
  parseMap(path: NodePath<t.VariableDeclarator>): boolean {
    if (!path.node) return false;
    const node = path.node;
    if (!t.isObjectExpression(node.init) || !t.isIdentifier(node.id)) return false;

    let flag = false;
    node.init.properties = node.init.properties.filter((el) => {
      if (!t.isObjectProperty(el) || !t.isIdentifier(el.key)) return true;
      const key = el.key.name;

      // value is a function → it encodes an operator or a small helper
      if (t.isFunctionExpression(el.value)) {
        const body = el.value.body.body;
        if (body.length !== 1 || !t.isReturnStatement(body[0])) return true;
        const ret = (body[0] as t.ReturnStatement).argument;

        if (t.isBinaryExpression(ret)) {
          this.decryptionMap[key] = ret.operator;
          flag = true;
        } else if (t.isCallExpression(ret)) {
          if (ret.arguments.length === 3) {
            this.decryptionMap[key] = MapFuncType.CallThreeArg;
            flag = true;
          } else if (ret.arguments.length === 1) {
            this.decryptionMap[key] = MapFuncType.CallOneArg;
            flag = true;
          }
        }
        // keep only the operators / helpers, discard the rest
        return false;
      }

      // plain string literal → simple substitution
      if (t.isStringLiteral(el.value)) {
        this.decryptionMap[key] = el.value.value;
        flag = true;
        return false;
      }

      return true; // keep anything we don't understand
    });

    if (flag) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      log("parseMap ->", node.id.name);
    }
    return flag;
  }

  /** Replace calls like `o["Add"](a,b)` **or** `o.Add(a,b)` with `a + b` */
  replaceBinaryOpCalls() {
    let n = 0;
    this.scope?.traverse(this.scope.path.node, {
      CallExpression: (path: NodePath<t.CallExpression>) => {
        const node = path.node;
        if (!t.isMemberExpression(node.callee)) return;
        const { object, property, computed } = node.callee;

        // object must be the operator‑map identifier (e.g. `o`)
        if (!t.isIdentifier(object, { name: this.mapName })) return;

        // property may be a string literal (computed) or an identifier (dot)
        let key: string | undefined;
        if (t.isStringLiteral(property)) {
          key = property.value;
        } else if (t.isIdentifier(property) && !computed) {
          key = property.name;
        }
        if (!key) return;

        if (node.arguments.length !== 2) return;
        const op = this.decryptionMap[key];
        if (!isBinaryOperator(op)) return;

        path.replaceWith(
          t.binaryExpression(
            op,
            node.arguments[0] as t.Expression,
            node.arguments[1] as t.Expression,
          ),
        );
        n++;
      },
    });
    log("replaceBinaryOpCalls ->", n);
  }

  /** Replace plain map look‑ups (`o["X"]` or `o.X`) with the literal value,
   *  and replace calls like `o["X"](a,b)` with the appropriate call‑through. */
  replaceMapIndexing() {
    if (!this.mapName) return;
    this.scope?.crawl();
    const binding = this.scope?.getBinding(this.mapName);
    if (!binding) return;
    const refs = binding.referencePaths;
    let n = 0;

    for (const ref of refs) {
      const mem = ref.parentPath;                 // MemberExpression ?
      const memParent = mem?.parentPath;          // maybe CallExpression
      if (!mem || !memParent || !t.isMemberExpression(mem.node)) continue;

      const { object, computed, property } = mem.node;
      if (object !== ref.node) continue;

      // Resolve the key (computed string literal or plain identifier)
      let key: string | undefined;
      if (computed && t.isStringLiteral(property)) {
        key = property.value;                     // o["foo"]
      } else if (!computed && t.isIdentifier(property)) {
        key = property.name;                      // o.foo
      }
      if (!key) continue;

      const val = this.decryptionMap[key];

      // 1️⃣ simple value substitution (string literal)
      if (typeof val === "string" && !isBinaryOperator(val)) {
        mem.replaceWith(t.valueToNode(val));
        n++;
        continue;
      }

      // 2️⃣ call‑through: map["X"](a,b,…) → a(b,…)
      if (typeof val !== "string" && t.isCallExpression(memParent.node) &&
          memParent.node.arguments.length !== 0) {
        memParent.node.callee = memParent.node.arguments[0] as t.Expression;
        memParent.node.arguments = memParent.node.arguments.slice(1);
        n++;
      }
    }
    log("replaceMapIndexing ->", n);
  }
}

/* -------------------------------------------------------------------------
 *  7️⃣ unwrapOrElse → a?.b?.c || d
 * ------------------------------------------------------------------------- */
function simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
  if (!path.node) return;
  const node = path.node;
  if (!t.isCallExpression(node.callee) || node.arguments.length !== 3) return;
  const [obj, prop, fallback] = node.arguments as t.Expression[];
  let res: t.Expression | undefined;

  if (!t.isStringLiteral(prop) || !prop.value.includes(".")) {
    // one‑level optional chaining
    res = t.memberExpression(obj, prop, true);
  } else {
    // multi‑level: split by dot and chain `?.`
    for (const p of prop.value.split(".")) {
      res = res
        ? t.memberExpression(res, t.stringLiteral(p), true)
        : t.memberExpression(obj, t.stringLiteral(p), true);
    }
  }
  if (!res) return;
  path.replaceWith(t.logicalExpression("||", res, fallback));
  path.skip();
}

/* -------------------------------------------------------------------------
 *  8️⃣ Main driver
 * ------------------------------------------------------------------------- */
function deobfuscate(source: string) {
  log("source length:", source.length);
  const ast = parser.parse(source);
  log("AST parsed OK");

  const ctx = makeContext();
  const collector = new SetupCollector(ctx);

  let funcObfStrings: string | undefined;
  let baseDecryptFunc: string | undefined;
  let firstBinding: Binding | undefined;
  let secondBinding: Binding | undefined;
  let foundShuffle = false;

  /* ------------------- 1️⃣ Find the string‑array function ------------------- */
  log("BEGIN findObfuscatedStrings");
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = findStringsArray(path, collector);
      if (name) {
        funcObfStrings = name;
        path.stop();
      }
    },
  });
  log(
    "END findObfuscatedStrings ->",
    funcObfStrings ?? "NOT FOUND",
  );
  if (!funcObfStrings) {
    console.error("String array not found!");
    return;
  }

  /* ------------------- 2️⃣ Find decryption functions + shuffle ------------------- */
  log("BEGIN parseDecryptFunctions");
  traverse(ast, {
    // One visitor handles both the base function and the thin wrappers.
    FunctionDeclaration(path) {
      if (!path.node) return;

      // ----- base decryption function -----
      if (!baseDecryptFunc) {
        const name = findBaseDecryptFunction(
          path,
          collector,
          funcObfStrings!,
        );
        if (name) {
          baseDecryptFunc = name;
          log("baseDecryptFunc:", name);
          return; // path удалён, выходим
        }
      }

      // ----- thin wrappers (FunctionDeclaration) -----
      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunction(path, collector, baseDecryptFunc);
        if (b) {
          firstBinding = b;
          log("firstBinding:", b.identifier.name);
          return;
        }
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunction(path, collector, firstBinding.identifier.name);
        if (b) {
          secondBinding = b;
          log("secondBinding:", b.identifier.name);
          return;
        }
      }
    },

    // ----- thin wrappers declared via variable (var r = function…) -----
    VariableDeclarator(path) {
      if (!path.node) return;

      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunctionFromDeclarator(path, collector, baseDecryptFunc);
        if (b) {
          firstBinding = b;
          log("firstBinding (var):", b.identifier.name);
          return;
        }
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunctionFromDeclarator(path, collector, firstBinding.identifier.name);
        if (b) {
          secondBinding = b;
          log("secondBinding (var):", b.identifier.name);
          return;
        }
      }
    },

    // ----- shuffle – a single call like f(519367) -----
    CallExpression(path) {
      if (!path.node) return;
      if (!funcObfStrings || foundShuffle) return;
      if (shuffleObfuscatedStrings(path, collector, funcObfStrings)) {
        foundShuffle = true;
      }
    },
  });
  log("END parseDecryptFunctions");
  log("  baseDecryptFunc:", baseDecryptFunc ?? "NOT FOUND");
  log(
    "  firstBinding:",
    firstBinding?.identifier.name ?? "NOT FOUND",
  );
  log(
    "  secondBinding:",
    secondBinding?.identifier.name ?? "NOT FOUND",
  );
  log("  foundShuffle:", foundShuffle);

  if (!baseDecryptFunc || !firstBinding || !foundShuffle) {
    console.error("Essential decryption pieces missing – aborting");
    return;
  }

  // Execute everything that was collected (functions + shuffle + consts)
  collector.flush();

  /* ------------------- 3️⃣ Decrypt literal strings ------------------- */
  log("BEGIN decryptMapKeys");
  decryptMapKeys(firstBinding, collector);
  if (secondBinding) decryptMapKeys(secondBinding, collector);
  else log("secondBinding not found — skipping");
  log("END decryptMapKeys");

  /* ------------------- 4️⃣ Process the operator map ------------------- */
  log("BEGIN processMap");
  const mr = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path) {
      if (!path.node) return;
      if (!mr.parseMap(path)) return;
      mr.replaceBinaryOpCalls();
      mr.replaceMapIndexing();
      path.stop();
      path.remove();
    },
  });
  log("END processMap");

  /* ------------------- 5️⃣ Simplify unwrapOrElse ------------------- */
  log("BEGIN simplifyUnwrapOrElse");
  traverse(ast, {
    CallExpression(path) { simplifyUnwrapOrElse(path); },
  });
  log("END simplifyUnwrapOrElse");

  /* ------------------- 6️⃣ Convert ['id'] → .id when safe ------------------- */
  log("BEGIN bracketToDot");
  const validId = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$_A-Za-z][$_0-9A-Za-z]*$/;
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node) return;
      const { object, property, computed } = path.node;
      if (!computed || !t.isStringLiteral(property) || !validId.test(property.value)) return;
      path.replaceWith(
        t.memberExpression(object, t.identifier(property.value), false),
      );
    },
  });
  log("END bracketToDot");

  /* ------------------- 7️⃣ Generate beautified output ------------------- */
  log("BEGIN generate");
  let code = generate(ast, { comments: false }).code;
  log("END generate, BEGIN beautify");
  code = beautify(code, { indent_size: 2, space_in_empty_paren: true });
  log("END beautify");

  const outputPath = process.argv[3];
  writeFile(outputPath, code, (err) => {
    if (err) {
      console.error("Error writing file", err);
      return;
    }
    log("Wrote file to", outputPath);
  });
}

/* -------------------------------------------------------------------------
 *  Run
 * ------------------------------------------------------------------------- */
log("argv:", process.argv.slice(2).join(" "));
deobfuscate(readFileSync(process.argv[2], "utf8"));
