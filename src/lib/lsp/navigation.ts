import type * as MonacoTypes from "monaco-editor";
import { getModelValue, pathFromUri } from "../editorRegistry";
import { readFile } from "../ipc";
import {
  capabilitiesOf,
  changeDocument,
  connectedServers,
  extensionForServer,
  extensionOf,
  pathToUri,
  sendRequest,
  serverIdFor,
  uriToPath,
} from "./lspClient";

/**
 * Code navigation over LSP: Find Usages, Go to Implementation / Type
 * Definition, File Structure (document symbols), Go to Symbol (workspace
 * symbols), Call Hierarchy, occurrence highlights and inlay hints.
 *
 * The plain functions feed Sable's own UI (the Usages and Call Hierarchy
 * panels, the symbol popups); registerNavigationProviders also plugs
 * them into Monaco's built-in features (peek references ⇧F12, the
 * context menu's Go to…, quick outline ⇧⌘O, highlights, inlay hints).
 */

type Monaco = typeof MonacoTypes;

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = { targetUri: string; targetRange: LspRange; targetSelectionRange: LspRange };

/** A place in a file, 1-based like Monaco. */
export interface NavLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

function toNavLocation(path: string, range: LspRange): NavLocation {
  return {
    path,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function lspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** The server must see the latest text before answering. */
async function syncedRequest(
  path: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const text = getModelValue(path);
  if (text !== null) await changeDocument(path, text);
  return sendRequest(extensionOf(path), method, { textDocument: { uri: pathToUri(path) }, ...params }, timeoutMs);
}

/** Whether the file's running server supports a capability. */
export function serverSupports(path: string, capability: string): boolean {
  const serverId = serverIdFor(path);
  return Boolean(serverId && capabilitiesOf(serverId)?.[capability]);
}

function locationsOf(response: unknown): NavLocation[] {
  if (!response) return [];
  const items = (Array.isArray(response) ? response : [response]) as (LspLocation | LspLocationLink)[];
  return items.map((item) =>
    "targetUri" in item
      ? toNavLocation(uriToPath(item.targetUri), item.targetSelectionRange)
      : toNavLocation(uriToPath(item.uri), item.range),
  );
}

/** Every use of the symbol at a position, including its declaration. */
export async function findUsages(path: string, position: { lineNumber: number; column: number }): Promise<NavLocation[]> {
  const response = await syncedRequest(
    path,
    "textDocument/references",
    { position: lspPosition(position), context: { includeDeclaration: true } },
    15_000,
  );
  return sortLocations(locationsOf(response));
}

/** textDocument/implementation or textDocument/typeDefinition. */
export async function goToLocations(
  method: "textDocument/implementation" | "textDocument/typeDefinition",
  path: string,
  position: { lineNumber: number; column: number },
): Promise<NavLocation[]> {
  return locationsOf(await syncedRequest(path, method, { position: lspPosition(position) }));
}

export function sortLocations(locations: NavLocation[]): NavLocation[] {
  return [...locations].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
}

// --- Line previews -------------------------------------------------------------

/** The text of each line a set of locations points at (open buffers first,
 *  then disk), for result lists. */
export async function linePreviews(locations: NavLocation[]): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  for (const path of new Set(locations.map((location) => location.path))) {
    const text = getModelValue(path) ?? (await readFile(path).catch(() => ""));
    files.set(path, text.split("\n"));
  }
  return files;
}

// --- Symbols -----------------------------------------------------------------------

/** LSP SymbolKind (1–26). */
export const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property",
  8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable",
  14: "constant", 15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key",
  21: "null", 22: "enum member", 23: "struct", 24: "event", 25: "operator", 26: "type parameter",
};

export interface SymbolEntry {
  name: string;
  /** Signature or type, when the server gives one. */
  detail?: string;
  kind: number;
  path: string;
  line: number;
  column: number;
  /** Enclosing symbol (class for a method, …). */
  container?: string;
  /** Nesting depth in the file (File Structure indents by it). */
  depth: number;
}

interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range?: LspRange };
  containerName?: string;
}

/** The symbols of one file, flattened in order with their depth. */
export async function documentSymbols(path: string): Promise<SymbolEntry[]> {
  const response = (await syncedRequest(path, "textDocument/documentSymbol", {})) as
    | LspDocumentSymbol[]
    | LspSymbolInformation[]
    | null;
  return flattenDocumentSymbols(path, response ?? []);
}

