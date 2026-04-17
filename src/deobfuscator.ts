/* deobfuscator‑fixed.ts */
import * as parser from "@babel/parser";
import traverse, { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import beautify from "js-beautify";
import { readFileSync, writeFile } from "fs";
import vm from "vm";

/* ---------------------  Бинарные операторы  --------------------- */
const binop = [
  "+", "-", "/", "%", "*", "**", "&", "|", ">>", ">>>", "<<", "^",
  "==", "===", "!=", "!==", "in", "instanceof",
  ">", "<", ">=", "<=", "|>",
] as const;
type BinaryOperator = typeof binop[number];
const isBinaryOperator = (x: any): x is BinaryOperator => binop.includes(x);

/* ---------------------  Утилита логов  ------------------------ */
function log(...args: any[]) {
  console.error("[deobf]", ...args);
}

/* ---------------------  VM‑контекст  -------------------------- */
function makeContext(): vm.Context {
  return vm.createContext({
    parseInt, parseFloat, isNaN, isFinite,
    Math, String, Number, Boolean, Array, Object,
    RegExp, Error, TypeError, RangeError,
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    JSON, console,
  });
}

/* ---------------------  Collector  --------------------------- */
class SetupCollector {
  private snippets: string[] = [];
  readonly ctx: vm.Context;

  constructor(ctx: vm.Context) {
    this.ctx = ctx;
  }

  /** добавить кусок кода – будет выполнен позже */
  add(code: string) {
    this.snippets.push(code);
  }

  /** выполнить всё накопленное и очистить буфер */
  flush() {
    if (!this.snippets.length) return;
    const combined = this.snippets.join(";\n");
    this.snippets = [];
    try {
      vm.runInContext(combined, this.ctx);
      log("flush OK, combined length:", combined.length);
    } catch (e: any) {
      log("flush error:", e?.message);
      log("code start:", combined.slice(0, 300));
    }
  }

  /** выполнить один кусок кода и вернуть результат (или undefined) */
  run(code: string): any {
    try {
      return vm.runInContext(code, this.ctx);
    } catch (e: any) {
      log("run error:", e?.message, "code:", code);
      return undefined;
    }
  }
}

/* -----------------------------------------------------------------
 *  1️⃣ Поиск функции‑массива строк
 * ----------------------------------------------------------------- */
function findStringsArray(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
): string | undefined {
  const node = path.node;
  const body = node.body.body;
  if (node.params.length !== 0) return;
  if (body.length !== 2) return;

  // ищем var <id> = [ "abc", … ];
  const varDecl = body.find(
    (stmt): stmt is t.VariableDeclaration => t.isVariableDeclaration(stmt)
  );
  if (!varDecl) return;
  const decl = varDecl.declarations[0];
  if (!decl || !t.isArrayExpression(decl.init)) return;
  if (!decl.init.elements.every((el) => t.isStringLiteral(el))) return;
  if (!node.id) return;

  log(
    "findStringsArray ->",
    node.id.name,
    "array‑var:",
    (decl.id as t.Identifier).name,
    "elements:",
    decl.init.elements.length,
  );

  // сохраняем функцию в VM (в ней внутри объявлен массив)
  collector.add(generate(node).code);
  path.remove(); // убираем её из итогового AST
  return node.id.name;
}

/* -----------------------------------------------------------------
 *  2️⃣ Поиск базовой функции дешифрования (k)
 * ----------------------------------------------------------------- */
function findBaseDecryptFunction(
  path: NodePath<t.FunctionDeclaration>,
  collector: SetupCollector,
  funcObfStrings: string,
): string | undefined {
  const node = path.node;
  if (node.params.length !== 2) return;
  if (!node.id) return;

  // ищем, чтобы внутри функции явно вызывался funcObfStrings()
  const usesObfStrings = node.body.body.some((stmt) => {
    return t.isVariableDeclaration(stmt) && stmt.declarations.some((d) => {
      return (
        t.isCallExpression(d.init) &&
        t.isIdentifier(d.init.callee, { name: funcObfStrings })
      );
    });
  });
  if (!usesObfStrings) return;

  log("findBaseDecryptFunction ->", node.id.name, "body stmts:", node.body.body.length);
  collector.add(generate(node).code);
  path.remove();
  return node.id.name;
}

/* -----------------------------------------------------------------
 *  3️⃣ Поиск thin‑wrapper‑функций (FunctionDeclaration)
 * ----------------------------------------------------------------- */
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

  log("findDecryptFunction ->", node.id.name);
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

/* -----------------------------------------------------------------
 *  3b️⃣ thin‑wrapper, объявленная как var r = function…
 * ----------------------------------------------------------------- */
function findDecryptFunctionFromDeclarator(
  path: NodePath<t.VariableDeclarator>,
  collector: SetupCollector,
  baseDecryptFunc: string,
): Binding | undefined {
  const node = path.node;
  if (!t.isIdentifier(node.id) || !node.init) return;
  const init = node.init;
  if (!t.isFunctionExpression(init) && !t.isArrowFunctionExpression(init)) return;
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

  const name = node.id.name;
  log("findDecryptFunctionFromDeclarator ->", name);
  collector.add(`${name} = ${generate(init).code}`);
  const binding = path.scope.getBinding(name);
  if (!binding) {
    log("no binding for", name);
    return;
  }
  path.remove();
  log("  refs:", binding.referencePaths.length);
  return binding;
}

/* -----------------------------------------------------------------
 *  4️⃣ Шаффлер массива строк (shuffle)
 * ----------------------------------------------------------------- */
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
  collector.add(generate(t.expressionStatement(node)).code);
  collector.flush();

  // убираем вызов из AST, он уже выполнен
  if (t.isUnaryExpression(path.parentPath.node)) {
    path.parentPath.remove();
  } else {
    path.remove();
  }
  return true;
}

