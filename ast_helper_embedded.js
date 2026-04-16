const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const beautify = require('js-beautify').js;
const vm = require('vm');

const BINOPS = ['+', '-', '/', '%', '*', '**', '&', '|', '>>', '>>>', '<<', '^', '==', '===', '!=', '!==', 'in', 'instanceof', '>', '<', '>=', '<=', '|>'];
const VALID_IDENTIFIER_REGEX = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$A-Z_a-z][$\w]*$/;

function log(...args) { console.error('[deobf]', ...args); }

function parseAst(source) {
  log('BEGIN parser.parse');
  const ast = parser.parse(source, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: [
      'jsx', 'typescript', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
      'numericSeparator', 'optionalChaining', 'nullishCoalescingOperator',
      'objectRestSpread', 'topLevelAwait', 'dynamicImport'
    ]
  });
  log('END parser.parse');
  return ast;
}

class ObfuscatedStrings {
  static findStringsArray(path, vmContext) {
    const node = path.node;
    const body = node.body.body;
    if (node.params.length !== 0) return;
    if (body.length !== 2 || !t.isVariableDeclaration(body[0])) return;
    const declarations = body[0].declarations;
    if (declarations.length !== 1) return;
    const obfStrings = declarations[0];
    if (!t.isArrayExpression(obfStrings.init)) return;
    const elements = obfStrings.init.elements;
    if (!elements.length) return;
    for (const elemNode of elements) {
      if (!t.isStringLiteral(elemNode)) return;
    }
    if (!node.id) return;
    log('findStringsArray -> candidate:', node.id.name, 'elements:', elements.length);
    vm.runInContext(generate(node).code, vmContext);
    path.remove();
    log('findStringsArray -> accepted:', node.id.name);
    return node.id.name;
  }

  static findBaseDecryptFunction(path, vmContext, obfStringsFunc) {
    const node = path.node;
    const body = node.body.body;
    if (node.params.length !== 2) return;
    if (body.length !== 2 || !t.isVariableDeclaration(body[0])) return;
    const declarations = body[0].declarations;
    if (declarations.length !== 1) return;
    if (!t.isCallExpression(declarations[0].init)) return;
    if (!t.isIdentifier(declarations[0].init.callee, {name: obfStringsFunc})) return;
    if (!node.id) return;
    log('findBaseDecryptFunction -> candidate:', node.id.name, 'provider:', obfStringsFunc);
    vm.runInContext(generate(node).code, vmContext);
    path.remove();
    return node.id.name;
  }

  static findDecryptFunction(path, vmContext, baseDecryptFunc) {
    const node = path.node;
    const body = node.body.body;
    if (node.params.length !== 2 || body.length !== 1) return;
    if (!t.isReturnStatement(body[0]) || !body[0].argument || !t.isCallExpression(body[0].argument)) return;
    const call = body[0].argument;
    if (!t.isIdentifier(call.callee, {name: baseDecryptFunc})) return;
    if (!node.id) return;
    log('findDecryptFunction -> candidate:', node.id.name, 'target:', baseDecryptFunc);
    vm.runInContext(generate(node).code, vmContext);
    const binding = path.parentPath.scope.getBinding(node.id.name);
    if (!binding) return;
    path.remove();
    return binding;
  }

  static shuffleObfuscatedStrings(path, vmContext, funcObfStrings) {
    const node = path.node;
    if (node.arguments.length !== 2) return;
    if (!t.isIdentifier(node.arguments[0], {name: funcObfStrings})) return;
    if (!t.isNumericLiteral(node.arguments[1])) return;
    const seed = node.arguments[1].value;
    log('shuffleObfuscatedStrings -> candidate:', funcObfStrings, 'seed:', seed);
    const code = generate(t.expressionStatement(node)).code;
    vm.runInContext(code, vmContext);
    if (t.isUnaryExpression(path.parentPath.node)) path.parentPath.remove();
    else path.remove();
    return true;
  }
}

