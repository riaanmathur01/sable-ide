import type * as MonacoTypes from "monaco-editor";
import { readFile } from "../ipc";
import { pathFromUri } from "../editorRegistry";
import {
  capabilitiesOf,
  changeDocument,
  extensionOf,
  lspDiagnosticsFor,
  onServerConnection,
  pathToUri,
  sendRequest,
} from "./lspClient";
import { semanticTokenTypes, translateTokens, type ServerLegend } from "./semanticTokens";
import { registerRename } from "./rename";
import { registerNavigationProviders } from "./navigation";
import { DARCULA, DARK } from "../jetbrains/schemes.generated";
import { themeById } from "../themes";
import { currentThemeId, onThemeChange } from "../shikiMonaco";
import { applyWorkspaceEdit, type LspWorkspaceEdit } from "./workspaceEdit";
import { registerPythonQuickFixes } from "./pythonQuickFixes";
import { useAgentStore } from "../../store/agentStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { getSetting } from "../../store/settingsStore";

/**
 * Hand-wired Monaco language providers backed by the LSP relay. Each
 * provider turns a Monaco request into an LSP request through Rust,
 * awaits the response, and maps the result into Monaco's shape.
 *
 * Registered once from monacoSetup: completions, hover, go-to-definition
 * (⌘-click / F12), signature help (parameter hints while typing a call),
 * and quick fixes (the lightbulb / ⌘.) — the server's own fixes, plus
 * "Fix with Agent" for every error in any language.
 */

type Monaco = typeof MonacoTypes;

/** Minimal shape of an LSP CompletionItem (only the fields we use). */
interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
  textEdit?: { newText: string };
  /** Extra edits applied on accept — e.g. the import an auto-import adds. */
  additionalTextEdits?: { range: LspRange; newText: string }[];
}

/** A Monaco suggestion that remembers the LSP item it came from (for resolve). */
type LspSuggestion = MonacoTypes.languages.CompletionItem & {
  lspItem?: LspCompletionItem;
  extension?: string;
};

interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

/**
 * LSP CompletionItemKind (1–25) → Monaco's CompletionItemKind. The two
 * enums use different numeric values, so map by name.
 */
function lspKindToMonaco(
  monaco: Monaco,
  kind: number | undefined,
): MonacoTypes.languages.CompletionItemKind {
  const Kind = monaco.languages.CompletionItemKind;
  const byLspKind: Record<number, MonacoTypes.languages.CompletionItemKind> = {
    1: Kind.Text,
    2: Kind.Method,
    3: Kind.Function,
    4: Kind.Constructor,
    5: Kind.Field,
    6: Kind.Variable,
    7: Kind.Class,
    8: Kind.Interface,
    9: Kind.Module,
    10: Kind.Property,
    11: Kind.Unit,
    12: Kind.Value,
    13: Kind.Enum,
    14: Kind.Keyword,
    15: Kind.Snippet,
    16: Kind.Color,
    17: Kind.File,
    18: Kind.Reference,
    19: Kind.Folder,
    20: Kind.EnumMember,
    21: Kind.Constant,
    22: Kind.Struct,
    23: Kind.Event,
    24: Kind.Operator,
    25: Kind.TypeParameter,
  };
  return kind != null ? (byLspKind[kind] ?? Kind.Text) : Kind.Text;
}

