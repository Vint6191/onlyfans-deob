import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
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

// 40-char deterministic hash stand-in (SHA-1 hex length)
const FAKE_HASH = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
if (FAKE_HASH.length !== 40) {
    throw new Error("FAKE_HASH must be 40 chars (got " + FAKE_HASH.length + ")");
}

/**
 * Extract prefix / suffix / static_param using stable AST patterns.
 */
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
 * Run the ENTIRE deobfuscated script in a sandbox, then invoke its sign
 * function with a synthetic request. Hooks on charCodeAt and join let us
 * back-solve the checksum parameters.
 */
function runChecksumFunction(deobfSource: string): RuntimeResult | undefined {
    const touchedIndexes: number[] = [];
    const joinResults: { sep: string; arr: any[] }[] = [];

    // Build sandbox with real globals
    const sandbox: any = {
        Math, Date, JSON, console,
        Array, Number, Boolean, Object, RegExp, String,
        Error, TypeError, RangeError,
        parseInt, parseFloat, isNaN, isFinite,
        decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    };

    // Fake browser globals
    sandbox.window = { navigator: { userAgent: "Mozilla/5.0" } };
    sandbox.globalThis = sandbox;

    // Webpack chunk collector — intercepts module registration
    const registeredModules: Array<{ id: number; fn: Function }> = [];
    sandbox.self = {
        webpackChunkof_vue: {
            push(chunk: any) {
                // chunk format: [[chunkIds], {moduleId: function(W,n,o){...}}]
                const moduleMap = chunk[1];
                for (const id of Object.keys(moduleMap)) {
                    registeredModules.push({ id: Number(id), fn: moduleMap[id] });
                }
            },
        },
    };

    sandbox.global = sandbox;
    sandbox.__touched = touchedIndexes;
    sandbox.__joins = joinResults;

    const ctx = vm.createContext(sandbox);

    // Install runtime hooks inside the VM
    const installHooks = `
        (function() {
            const origCharCodeAt = String.prototype.charCodeAt;
            String.prototype.charCodeAt = function(idx) {
                if (this.valueOf() === ${JSON.stringify(FAKE_HASH)}) {
                    globalThis.__touched.push(idx);
                }
                return origCharCodeAt.call(this, idx);
            };

            const origJoin = Array.prototype.join;
            Array.prototype.join = function(sep) {
                if (sep === "\\n" || sep === ":") {
                    globalThis.__joins.push({ sep: sep, arr: Array.from(this) });
                }
                return origJoin.call(this, sep);
            };
        })();
    `;

    try {
        vm.runInContext(installHooks, ctx);
    } catch (e: any) {
        console.error("[runtime] hook install failed:", e?.message);
        return;
    }

    // Load the entire deobfuscated script. This triggers webpackChunkof_vue.push(...)
    try {
        vm.runInContext(deobfSource, ctx);
    } catch (e: any) {
        console.error("[runtime] script load warning:", e?.message?.slice(0, 200));
        // Continue — the important part (module registration) may still have happened
    }

    if (!registeredModules.length) {
        console.error("[runtime] no modules registered via webpackChunkof_vue");
        return;
    }

    // Invoke the module with a fake webpack require
    const mod = registeredModules[registeredModules.length - 1];
    console.error("[runtime] invoking module id:", mod.id);

    const fakeRequire: any = (id: number) => {
        switch (id) {
            case 89668:  // SHA-1 library: default export = function that returns hash
                return function () { return FAKE_HASH; };
            case 944114: // Helper — return a permissive function
                return function () { return ""; };
            case 858156: // get(obj, path, default)
                return function (obj: any, path: string, dflt: any) {
                    try {
                        return path.split(".").reduce((o: any, p: string) => o?.[p], obj) ?? dflt;
                    } catch { return dflt; }
                };
            case 441153: // auth store
                return { A: { getters: { "auth/authUserId": 42 } } };
            default:
                return {};
        }
    };
    // webpack's `o.n` helper — returns a function that returns the module's default export
    fakeRequire.n = (mod: any) => {
        if (typeof mod === "function") return () => mod;
        if (mod && typeof mod.A === "function") return () => mod.A;
        return () => mod;
    };

    // Run the module function: function(W, n, o) { ...assigns n.A = ...; }
    const nsObj: any = {};
    try {
        mod.fn({}, nsObj, fakeRequire);
    } catch (e: any) {
        console.error("[runtime] module function threw:", e?.message?.slice(0, 200));
        return;
    }

    if (typeof nsObj.A !== "function") {
        console.error("[runtime] module did not export a sign function; keys:", Object.keys(nsObj));
        return;
    }

    // Clear hook buffers before the real call (we don't care about setup-time joins)
    touchedIndexes.length = 0;
    joinResults.length = 0;

    // Call the sign function with a synthetic request
    let signResult: any;
    try {
        signResult = nsObj.A({ url: "/api2/v2/users/me" });
    } catch (e: any) {
        console.error("[runtime] sign call threw:", e?.message?.slice(0, 200));
        return;
    }

    // signResult = { time: ..., sign: "prefix:hash:checksum:suffix" }
    if (!signResult || typeof signResult.sign !== "string") {
        console.error("[runtime] sign call returned unexpected value:", signResult);
        return;
    }

    const signParts = signResult.sign.split(":");
    if (signParts.length !== 4) {
        console.error("[runtime] unexpected sign format:", signResult.sign);
        return;
    }

    const checksumHex = signParts[2];
    const checksumDecimal = parseInt(checksumHex, 16);
    if (Number.isNaN(checksumDecimal)) {
        console.error("[runtime] checksum not parseable as hex:", checksumHex);
        return;
    }

    // Back-solve constant from: result = Σ(charCode[idx] + constantPart)
    // Sum all charCodes at touched indexes; constant = result - sum
    const sumOfCharCodes = touchedIndexes.reduce(
        (acc, idx) => acc + FAKE_HASH.charCodeAt(idx % FAKE_HASH.length),
        0,
    );
    const checksum_constant = checksumDecimal - sumOfCharCodes;
    const checksum_indexes = touchedIndexes.map(i => ((i % 40) + 40) % 40);

    console.error(
        "[runtime] captured: indexes.length=" + checksum_indexes.length +
        " sign=" + signResult.sign,
    );

    return { checksum_indexes, checksum_constant };
}

function getRules(deobfSource: string, ast: t.Node, appToken: string): DynamicRules | undefined {
    const { prefix, suffix, staticParam } = extractBasicFields(ast);

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

    const rt = runChecksumFunction(deobfSource);

    if (!rt) {
        console.error("[dynamic_rules] Stage 2 failed: returning partial rules");
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

const deobfSource = readFileSync(process.argv[2], "utf8");
const ast = parser.parse(deobfSource);
const appToken = process.argv[3] || "";
const rules = getRules(deobfSource, ast, appToken);
if (!rules) process.exit(1);
console.log(JSON.stringify(rules));
