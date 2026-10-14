import type * as MonacoTypes from "monaco-editor";

/**
 * The symbol tree behind the breadcrumbs. Monaco's outline gathers every
 * document-symbol provider for the file: the language server's (Sable
 * registers one per LSP language, hierarchical — lib/lsp/navigation.ts)
 * and Monaco's own for TS/JS/CSS/JSON/HTML. A language with neither gets
 * no symbols, and the breadcrumbs show just the path.
 */

export interface SymbolNode {
  name: string;
  detail: string;
  /** Monaco's SymbolKind (0-based: 4 class, 5 method, 11 function, 12 variable…). */
  kind: number;
  range: MonacoTypes.IRange;
  selectionRange: MonacoTypes.IRange;
  children: SymbolNode[];
}

/** The symbols of an editor's model, as a tree (empty if nothing provides them). */
export async function documentSymbolTree(editor: MonacoTypes.editor.ICodeEditor): Promise<SymbolNode[]> {
  const model = editor.getModel();
  // The outline command lives on the editor's command service (not in Monaco's public API).
  const commands = (editor as unknown as { _commandService?: { executeCommand(id: string, ...args: unknown[]): Promise<unknown> } })
    ._commandService;
  if (!model || !commands) return [];
  const symbols = (await commands.executeCommand("_executeDocumentSymbolProvider", model.uri).catch(() => null)) as
    | MonacoTypes.languages.DocumentSymbol[]
    | null;
  const convert = (symbol: MonacoTypes.languages.DocumentSymbol): SymbolNode => ({
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
    children: nestByRange((symbol.children ?? []).map(convert)),
  });
  return nestByRange((symbols ?? []).map(convert));
}

const startsBefore = (a: MonacoTypes.IRange, b: MonacoTypes.IRange) =>
  a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn;
const endsAfter = (a: MonacoTypes.IRange, b: MonacoTypes.IRange) => b.endLineNumber - a.endLineNumber || b.endColumn - a.endColumn;

function containsRange(outer: MonacoTypes.IRange, inner: MonacoTypes.IRange): boolean {
  return startsBefore(outer, inner) <= 0 && endsAfter(outer, inner) <= 0;
}

/**
 * Siblings in position order — and, for providers that list symbols flat
 * (Monaco's HTML outline: html, body, div… all at the top), nested by
 * which range contains which, so the path at the cursor is html › body › div.
 */
export function nestByRange(nodes: SymbolNode[]): SymbolNode[] {
  const sorted = [...nodes].sort((a, b) => startsBefore(a.range, b.range) || endsAfter(a.range, b.range));
  const roots: SymbolNode[] = [];
  const stack: SymbolNode[] = [];
  for (const node of sorted) {
    while (stack.length && !containsRange(stack[stack.length - 1].range, node.range)) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children = nestByRange([...parent.children, node]);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function containsPosition(range: MonacoTypes.IRange, position: MonacoTypes.IPosition): boolean {
  if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) return false;
  if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) return false;
  if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) return false;
  return true;
}

/** The chain of symbols around a position, outermost first (`App › render › handleClick`). */
export function symbolPathAt(tree: SymbolNode[], position: MonacoTypes.IPosition): SymbolNode[] {
  const path: SymbolNode[] = [];
  let level = tree;
  for (;;) {
    const inside = level.find((node) => containsPosition(node.range, position));
    if (!inside) return path;
    path.push(inside);
    level = inside.children;
  }
}

/** The symbols beside the one at `depth` in a path (its parent's children, or the top level). */
export function siblingsAt(tree: SymbolNode[], path: SymbolNode[], depth: number): SymbolNode[] {
  return depth === 0 ? tree : path[depth - 1].children;
}
