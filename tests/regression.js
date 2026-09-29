const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const { captureDeclarationReferences } = require("../build/declaration-binding.js");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "build", "dynamic_rules.js");
const deobfuscatorCli = path.join(root, "build", "deobfuscator.js");

function runRulesFile(file, label = file) {
  const result = spawnSync(process.execPath, [cli, file, "unused-app-token"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0) {
    throw new Error(
      `dynamic-rules failed for ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

function runRules(relPath) {
  return runRulesFile(path.join(root, relPath), relPath);
}

function deobfuscateToTemp(relPath) {
  const input = path.join(root, relPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onlyfans-deob-regression-"));
  const output = path.join(tempDir, "deobfuscated.js");
  const result = spawnSync(process.execPath, [deobfuscatorCli, input, output], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(
      `deobfuscator failed for ${relPath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { output, tempDir, stderr: result.stderr };
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}\nexpected: ${e}\nactual:   ${a}`);
  }
}

const LEGACY_EXPECTED = {
  end: "67922a28",
  start: "36031",
  format: "36031:{}:{:x}:67922a28",
  prefix: "36031",
  suffix: "67922a28",
  static_param: "IjPESe2BMUL892ZTKVXh6e98Jc3KQf0c",
  remove_headers: ["user_id"],
  checksum_indexes: [18,1,19,34,13,25,7,26,6,25,4,32,18,36,14,20,1,5,36,33,0,11,25,0,2,10,36,15,16,8,2,12],
  checksum_constant: 127,
};

const oldSample = runRules("samples/deobfuscated/202501231137-41432dce62.js");
assertEqual(oldSample, LEGACY_EXPECTED, "legacy deobfuscated sample regression failed");

// End-to-end guard: this is the path the workflow actually uses.  It catches
// wrapper-binding/shadowing mistakes that a pre-deobfuscated fixture cannot.
const e2e = deobfuscateToTemp("samples/obfuscated/202501231137-41432dce62.js");
try {
  if (!/replaced:\s*[1-9]\d*/.test(e2e.stderr)) {
    throw new Error(`end-to-end deobfuscator replaced no wrapper calls\nstderr:\n${e2e.stderr}`);
  }
  const e2eRules = runRulesFile(e2e.output, "end-to-end legacy deobfuscation output");
  assertEqual(e2eRules, LEGACY_EXPECTED, "end-to-end obfuscated -> rules regression failed");
} finally {
  fs.rmSync(e2e.tempDir, { recursive: true, force: true });
}

const churn = runRules("tests/fixtures/webpack-module-id-churn.js");
assertEqual(churn, {
  end: "deadbeef",
  start: "12345",
  format: "12345:{}:{:x}:deadbeef",
  prefix: "12345",
  suffix: "deadbeef",
  static_param: "0123456789abcdef0123456789abcdef",
  remove_headers: ["user_id"],
  checksum_indexes: [1,7,3,11,2,19,5,13],
  checksum_constant: 321,
}, "synthetic webpack module-id churn regression failed");

// FunctionDeclaration.path.scope is the function's own scope. A parameter
// with the same name is NOT the declaration binding in the parent scope.
const bindingAst = parser.parse(`
  function base(index, key) { return index; }
  function n(index, n) { return base(index, n); }
  n(0, "outside");
  function foreign(n) { return n(1, "foreign"); }
  const wrapper = function wrapper(wrapper, key) { return base(wrapper, key); };
  wrapper(2, "variable");
`);
let bindingCases = 0;
traverse(bindingAst, {
  FunctionDeclaration(declaration) {
    if (declaration.node.id.name !== "n") return;
    const own = declaration.scope.getBinding("n");
    const actual = declaration.parentPath.scope.getBinding("n");
    assert.notStrictEqual(own, actual, "fixture must expose the parameter/declaration collision");
    assert.strictEqual(own.kind, "param");
    const refs = new WeakSet();
    assert.strictEqual(captureDeclarationReferences(declaration, "n", refs), 1);
    assert(actual.referencePaths.every(ref => refs.has(ref.node)));
    assert(own.referencePaths.every(ref => !refs.has(ref.node)), "parameter references must not be captured");
    bindingCases++;
  },
  VariableDeclarator(declaration) {
    if (declaration.node.id.name !== "wrapper") return;
    const refs = new WeakSet();
    assert.strictEqual(captureDeclarationReferences(declaration, "wrapper", refs), 1);
    assert(declaration.scope.getBinding("wrapper").referencePaths.every(ref => refs.has(ref.node)));
    assert.throws(
      () => captureDeclarationReferences(declaration, "notTheDeclaration", new WeakSet()),
      /identifier mismatch/,
    );
    bindingCases++;
  },
});
assert.strictEqual(bindingCases, 2);

const legacySource = fs.readFileSync(
  path.join(root, "samples/obfuscated/202501231137-41432dce62.js"), "utf8",
);
function replaceOnce(source, from, to) {
  assert(source.includes(from), `fixture mutation target not found: ${from}`);
  assert.strictEqual(source.indexOf(from), source.lastIndexOf(from), `fixture mutation target is ambiguous: ${from}`);
  return source.replace(from, to);
}
const outerWrapper = "function f(W,n){return S(n-493,W)}";
const innerWrapper = "function o(W,n){return f(W,n- -142)}";
function asVariableWrapper(initializer) {
  const withoutDeclaration = replaceOnce(legacySource, outerWrapper, "");
  // Place the variable before its calls: do not create an artificial TDZ fixture.
  return replaceOnce(withoutDeclaration, "n.A=W=>{const n=", `n.A=W=>{const f=${initializer};const n=`);
}

const additionalE2E = [
  ["outer wrapper / first parameter shadows function name",
    replaceOnce(legacySource, outerWrapper, "function f(f,n){return S(n-493,f)}")],
  ["outer wrapper / second parameter shadows function name",
    replaceOnce(legacySource, outerWrapper, "function f(W,f){return S(f-493,W)}")],
  ["nested wrapper / first parameter shadows function name",
    replaceOnce(legacySource, innerWrapper, "function o(o,n){return f(o,n- -142)}")],
  ["both wrapper scopes have same-named parameters",
    replaceOnce(
      replaceOnce(legacySource, outerWrapper, "function f(W,f){return S(f-493,W)}"),
      innerWrapper, "function o(o,n){return f(o,n- -142)}",
    )],
  ["variable wrapper / anonymous function with same-named parameter",
    asVariableWrapper("function(f,n){return S(n-493,f)}")],
  ["variable wrapper / named expression with same-named parameter",
    asVariableWrapper("function f(f,n){return S(n-493,f)}")],
  ["variable wrapper / arrow with same-named parameter",
    asVariableWrapper("(f,n)=>S(n-493,f)")],
  ["direct base-decoder call in sign prefix",
    replaceOnce(legacySource, 'f("6mWI",947)', 'S(454,"6mWI")')],
  ["foreign helper returns same-named webpack require, not decrypt wrapper",
    replaceOnce(legacySource, "function f(){const W=",
      "function foreignHelper(W,n){return o(W,n)}n.foreignHelper=foreignHelper;function f(){const W=")],
];

function runSourceCase(source, label, { errorPattern, preserveOutput = false, directoryOutput = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onlyfans-deob-binding-"));
  const input = path.join(dir, "obfuscated.js");
  const output = directoryOutput ? dir : path.join(dir, "deobfuscated.js");
  const sentinel = "DO NOT OVERWRITE PREVIOUS OUTPUT";
  try {
    fs.writeFileSync(input, source);
    if (preserveOutput) fs.writeFileSync(output, sentinel);
    const result = spawnSync(process.execPath, [deobfuscatorCli, input, output], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (errorPattern) {
      assert.strictEqual(result.status, 1, `${label}: must fail with exit 1\n${result.stderr}`);
      assert.match(result.stderr, errorPattern, `${label}: wrong failure diagnostic`);
      if (preserveOutput) assert.strictEqual(fs.readFileSync(output, "utf8"), sentinel);
      else if (!directoryOutput) assert(!fs.existsSync(output), `${label}: incomplete output was written`);
      return;
    }
    assert.strictEqual(result.status, 0, `${label}: deobfuscation failed\n${result.stderr}`);
    assertEqual(runRulesFile(output, label), LEGACY_EXPECTED, `${label}: full rules mismatch`);

    // The genuine webpack require called `o` is not the nested decrypt wrapper.
    const outputAst = parser.parse(fs.readFileSync(output, "utf8"));
    let importCallFound = false;
    traverse(outputAst, {
      CallExpression(call) {
        if (call.node.callee.type === "Identifier" && call.node.callee.name === "o" &&
            call.node.arguments[0]?.type === "NumericLiteral" && call.node.arguments[0].value === 944114) {
          importCallFound = true;
        }
      },
    });
    assert(importCallFound, `${label}: unrelated webpack import was changed`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, source] of additionalE2E) runSourceCase(source, label);

runSourceCase("var notObfuscated = true;", "missing string array", {
  errorPattern: /String array not found/,
});
runSourceCase(
  replaceOnce(legacySource, outerWrapper, outerWrapper + "globalThis.decoderAlias=f;"),
  "dangling non-call decoder reference preserves old output", {
    errorPattern: /Unresolved decoder references/,
    preserveOutput: true,
  },
);
runSourceCase(
  replaceOnce(legacySource, 'f("2RE*",961)', 'f("2RE*",missingRuntimeIndex)'),
  "unresolvable decoder call refuses incomplete output", {
    errorPattern: /Unresolved decoder references/,
  },
);
runSourceCase(
  replaceOnce(legacySource, "===n)break;o.push(o.shift())", "===n&&false)break;o.push(o.shift())"),
  "nonterminating shuffle is bounded and preserves old output", {
    errorPattern: /Decoder setup failed: Script execution timed out/,
    preserveOutput: true,
  },
);
runSourceCase(legacySource, "output write failure returns nonzero", {
  errorPattern: /EISDIR/,
  directoryOutput: true,
});

console.log(
  "Regression tests passed: legacy direct + legacy end-to-end + module-id churn + " +
  `${bindingCases} binding cases + ${additionalE2E.length} end-to-end collision/base-call cases + 5 failure-path cases`,
);