export function flattenDocumentSymbols(
  path: string,
  symbols: LspDocumentSymbol[] | LspSymbolInformation[],
): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  const visit = (symbol: LspDocumentSymbol, depth: number, container?: string) => {
    out.push({
      name: symbol.name,
      detail: symbol.detail || undefined,
      kind: symbol.kind,
      path,
      line: symbol.selectionRange.start.line + 1,
      column: symbol.selectionRange.start.character + 1,
      container,
      depth,
    });
    for (const child of symbol.children ?? []) visit(child, depth + 1, symbol.name);
  };
  for (const symbol of symbols) {
    if ("location" in symbol) {
      const range = symbol.location.range;
      out.push({
        name: symbol.name,
        kind: symbol.kind,
        path,
        line: (range?.start.line ?? 0) + 1,
        column: (range?.start.character ?? 0) + 1,
        container: symbol.containerName || undefined,
        depth: symbol.containerName ? 1 : 0,
      });
    } else {
      visit(symbol, 0);
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Symbols across the project matching `query`, from every running server
 * that supports workspace symbols. With `root`, only the project's own
 * symbols — like JetBrains, which leaves out libraries by default — unless
 * nothing in the project matches.
 */
export async function workspaceSymbols(query: string, root?: string | null): Promise<SymbolEntry[]> {
  const all = await allWorkspaceSymbols(query);
  if (!root) return all;
  const inProject = all.filter((symbol) => symbol.path.startsWith(root));
  return inProject.length > 0 ? inProject : all;
}

async function allWorkspaceSymbols(query: string): Promise<SymbolEntry[]> {
  const servers = connectedServers().filter((serverId) => capabilitiesOf(serverId)?.workspaceSymbolProvider);
  const results = await Promise.all(
    servers.map(async (serverId) => {
      const extension = extensionForServer(serverId);
      if (!extension) return [];
      const response = (await sendRequest(extension, "workspace/symbol", { query }, 8000)) as
        | LspSymbolInformation[]
        | null;
      return (response ?? []).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        path: uriToPath(symbol.location.uri),
        line: (symbol.location.range?.start.line ?? 0) + 1,
        column: (symbol.location.range?.start.character ?? 0) + 1,
        container: symbol.containerName || undefined,
        depth: 0,
      }));
    }),
  );
  // The same symbol can come from two servers (e.g. a header via clangd).
  const seen = new Set<string>();
  return results.flat().filter((symbol) => {
    const key = `${symbol.path}:${symbol.line}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Call hierarchy ---------------------------------------------------------------

export interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  path: string;
  line: number;
  column: number;
  /** The server's own item, sent back to expand it. */
  raw: unknown;
}

interface LspCallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

function toCallItem(item: LspCallHierarchyItem): CallHierarchyItem {
  return {
    name: item.name,
    kind: item.kind,
    detail: item.detail || undefined,
    path: uriToPath(item.uri),
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
    raw: item,
  };
}

/** The function at a position, as a call hierarchy root. */
export async function prepareCallHierarchy(
  path: string,
  position: { lineNumber: number; column: number },
): Promise<CallHierarchyItem[]> {
  const response = (await syncedRequest(path, "textDocument/prepareCallHierarchy", {
    position: lspPosition(position),
  })) as LspCallHierarchyItem[] | null;
  return (response ?? []).map(toCallItem);
}

/** Callers ("incoming") or callees ("outgoing") of an item. */
export async function callHierarchyCalls(
  item: CallHierarchyItem,
  direction: "incoming" | "outgoing",
): Promise<CallHierarchyItem[]> {
  const response = (await sendRequest(
    extensionOf(item.path),
    direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
    { item: item.raw },
    15_000,
  )) as ({ from: LspCallHierarchyItem } | { to: LspCallHierarchyItem })[] | null;
  // A function calling another twice is reported once per call; list it once.
  const seen = new Set<string>();
  return (response ?? [])
    .map((call) => toCallItem("from" in call ? call.from : call.to))
    .filter((item) => {
      const key = `${item.path}:${item.line}:${item.column}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// --- Monaco providers ----------------------------------------------------------------

interface LspInlayHint {
  position: LspPosition;
  label: string | { value: string; tooltip?: string | { value: string } }[];
  kind?: number;
  tooltip?: string | { value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export function registerNavigationProviders(
  monaco: Monaco,
  languages: readonly string[],
  ensureModel: (monaco: Monaco, path: string) => Promise<MonacoTypes.Uri>,
) {
  const toMonacoLocations = (locations: NavLocation[]) =>
    Promise.all(
      locations.map(async (location) => ({
        uri: await ensureModel(monaco, location.path),
        range: {
          startLineNumber: location.line,
          startColumn: location.column,
          endLineNumber: location.endLine,
          endColumn: location.endColumn,
        },
      })),
    );

  for (const language of languages) {
    monaco.languages.registerReferenceProvider(language, {
      provideReferences: async (model, position) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "referencesProvider")) return [];
        return toMonacoLocations(await findUsages(path, position));
      },
    });
    monaco.languages.registerImplementationProvider(language, {
      provideImplementation: async (model, position) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "implementationProvider")) return [];
        return toMonacoLocations(await goToLocations("textDocument/implementation", path, position));
      },
    });
    monaco.languages.registerTypeDefinitionProvider(language, {
      provideTypeDefinition: async (model, position) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "typeDefinitionProvider")) return [];
        return toMonacoLocations(await goToLocations("textDocument/typeDefinition", path, position));
      },
    });
    monaco.languages.registerDocumentHighlightProvider(language, {
      provideDocumentHighlights: async (model, position) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "documentHighlightProvider")) return null;
        const response = (await syncedRequest(path, "textDocument/documentHighlight", {
          position: lspPosition(position),
        })) as { range: LspRange; kind?: number }[] | null;
        return (response ?? []).map((highlight) => ({
          range: {
            startLineNumber: highlight.range.start.line + 1,
            startColumn: highlight.range.start.character + 1,
            endLineNumber: highlight.range.end.line + 1,
            endColumn: highlight.range.end.character + 1,
          },
          // LSP: 1 text, 2 read, 3 write — Monaco: 0, 1, 2.
          kind: (highlight.kind ?? 1) - 1,
        }));
      },
    });
    monaco.languages.registerDocumentSymbolProvider(language, {
      provideDocumentSymbols: async (model) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "documentSymbolProvider")) return [];
        const response = (await syncedRequest(path, "textDocument/documentSymbol", {})) as
          | LspDocumentSymbol[]
          | LspSymbolInformation[]
          | null;
        return toMonacoSymbols(response ?? []);
      },
    });
    monaco.languages.registerInlayHintsProvider(language, {
      provideInlayHints: async (model, range) => {
        const path = pathFromUri(model.uri);
        if (!serverSupports(path, "inlayHintProvider")) return { hints: [], dispose() {} };
        const response = (await syncedRequest(path, "textDocument/inlayHint", {
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
        })) as LspInlayHint[] | null;
        const tooltip = (value: LspInlayHint["tooltip"]) =>
          value === undefined ? undefined : typeof value === "string" ? value : { value: value.value };
        return {
          hints: (response ?? []).map((hint) => ({
            label:
              typeof hint.label === "string"
                ? hint.label
                : hint.label.map((part) => ({ label: part.value, tooltip: tooltip(part.tooltip) })),
            position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
            // LSP: 1 type, 2 parameter — Monaco: 1 Type, 2 Parameter.
            kind: hint.kind,
            tooltip: tooltip(hint.tooltip),
            paddingLeft: hint.paddingLeft,
            paddingRight: hint.paddingRight,
          })),
          dispose() {},
        };
      },
    });
  }
}

/** LSP document symbols → Monaco's (whose SymbolKind is LSP's minus one). */
function toMonacoSymbols(symbols: LspDocumentSymbol[] | LspSymbolInformation[]): MonacoTypes.languages.DocumentSymbol[] {
  const range = (lsp: LspRange) => ({
    startLineNumber: lsp.start.line + 1,
    startColumn: lsp.start.character + 1,
    endLineNumber: lsp.end.line + 1,
    endColumn: lsp.end.character + 1,
  });
  const convert = (symbol: LspDocumentSymbol): MonacoTypes.languages.DocumentSymbol => ({
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind - 1,
    tags: [],
    range: range(symbol.range),
    selectionRange: range(symbol.selectionRange),
    children: (symbol.children ?? []).map(convert),
  });
  return symbols.map((symbol) => {
    if (!("location" in symbol)) return convert(symbol);
    const where = symbol.location.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
      name: symbol.name,
      detail: "",
      kind: symbol.kind - 1,
      tags: [],
      containerName: symbol.containerName,
      range: range(where),
      selectionRange: range(where),
    };
  });
}
