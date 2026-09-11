import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import { readFileSync } from "fs";
import vm from "vm";

interface DynamicRules {
    end: string;
    start: string;
    format: string;
    prefix: string;
    suffix: string;
    static_param: string;
    remove_headers: string[];
    checksum_indexes: number[];
    checksum_constant: number;
}

const FAKE_HASH = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
if (FAKE_HASH.length !== 40) {
    throw new Error("FAKE_HASH must be 40 chars (got " + FAKE_HASH.length + ")");
}

function extractBasicFields(ast: t.Node): {
    prefix?: string;
    suffix?: string;
    staticParam?: string;
} {
    let staticParam: string | undefined;
    let prefix: string | undefined;
    let suffix: string | undefined;

    traverse(ast, {
        CallExpression(path) {
            const node = path.node;
            if (!t.isMemberExpression(node.callee)) return;
            if (!t.isIdentifier(node.callee.property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0])) return;

            const joinChar = (node.arguments[0] as t.StringLiteral).value;

            if (joinChar === "\n" && t.isArrayExpression(node.callee.object)) {
                const first = node.callee.object.elements[0];
                if (t.isStringLiteral(first) && first.value.length === 32) {
                    staticParam = first.value;
                }
                return;
            }

            if (joinChar === ":" && t.isArrayExpression(node.callee.object)) {
                const elems = node.callee.object.elements;
                if (elems.length < 4) return;
                const firstElem = elems[0];
                const lastElem = elems[elems.length - 1];
                if (t.isStringLiteral(firstElem) && !isNaN(Number(firstElem.value))) {
                    prefix = firstElem.value;
                } else if (t.isNumericLiteral(firstElem)) {
                    prefix = String(firstElem.value);
                }
                if (
                    t.isStringLiteral(lastElem) &&
                    /^[0-9a-f]+$/i.test(lastElem.value) &&
                    lastElem.value.length > 0
                ) {
                    suffix = lastElem.value;
                }
            }
        },
    });

    return { prefix, suffix, staticParam };
}

interface RuntimeResult {
    checksum_indexes: number[];
    checksum_constant: number;
}

/**
 * Find the checksum IIFE directly inside the final colon-joined sign value.
 *
 * Important: webpack numeric module ids are build-local implementation details.
 * Stage 2 must not execute the whole webpack module or emulate its imports just
 * to reach the checksum.  The checksum function is already present in the
 * deobfuscated AST, so execute only that function with a tracked 40-char hash.
 */
function findChecksumFunctionSource(ast: t.Node): string | undefined {
    let found: string | undefined;

    traverse(ast, {
        CallExpression(path) {
            if (found) {
                path.stop();
                return;
            }

            const node = path.node;
            if (!t.isMemberExpression(node.callee)) return;
            if (!t.isIdentifier(node.callee.property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0], { value: ":" })) return;
            if (!t.isArrayExpression(node.callee.object)) return;

            const elems = node.callee.object.elements;
            if (elems.length < 4) return;

            const firstElem = elems[0];
            const hashElem = elems[1];
            const checksumElem = elems[2];
            const lastElem = elems[elems.length - 1];

            const hasNumericPrefix =
                (t.isStringLiteral(firstElem) && !isNaN(Number(firstElem.value))) ||
                t.isNumericLiteral(firstElem);
            const hasHexSuffix =
                t.isStringLiteral(lastElem) && /^[0-9a-f]+$/i.test(lastElem.value);
            if (!hasNumericPrefix || !hasHexSuffix) return;

            // Dynamic-rules sign layout is [prefix, hash, checksum(hash), suffix].
            // We intentionally identify the checksum by semantic shape rather
            // than by webpack require/module ids.
            if (!t.isExpression(hashElem) || !t.isCallExpression(checksumElem)) return;
            if (checksumElem.arguments.length !== 1 || !t.isExpression(checksumElem.arguments[0])) return;
            if (generate(hashElem).code !== generate(checksumElem.arguments[0]).code) return;

            const checksumFn = checksumElem.callee;
            if (!t.isFunctionExpression(checksumFn) && !t.isArrowFunctionExpression(checksumFn)) {
                return;
            }
            if (checksumFn.params.length !== 1 || !t.isIdentifier(checksumFn.params[0])) return;

            let hasCharCodeAt = false;
            let hasHexToString = false;
            t.traverseFast(checksumFn.body, (child) => {
                if (!t.isCallExpression(child) || !t.isMemberExpression(child.callee)) return;

                if (
                    t.isIdentifier(child.callee.property, { name: "charCodeAt" }) &&
                    child.arguments.length === 1 &&
                    t.isNumericLiteral(child.arguments[0], { value: 0 })
                ) {
                    hasCharCodeAt = true;
                }

                if (
                    t.isIdentifier(child.callee.property, { name: "toString" }) &&
                    child.arguments.length === 1 &&
                    t.isNumericLiteral(child.arguments[0], { value: 16 })
                ) {
                    hasHexToString = true;
                }
            });

            if (!hasCharCodeAt || !hasHexToString) return;

            found = generate(checksumFn).code;
            path.stop();
        },
    });

    return found;
}