class DecryptStrings {
  static decryptMapKeys(decryptFuncBinding, vmContext) {
    let replaced = 0;
    const references = decryptFuncBinding.referencePaths || [];
    for (const reference of references) {
      const refParentPath = reference.parentPath;
      if (!refParentPath) continue;
      if (t.isReturnStatement(refParentPath.parent)) continue;
      const code = generate(refParentPath.node).code;
      try {
        const value = vm.runInContext(code, vmContext);
        refParentPath.replaceWith(t.valueToNode(value));
        replaced += 1;
      } catch (_) {}
    }
    return replaced;
  }
}

const MapFuncType = {
  CallOneArg: 1,
  CallThreeArg: 3,
};

class MapReplacer {
  constructor() {
    this.decryptionMap = {};
    this.mapName = undefined;
    this.scope = undefined;
  }

  parseMap(path) {
    const node = path.node;
    if (!t.isObjectExpression(node.init) || !t.isIdentifier(node.id)) return;
    let flag = false;

    node.init.properties = node.init.properties.filter((elemNode) => {
      if (!t.isObjectProperty(elemNode)) return true;
      const key = t.isIdentifier(elemNode.key) ? elemNode.key.name : t.isStringLiteral(elemNode.key) ? elemNode.key.value : null;
      if (!key) return true;

      if (t.isFunctionExpression(elemNode.value) || t.isArrowFunctionExpression(elemNode.value)) {
        const funcBody = t.isBlockStatement(elemNode.value.body) ? elemNode.value.body.body : [];
        if (funcBody.length !== 1) return true;
        if (!t.isReturnStatement(funcBody[0])) return true;
        const ret = funcBody[0].argument;
        if (!ret) return true;

        if (t.isBinaryExpression(ret) && BINOPS.includes(ret.operator)) {
          this.decryptionMap[key] = ret.operator;
          flag = true;
        } else if (t.isCallExpression(ret)) {
          if (ret.arguments.length === 3) this.decryptionMap[key] = MapFuncType.CallThreeArg;
          else if (ret.arguments.length === 1) this.decryptionMap[key] = MapFuncType.CallOneArg;
          else return true;
          flag = true;
        } else {
          return true;
        }
      } else if (t.isStringLiteral(elemNode.value)) {
        this.decryptionMap[key] = elemNode.value.value;
        flag = true;
      } else {
        return true;
      }
      return false;
    });

    if (flag) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      return true;
    }
  }

  replaceBinaryOpCalls() {
    let changed = 0;
    this.scope?.traverse(this.scope.path.node, {
      CallExpression: (path) => {
        const node = path.node;
        if (!t.isMemberExpression(node.callee)) return;
        const {object, property} = node.callee;
        if (!t.isIdentifier(object, {name: this.mapName})) return;
        if (!t.isStringLiteral(property)) return;
        if (node.arguments.length !== 2) return;
        const op = this.decryptionMap[property.value];
        if (typeof op !== 'string' || !BINOPS.includes(op)) return;
        path.replaceWith(t.binaryExpression(op, node.arguments[0], node.arguments[1]));
        changed += 1;
      }
    });
    return changed;
  }

  replaceMapIndexing() {
    if (!this.mapName || !this.scope) return 0;
    let changed = 0;
    this.scope.crawl();
    const references = this.scope.getBinding(this.mapName)?.referencePaths || [];
    for (const reference of references) {
      const mapIndex = reference.parentPath;
      const mapIndexParent = mapIndex?.parentPath;
      if (!mapIndex || !mapIndexParent || !t.isMemberExpression(mapIndex.node)) continue;
      const { object, computed, property } = mapIndex.node;
      if (object !== reference.node || !computed || !t.isStringLiteral(property)) continue;
      const mapVal = this.decryptionMap[property.value];

      if (typeof mapVal === 'string' && !BINOPS.includes(mapVal)) {
        mapIndex.replaceWith(t.valueToNode(mapVal));
        changed += 1;
      } else if (typeof mapVal !== 'string' && t.isCallExpression(mapIndexParent.node)) {
        if (mapIndexParent.node.arguments.length !== 0) {
          const func = mapIndexParent.node.arguments[0];
          const args = mapIndexParent.node.arguments.slice(1);
          mapIndexParent.node.callee = func;
          mapIndexParent.node.arguments = args;
          changed += 1;
        }
      }
    }
    return changed;
  }
}

