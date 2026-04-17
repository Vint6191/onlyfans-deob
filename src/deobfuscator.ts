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

/* -------------------------------  SetupCollector  ------------------------------- */
class SetupCollector {
  private snippets: string[] = [];
  readonly ctx: vm.Context;

  constructor(ctx: vm.Context) {
    this.ctx = ctx;
  }

  add(code: string)   { this.snippets.push(code); }

  /** Выполняет всё, что накопилось, и очищает буфер */
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

  /** Выполняет единичный кусок кода и возвращает результат (или undefined) */
  run(code: string): any {
    try { return vm.runInContext(code, this.ctx); }
    catch (_) { return undefined; }
  }
}

/* -------------------------------------------------------------------------
 *  1️⃣ Поиск функции‑массива строк
 * ------------------------------------------------------------------------- */
function findStringsArray(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
): string | undefined {
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 0) return;
  if (body.length !== 2) return;

  // Находим объявление переменной, где хранится массив строк
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
  // 1️⃣  The de‑obfuscator assumes that the string‑array function
  //      has a unique name.  In many packs it is called `i`, but the
  //      same name is later reused for a thin wrapper (`i(a,b){…}`).
  //      If we keep the original name the second definition overwrites
  //      the first one in the VM, breaking every later call to `i()`.
  // -----------------------------------------------------------------
  const oldName = node.id.name;
  const newName = "__obfStrArray";                 // any name that does not clash
  // Rename the identifier *and* every reference to it (shuffle call,
  // base‑decrypt function, etc.).
  path.scope.rename(oldName, newName);

  log(
    "findStringsArray ->",
    newName,
    "array‑var:",
    (decl.id as t.Identifier).name,
    "elements:",
    arraySize,
  );

  // Add the (already renamed) function to the VM.
  collector.add(generate(node).code);
  // Remove the declaration from the final AST – we already executed it.
  path.remove();
  // Return the *new* identifier so the rest of the script works with it.
  return newName;
}

/* -------------------------------------------------------------------------
 *  2️⃣ Поиск базовой функции дешифрования (k)
 * ------------------------------------------------------------------------- */
function findBaseDecryptFunction(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
  funcObfStrings: string,
): string | undefined {
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 2) return;
  if (!node.id) return;

  // Проверяем, что внутри функции явно вызывается funcObfStrings()
  const usesObfStrings = body.some((stmt) => {
    return t.isVariableDeclaration(stmt) && stmt.declarations.some((d) => {
      return (
        t.isCallExpression(d.init) &&
        t.isIdentifier((d.init as t.CallExpression).callee, {
          name: funcObfStrings,
        })
      );
    });
  });
  if (!usesObfStrings) return;

  log(
    "findBaseDecryptFunction -> accepted:",
    node.id.name,
    "body stmts:",
    body.length,
  );
  collector.add(generate(node).code);
  path.remove();
  return node.id.name;
}

/* -------------------------------------------------------------------------
 *  3️⃣ Поиск thin‑wrapper‑функций как FunctionDeclaration
 * ------------------------------------------------------------------------- */
function findDecryptFunction(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
  baseDecryptFunc: string,
): Binding | undefined {
  const node = path.node;
  if (node.params.length !== 2) return;
  if (node.body.body.length !== 1) return;
  const ret = node.body.body[0];
  if (!t.isReturnStatement(ret) || !ret.argument) return;
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
 *  3b️⃣ thin‑wrapper, объявленная через переменную (var r = function…)
 * ------------------------------------------------------------------------- */
function findDecryptFunctionFromDeclarator(
  path: NodePath<t.VariableDeclarator>,
  collector: SetupCollector,
  baseDecryptFunc: string,
): Binding | undefined {
  const node = path.node;
  if (!t.isIdentifier(node.id) || !node.init) return;

  const init = node.init;
  if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init))
    return;
  if (init.params.length !== 2) return;

  // Приводим тело к единственному оператору return
  let stmt: t.Statement | undefined;
  if (t.isBlockStatement(init.body)) {
    if (init.body.body.length !== 1) return;
    stmt = init.body.body[0];
  } else {
    stmt = t.returnStatement(init.body as t.Expression);
  }
  if (!t.isReturnStatement(stmt) || !stmt.argument) return;
  const call = stmt.argument as t.CallExpression;
  if (!t.isIdentifier(call.callee, { name: baseDecryptFunc })) return;

  const funcName = node.id.name;
  log("findDecryptFunctionFromDeclarator -> accepted:", funcName);

  // Добавляем в collector строку вида `r = function(a,b){…}`
  collector.add(`${funcName} = ${generate(init).code}`);

  const binding = path.scope.getBinding(funcName);
  if (!binding) {
    log("no binding for", funcName);
    return;
  }

  // Убираем объявление из AST – уже выполнено в vm
  path.remove();
  log("  refs:", binding.referencePaths.length);
  return binding;
}