/** LSP Hover contents can take several shapes; normalize to Monaco. */
type LspMarkedString = string | { language: string; value: string };
interface LspHover {
  contents:
    | { kind: string; value: string } // MarkupContent
    | LspMarkedString
    | LspMarkedString[];
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** One LSP hover content piece → a Monaco markdown string. */
function markedStringToMarkdown(
  content: LspMarkedString | { kind: string; value: string },
): { value: string } {
  if (typeof content === "string") return { value: content };
  // MarkupContent ({kind, value}) is already markdown/plaintext text.
  if ("kind" in content) return { value: content.value };
  // MarkedString ({language, value}) → a fenced code block.
  return { value: "```" + content.language + "\n" + content.value + "\n```" };
}

/** Monaco language ids backed by an LSP server (mirrors the Rust map). */
const LSP_LANGUAGES = ["python", "java", "rust", "go", "c", "cpp", "typescript", "javascript", "php", "ruby", "csharp", "kotlin"];

/** Monaco languages each server handles (for semantic highlighting). */
const LANGUAGES_BY_SERVER: Record<string, string[]> = {
  pyright: ["python"],
  java: ["java"],
  "rust-analyzer": ["rust"],
  gopls: ["go"],
  clangd: ["c", "cpp"],
  typescript: ["typescript", "javascript"],
  intelephense: ["php"],
  ruby: ["ruby"],
  csharp: ["csharp"],
  kotlin: ["kotlin"],
};

const APPLY_CODE_ACTION = "sable.lsp.applyCodeAction";
const EXECUTE_LSP_COMMAND = "sable.lsp.executeCommand";
const AGENT_PROBLEM = "sable.agent.problem";

async function provideHover(
  model: MonacoTypes.editor.ITextModel,
  position: MonacoTypes.Position,
): Promise<MonacoTypes.languages.Hover | null> {
  const path = pathFromUri(model.uri);
  await changeDocument(path, model.getValue());

  const hover = (await sendRequest(extensionOf(path), "textDocument/hover", {
    textDocument: { uri: pathToUri(path) },
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  })) as LspHover | null;

  if (!hover || !hover.contents) return null;
  const pieces = Array.isArray(hover.contents)
    ? hover.contents
    : [hover.contents];
  const contents = pieces
    .map(markedStringToMarkdown)
    .filter((piece) => piece.value.trim().length > 0);
  if (contents.length === 0) return null;

  const range = hover.range
    ? {
        startLineNumber: hover.range.start.line + 1,
        startColumn: hover.range.start.character + 1,
        endLineNumber: hover.range.end.line + 1,
        endColumn: hover.range.end.character + 1,
      }
    : undefined;
  return { contents, range };
}

async function provideCompletions(
  monaco: Monaco,
  model: MonacoTypes.editor.ITextModel,
  position: MonacoTypes.Position,
): Promise<MonacoTypes.languages.CompletionList> {
  const path = pathFromUri(model.uri);
  // Sync the buffer first so completion is against current text.
  await changeDocument(path, model.getValue());

  const response = (await sendRequest(
    extensionOf(path),
    "textDocument/completion",
    {
      textDocument: { uri: pathToUri(path) },
      position: {
        line: position.lineNumber - 1, // LSP is 0-based
        character: position.column - 1,
      },
    },
  )) as LspCompletionItem[] | LspCompletionList | null;

  if (!response) return { suggestions: [] };
  const items = Array.isArray(response) ? response : response.items;
  const isIncomplete = Array.isArray(response)
    ? false
    : (response.isIncomplete ?? false);

  const word = model.getWordUntilPosition(position);
  const range: MonacoTypes.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };

  const extension = extensionOf(path);
  const suggestions = items.map((item): LspSuggestion => {
    const insertText = item.insertText ?? item.textEdit?.newText ?? item.label;
    let documentation: string | { value: string } | undefined;
    if (typeof item.documentation === "string") {
      documentation = item.documentation;
    } else if (item.documentation?.value) {
      documentation = { value: item.documentation.value };
    }
    return {
      label: item.label,
      kind: lspKindToMonaco(monaco, item.kind),
      insertText,
      detail: item.detail,
      documentation,
      sortText: item.sortText,
      filterText: item.filterText,
      range,
      additionalTextEdits: item.additionalTextEdits?.map(toMonacoEdit),
      lspItem: item,
      extension,
    };
  });
  return { suggestions, incomplete: isIncomplete };
}