class SimplifyIndexing {
  static simplifyUnwrapOrElse(path) {
    const node = path.node;
    if (!t.isCallExpression(node.callee) || node.arguments.length !== 3) return;
    const [object, property, elseExpr] = node.arguments;
    const resultObj = this.simplifyMultiProperty(object, property);
    if (!resultObj) return;
    path.replaceWith(t.logicalExpression('||', resultObj, elseExpr));
    path.skip();
  }

  static simplifyMultiProperty(object, property) {
    if (!t.isStringLiteral(property) || !property.value.includes('.')) {
      return t.memberExpression(object, property, true);
    }
    const properties = property.value.split('.');
    let resultObj = null;
    for (const prop of properties) {
      const propLit = t.stringLiteral(prop);
      resultObj = resultObj ? t.memberExpression(resultObj, propLit, true) : t.memberExpression(object, propLit, true);
    }
    return resultObj;
  }
}

function extractRules(source) {
  const ast = parseAst(source);
  let staticParam = null;
  let checksumConstant = 0;
  let checksumIndexes = [];
  let prefix = null;
  let suffix = null;

  traverse(ast, {
    ArrayExpression(path) {
      const elements = path.node.elements;
      if (!elements.length || !t.isStringLiteral(elements[0])) return;
      const first = elements[0].value;
      if (first.length === 32) staticParam = first;
      else if (!Number.isNaN(parseInt(first, 10))) prefix = first;
      const last = elements[elements.length - 1];
      if (t.isStringLiteral(last) && !Number.isNaN(parseInt(last.value, 16))) suffix = last.value;
    },
    BinaryExpression(path) {
      const node = path.node;
      if (t.isNumericLiteral(node.right)) {
        if (node.operator === '+') checksumConstant += node.right.value;
        else if (node.operator === '-') checksumConstant -= node.right.value;
      } else if (t.isNumericLiteral(node.left) && node.operator === '%') {
        checksumIndexes.push(node.left.value % 40);
      }
    }
  });

  if (!prefix || !suffix || !staticParam || !checksumIndexes.length) return null;
  return {
    end: suffix,
    start: prefix,
    format: `${prefix}:{}:{:x}:${suffix}`,
    prefix,
    suffix,
    static_param: staticParam,
    remove_headers: ['user_id'],
    checksum_indexes: checksumIndexes,
    checksum_constant: checksumConstant,
  };
}

