import { capabilitiesOf, changeDocument, extensionOf, pathToUri, sendRequest, serverIdFor, uriToPath } from "../lsp/lspClient";
import { findUsages, serverSupports } from "../lsp/navigation";
import { getModelValue } from "../editorRegistry";
import { listWorkspaceFiles } from "../ipc";
import { applyTextEdits, type LspWorkspaceEdit } from "../lsp/workspaceEdit";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { currentText } from "./apply";
import { languageOf } from "./signature";
import { offsetAt, positionAt } from "./textScan";
import {
  TextFailure,
  declarationExtent,
  deleteDeclaration,
  parameterOf,
  readDeclaration,
  rewriteSignature,
  scanOptions,
  usageOf,
  type TextDeclaration,
  type TextLocation,
} from "./textEngine";
import type { PlannedFile, RefactoringPlan, Signature, SignatureLanguage, UsageItem } from "./types";

/**
 * Languages without a syntax tree here (Java, Go, Rust, C/C++, C#,
 * Kotlin, PHP, Ruby…): usages and definitions from the language server
 * (LSP references), declarations and calls rewritten as text
 * (textEngine.ts). Best effort, and labeled so.
 */

export { TEXT_ENGINE } from "./textEngine";

type Position = { lineNumber: number; column: number };

export function requireServer(path: string) {
  if (!serverSupports(path, "referencesProvider")) {
    throw new TextFailure(`This needs a running language server for .${extensionOf(path)} files (none answers here)`);
  }
}

/** Every reference (declaration included), as offsets, and each file's text. */
async function references(path: string, position: Position) {
  const found = await findUsages(path, position);
  const files = new Map<string, string>();
  for (const file of new Set([path, ...found.map((location) => location.path)])) {
    const text = await currentText(file);
    if (text !== null) files.set(file, text);
  }
  const locations: TextLocation[] = found.map((location) => {
    const text = files.get(location.path) ?? "";
    return { path: location.path, start: offsetAt(text, location.line, location.column), end: offsetAt(text, location.endLine, location.endColumn) };
  });
  return { locations, files };
}

/** Where the name at the cursor is declared (the server's definition). */
async function definition(path: string, position: Position): Promise<{ path: string; line: number; column: number }> {
  const text = getModelValue(path);
  if (text !== null) await changeDocument(path, text);
  const result = (await sendRequest(extensionOf(path), "textDocument/definition", {
    textDocument: { uri: pathToUri(path) },
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  })) as unknown;
  const first = (Array.isArray(result) ? result[0] : result) as
    | { uri?: string; range?: { start: { line: number; character: number } }; targetUri?: string; targetSelectionRange?: { start: { line: number; character: number } } }
    | null
    | undefined;
  const uri = first?.targetUri ?? first?.uri;
  const start = (first?.targetSelectionRange ?? first?.range)?.start;
  if (!uri || !start) return { path, line: position.lineNumber, column: position.column };
  return { path: uriToPath(uri), line: start.line + 1, column: start.character + 1 };
}

// --- Safe Delete ------------------------------------------------------------------------------

export async function genericUsages(path: string, position: Position) {
  requireServer(path);
  const declared = await definition(path, position);
  const { locations, files } = await references(declared.path, { lineNumber: declared.line, column: declared.column });
  const text = files.get(declared.path) ?? (await currentText(declared.path)) ?? "";
  const nameStart = offsetAt(text, declared.line, declared.column);
  const parameter = parameterOf(text, nameStart, scanOptions(declared.path));
  if (parameter) {
    // A parameter: its uses; deleting removes it and its arguments.
    const at = positionAt(text, parameter.functionAt);
    const declaration = await genericSignature(declared.path, { lineNumber: at.line, column: at.column });
    const removed = declaration.signature.params[parameter.index];
    return {
      what: `parameter ${removed?.name ?? ""}`.trim(),
      usages: locations
        .filter((location) => !(location.path === declared.path && location.start === nameStart))
        .map((location) => usageOf(location.path, files.get(location.path) ?? "", location.start, location.end)),
      plan: () =>
        genericChangeSignature(declaration, {
          ...declaration.signature,
          params: declaration.signature.params.filter((param) => param.original !== parameter.index),
        }),
    };
  }
  const extent = declarationExtent(text, nameStart, scanOptions(declared.path));
  const name = text.slice(nameStart).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? "this";
  return {
    what: name,
    usages: locations
      .filter((location) => !(location.path === declared.path && location.start >= extent.start && location.start < extent.end))
      .map((location) => usageOf(location.path, files.get(location.path) ?? "", location.start, location.end)),
    plan: async (): Promise<RefactoringPlan> => deleteDeclaration(declared.path, text, nameStart),
  };
}

