/* src/deobfuscator.ts */
import * as parser from "@babel/parser";
import traverse, { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import beautify from "js-beautify";
import { readFileSync, writeFile } from "fs";
import vm from "vm";

const binop = [
  "+", "-", "/", "%", "*", "**", "&", "|", ">>", ">>>", "<<", "^",
  "==", "===", "!=", "!==", "in", "instanceof",
  ">", "<", ">=", "<=", "|>",
] as const;
type BinaryOperator = typeof binop[number];
const isBinaryOperator = (x: any): x is BinaryOperator => binop.includes(x);

function log(...args: any[]) {
  console.error("[deobf]", ...args);
}

function makeContext(): vm.Context {
  return vm.createContext({
    parseInt, parseFloat, isNaN, isFinite,
    Math, String, Number, Boolean, Array, Object,
    RegExp, Error, TypeError, RangeError,
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    JSON, console,
  });
}

class SetupCollector {
  private snippets: string[] = [];
  private errCount = 0;
  readonly ctx: vm.Context;
  constructor(ctx: vm.Context) { this.ctx = ctx; }
  add(code: string) { this.snippets.push(code); }
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
  run(code: string): any {
    try { return vm.runInContext(code, this.ctx); }
    catch (e: any) {
      if (this.errCount < 5) {
        log("vm.run error:", e?.message, "| code:", code.slice(0, 200));
        this.errCount++;
      }
      return undefined;
    }
  }
}

function findStringsArray(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
): string | undefined {
  if (!path.node) return;
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 0) return;
  if (body.length !== 2) return;
  const varDecl = body.find(
    (stmt): stmt is t.VariableDeclaration => t.isVariableDeclaration(stmt)
  );
  if (!varDecl) return;
  const decl = varDecl.declarations[0];
  if (!decl || !t.isArrayExpression(decl.init)) return;
  if (!decl.init.elements.every((el) => t.isStringLiteral(el))) return;
  if (!node.id) return;
  const arraySize = (decl.init as t.ArrayExpression).elements.length;
  const oldName = node.id.name;
  const newName = "__obfStrArray";
  path.scope.rename(oldName, newName);
  log("findStringsArray ->", newName, "array-var:", (decl.id as t.Identifier).name, "elements:", arraySize);
  collector.add(generate(node).code);
  path.remove();
  return newName;
}

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

function tryWrapperDecl(
  path: NodePath<t.FunctionDeclaration>,
  knownWrappers: Set<string>,
): string | undefined {
  if (!path.node) return;
  const node = path.node;
  if (node.params.length !== 2) return;
  if (node.body.body.length !== 1) return;
  const ret = node.body.body[0];
  if (!t.isReturnStatement(ret) || !ret.argument) return;
  if (!t.isCallExpression(ret.argument)) return;
  const call = ret.argument as t.CallExpression;
  if (!t.isIdentifier(call.callee)) return;
  if (!knownWrappers.has(call.callee.name)) return;
  if (!node.id) return;
  return node.id.name;
}

function tryWrapperVar(
  path: NodePath<t.VariableDeclarator>,
  knownWrappers: Set<string>,
): string | undefined {
  if (!path.node) return;
  const node = path.node;
  if (!t.isIdentifier(node.id) || !node.init) return;
  const init = node.init;
  if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
  if (init.params.length !== 2) return;
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
  if (!t.isIdentifier(call.callee)) return;
  if (!knownWrappers.has(call.callee.name)) return;
  return node.id.name;
}

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
  if (t.isUnaryExpression(path.parentPath.node)) {
    path.parentPath.remove();
  } else {
    path.remove();
  }
  return true;
}

function replaceAllWrapperCalls(ast: t.Node, wrapperNames: Set<string>, collector: SetupCollector) {
  let replaced = 0;
  let skipped = 0;
  let visited = 0;

  traverse(ast, {
    CallExpression(path) {
      if (!path.node) return;
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      if (!wrapperNames.has(callee.name)) return;
      visited++;

      if (t.isReturnStatement(path.parentPath?.node)) {
        const fn = path.getFunctionParent();
        if (fn && t.isFunctionDeclaration(fn.node) && fn.node.id && wrapperNames.has(fn.node.id.name)) {
          skipped++;
          return;
        }
      }

      const argCodes: string[] = [];
      let allConfident = true;
      path.get("arguments").forEach((arg) => {
        const ev = arg.evaluate();
        if (ev.confident) {
          argCodes.push(JSON.stringify(ev.value));
        } else {
          allConfident = false;
          argCodes.push(generate(arg.node).code);
        }
      });

      const src = allConfident
        ? `${callee.name}(${argCodes.join(",")})`
        : generate(path.node).code;

      const value = collector.run(src);
      if (
        value !== undefined &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null)
      ) {
        path.replaceWith(t.valueToNode(value));
        replaced++;
      } else {
        skipped++;
      }
    },
  });
  log(`replaceAllWrapperCalls -> visited: ${visited} replaced: ${replaced} skipped: ${skipped}`);
}

