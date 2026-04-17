import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import { readFileSync } from "fs";
import vm from "vm";

/**
 * Extracts OnlyFans dynamic-rules from the (partially) deobfuscated script.
 *
 * Strategy is intentionally hybrid:
 *   - prefix / suffix / static_param are pulled out by AST pattern-matching
 *     on `.join(":")` and `.join("\n")` calls. These are stable: OF has not
 *     changed the overall shape of `[static, time, url, uid].join("\n")` or
 *     `[prefix, hash, checksum, suffix].join(":")` in a long time.
 *
 *   - checksum_indexes and checksum_constant are extracted by actually
 *     RUNNING the checksum function inside a sandbox. We feed it a
 *     known 40-char "hash", log which indexes it touched (via a hooked
 *     charCodeAt), and back-solve the constant by comparing the hex value
 *     it returned with the sum of the known charCodes. This works
 *     regardless of how deeply obfuscated the function still is.
 */

interface DynamicRules {
    end: string;
    start: string;
    format: string;
    prefix: string;
    suffix: string;
    static_param: string;
    app_token: string;
    remove_headers: string[];
    checksum_indexes: number[];
    checksum_constant: number;
}

// 40-char deterministic hash stand-in. Must be length 40 (SHA-1 hex length).
// Use varied chars so every index yields a distinguishable charCode.
const FAKE_HASH = "0123456789abcdef" + "ghijklmnopqrstuv" + "wxyzABCDEFGH"; // 40 chars
if (FAKE_HASH.length !== 40) throw new Error("FAKE_HASH must be 40 chars");

/**
 * Find the checksum FunctionExpression/ArrowFunctionExpression inside the
 * `.join(":")` array. Returns its source code as a string that can be
 * evaluated standalone (after we supply needed externals in the VM).
 */
function findChecksumFunctionSource(ast: t.Node): string | undefined {
    let source: string | undefined;

    traverse(ast, {
        CallExpression(path) {
            if (source) return; // first match only
            const node = path.node;
            if (!t.isMemberExpression(node.callee)) return;
            if (!t.isIdentifier(node.callee.property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0])) return;
            if ((node.arguments[0] as t.StringLiteral).value !== ":") return;
            if (!t.isArrayExpression(node.callee.object)) return;

            // Find an immediately-invoked function in the array elements.
            // Pattern: function(W){...}(hashVar)  or  (W => {...})(hashVar)
            for (const elem of node.callee.object.elements) {
                if (!elem || !t.isCallExpression(elem)) continue;
                const callee = elem.callee;
                if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
                    source = generate(callee).code;
                    return;
                }
            }
        },
    });

    return source;
}

/**
 * Find ALL auxiliary top-level function/variable declarations that the
 * checksum function might reference (operator maps, decrypt wrappers, etc.).
 * We include them in the sandbox so the checksum function can actually run.
 *
 * This is done permissively: we grab every top-level FunctionDeclaration
 * and VariableDeclaration and stick them into the VM context. Harmless
 * ones just sit there unused.
 */
function extractAuxSource(ast: t.Node): string {
    if (!t.isFile(ast) && !t.isProgram(ast)) return "";
    const program = t.isFile(ast) ? ast.program : ast;
    const out: string[] = [];

    // Traverse top-level program statements AND go one level into the
    // webpack module function, which is where OF stores everything.
    for (const stmt of program.body) {
        // Pull top-level function + var decls directly
        if (t.isFunctionDeclaration(stmt) || t.isVariableDeclaration(stmt)) {
            out.push(generate(stmt).code);
        }
    }

    // The real body of OF code lives inside a webpack module:
    //   (self.webpackChunkof_vue = ...).push([[2313], {802313: function(W,n,o){ ... HERE ... }}])
    // We dig into that inner function's body to get the helper vars & funcs.
    traverse(ast, {
        FunctionExpression(path) {
            // Heuristic: OF module fn has exactly 3 params (W, n, o)
            if (path.node.params.length !== 3) return;
            // Only take ones whose body contains `join` somewhere (that's the signing module)
            let hasJoin = false;
            path.traverse({
                Identifier(p) {
                    if (p.node.name === "join") hasJoin = true;
                },
            });
            if (!hasJoin) return;

            // Pull inner var/func decls into aux
            for (const inner of path.node.body.body) {
                if (t.isVariableDeclaration(inner) || t.isFunctionDeclaration(inner)) {
                    out.push(generate(inner).code);
                }
            }
            path.stop();
        },
    });

    return out.join(";\n");
}

interface RuntimeResult {
    checksum_indexes: number[];
    checksum_constant: number;
}