function toMonacoEdit(edit: { range: LspRange; newText: string }) {
  return { range: toMonacoRange(edit.range), text: edit.newText };
}

/**
 * Fill in details the server leaves for `completionItem/resolve` —
 * notably the import edit of an auto-import completion (TypeScript and
 * Pyright both defer it), plus full documentation.
 */
async function resolveCompletion(
  suggestion: LspSuggestion,
): Promise<MonacoTypes.languages.CompletionItem> {
  if (!suggestion.lspItem || !suggestion.extension) return suggestion;
  const resolved = (await sendRequest(
    suggestion.extension,
    "completionItem/resolve",
    suggestion.lspItem,
  )) as LspCompletionItem | null;
  if (!resolved) return suggestion;
  const documentation =
    typeof resolved.documentation === "string"
      ? resolved.documentation
      : resolved.documentation?.value
        ? { value: resolved.documentation.value }
        : suggestion.documentation;
  return {
    ...suggestion,
    detail: resolved.detail ?? suggestion.detail,
    documentation,
    additionalTextEdits:
      resolved.additionalTextEdits?.map(toMonacoEdit) ?? suggestion.additionalTextEdits,
  };
}

// --- Semantic highlighting --------------------------------------------------------

/**
 * Register semantic highlighting for a server's languages once it
 * connects (its legend comes from the handshake), and drop it when it
 * disconnects. Tokens are translated into Sable's categories
 * (semanticTokens.ts) that each theme styles.
 */
/** Sable's semantic legend: generic categories + every JetBrains key. */
const SEMANTIC_TOKEN_TYPES = semanticTokenTypes([...Object.keys(DARK), ...Object.keys(DARCULA)]);

const usesJetBrainsColors = () => Boolean(themeById(currentThemeId()).jetbrains);

function registerSemanticHighlighting(monaco: Monaco) {
  const registrations = new Map<string, MonacoTypes.IDisposable[]>();
  // JetBrains themes get per-language keys, other themes generic
  // categories — so switching between the two kinds re-requests tokens.
  const themeKindChanged = new monaco.Emitter<void>();
  let jetbrains = usesJetBrainsColors();
  onThemeChange(() => {
    if (usesJetBrainsColors() === jetbrains) return;
    jetbrains = usesJetBrainsColors();
    themeKindChanged.fire();
  });
  onServerConnection((serverId, connected) => {
    registrations.get(serverId)?.forEach((registration) => registration.dispose());
    registrations.delete(serverId);
    if (!connected) return;
    const legend = capabilitiesOf(serverId)?.semanticTokensProvider?.legend as
      | ServerLegend
      | undefined;
    if (!legend) return; // e.g. plain Pyright — no semantic tokens
    const provider: MonacoTypes.languages.DocumentSemanticTokensProvider = {
      onDidChange: themeKindChanged.event,
      getLegend: () => ({ tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] }),
      provideDocumentSemanticTokens: async (model) => {
        const path = pathFromUri(model.uri);
        const response = (await sendRequest(
          extensionOf(path),
          "textDocument/semanticTokens/full",
          { textDocument: { uri: pathToUri(path) } },
        )) as { data?: number[] } | null;
        if (!response?.data || model.isDisposed()) return null;
        const data = translateTokens(
          response.data,
          legend,
          model.getLanguageId(),
          (line) => (line < model.getLineCount() ? model.getLineContent(line + 1) : ""),
          SEMANTIC_TOKEN_TYPES,
          jetbrains,
        );
        return { data: new Uint32Array(data) };
      },
      releaseDocumentSemanticTokens: () => {},
    };
    registrations.set(
      serverId,
      (LANGUAGES_BY_SERVER[serverId] ?? []).map((language) =>
        monaco.languages.registerDocumentSemanticTokensProvider(language, provider),
      ),
    );
  });
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
};