enum MapFuncType { CallOneArg, CallThreeArg }

class MapReplacer {
  decryptionMap: { [key: string]: BinaryOperator | MapFuncType | string } = {};
  mapName: string | undefined;
  scope: Scope | undefined;

  parseMap(path: NodePath<t.VariableDeclarator>): boolean {
    if (!path.node) return false;
    const node = path.node;
    if (!t.isObjectExpression(node.init) || !t.isIdentifier(node.id)) return false;
    let flag = false;
    node.init.properties = node.init.properties.filter((el) => {
      if (!t.isObjectProperty(el) || !t.isIdentifier(el.key)) return true;
      const key = el.key.name;
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
        return false;
      }
      if (t.isStringLiteral(el.value)) {
        this.decryptionMap[key] = el.value.value;
        flag = true;
        return false;
      }
      return true;
    });
    if (flag) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      log("parseMap ->", node.id.name);
    }
    return flag;
  }

  replaceBinaryOpCallsGlobal(ast: t.Node): number {
    let n = 0;
    traverse(ast, {
      CallExpression: (path: NodePath<t.CallExpression>) => {
        const node = path.node;
        if (!t.isMemberExpression(node.callee)) return;
        const { object, property, computed } = node.callee;
        if (!t.isIdentifier(object, { name: this.mapName })) return;
        let key: string | undefined;
        if (t.isStringLiteral(property)) key = property.value;
        else if (t.isIdentifier(property) && !computed) key = property.name;
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
    log("replaceBinaryOpCallsGlobal ->", n);
    return n;
  }

  replaceMapIndexing(): number {
    if (!this.mapName) return 0;
    this.scope?.crawl();
    const binding = this.scope?.getBinding(this.mapName);
    if (!binding) return 0;
    const refs = binding.referencePaths;
    let n = 0;
    for (const ref of refs) {
      const mem = ref.parentPath;
      const memParent = mem?.parentPath;
      if (!mem || !memParent || !t.isMemberExpression(mem.node)) continue;
      const { object, computed, property } = mem.node;
      if (object !== ref.node) continue;
      let key: string | undefined;
      if (computed && t.isStringLiteral(property)) key = property.value;
      else if (!computed && t.isIdentifier(property)) key = property.name;
      if (!key) continue;
      const val = this.decryptionMap[key];
      if (typeof val === "string" && !isBinaryOperator(val)) {
        mem.replaceWith(t.valueToNode(val));
        n++;
        continue;
      }
      if (typeof val !== "string" && t.isCallExpression(memParent.node) &&
          memParent.node.arguments.length !== 0) {
        memParent.node.callee = memParent.node.arguments[0] as t.Expression;
        memParent.node.arguments = memParent.node.arguments.slice(1);
        n++;
      }
    }
    log("replaceMapIndexing ->", n);
    return n;
  }
}

function simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
  if (!path.node) return;
  const node = path.node;
  if (!t.isCallExpression(node.callee) || node.arguments.length !== 3) return;
  const [obj, prop, fallback] = node.arguments as t.Expression[];
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
  path.replaceWith(t.logicalExpression("||", res, fallback));
  path.skip();
}

function deobfuscate(source: string) {
  log("source length:", source.length);
  const ast = parser.parse(source);
  log("AST parsed OK");

  const ctx = makeContext();
  const collector = new SetupCollector(ctx);

  let funcObfStrings: string | undefined;
  let baseDecryptFunc: string | undefined;
  let foundShuffle = false;
  const wrapperNames = new Set<string>();

  // 1. Find string array
  log("BEGIN findObfuscatedStrings");
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = findStringsArray(path, collector);
      if (name) { funcObfStrings = name; path.stop(); }
    },
  });
  log("END findObfuscatedStrings ->", funcObfStrings ?? "NOT FOUND");
  if (!funcObfStrings) { console.error("String array not found!"); return; }

  // 2. Find base decrypt function + shuffle
  log("BEGIN find base + shuffle");
  traverse(ast, {
    FunctionDeclaration(path) {
      if (!baseDecryptFunc) {
        const name = findBaseDecryptFunction(path, collector, funcObfStrings!);
        if (name) { baseDecryptFunc = name; log("baseDecryptFunc:", name); }
      }
    },
    CallExpression(path) {
      if (!funcObfStrings || foundShuffle) return;
      if (shuffleObfuscatedStrings(path, collector, funcObfStrings)) {
        foundShuffle = true;
      }
    },
  });
  log("END find base + shuffle");
  if (!baseDecryptFunc || !foundShuffle) {
    console.error("Base decrypt func or shuffle missing — aborting");
    return;
  }
  wrapperNames.add(baseDecryptFunc);

  // 3. Find wrappers iteratively
  log("BEGIN find wrappers (iterative)");
  for (let pass = 1; pass <= 5; pass++) {
    let foundThisPass = 0;
    const toCollect: Array<{ name: string; path: NodePath }> = [];

    traverse(ast, {
      FunctionDeclaration(path) {
        const name = tryWrapperDecl(path as NodePath<t.FunctionDeclaration>, wrapperNames);
        if (name && !wrapperNames.has(name)) {
          log(`  pass ${pass} -> FunctionDecl wrapper:`, name);
          toCollect.push({ name, path });
        }
      },
      VariableDeclarator(path) {
        const name = tryWrapperVar(path as NodePath<t.VariableDeclarator>, wrapperNames);
        if (name && !wrapperNames.has(name)) {
          log(`  pass ${pass} -> VarDecl wrapper:`, name);
          toCollect.push({ name, path });
        }
      },
    });

    for (const w of toCollect) {
      if (wrapperNames.has(w.name)) continue;
      wrapperNames.add(w.name);
      foundThisPass++;
      if (w.path.isFunctionDeclaration()) {
        collector.add(generate(w.path.node).code);
        w.path.remove();
      } else if (w.path.isVariableDeclarator()) {
        const init = (w.path.node as t.VariableDeclarator).init!;
        collector.add(`${w.name} = ${generate(init).code}`);
        w.path.remove();
      }
    }

    log(`  pass ${pass} -> found ${foundThisPass} new wrappers`);
    if (foundThisPass === 0) break;
  }
  log("END find wrappers");

  collector.flush();

  // 4. Replace wrapper calls
  log("BEGIN replace wrapper calls");
  const userWrappers = new Set(wrapperNames);
  userWrappers.delete(baseDecryptFunc);
  replaceAllWrapperCalls(ast, userWrappers, collector);
  log("END replace wrapper calls");

  // 5. Operator map — CAREFUL: don't remove the map if we couldn't consume its usages,
  //    otherwise runtime execution of the script will crash.
  log("BEGIN processMap");
  const mr = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path) {
      if (!path.node) return;
      if (!mr.parseMap(path)) return;
      const binReplaced = mr.replaceBinaryOpCallsGlobal(ast);
      const idxReplaced = mr.replaceMapIndexing();
      path.stop();
      if (binReplaced > 0 || idxReplaced > 0) {
        // But even then, keep it if any references remain in the AST
        const binding = path.scope.getBinding(mr.mapName!);
        const remainingRefs = binding?.referencePaths.filter(r => !r.removed).length ?? 0;
        if (remainingRefs === 0) {
          path.remove();
          log("processMap: map removed (fully consumed)");
        } else {
          log(`processMap: map KEPT (${remainingRefs} refs still present)`);
        }
      } else {
        log("processMap: map KEPT (0 replacements — runtime will need it)");
      }
    },
  });
  log("END processMap");

  // 6. unwrapOrElse
  log("BEGIN simplifyUnwrapOrElse");
  traverse(ast, { CallExpression(path) { simplifyUnwrapOrElse(path); } });
  log("END simplifyUnwrapOrElse");

  // 7. bracketToDot
  log("BEGIN bracketToDot");
  const validId = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$_A-Za-z][$_0-9A-Za-z]*$/;
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node) return;
      const { object, property, computed } = path.node;
      if (!computed || !t.isStringLiteral(property) || !validId.test(property.value)) return;
      path.replaceWith(t.memberExpression(object, t.identifier(property.value), false));
    },
  });
  log("END bracketToDot");

  // 8. Generate
  log("BEGIN generate");
  let code = generate(ast, { comments: false }).code;
  code = beautify(code, { indent_size: 2, space_in_empty_paren: true });
  log("END generate+beautify");

  const outputPath = process.argv[3];
  writeFile(outputPath, code, (err) => {
    if (err) { console.error("Error writing file", err); return; }
    log("Wrote file to", outputPath);
  });
}

log("argv:", process.argv.slice(2).join(" "));
deobfuscate(readFileSync(process.argv[2], "utf8"));
