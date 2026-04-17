import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { readFileSync } from "fs";

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

function extractChecksumFromNode(
    funcNode: t.FunctionExpression | t.ArrowFunctionExpression,
    checksumIndexes: number[],
    checksumConstantRef: { value: number }
) {
    traverse(
        t.file(t.program([t.expressionStatement(funcNode)])),
        {
            BinaryExpression(path) {
                const node = path.node;

                if (node.operator === "%" && t.isNumericLiteral(node.left)) {
                    checksumIndexes.push((node.left as t.NumericLiteral).value % 40);
                }

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
        CallExpression(path) {
            const node = path.node;

            if (!t.isMemberExpression(node.callee)) return;
            const { object, property } = node.callee;
            if (!t.isIdentifier(property, { name: "join" })) return;
            if (node.arguments.length !== 1) return;
            if (!t.isStringLiteral(node.arguments[0])) return;

            const joinChar = (node.arguments[0] as t.StringLiteral).value;

            if (joinChar === "\n" && t.isArrayExpression(object)) {
                const first = object.elements[0];
                if (t.isStringLiteral(first) && first.value.length === 32) {
                    staticParam = first.value;
                }
                return;
            }

            if (joinChar === ":" && t.isArrayExpression(object)) {
                const elems = object.elements;
                if (elems.length < 4) return;

                const firstElem = elems[0];
                const lastElem  = elems[elems.length - 1];

                if (t.isStringLiteral(firstElem) && !isNaN(Number(firstElem.value))) {
                    prefix = firstElem.value;
                } else if (t.isNumericLiteral(firstElem)) {
                    prefix = String((firstElem as t.NumericLiteral).value);
                }

                if (
                    t.isStringLiteral(lastElem) &&
                    /^[0-9a-f]+$/i.test(lastElem.value) &&
                    lastElem.value.length > 0
                ) {
                    suffix = lastElem.value;
                }

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
                        break;
                    }
                }
            }
        },
    });

    if (!prefix || !suffix || !staticParam) {
        console.error(
            "[dynamic_rules] Targeted search failed.\n" +
            "  prefix      = " + prefix + "\n" +
            "  suffix      = " + suffix + "\n" +
            "  static_param= " + staticParam + "\n" +
            "The OF script structure may have changed - please update dynamic_rules.ts."
        );
        return undefined;
    }

    return {
        end:    suffix,
        start:  prefix,
        format: prefix + ":{}:{:x}:" + suffix,
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