function runChecksumFunction(
    funcSource: string,
    auxSource: string,
): RuntimeResult | undefined {
    const touchedIndexes: number[] = [];

    // Build sandbox with hooked charCodeAt
    const sandbox: any = {
        Math, Date, JSON, console,
        Array, Number, Boolean, Object, RegExp,
        Error, TypeError, RangeError,
        parseInt, parseFloat, isNaN, isFinite,
        decodeURIComponent, encodeURIComponent,
        // Stubs for webpack helpers the aux code might reference
        r: (...a: any[]) => a.join(""),
        d: () => () => FAKE_HASH,
        e: () => (obj: any, path: string, dflt: any) => {
            try { return path.split(".").reduce((o: any, p: string) => o?.[p], obj) ?? dflt; }
            catch { return dflt; }
        },
        u: () => FAKE_HASH,
        i: { A: { getters: { "auth/authUserId": 42 } } },
    };

    const ctx = vm.createContext(sandbox);

    // Install hooked String.prototype.charCodeAt that logs reads on FAKE_HASH
    const installHook = `
        (function() {
            const origCharCodeAt = String.prototype.charCodeAt;
            String.prototype.charCodeAt = function(idx) {
                if (this.valueOf() === ${JSON.stringify(FAKE_HASH)}) {
                    globalThis.__touched.push(idx);
                }
                return origCharCodeAt.call(this, idx);
            };
        })();
    `;

    sandbox.globalThis = sandbox;
    sandbox.__touched = touchedIndexes;

    try {
        vm.runInContext(installHook, ctx);
    } catch (e: any) {
        console.error("[runtime] hook install failed:", e?.message);
        return;
    }

    // Load all helper code (operator maps, decrypt wrappers, etc.)
    // Wrap in try so partial failures don't kill everything.
    try {
        vm.runInContext(auxSource, ctx);
    } catch (e: any) {
        // Aux load is best-effort; many parts may fail and that's okay
        // as long as the operator map + decrypt wrappers get through.
        console.error("[runtime] aux load (partial) warning:", e?.message?.slice(0, 120));
    }

    // Now call the checksum function with FAKE_HASH
    let result: any;
    try {
        const invoker = `(${funcSource})(${JSON.stringify(FAKE_HASH)})`;
        result = vm.runInContext(invoker, ctx);
    } catch (e: any) {
        console.error("[runtime] checksum invocation failed:", e?.message);
        return;
    }

    if (typeof result !== "string" && typeof result !== "number") {
        console.error("[runtime] checksum returned non-string/number:", typeof result, result);
        return;
    }

    // Back-solve constant:
    //   result (hex) = Math.floor(SUM(W[idx_i].charCodeAt(0) + const_i))
    //   We know: all charCodes (from FAKE_HASH + touchedIndexes)
    //   We know: result as a number
    //   constant = result - sum_of_charcodes
    const decimal = typeof result === "number"
        ? result
        : parseInt(String(result), 16);
    if (Number.isNaN(decimal)) {
        console.error("[runtime] checksum result not parseable as hex:", result);
        return;
    }

    const sumOfCharCodes = touchedIndexes.reduce(
        (acc, idx) => acc + FAKE_HASH.charCodeAt(idx % FAKE_HASH.length),
        0,
    );
    const checksum_constant = decimal - sumOfCharCodes;

    // Normalize indexes to be in [0, 40)
    const checksum_indexes = touchedIndexes.map(i => ((i % 40) + 40) % 40);

    return { checksum_indexes, checksum_constant };
}

function getRules(ast: t.Node, appToken: string): DynamicRules | undefined {
    let staticParam: string | undefined;
    let prefix: string | undefined;
    let suffix: string | undefined;

    // Stage 1: pull prefix / suffix / static_param via AST patterns
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

    if (!prefix || !suffix || !staticParam) {
        console.error(
            "[dynamic_rules] Stage 1 failed.\n" +
            "  prefix       = " + prefix + "\n" +
            "  suffix       = " + suffix + "\n" +
            "  static_param = " + staticParam + "\n" +
            "OF script structure changed beyond basic .join() patterns."
        );
        return undefined;
    }

    console.error("[dynamic_rules] Stage 1 OK: prefix=" + prefix + " suffix=" + suffix);

    // Stage 2: run the checksum function to back-solve indexes + constant
    const funcSource = findChecksumFunctionSource(ast);
    if (!funcSource) {
        console.error("[dynamic_rules] Stage 2: checksum function not found");
        return undefined;
    }
    console.error("[dynamic_rules] Stage 2: checksum func found (" + funcSource.length + " chars)");

    const auxSource = extractAuxSource(ast);
    console.error("[dynamic_rules] Stage 2: aux source (" + auxSource.length + " chars)");

    const rt = runChecksumFunction(funcSource, auxSource);
    if (!rt) {
        console.error("[dynamic_rules] Stage 2 failed: could not execute checksum");
        // Return partial rules — still useful even without checksum
        return {
            end: suffix,
            start: prefix,
            format: prefix + ":{}:{:x}:" + suffix,
            prefix,
            suffix,
            static_param: staticParam,
            app_token: appToken,
            remove_headers: ["user_id"],
            checksum_indexes: [],
            checksum_constant: 0,
        };
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
        app_token: appToken,
        remove_headers: ["user_id"],
        checksum_indexes: rt.checksum_indexes,
        checksum_constant: rt.checksum_constant,
    };
}

const ast = parser.parse(readFileSync(process.argv[2], "utf8"));
const appToken = process.argv[3] || "";
const rules = getRules(ast, appToken);
if (!rules) process.exit(1);
console.log(JSON.stringify(rules));