/* -------------------------------------------------------------------------
 *  4️⃣ Шаффлер массива строк (shuffle)
 * ------------------------------------------------------------------------- */
function shuffleObfuscatedStrings(
  path: NodePath<t.CallExpression>,
  collector: SetupCollector,
  funcObfStrings: string,
): boolean | undefined {
  const node = path.node;
  if (node.arguments.length !== 2) return;
  if (!t.isIdentifier(node.arguments[0], { name: funcObfStrings })) return;
  if (!t.isNumericLiteral(node.arguments[1])) return;

  const seed = (node.arguments[1] as t.NumericLiteral).value;
  log("shuffleObfuscatedStrings -> seed:", seed);

  // Добавляем вызов shuffle и сразу исполняем
  collector.add(generate(t.expressionStatement(node)).code);
  collector.flush();

  // Убираем уже выполненный вызов из AST
  if (t.isUnaryExpression(path.parentPath.node)) {
    path.parentPath.remove();
  } else {
    path.remove();
  }
  return true;
}

/* -------------------------------------------------------------------------
 *  5️⃣ Дешифруем вызовы thin‑wrapper‑функций → реальные строки
 * ------------------------------------------------------------------------- */
function decryptMapKeys(binding: Binding, collector: SetupCollector) {
  log(
    "decryptMapKeys ->",
    binding.identifier.name,
    "refs:",
    binding.referencePaths.length,
  );
  let replaced = 0;
  for (const ref of binding.referencePaths) {
    const callPath = ref.parentPath as NodePath<t.CallExpression>;
    if (!callPath) continue;
    // не трогаем возврат из самой обёртки
    if (t.isReturnStatement(callPath.parentPath?.node)) continue;

    // -----------------------------------------------------------------
    // Попытка статически вычислить аргументы
    // -----------------------------------------------------------------
    const argCodes: string[] = [];
    let allConfident = true;
    callPath.get('arguments').forEach(arg => {
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
    if (value !== undefined) {
      callPath.replaceWith(t.valueToNode(value));
      replaced++;
    }
  }
  log("decryptMapKeys -> replaced:", replaced);
}

/* -------------------------------------------------------------------------
 *  6️⃣ Объект‑карта операторов
 * ------------------------------------------------------------------------- */
enum MapFuncType { CallOneArg, CallThreeArg }

class MapReplacer {
  decryptionMap: { [key: string]: BinaryOperator | MapFuncType | string } = {};
  mapName: string | undefined;
  scope: Scope | undefined;

  parseMap(path: NodePath<t.VariableDeclarator>): boolean | undefined {
    const node = path.node;
    if (!t.isObjectExpression(node.init) || !t.isIdentifier(node.id)) return false;
    let flag = false;
    node.init.properties = node.init.properties.filter((el) => {
      if (!t.isObjectProperty(el) || !t.isIdentifier(el.key)) return true;
      const key = el.key.name;
      if (t.isFunctionExpression(el.value)) {
        const fb = el.value.body.body;
        if (fb.length !== 1 || !t.isReturnStatement(fb[0])) return true;
        const ret = fb[0].argument;
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
          } else return true;
        } else return true;
      } else if (t.isStringLiteral(el.value)) {
        this.decryptionMap[key] = el.value.value;
        flag = true;
      } else return true;
      return false;
    });
    if (flag) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      log("parseMap ->", node.id.name);
    }
    return flag;
  }

  replaceBinaryOpCalls() {
    let n = 0;
    this.scope?.traverse(this.scope.path.node, {
      CallExpression: (path: NodePath<t.CallExpression>) => {
        const node = path.node;
        if (!t.isMemberExpression(node.callee)) return;
        const { object, property } = node.callee;
        if (!t.isIdentifier(object, { name: this.mapName }) ||
            !t.isStringLiteral(property)) return;
        if (node.arguments.length !== 2) return;
        const op = this.decryptionMap[property.value];
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

  replaceMapIndexing() {
    if (!this.mapName) return;
    this.scope?.crawl();
    const refs = this.scope?.getBinding(this.mapName)?.referencePaths;
    if (!refs) return;
    let n = 0;
    for (const ref of refs) {
      const mi = ref.parentPath;
      const mip = mi?.parentPath;
      if (!mi || !mip || !t.isMemberExpression(mi.node)) continue;
      const { object, computed, property } = mi.node;
      if (object !== ref.node || !computed || !t.isStringLiteral(property))
        continue;
      const val = this.decryptionMap[property.value];
      if (typeof val === "string" && !isBinaryOperator(val)) {
        mi.replaceWith(t.valueToNode(val));
        n++;
      } else if (
        typeof val !== "string" &&
        t.isCallExpression(mip.node) &&
        mip.node.arguments.length !== 0
      ) {
        // map["X"](a,b,c) → a(b,c)
        mip.node.callee = mip.node.arguments[0] as t.Expression;
        mip.node.arguments = mip.node.arguments.slice(1);
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
  const node = path.node;
  if (!t.isCallExpression(node.callee) || node.arguments.length !== 3) return;
  const [obj, prop, els] = node.arguments as t.Expression[];
  let res: t.Expression | undefined;
  if (!t.isStringLiteral(prop) || !prop.value.includes(".")) {
    res = t.memberExpression(obj, prop, true);
  } else {
    for (const p of prop.value.split(".")) {
      res = res
        ? t.memberExpression(res, t.stringLiteral(p), true)
        : t.memberExpression(obj, t.stringLiteral(p), true);
    }
  }
  if (!res) return;
  path.replaceWith(t.logicalExpression("||", res, els));
  path.skip();
}

/* -------------------------------------------------------------------------
 *  Основная функция
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

  /* ------------------- 1️⃣ массив строк ------------------- */
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
    console.error("Strings not found!");
    return;
  }

  /* ------------------- 2️⃣ функции + shuffle ------------------- */
  log("BEGIN parseDecryptFunctions");
  traverse(ast, {
    // -------------------------------------------------------------
    // This single visitor handles:
    //   ① the base decryption function (k)
    //   ② thin‑wrapper functions (i, n, …)
    // -------------------------------------------------------------
    FunctionDeclaration(path) {
      // ---- ① look for the base decryption function (k) ----
      if (!baseDecryptFunc) {
        const name = findBaseDecryptFunction(
          path,
          collector,
          funcObfStrings!,
        );
        if (name) {
          baseDecryptFunc = name;
          log("baseDecryptFunc:", name);
          // No need to hunt for wrappers on this node yet – they will be
          // processed on later passes once the base name is known.
          return;
        }
      }

      // ---- ② look for thin‑wrapper functions (i, n, …) ----
      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunction(path, collector, baseDecryptFunc);
        if (b) {
          firstBinding = b;
          log("firstBinding:", b.identifier.name);
          return;
        }
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunction(
          path,
          collector,
          firstBinding.identifier.name,
        );
        if (b) {
          secondBinding = b;
          log("secondBinding:", b.identifier.name);
        }
      }
    },

    // thin‑wrapper‑функции, объявленные через var/let/const
    VariableDeclarator(path) {
      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunctionFromDeclarator(
          path,
          collector,
          baseDecryptFunc,
        );
        if (b) {
          firstBinding = b;
          log("firstBinding (var):", b.identifier.name);
        }
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunctionFromDeclarator(
          path,
          collector,
          firstBinding.identifier.name,
        );
        if (b) {
          secondBinding = b;
          log("secondBinding (var):", b.identifier.name);
        }
      }
    },

    // shuffle – единовременный вызов f(120563)
    CallExpression(path) {
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
    console.error("Some decryption stuff was not found!");
    return;
  }

  // ★★★★★  Важно: выполнить thin‑wrapper‑функции (r, o, …) ★★★★★
  collector.flush();

  /* ------------------- 3️⃣ раскрываем строки ------------------- */
  log("BEGIN decryptMapKeys");
  decryptMapKeys(firstBinding, collector);
  if (secondBinding) decryptMapKeys(secondBinding, collector);
  else log("secondBinding not found — skipping");
  log("END decryptMapKeys");

  /* ------------------- 4️⃣ карта операторов ------------------- */
  log("BEGIN processMap");
  const mr = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path) {
      if (!mr.parseMap(path)) return;
      mr.replaceBinaryOpCalls();
      mr.replaceMapIndexing();
      path.stop();
      path.remove();
    },
  });
  log("END processMap");

  /* ------------------- 5️⃣ unwrapOrElse ------------------- */
  log("BEGIN simplifyUnwrapOrElse");
  traverse(ast, {
    CallExpression(path) { simplifyUnwrapOrElse(path); },
  });
  log("END simplifyUnwrapOrElse");

  /* ------------------- 6️⃣ [«строка»] → .identifier ------------------- */
  log("BEGIN bracketToDot");
  const validId = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$_A-Za-z][$_0-9A-Za-z]*$/;
  traverse(ast, {
    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (!computed || !t.isStringLiteral(property) || !validId.test(property.value))
        return;
      path.replaceWith(
        t.memberExpression(object, t.identifier(property.value), false),
      );
    },
  });
  log("END bracketToDot");

  /* ------------------- 7️⃣ генерация кода ------------------- */
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
 *  Запуск
 * ------------------------------------------------------------------------- */
log("argv:", process.argv.slice(2).join(" "));
deobfuscate(readFileSync(process.argv[2], "utf8"));