/* -----------------------------------------------------------------
 *  5️⃣ Дешифруем вызовы thin‑wrapper‑функций → реальные строки
 * ----------------------------------------------------------------- */
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
    if (!callPath || !t.isCallExpression(callPath.node)) continue;

    // Не трогаем возврат из самой функции‑обёртки
    if (t.isReturnStatement(callPath.parentPath?.node)) continue;

    // ----- статическая оценка аргументов -----
    const argsCode: string[] = [];
    let allConfident = true;
    for (const arg of callPath.get("arguments")) {
      const evalResult = arg.evaluate();
      if (evalResult.confident) {
        // примитивы сериализуем через JSON (корректно работает с числами, строками, bool, null)
        argsCode.push(JSON.stringify(evalResult.value));
      } else {
        // если оценка не уверена – просто берём сгенерированный код (может содержать переменные)
        // — в таком случае run скорее всего бросит ошибку и вернёт undefined
        allConfident = false;
        argsCode.push(generate(arg.node).code);
      }
    }

    const callSrc = `${binding.identifier.name}(${argsCode.join(",")})`;
    const value = collector.run(callSrc);
    if (value !== undefined) {
      // заменяем весь CallExpression на полученное литеральное значение
      callPath.replaceWith(t.valueToNode(value));
      replaced++;
    }
  }
  log("decryptMapKeys -> replaced:", replaced);
}

/* -----------------------------------------------------------------
 *  6️⃣ Объект‑карта операторов
 * ----------------------------------------------------------------- */
enum MapFuncType { CallOneArg, CallThreeArg }

class MapReplacer {
  decryptionMap: { [key: string]: BinaryOperator | MapFuncType | string } = {};
  mapName: string | undefined;
  scope: Scope | undefined;

  /** Обрабатываем объявление var map = { … } */
  parseMap(path: NodePath<t.VariableDeclarator>): boolean {
    const node = path.node;
    if (!t.isObjectExpression(node.init) || !t.isIdentifier(node.id)) return false;

    let changed = false;
    node.init.properties = node.init.properties.filter((prop) => {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) return true;
      const key = prop.key.name;

      // === function(){ return a+b } ===
      if (t.isFunctionExpression(prop.value)) {
        const body = prop.value.body.body;
        if (body.length !== 1 || !t.isReturnStatement(body[0])) return true;
        const ret = (body[0] as t.ReturnStatement).argument;
        if (t.isBinaryExpression(ret)) {
          this.decryptionMap[key] = ret.operator;
          changed = true;
          return false;
        }
        if (t.isCallExpression(ret)) {
          if (ret.arguments.length === 3) {
            this.decryptionMap[key] = MapFuncType.CallThreeArg;
            changed = true;
            return false;
          }
          if (ret.arguments.length === 1) {
            this.decryptionMap[key] = MapFuncType.CallOneArg;
            changed = true;
            return false;
          }
        }
        return true;
      }

      // === string literal ===
      if (t.isStringLiteral(prop.value)) {
        this.decryptionMap[key] = prop.value.value;
        changed = true;
        return false;
      }

      return true;
    });

