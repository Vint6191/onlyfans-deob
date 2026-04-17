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
    app_token: string;
    remove_headers: string[];
    checksum_indexes: number[];
    checksum_constant: number;
}

// Exactly 40 chars (length of SHA-1 hex output)
const FAKE_HASH = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
if (FAKE_HASH.length !== 40) {
    throw new Error("FAKE_HASH must be 40 chars (got " + FAKE_HASH.length + ")");
}

function findChecksumFunctionSource(ast: t.Node): string | undefined {
    let source: string | undefined;

    traverse(ast, {
        CallExpression(path) {
            if (source) return;
            const node = path.node;
            if (!t.isMemberExpression(node.callee)) return;
            if (!t.isIdentifier(node.callee.property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0])) return;
            if ((node.arguments[0] as t.StringLiteral).value !== ":") return;
            if (!t.isArrayExpression(node.callee.object)) return;

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

function extractAuxSource(ast: t.Node): string {
    if (!t.isFile(ast) && !t.isProgram(ast)) return "";
    const program = t.isFile(ast) ? ast.program : ast;
    const out: string[] = [];

    for (const stmt of program.body) {
        if (t.isFunctionDeclaration(stmt) || t.isVariableDeclaration(stmt)) {
            out.push(generate(stmt).code);
        }
    }

    traverse(ast, {
        FunctionExpression(path) {
            if (path.node.params.length !== 3) return;
            let hasJoin = false;
            path.traverse({
                Identifier(p) {
                    if (p.node.name === "join") hasJoin = true;
                },
            });
            if (!hasJoin) return;

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

    try {
        vm.runInContext(auxSource, ctx);
    } catch (e: any) {
        console.error("[runtime] aux load (partial) warning:", e?.message?.slice(0, 200));
    }

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

    const checksum_indexes = touchedIndexes.map(i => ((i % 40) + 40) % 40);

    return { checksum_indexes, checksum_constant };
}

function getRules(ast: t.Node, appToken: string): DynamicRules | undefined {
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
