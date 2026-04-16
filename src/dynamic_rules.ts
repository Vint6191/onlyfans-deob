import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { readFileSync } from "fs";

interface DynamicRules {
    end: string
    start: string
    format: string
    prefix: string
    suffix: string
    static_param: string
    remove_headers: string[]
    checksum_indexes: number[]
    checksum_constant: number
}

/**
 * Extracts checksum_indexes and checksum_constant by traversing ONLY
 * the checksum function node — not the whole file.
 *
 * Pattern inside the function:
 *   W[37618 % W.length].charCodeAt(0) + 74
 *   W[37281 % W.length].charCodeAt(0) - 76
 *   ...
 */
function extractChecksumFromNode(
    funcNode: t.FunctionExpression | t.ArrowFunctionExpression,
    checksumIndexes: number[],
    checksumConstantRef: { value: number }
) {
    // Wrap in a minimal File/Program so traverse() works on it standalone
    traverse(
        t.file(t.program([t.expressionStatement(funcNode)])),
        {
            BinaryExpression(path) {
                const node = path.node;

                // W[37618 % W.length] → left=37618 (NumericLiteral), op="%"
                if (node.operator === "%" && t.isNumericLiteral(node.left)) {
                    checksumIndexes.push((node.left as t.NumericLiteral).value % 40);
                }

                // .charCodeAt(0) + 74  or  .charCodeAt(0) - 76
                // → right side is a plain NumericLiteral
                if (t.isNumericLiteral(node.right)) {
                    const val = (node.right as t.NumericLiteral).value;
                    if (node.operator === "+") checksumConstantRef.value += val;
                    else if (node.operator === "-") checksumConstantRef.value -= val;
                }
            },
        }
    );
}

function getRules(ast: t.Node): DynamicRules | undefined {
    let staticParam: string | undefined;
    let prefix: string | undefined;
    let suffix: string | undefined;
    const checksumIndexes: number[] = [];
    const checksumConstantRef = { value: 0 };

    traverse(ast, {
        /**
         * We anchor on two specific .join() calls that are unique to OF signing:
         *
         *  A) Hash-input array — joined with "\n":
         *       [static_param_32chars, c.time, url, userId].join("\n")
         *
         *  B) Sign array — joined with ":":
         *       [prefix, hash, checksumFn(hash), suffix].join(":")
         *
         * Anchoring on .join() prevents us from accidentally matching
         * the webpack chunk-ID array ([2313] or [2] etc.) that the old
         * generic ArrayExpression visitor was picking up as the prefix.
         */
        CallExpression(path) {
            const node = path.node;

            // Must be  <something>.join(<string>)
            if (!t.isMemberExpression(node.callee)) return;
            const { object, property } = node.callee;
            if (!t.isIdentifier(property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0])) return;

            const joinChar = (node.arguments[0] as t.StringLiteral).value;

            // ── A) Hash-input array: .join("\n") ─────────────────────────────
            if (joinChar === "\n" && t.isArrayExpression(object)) {
                const first = object.elements[0];
                // static_param is always the first element, always 32 chars
                if (t.isStringLiteral(first) && first.value.length === 32) {
                    staticParam = first.value;
                }
                return;
            }

            // ── B) Sign array: .join(":") ────────────────────────────────────
            if (joinChar === ":" && t.isArrayExpression(object)) {
                const elems = object.elements;
                if (elems.length < 4) return;

                const firstElem = elems[0];
                const lastElem  = elems[elems.length - 1];

                // Prefix — first element.
                // Can be a StringLiteral "120563" OR a NumericLiteral 120563
                // depending on the OF script version. Either way must be numeric-valued.
                if (t.isStringLiteral(firstElem) && !isNaN(Number(firstElem.value))) {
                    prefix = firstElem.value;
                } else if (t.isNumericLiteral(firstElem)) {
                    prefix = String((firstElem as t.NumericLiteral).value);
                }

                // Suffix — last element, always an 8-char lowercase hex string.
                if (
                    t.isStringLiteral(lastElem) &&
                    /^[0-9a-f]+$/i.test(lastElem.value) &&
                    lastElem.value.length > 0
                ) {
                    suffix = lastElem.value;
                }

                // Checksum function — look for an immediately-invoked FunctionExpression
                // or ArrowFunctionExpression among the array elements (usually index 2).
                for (const elem of elems) {
                    if (!elem || !t.isCallExpression(elem)) continue;
                    const callee = elem.callee;
                    if (
                        t.isFunctionExpression(callee) ||
                        t.isArrowFunctionExpression(callee)
                    ) {
                        extractChecksumFromNode(
                            callee as t.FunctionExpression | t.ArrowFunctionExpression,
                            checksumIndexes,
                            checksumConstantRef
                        );
                        break; // only one checksum function expected
                    }
                }
            }
        },
    });

    if (!prefix || !suffix || !staticParam) {
        console.error(
            `[dynamic_rules] Targeted search failed.\n` +
            `  prefix      = ${prefix}\n` +
            `  suffix      = ${suffix}\n` +
            `  static_param= ${staticParam}\n` +
            `The OF script structure may have changed — please update dynamic_rules.ts.`
        );
        return undefined;
    }

    return {
        end:    suffix,
        start:  prefix,
        format: `${prefix}:{}:{:x}:${suffix}`,
        prefix,
        suffix,
        static_param: staticParam,
        remove_headers:    ["user_id"],
        checksum_indexes:  checksumIndexes,
        checksum_constant: checksumConstantRef.value,
    };
}

const ast   = parser.parse(readFileSync(process.argv[2], "utf8"));
const rules = getRules(ast);
if (!rules) process.exit(1);

console.log(JSON.stringify(rules));