    if (changed) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      log("parseMap ->", this.mapName);
    }
    return changed;
  }

  /** map["X"](a,b) → a op b */
  replaceBinaryOpCalls() {
    if (!this.mapName || !this.scope) return;
    let count = 0;
    this.scope.traverse(this.scope.path.node, {
      CallExpression: (p: NodePath<t.CallExpression>) => {
        const callee = p.node.callee;
        if (!t.isMemberExpression(callee)) return;
        const { object, property } = callee;
        if (!t.isIdentifier(object, { name: this.mapName })) return;
        if (!t.isStringLiteral(property)) return;
        const op = this.decryptionMap[property.value];
        if (!isBinaryOperator(op)) return;
        if (p.node.arguments.length !== 2) return;
        p.replaceWith(
          t.binaryExpression(
            op,
            p.node.arguments[0] as t.Expression,
            p.node.arguments[1] as t.Expression,
          ),
        );
        count++;
      },
    });
    log("replaceBinaryOpCalls ->", count);
  }

  /** map["X"] → литерал  /  map["X"](a,b,…) → a(b,…) */
  replaceMapIndexing() {
    if (!this.mapName) return;
    const binding = this.scope?.getBinding(this.mapName);
    if (!binding) return;
    let count = 0;
    for (const ref of binding.referencePaths) {
      const mem = ref.parentPath;
      const memParent = mem?.parentPath;
      if (!mem || !memParent || !t.isMemberExpression(mem.node)) continue;
      const { object, computed, property } = mem.node;
      if (object !== ref.node || !computed || !t.isStringLiteral(property)) continue;

      const key = property.value;
      const val = this.decryptionMap[key];
      if (typeof val === "string" && !isBinaryOperator(val)) {
        // простая подстановка литерала
        mem.replaceWith(t.valueToNode(val));
        count++;
        continue;
      }

      // map["X"](a,b,…) → a(b,…)
      if (
        typeof val !== "string" &&
        t.isCallExpression(memParent.node) &&
        memParent.node.arguments.length !== 0
      ) {
        const callNode = memParent.node;
        callNode.callee = callNode.arguments[0] as t.Expression;
        callNode.arguments = callNode.arguments.slice(1);
        count++;
      }
    }
    log("replaceMapIndexing ->", count);
  }
}

/* -----------------------------------------------------------------
 *  7️⃣ unwrapOrElse → a?.b?.c || d
 * ----------------------------------------------------------------- */
function simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
  const node = path.node;
  if (!t.isCallExpression(node.callee) || node.arguments.length !== 3) return;
  const [obj, prop, fallback] = node.arguments as t.Expression[];
  if (!t.isStringLiteral(prop) || !prop.value.includes(".")) {
    // one‑level – a?.b
    const expr = t.memberExpression(obj, prop, true);
    path.replaceWith(t.logicalExpression("||", expr, fallback));
    path.skip();
    return;
  }

  // многоуровневый: "a.b.c"
  let cur: t.Expression | undefined = undefined;
  for (const part of prop.value.split(".")) {
    const key = t.stringLiteral(part);
    cur = cur ? t.memberExpression(cur, key, true) : t.memberExpression(obj, key, true);
  }
  if (!cur) return;
  path.replaceWith(t.logicalExpression("||", cur, fallback));
  path.skip();
}

/* -----------------------------------------------------------------
 *  8️⃣ Сбор всех "константных" переменных (чисел и строк) —
 *       они часто участвуют в аргументах обёрток.
 * ----------------------------------------------------------------- */
function collectTopLevelConsts(ast: t.File, collector: SetupCollector) {
  traverse(ast, {
    VariableDeclarator(path) {
      const node = path.node;
      if (!t.isIdentifier(node.id) || !node.init) return;
      if (t.isStringLiteral(node.init) || t.isNumericLiteral(node.init) || t.isBooleanLiteral(node.init) || t.isNullLiteral(node.init)) {
        // Пример: var _0x1a2b = 0x14;
        collector.add(generate(path.parentPath.node).code);
      }
    },
    // аналогично для const и let – но они уже приходятся в VariableDeclarator
  });
}

/* -----------------------------------------------------------------
 *  Основная функция
 * ----------------------------------------------------------------- */
