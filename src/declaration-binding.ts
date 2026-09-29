import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

/**
 * Capture references to the DECLARATION, never to a same-named parameter.
 *
 * For `function n(W, n) { return base(W, n); }`, path.scope is the
 * function's own scope: getBinding("n") there returns the PARAMETER.
 * The function declaration itself belongs to its parent/declaring scope.
 * A VariableDeclarator already has that declaring scope as path.scope.
 * Capture node identities before removal, while Babel can still resolve them.
 */
export function captureDeclarationReferences(
  path: NodePath,
  name: string,
  target: WeakSet<t.Identifier>,
): number {
  if (!path.isFunctionDeclaration() && !path.isVariableDeclarator()) {
    throw new Error(`Unsupported decoder declaration: ${path.node.type}`);
  }
  const identifier = path.node.id;
  if (!identifier || identifier.type !== "Identifier" || identifier.name !== name) {
    throw new Error(`Decoder declaration identifier mismatch: ${name}`);
  }

  const declaringScope = path.isFunctionDeclaration() ? path.parentPath?.scope : path.scope;
  const binding = declaringScope?.getBinding(name);
  if (!binding || binding.identifier !== identifier || binding.path.node !== path.node) {
    throw new Error(`Cannot resolve original decoder declaration binding: ${name}`);
  }

  let captured = 0;
  for (const reference of binding.referencePaths) {
    if (!reference.isIdentifier({ name })) continue;
    target.add(reference.node);
    captured++;
  }
  return captured;
}