function deobfuscate(source) {
  log('source length:', source.length);
  const ast = parseAst(source);
  const decryptCtx = vm.createContext({});

  let funcObfStrings;
  let baseDecryptFunc;
  let firstDecryptFuncBinding;
  let secondDecryptFuncBinding;
  let foundShuffleFunc = false;

  log('BEGIN traverse findObfuscatedStrings');
  traverse(ast, {
    FunctionDeclaration(path) {
      const funcName = ObfuscatedStrings.findStringsArray(path, decryptCtx);
      if (funcName) {
        funcObfStrings = funcName;
        log('found obfuscated strings function:', funcName);
        path.stop();
      }
    }
  });
  log('END traverse findObfuscatedStrings');

  if (!funcObfStrings) throw new Error('Strings was not found!');

  log('BEGIN traverse parseDecryptFunctions');
  traverse(ast, {
    ArrowFunctionExpression(arrowFuncPath) {
      arrowFuncPath.traverse({
        FunctionDeclaration(path) {
          if (!firstDecryptFuncBinding && baseDecryptFunc) {
            const binding = ObfuscatedStrings.findDecryptFunction(path, decryptCtx, baseDecryptFunc);
            if (binding) {
              firstDecryptFuncBinding = binding;
              log('accepted first decrypt binding:', binding.identifier?.name || '?');
            }
          } else if (!secondDecryptFuncBinding && firstDecryptFuncBinding) {
            const binding = ObfuscatedStrings.findDecryptFunction(path, decryptCtx, firstDecryptFuncBinding.identifier.name);
            if (binding) {
              secondDecryptFuncBinding = binding;
              log('accepted second decrypt binding:', binding.identifier?.name || '?');
            }
          }
        }
      });
    },
    FunctionDeclaration(path) {
      if (!funcObfStrings) return;
      const funcName = ObfuscatedStrings.findBaseDecryptFunction(path, decryptCtx, funcObfStrings);
      if (funcName) {
        baseDecryptFunc = funcName;
        log('accepted base decrypt function:', funcName);
      }
    },
    CallExpression(path) {
      if (!funcObfStrings || foundShuffleFunc) return;
      if (ObfuscatedStrings.shuffleObfuscatedStrings(path, decryptCtx, funcObfStrings)) {
        foundShuffleFunc = true;
      }
    },
  });
  log('END traverse parseDecryptFunctions');

  if (!baseDecryptFunc || !firstDecryptFuncBinding || !foundShuffleFunc) {
    throw new Error('Some decryption stuff was not found!');
  }

  const firstReplaced = DecryptStrings.decryptMapKeys(firstDecryptFuncBinding, decryptCtx);
  const secondReplaced = secondDecryptFuncBinding ? DecryptStrings.decryptMapKeys(secondDecryptFuncBinding, decryptCtx) : 0;
  log('decryptMapKeys replaced:', firstReplaced + secondReplaced);

  const mapReplacer = new MapReplacer();
  let mapChanged = 0;
  traverse(ast, {
    VariableDeclarator(path) {
      const found = mapReplacer.parseMap(path);
      if (!found) return;
      const bin = mapReplacer.replaceBinaryOpCalls();
      const idx = mapReplacer.replaceMapIndexing();
      mapChanged += bin + idx;
      path.stop();
      path.remove();
    }
  });
  log('map replacements:', mapChanged);

  let unwrapChanged = 0;
  traverse(ast, {
    CallExpression(path) {
      const before = generate(path.node).code;
      SimplifyIndexing.simplifyUnwrapOrElse(path);
      const afterNode = path.node;
      const after = afterNode ? generate(afterNode).code : '';
      if (before !== after) unwrapChanged += 1;
    }
  });
  log('unwrap replacements:', unwrapChanged);

  let bracketToDot = 0;
  traverse(ast, {
    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (!computed || !t.isStringLiteral(property)) return;
      if (!VALID_IDENTIFIER_REGEX.test(property.value)) return;
      path.replaceWith(t.memberExpression(object, t.identifier(property.value), false));
      bracketToDot += 1;
    }
  });
  log('bracketToDot replacements:', bracketToDot);

  let deobfCode = generate(ast, { comments: false }).code;
  deobfCode = beautify(deobfCode, { indent_size: 2, space_in_empty_paren: true });
  return deobfCode;
}

function main() {
  const cmd = process.argv[2];
  if (!cmd) throw new Error('cmd required');
  const input = process.argv[3];
  if (!input) throw new Error('input required');

  log('readFileSync start');
  const source = fs.readFileSync(input, 'utf8');
  log('readFileSync done len =', source.length);
  log('argv input:', input);

  if (cmd === 'deobfuscate') {
    const output = process.argv[4];
    if (!output) throw new Error('output required');
    log('argv output:', output);
    const code = deobfuscate(source);
    fs.writeFileSync(output, code, 'utf8');
    console.log(JSON.stringify({ ok: true, output_js: output }));
    return;
  }

  if (cmd === 'extract_rules') {
    const rules = extractRules(source);
    console.log(JSON.stringify({ ok: !!rules, rules }));
    return;
  }

  throw new Error(`unknown cmd ${cmd}`);
}

main();