function toMonacoRange(range: LspRange): MonacoTypes.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * Monaco can only show/peek a definition that has a model. For targets
 * in files that aren't open yet, create the model from disk (keyed the
 * same way tabs key theirs, so opening the tab later reuses it).
 */
export async function ensureModel(monaco: Monaco, path: string) {
  const uri = monaco.Uri.file(path);
  if (monaco.editor.getModel(uri)) return uri;
  try {
    const text = await readFile(path);
    if (!monaco.editor.getModel(uri)) {
      monaco.editor.createModel(text, undefined, uri);
    }
  } catch {
    /* unreadable (e.g. inside a zip) — Monaco just won't preview it */
  }
  return uri;
}

async function provideDefinition(
  monaco: Monaco,
  model: MonacoTypes.editor.ITextModel,
  position: MonacoTypes.Position,
): Promise<MonacoTypes.languages.Location[]> {
  const path = pathFromUri(model.uri);
  await changeDocument(path, model.getValue());
  const response = (await sendRequest(
    extensionOf(path),
    "textDocument/definition",
    {
      textDocument: { uri: pathToUri(path) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    },
  )) as LspLocation | LspLocation[] | LspLocationLink[] | null;
  if (!response) return [];
  const items = Array.isArray(response) ? response : [response];
  return Promise.all(
    items.map(async (item) => {
      const isLink = "targetUri" in item;
      const targetPath = uriToPath(isLink ? item.targetUri : item.uri);
      const range = isLink ? item.targetSelectionRange : item.range;
      return {
        uri: await ensureModel(monaco, targetPath),
        range: toMonacoRange(range),
      };
    }),
  );
}

interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: {
      label: string | [number, number];
      documentation?: string | { kind: string; value: string };
    }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

function toDocumentation(
  documentation: string | { kind: string; value: string } | undefined,
): string | { value: string } | undefined {
  if (documentation == null) return undefined;
  return typeof documentation === "string"
    ? documentation
    : { value: documentation.value };
}

async function provideSignatureHelp(
  model: MonacoTypes.editor.ITextModel,
  position: MonacoTypes.Position,
): Promise<MonacoTypes.languages.SignatureHelpResult | null> {
  const path = pathFromUri(model.uri);
  await changeDocument(path, model.getValue());
  const help = (await sendRequest(
    extensionOf(path),
    "textDocument/signatureHelp",
    {
      textDocument: { uri: pathToUri(path) },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    },
  )) as LspSignatureHelp | null;
  if (!help || help.signatures.length === 0) return null;
  return {
    value: {
      signatures: help.signatures.map((signature) => ({
        label: signature.label,
        documentation: toDocumentation(signature.documentation),
        parameters: (signature.parameters ?? []).map((parameter) => ({
          label: parameter.label,
          documentation: toDocumentation(parameter.documentation),
        })),
        activeParameter: signature.activeParameter,
      })),
      activeSignature: help.activeSignature ?? 0,
      activeParameter: help.activeParameter ?? 0,
    },
    dispose: () => {},
  };
}

// --- Code actions / quick fixes ----------------------------------------------

export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: { reason: string };
  diagnostics?: { message: string; range: LspRange }[];
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
}

function rangesOverlap(a: LspRange, b: LspRange): boolean {
  const before = (x: LspRange["start"], y: LspRange["start"]) =>
    x.line < y.line || (x.line === y.line && x.character <= y.character);
  return before(a.start, b.end) && before(b.start, a.end);
}

/** Run a server command. A few are client-side by convention. */
async function executeLspCommand(extension: string, command: LspCommand) {
  if (command.command === "java.apply.workspaceEdit" && command.arguments?.[0]) {
    await applyWorkspaceEdit(command.arguments[0] as LspWorkspaceEdit);
    return;
  }
  await sendRequest(extension, "workspace/executeCommand", {
    command: command.command,
    arguments: command.arguments,
  });
}

