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

function runChecksumFunction(deobfSource: string): RuntimeResult | undefined {
    const sandbox: any = {};
    const ctx = vm.createContext(sandbox);

    // KEY IDEA: Use a custom String SUBCLASS for the fake hash, and only hook
    // charCodeAt on instances of that subclass. This is 100% reliable —
    // no valueOf() comparisons, no race conditions with Sentry or whatever.
    //
    // Also: we hand the OF sign function our tagged hash directly via a
    // custom SHA-1 stub, so the instance identity is preserved.
    const bootstrap = `
        var __touched = [];
        var __FAKE_HASH = ${JSON.stringify(FAKE_HASH)};

        // Create a tagged String subclass. Instances are String objects but
        // carry a marker we can check in the charCodeAt hook.
        function TaggedHash(s) {
            var obj = Object.assign(Object(s), { __of_tagged: true });
            return obj;
        }

        // Hook charCodeAt to record index reads on tagged instances only
        var __origCharCodeAt = String.prototype.charCodeAt;
        String.prototype.charCodeAt = function(idx) {
            if (this && this.__of_tagged === true) {
                __touched.push(idx);
            }
            return __origCharCodeAt.call(this, idx);
        };

        // We also need to handle the case where the script does W.length on
        // our tagged hash — it should return 40, not undefined.
        // (String objects already have .length, so this works automatically.)

        // Browser-like globals
        var window = { navigator: { userAgent: "Mozilla/5.0" } };
        var global = globalThis;

        // Webpack chunk collector
        var __registeredModules = [];
        var self = {
            webpackChunkof_vue: {
                push: function(chunk) {
                    var moduleMap = chunk[1];
                    for (var id in moduleMap) {
                        __registeredModules.push({ id: Number(id), fn: moduleMap[id] });
                    }
                }
            }
        };

        // Fake webpack require
        function __fakeRequire(id) {
            switch (id) {
                case 89668:
                    // SHA-1 library: default export = function returning our TAGGED hash
                    return function() { return TaggedHash(__FAKE_HASH); };
                case 944114:
                    return function() { return ""; };
                case 858156:
                    return function(obj, path, dflt) {
                        try {
                            return path.split(".").reduce(function(o, p) {
                                return o == null ? undefined : o[p];
                            }, obj) || dflt;
                        } catch(e) { return dflt; }
                    };
                case 441153:
                    return { A: { getters: { "auth/authUserId": 42 } } };
                default:
                    return {};
            }
        }
        __fakeRequire.n = function(mod) {
            if (typeof mod === "function") return function() { return mod; };
            if (mod && typeof mod.A === "function") return function() { return mod.A; };
            return function() { return mod; };
        };

        // Load OF deobfuscated script
        var __scriptLoadError = null;
        try {
            ${deobfSource}
        } catch(e) {
            __scriptLoadError = e.message;
        }

        // Invoke the registered module
        var __signResult = null;
        var __invokeError = null;
        if (__registeredModules.length > 0) {
            var __mod = __registeredModules[__registeredModules.length - 1];
            var __nsObj = {};
            try {
                __mod.fn({}, __nsObj, __fakeRequire);
            } catch(e) {
                __invokeError = "module fn threw: " + e.message;
            }

            if (typeof __nsObj.A === "function") {
                // Reset the hook buffer for clean capture
                __touched.length = 0;
                try {
                    __signResult = __nsObj.A({ url: "/api2/v2/users/me" });
                } catch(e) {
                    __invokeError = "sign call threw: " + e.message;
                }
            } else if (!__invokeError) {
                __invokeError = "no n.A function (keys: " + Object.keys(__nsObj).join(",") + ")";
            }
        } else {
            __invokeError = "no modules registered";
        }

        globalThis.__result = {
            touched: __touched.slice(),
            signResult: __signResult,
            invokeError: __invokeError,
            scriptLoadError: __scriptLoadError,
            moduleCount: __registeredModules.length,
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

    if (result.scriptLoadError) {
        console.error("[runtime] script load error:", result.scriptLoadError.slice(0, 200));
    }
    console.error("[runtime] modules registered:", result.moduleCount);

    if (result.invokeError) {
        console.error("[runtime] invoke error:", result.invokeError.slice(0, 300));
        return;
    }

    const signResult = result.signResult;
    if (!signResult || typeof signResult.sign !== "string") {
        console.error("[runtime] unexpected sign result:", signResult);
        return;
    }

    const signParts = signResult.sign.split(":");
    if (signParts.length !== 4) {
        console.error("[runtime] unexpected sign format (parts=" + signParts.length + "):", signResult.sign);
        return;
    }

    const checksumHex = signParts[2];
    const checksumDecimal = parseInt(checksumHex, 16);
    if (Number.isNaN(checksumDecimal)) {
        console.error("[runtime] checksum not parseable as hex:", checksumHex);
        return;
    }

    const touchedIndexes: number[] = result.touched;
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

function getRules(deobfSource: string, ast: t.Node, appToken: string): DynamicRules | undefined {
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

    const rt = runChecksumFunction(deobfSource);

    if (!rt) {
        console.error("[dynamic_rules] Stage 2 failed — aborting (not emitting partial rules)");
        // IMPORTANT: if we can't get checksum, fail hard — a rules.json with empty
        // indexes and constant=2016 is WORSE than no update at all. Better to
        // retry on the next run than to commit garbage.
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
