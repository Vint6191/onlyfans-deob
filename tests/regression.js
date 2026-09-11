const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "build", "dynamic_rules.js");

function runRules(relPath) {
  const file = path.join(root, relPath);
  const result = spawnSync(process.execPath, [cli, file, "unused-app-token"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `dynamic-rules failed for ${relPath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}\nexpected: ${e}\nactual:   ${a}`);
  }
}

const oldSample = runRules("samples/deobfuscated/202501231137-41432dce62.js");
assertEqual(oldSample, {
  end: "67922a28",
  start: "36031",
  format: "36031:{}:{:x}:67922a28",
  prefix: "36031",
  suffix: "67922a28",
  static_param: "IjPESe2BMUL892ZTKVXh6e98Jc3KQf0c",
  remove_headers: ["user_id"],
  checksum_indexes: [18,1,19,34,13,25,7,26,6,25,4,32,18,36,14,20,1,5,36,33,0,11,25,0,2,10,36,15,16,8,2,12],
  checksum_constant: 127,
}, "legacy sample regression failed");

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

console.log("Regression tests passed: legacy sample + synthetic module-id churn fixture");