/** Apply a server's code action: resolve it if needed, apply its edit,
 *  run its command (which may push edits back via workspace/applyEdit). */
export async function applyLspCodeAction(extension: string, action: LspCodeAction | LspCommand) {
  if (typeof action.command === "string") {
    await executeLspCommand(extension, action as LspCommand);
    return;
  }
  let resolved = action as LspCodeAction;
  if (!resolved.edit && resolved.data !== undefined) {
    resolved =
      ((await sendRequest(extension, "codeAction/resolve", resolved)) as LspCodeAction | null) ?? resolved;
  }
  if (resolved.edit) await applyWorkspaceEdit(resolved.edit);
  if (resolved.command) await executeLspCommand(extension, resolved.command);
}

async function provideLspCodeActions(
  model: MonacoTypes.editor.ITextModel,
  range: MonacoTypes.Range,
  context: MonacoTypes.languages.CodeActionContext,
): Promise<MonacoTypes.languages.CodeActionList> {
  const empty = { actions: [], dispose: () => {} };
  const path = pathFromUri(model.uri);
  const lspRange: LspRange = {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
  const diagnostics = lspDiagnosticsFor(path).filter((diagnostic) =>
    rangesOverlap(diagnostic.range, lspRange),
  );
  const extension = extensionOf(path);
  const result = (await sendRequest(extension, "textDocument/codeAction", {
    textDocument: { uri: pathToUri(path) },
    range: lspRange,
    context: {
      diagnostics,
      only: context.only ? [context.only] : undefined,
      triggerKind: context.trigger, // Monaco and LSP share 1 = invoked, 2 = auto
    },
  })) as (LspCodeAction | LspCommand)[] | null;
  if (!result || result.length === 0) return empty;

  const actions = result.map((item): MonacoTypes.languages.CodeAction => {
    // A bare Command (legacy shape): `command` is the command id string.
    if (typeof item.command === "string") {
      const command = item as LspCommand;
      return {
        title: command.title,
        command: { id: EXECUTE_LSP_COMMAND, title: command.title, arguments: [extension, command] },
      };
    }
    const action = item as LspCodeAction;
    const markers = context.markers.filter((marker) =>
      action.diagnostics?.some((diagnostic) => diagnostic.message === marker.message),
    );
    return {
      title: action.title,
      kind: action.kind,
      isPreferred: action.isPreferred,
      disabled: action.disabled?.reason,
      diagnostics: markers.length > 0 ? markers : undefined,
      // Applied by our command (not Monaco's edit service) so it can
      // resolve lazily, edit files that aren't open, and run commands.
      command: { id: APPLY_CODE_ACTION, title: action.title, arguments: [extension, action] },
    };
  });
  return { actions, dispose: () => {} };
}

/** Prompt for the agent about one problem, with surrounding code. */
function agentProblemPrompt(
  model: MonacoTypes.editor.ITextModel,
  path: string,
  marker: MonacoTypes.editor.IMarkerData,
  mode: "fix" | "explain",
): string {
  const root = useWorkspaceStore.getState().rootPath;
  const relative =
    root && path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const first = Math.max(1, marker.startLineNumber - 3);
  const last = Math.min(model.getLineCount(), marker.endLineNumber + 3);
  const lines: string[] = [];
  for (let line = first; line <= last; line++) {
    const pointer = line >= marker.startLineNumber && line <= marker.endLineNumber ? "→" : " ";
    lines.push(`${pointer} ${String(line).padStart(4)} | ${model.getLineContent(line)}`);
  }
  const severity = marker.severity >= 8 ? "error" : marker.severity >= 4 ? "warning" : "problem";
  const code = typeof marker.code === "string" ? marker.code : marker.code?.value;
  const origin = [marker.source, code].filter(Boolean).join(" ");
  const fence = "```";
  const header = [
    `${severity} in \`${relative}:${marker.startLineNumber}\`${origin ? ` (${origin})` : ""}:`,
    "",
    `> ${marker.message}`,
    "",
    fence,
    ...lines,
    fence,
  ].join("\n");
  return mode === "fix"
    ? `Fix this ${header}\n\nMake the smallest correct change, then briefly explain the cause.`
    : `Explain this ${header}\n\nExplain what it means, why it happens here, and how to fix it. Don't edit any files.`;
}

function provideAgentCodeActions(
  model: MonacoTypes.editor.ITextModel,
  context: MonacoTypes.languages.CodeActionContext,
): MonacoTypes.languages.CodeActionList {
  const empty = { actions: [], dispose: () => {} };
  if (!getSetting("ai.quickFixes")) return empty;
  if (context.only && !"quickfix".startsWith(context.only)) return empty;
  // Most severe problem under the cursor (Warning = 4, Error = 8).
  const marker = [...context.markers]
    .filter((candidate) => candidate.severity >= 4)
    .sort((a, b) => b.severity - a.severity)[0];
  if (!marker || model.uri.scheme !== "file") return empty;
  const path = pathFromUri(model.uri);
  return {
    actions: [
      {
        title: "✨ Fix with Agent",
        kind: "quickfix",
        diagnostics: [marker],
        command: { id: AGENT_PROBLEM, title: "Fix with Agent", arguments: [path, marker, "fix"] },
      },
      {
        title: "✨ Explain with Agent",
        kind: "quickfix",
        diagnostics: [marker],
        command: {
          id: AGENT_PROBLEM,
          title: "Explain with Agent",
          arguments: [path, marker, "explain"],
        },
      },
    ],
    dispose: () => {},
  };
}

function registerCodeActions(monaco: Monaco) {
  monaco.editor.registerCommand(
    APPLY_CODE_ACTION,
    async (_accessor, extension: string, action: LspCodeAction) => {
      try {
        await applyLspCodeAction(extension, action);
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
      }
    },
  );
  monaco.editor.registerCommand(
    EXECUTE_LSP_COMMAND,
    (_accessor, extension: string, command: LspCommand) => {
      void executeLspCommand(extension, command).catch((error) =>
        useUiStore.getState().setLastError(String(error)),
      );
    },
  );
  monaco.editor.registerCommand(
    AGENT_PROBLEM,
    (_accessor, path: string, marker: MonacoTypes.editor.IMarkerData, mode: "fix" | "explain") => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (!model) return;
      const prompt = agentProblemPrompt(model, path, marker, mode);
      useUiStore.getState().focusAgent();
      const agent = useAgentStore.getState();
      // Busy with another request: stage it rather than interrupt.
      if (agent.isRunning) agent.setDraft(prompt);
      else void agent.send(prompt);
    },
  );

  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions: (model, range, context) =>
        provideLspCodeActions(model, range, context),
    });
  }
  // Every language: agent fixes for any marker (TS, JSON, LSP, …).
  monaco.languages.registerCodeActionProvider(
    "*",
    { provideCodeActions: (model, _range, context) => provideAgentCodeActions(model, context) },
    { providedCodeActionKinds: ["quickfix"] },
  );
}

export function registerLspProviders(monaco: Monaco): void {
  registerCodeActions(monaco);
  registerPythonQuickFixes(monaco);
  registerSemanticHighlighting(monaco);
  registerRename(monaco, LSP_LANGUAGES);
  registerNavigationProviders(monaco, LSP_LANGUAGES, ensureModel);
  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      provideHover: (model, position) => provideHover(model, position),
    });
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: (model, position) =>
        provideDefinition(monaco, model, position),
    });
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [")"],
      provideSignatureHelp: (model, position) =>
        provideSignatureHelp(model, position),
    });
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", ":"],
      provideCompletionItems: (model, position) =>
        provideCompletions(monaco, model, position),
      resolveCompletionItem: (item) => resolveCompletion(item as LspSuggestion),
    });
  }
}