function deobfuscate(source: string) {
  log("source length:", source.length);
  const ast = parser.parse(source);
  log("AST parsed OK");

  const ctx = makeContext();
  const collector = new SetupCollector(ctx);

  /** Имя функции, возвращающей массив строк (обычно `i`) */
  let funcObfStrings: string | undefined;
  /** Имя базовой функции дешифрования (обычно `f`) */
  let baseDecryptFunc: string | undefined;
  /** Обёртки над базовой функцией */
  let firstBinding: Binding | undefined;
  let secondBinding: Binding | undefined;
  /** Был ли выполнен shuffle? */
  let foundShuffle = false;

  /* ---------- 1️⃣ находка массива строк ---------- */
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
  if (!funcObfStrings) {
    console.error("Strings array not found");
    return;
  }
  log("END findObfuscatedStrings →", funcObfStrings);

  /* ---------- 2️⃣ базовая и обёртки ---------- */
  log("BEGIN parseDecryptFunctions");
  traverse(ast, {
    // базовая (k) – вызывается как f(...)
    FunctionDeclaration(path) {
      if (!baseDecryptFunc) {
        const name = findBaseDecryptFunction(path, collector, funcObfStrings!);
        if (name) baseDecryptFunc = name;
      }
    },

    // thin‑wrapper как FunctionDeclaration
    FunctionDeclaration(path) {
      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunction(path, collector, baseDecryptFunc);
        if (b) firstBinding = b;
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunction(path, collector, firstBinding.identifier.name);
        if (b) secondBinding = b;
      }
    },

    // thin‑wrapper объявлена через var/let/const
    VariableDeclarator(path) {
      if (!firstBinding && baseDecryptFunc) {
        const b = findDecryptFunctionFromDeclarator(path, collector, baseDecryptFunc);
        if (b) firstBinding = b;
      } else if (!secondBinding && firstBinding) {
        const b = findDecryptFunctionFromDeclarator(path, collector, firstBinding.identifier.name);
        if (b) secondBinding = b;
      }
    },

    // одно‑разовый shuffle
    CallExpression(path) {
      if (!funcObfStrings || foundShuffle) return;
      if (shuffleObfuscatedStrings(path, collector, funcObfStrings)) {
        foundShuffle = true;
      }
    },
  });

  if (!baseDecryptFunc || !firstBinding) {
    console.error("Не удалось собрать функции дешифрования");
    return;
  }
  log("END parseDecryptFunctions", {
    baseDecryptFunc,
    firstBinding: firstBinding?.identifier.name,
    secondBinding: secondBinding?.identifier.name,
    foundShuffle,
  });

  /* ---------- 3️⃣ Добавляем все константы (числа/строки) в VM ---------- */
  collectTopLevelConsts(ast, collector);

  /* ---------- 4️⃣ Выполняем всё собранное в VM (функции + shuffle + константы) ---------- */
  collector.flush();

  /* ---------- 5️⃣ Дешифруем вызовы thin‑wrapper‑функций ---------- */
  log("BEGIN decryptMapKeys");
  decryptMapKeys(firstBinding, collector);
  if (secondBinding) decryptMapKeys(secondBinding, collector);
  log("END decryptMapKeys");

  /* ---------- 6️⃣ Обрабатываем карту операторов ---------- */
  log("BEGIN processMap");
  const replacer = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path) {
      if (replacer.parseMap(path)) {
        replacer.replaceBinaryOpCalls();
        replacer.replaceMapIndexing();
        path.remove(); // удаляем объект‑карту из финального кода
      }
    },
  });
  log("END processMap");

  /* ---------- 7️⃣ unwrapOrElse ---------- */
  log("BEGIN simplifyUnwrapOrElse");
  traverse(ast, {
    CallExpression(path) { simplifyUnwrapOrElse(path); },
  });
  log("END simplifyUnwrapOrElse");

  /* ---------- 8️⃣ "[\"id\"]" → .id (если id – валидный идентификатор) ---------- */
  log("BEGIN bracketToDot");
  const validId = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$_A-Za-z][$_0-9A-Za-z]*$/;
  traverse(ast, {
    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (!computed || !t.isStringLiteral(property) || !validId.test(property.value)) return;
      path.replaceWith(t.memberExpression(object, t.identifier(property.value), false));
    },
  });
  log("END bracketToDot");

  /* ---------- 9️⃣ Генерация кода ---------- */
  log("BEGIN generate");
  let code = generate(ast, { comments: false }).code;
  code = beautify(code, { indent_size: 2, space_in_empty_paren: true });
  log("END generate");

  const outPath = process.argv[3];
  writeFile(outPath, code, (err) => {
    if (err) console.error("Write error:", err);
    else log("Wrote file to", outPath);
  });
}

/* -----------------------------------------------------------------
 *  Запуск
 * ----------------------------------------------------------------- */
log("argv:", process.argv.slice(2).join(" "));
deobfuscate(readFileSync(process.argv[2], "utf8"));