// --- Change Signature ---------------------------------------------------------------------------

export async function genericSignature(path: string, position: Position): Promise<TextDeclaration> {
  requireServer(path);
  const declared = await definition(path, position);
  const text = (await currentText(declared.path)) ?? "";
  return readDeclaration(declared.path, text, offsetAt(text, declared.line, declared.column));
}

export async function genericChangeSignature(declaration: TextDeclaration, signature: Signature): Promise<RefactoringPlan> {
  const start = positionAt(declaration.text, declaration.nameStart);
  const { locations, files } = await references(declaration.path, { lineNumber: start.line, column: start.column });
  return rewriteSignature(declaration, signature, locations, files);
}

// --- Files -------------------------------------------------------------------------------------

/** The server's import updates for a file rename, if it offers them (`workspace/willRenameFiles`). */
export async function lspFileRenamePlan(from: string, to: string): Promise<RefactoringPlan | null> {
  const serverId = serverIdFor(from);
  if (!serverId || !capabilitiesOf(serverId)?.workspace?.fileOperations?.willRename) return null;
  const edit = (await sendRequest(extensionOf(from), "workspace/willRenameFiles", { files: [{ oldUri: pathToUri(from), newUri: pathToUri(to) }] }, 15_000)) as LspWorkspaceEdit | null;
  const perFile = new Map<string, Parameters<typeof applyTextEdits>[1]>();
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) perFile.set(uriToPath(uri), edits);
  for (const change of edit?.documentChanges ?? []) {
    if ("textDocument" in change) perFile.set(uriToPath(change.textDocument.uri), change.edits);
  }
  const files: PlannedFile[] = [];
  for (const [path, edits] of perFile) {
    const before = await currentText(path);
    if (before === null) continue;
    const after = applyTextEdits(before, edits);
    if (after !== before) files.push({ path, before, after });
  }
  return { title: `Move ${from.split(/[/\\]/).pop()}`, files, moves: [{ from, to }], conflicts: [], engine: "language server" };
}

const IMPORT_LINE = /^\s*(import|from|#\s*include|use|using|require|require_relative|mod|package|@import|load)\b/;

/** Files whose import lines name `path`'s file (a text search). */
export async function importersByText(path: string): Promise<UsageItem[]> {
  const name = path.split(/[/\\]/).pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, "");
  const language: SignatureLanguage = languageOf(path);
  const { folders, rootPath } = useWorkspaceStore.getState();
  const roots = folders.length > 0 ? folders : rootPath ? [rootPath] : [];
  const word = new RegExp(`(^|[^\\p{L}\\p{N}_$])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}_$]|$)`, "u");
  const usages: UsageItem[] = [];
  const all = (await Promise.all(roots.map((root) => listWorkspaceFiles(root).catch(() => [] as string[])))).flat();
  const candidates = all.filter((file) => file !== path && languageOf(file) === language && !/[/\\](node_modules|\.git|target|build|dist)[/\\]/.test(file)).slice(0, 3000);
  for (const file of candidates) {
    const text = await currentText(file);
    if (!text || !text.includes(stem)) continue;
    text.split("\n").forEach((line, index) => {
      if (IMPORT_LINE.test(line) && word.test(line)) {
        const column = line.indexOf(stem) + 1;
        usages.push({ path: file, line: index + 1, column, endColumn: column + stem.length, preview: line, kind: "import" });
      }
    });
  }
  return usages;
}