function runChecksumFunction(ast: t.Node): RuntimeResult | undefined {
    const checksumFunctionSource = findChecksumFunctionSource(ast);
    if (!checksumFunctionSource) {
        console.error("[runtime] checksum function not found in sign expression");
        return;
    }

    const sandbox: any = {};
    const ctx = vm.createContext(sandbox);

    const bootstrap = `
        var __touched = [];
        var __FAKE_HASH = ${JSON.stringify(FAKE_HASH)};

        function makeTrackedHash() {
            var boxed = Object(__FAKE_HASH);
            return new Proxy(boxed, {
                get: function(target, prop, receiver) {
                    if (typeof prop === "string") {
                        var asNum = Number(prop);
                        if (Number.isInteger(asNum) && asNum >= 0 && asNum < __FAKE_HASH.length) {
                            __touched.push(asNum);
                            return __FAKE_HASH[asNum];
                        }
                    }
                    var val = Reflect.get(target, prop, receiver);
                    if (typeof val === "function") {
                        return val.bind(target);
                    }
                    return val;
                }
            });
        }

        var __checksumHex = null;
        var __invokeError = null;
        try {
            __checksumHex = (${checksumFunctionSource})(makeTrackedHash());
        } catch(e) {
            __invokeError = e && e.message ? e.message : String(e);
        }

        globalThis.__result = {
            touched: __touched.slice(),
            checksumHex: __checksumHex,
            invokeError: __invokeError,
        };
    `;

    try {
        vm.runInContext(bootstrap, ctx);
    } catch (e: any) {
        console.error("[runtime] bootstrap threw:", e?.message?.slice(0, 300));
        return;
    }

    const result = sandbox.__result;
    if (!result) {
        console.error("[runtime] no result exported from VM");
        return;
    }

    if (result.invokeError) {
        console.error("[runtime] checksum call threw:", String(result.invokeError).slice(0, 300));
        return;
    }

    const checksumHex = result.checksumHex;
    if (typeof checksumHex !== "string" || !/^[0-9a-f]+$/i.test(checksumHex)) {
        console.error("[runtime] checksum is not a hex string:", checksumHex);
        return;
    }

    const checksumDecimal = parseInt(checksumHex, 16);
    if (Number.isNaN(checksumDecimal)) {
        console.error("[runtime] checksum not parseable as hex:", checksumHex);
        return;
    }

    const touchedIndexes: number[] = result.touched;
    console.error("[runtime] checksum strategy: direct semantic IIFE");
    console.error("[runtime] touched indexes count:", touchedIndexes.length);
    console.error("[runtime] checksum hex:", checksumHex, "= decimal", checksumDecimal);

    if (touchedIndexes.length === 0) {
        console.error("[runtime] WARNING: no indexes captured — hook did not fire!");
        return;
    }

    const sumOfCharCodes = touchedIndexes.reduce(
        (acc, idx) => acc + FAKE_HASH.charCodeAt(idx % FAKE_HASH.length),
        0,
    );
    const checksum_constant = checksumDecimal - sumOfCharCodes;
    const checksum_indexes = touchedIndexes.map(i => ((i % 40) + 40) % 40);

    console.error("[runtime] sum of charCodes:", sumOfCharCodes);
    console.error("[runtime] computed constant:", checksum_constant);

    return { checksum_indexes, checksum_constant };
}

function getRules(ast: t.Node): DynamicRules | undefined {
    const { prefix, suffix, staticParam } = extractBasicFields(ast);

    if (!prefix || !suffix || !staticParam) {
        console.error(
            "[dynamic_rules] Stage 1 failed.\n" +
            "  prefix       = " + prefix + "\n" +
            "  suffix       = " + suffix + "\n" +
            "  static_param = " + staticParam
        );
        return undefined;
    }
    console.error("[dynamic_rules] Stage 1 OK: prefix=" + prefix + " suffix=" + suffix);

    const rt = runChecksumFunction(ast);

    if (!rt) {
        console.error("[dynamic_rules] Stage 2 failed — aborting (preserving old rules)");
        return undefined;
    }

    console.error(
        "[dynamic_rules] Stage 2 OK: indexes=" + rt.checksum_indexes.length +
        " constant=" + rt.checksum_constant,
    );

    return {
        end: suffix,
        start: prefix,
        format: prefix + ":{}:{:x}:" + suffix,
        prefix,
        suffix,
        static_param: staticParam,
        remove_headers: ["user_id"],
        checksum_indexes: rt.checksum_indexes,
        checksum_constant: rt.checksum_constant,
    };
}

const deobfSource = readFileSync(process.argv[2], "utf8");
const ast = parser.parse(deobfSource);
const rules = getRules(ast);
if (!rules) process.exit(1);
console.log(JSON.stringify(rules));
