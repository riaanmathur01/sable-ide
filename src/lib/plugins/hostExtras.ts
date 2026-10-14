import type * as MonacoTypes from "monaco-editor";
import { getEditor, pathFromUri, whenMonaco } from "../editorRegistry";
import { createDirectory, deletePath, readDirectory, renamePath, writeTerminal, killTerminal } from "../ipc";
import { confinedPath } from "../ai/tools";
import { applyWorkspaceEdit, type LspWorkspaceEdit } from "../lsp/workspaceEdit";
import { pathToUri } from "../lsp/lspClient";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useTerminalStore } from "../../store/terminalStore";
import { usePluginViewsStore, postToWebview, type TreeNode } from "../../store/pluginViewsStore";
import type { PluginPermission } from "./types";
import { addTextmateGrammar } from "../shikiMonaco";

/**
 * The plugin API's larger half — what VS Code extensions need beyond the
 * basics (lib/plugins/host.ts): more language features (definition,
 * references, symbols, code actions, code lenses, signature help, rename,
 * highlights, links, folding, inlay hints), editor decorations, terminals,
 * webview panels, tree and webview views, more file operations, and the
 * current diagnostics.
 *
 * Positions in this API are VS Code's: 0-based `{ line, character }`.
 */

type Monaco = typeof MonacoTypes;

/** What a runtime lets this module do. */
export interface RuntimeAccess {
  id: string;
  name: string;
  require(permission: PluginPermission): void;
  callback(handler: number, args: unknown[], kind: string): Promise<unknown>;
  register(handler: number, make: (monaco: Monaco) => MonacoTypes.IDisposable): Promise<void>;
  root(): string;
  /** Run when the plugin stops. */
  onStop(cleanup: () => void): void;
  /** Run one of the plugin's commands by id (with arguments). */
  executeCommand(id: string, args: unknown[]): Promise<unknown>;
}

interface Position0 {
  line: number;
  character: number;
}
interface Range0 {
  start: Position0;
  end: Position0;
}
interface FileEdit {
  path: string;
  edits: { range: Range0; text: string }[];
}
interface CommandRef {
  id: string;
  title?: string;
  arguments?: unknown[];
}

const toRange = (range: Range0): MonacoTypes.IRange => ({
  startLineNumber: (range?.start?.line ?? 0) + 1,
  startColumn: (range?.start?.character ?? 0) + 1,
  endLineNumber: (range?.end?.line ?? range?.start?.line ?? 0) + 1,
  endColumn: (range?.end?.character ?? range?.start?.character ?? 0) + 1,
});
const fromPosition = (position: MonacoTypes.IPosition): Position0 => ({ line: position.lineNumber - 1, character: position.column - 1 });
const fromRange = (range: MonacoTypes.IRange): Range0 => ({
  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
});

/** Our file edits → an LSP WorkspaceEdit (Sable applies those across files, undoably). */
function toLspEdit(edits: FileEdit[]): LspWorkspaceEdit {
  const changes: Record<string, { range: Range0; newText: string }[]> = {};
  for (const file of edits ?? []) {
    changes[pathToUri(file.path)] = (file.edits ?? []).map((edit) => ({ range: edit.range, newText: edit.text }));
  }
  return { changes } as unknown as LspWorkspaceEdit;
}

// Monaco commands for plugin results: run a plugin command; apply an edit.
let commandsInstalled = false;
const runners = new Map<string, RuntimeAccess>();
function installCommands(monaco: Monaco) {
  if (commandsInstalled) return;
  commandsInstalled = true;
  monaco.editor.registerCommand("sable.plugin.command", (_accessor, pluginId: string, id: string, args: unknown[]) => {
    void runners.get(pluginId)?.executeCommand(id, args ?? []).catch((error) => useUiStore.getState().setLastError(String(error)));
  });
  monaco.editor.registerCommand("sable.plugin.applyEdit", (_accessor, edit: LspWorkspaceEdit) => {
    void applyWorkspaceEdit(edit).catch((error) => useUiStore.getState().setLastError(String(error)));
  });
}

function monacoCommand(rt: RuntimeAccess, command: CommandRef | undefined): MonacoTypes.languages.Command | undefined {
  if (!command?.id) return undefined;
  return { id: "sable.plugin.command", title: command.title ?? "", arguments: [rt.id, command.id, command.arguments ?? []] };
}

/** The request a provider gets: the document, and where. */
function documentRequest(model: MonacoTypes.editor.ITextModel, extra: Record<string, unknown>) {
  return { path: pathFromUri(model.uri), language: model.getLanguageId(), text: model.getValue(), version: model.getVersionId(), ...extra };
}

const SYMBOL_KIND_OFFSET = 0; // VS Code's SymbolKind numbering matches Monaco's.

/** Register a language-feature provider of `kind`. */
async function registerProvider(rt: RuntimeAccess, handler: number, kind: string, language: string) {
  rt.require("editor");
  const call = (model: MonacoTypes.editor.ITextModel, extra: Record<string, unknown>) =>
    model.uri.scheme === "file" ? rt.callback(handler, [documentRequest(model, extra)], "completions").catch(() => null) : Promise.resolve(null);
  await rt.register(handler, (monaco) => {
    installCommands(monaco);
    runners.set(rt.id, rt);
    const locations = (result: unknown): MonacoTypes.languages.Location[] =>
      ((Array.isArray(result) ? result : result ? [result] : []) as { path: string; range: Range0 }[])
        .filter((item) => item?.path)
        .map((item) => ({ uri: monaco.Uri.file(item.path), range: toRange(item.range) }));
    switch (kind) {
      case "definition":
        return monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, position) => locations(await call(model, { position: fromPosition(position) })),
        });
      case "declaration":
        return monaco.languages.registerDeclarationProvider(language, {
          provideDeclaration: async (model, position) => locations(await call(model, { position: fromPosition(position) })),
        });
      case "typeDefinition":
        return monaco.languages.registerTypeDefinitionProvider(language, {
          provideTypeDefinition: async (model, position) => locations(await call(model, { position: fromPosition(position) })),
        });
      case "implementation":
        return monaco.languages.registerImplementationProvider(language, {
          provideImplementation: async (model, position) => locations(await call(model, { position: fromPosition(position) })),
        });
      case "references":
        return monaco.languages.registerReferenceProvider(language, {
          provideReferences: async (model, position, context) =>
            locations(await call(model, { position: fromPosition(position), includeDeclaration: context.includeDeclaration })),
        });
      case "documentHighlight":
        return monaco.languages.registerDocumentHighlightProvider(language, {
          provideDocumentHighlights: async (model, position) =>
            ((await call(model, { position: fromPosition(position) })) as { range: Range0; kind?: number }[] | null ?? []).map((item) => ({
              range: toRange(item.range),
              kind: item.kind,
            })),
        });
      case "documentSymbol": {
        type Symbol0 = { name: string; detail?: string; kind: number; range: Range0; selectionRange?: Range0; children?: Symbol0[] };
        const convert = (symbol: Symbol0): MonacoTypes.languages.DocumentSymbol => ({
          name: symbol.name,
          detail: symbol.detail ?? "",
          kind: (symbol.kind ?? 12) + SYMBOL_KIND_OFFSET,
          tags: [],
          range: toRange(symbol.range),
          selectionRange: toRange(symbol.selectionRange ?? symbol.range),
          children: (symbol.children ?? []).map(convert),
        });
        return monaco.languages.registerDocumentSymbolProvider(language, {
          displayName: rt.name,
          provideDocumentSymbols: async (model) => ((await call(model, {})) as Symbol0[] | null ?? []).map(convert),
        });
      }
      case "codeAction":
        return monaco.languages.registerCodeActionProvider(language, {
          provideCodeActions: async (model, range, context) => {
            const result = (await call(model, {
              range: fromRange(range),
              diagnostics: context.markers.map((marker) => ({ range: fromRange(marker), message: marker.message, severity: marker.severity, source: marker.source, code: marker.code })),
              only: context.only,
            })) as { title: string; kind?: string; isPreferred?: boolean; edit?: FileEdit[]; command?: CommandRef; diagnostics?: number[] }[] | null;
            const actions: MonacoTypes.languages.CodeAction[] = (result ?? []).map((action) => {
              // An edit (and maybe a command afterwards): apply through Sable,
              // across files; a command alone: run it.
              const command = action.edit?.length
                ? { id: "sable.plugin.applyEdit", title: action.title, arguments: [toLspEdit(action.edit)] }
                : monacoCommand(rt, action.command);
              return { title: action.title, kind: action.kind, isPreferred: action.isPreferred, command, diagnostics: context.markers };
            });
            return { actions, dispose() {} };
          },
        });
      case "codeLens": {
        const emitter = new monaco.Emitter<MonacoTypes.languages.CodeLensProvider>();
        const provider: MonacoTypes.languages.CodeLensProvider = {
          onDidChange: emitter.event,
          provideCodeLenses: async (model) => {
            const result = (await call(model, {})) as { range: Range0; command?: CommandRef }[] | null;
            return {
              lenses: (result ?? [])
                .filter((lens) => lens.command)
                .map((lens) => ({ range: toRange(lens.range), command: monacoCommand(rt, lens.command) })),
              dispose() {},
            };
          },
        };
        codeLensRefreshers.set(`${rt.id}:${handler}`, () => emitter.fire(provider));
        return monaco.languages.registerCodeLensProvider(language, provider);
      }
      case "signatureHelp":
        return monaco.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: ["(", ","],
          signatureHelpRetriggerCharacters: [")"],
          provideSignatureHelp: async (model, position) => {
            const result = (await call(model, { position: fromPosition(position) })) as {
              signatures: { label: string; documentation?: string; parameters?: { label: string | [number, number]; documentation?: string }[] }[];
              activeSignature?: number;
              activeParameter?: number;
            } | null;
            if (!result?.signatures?.length) return null;
            return {
              value: {
                signatures: result.signatures.map((signature) => ({
                  label: signature.label,
                  documentation: signature.documentation ? { value: signature.documentation } : undefined,
                  parameters: (signature.parameters ?? []).map((parameter) => ({
                    label: parameter.label,
                    documentation: parameter.documentation ? { value: parameter.documentation } : undefined,
                  })),
                })),
                activeSignature: result.activeSignature ?? 0,
                activeParameter: result.activeParameter ?? 0,
              },
              dispose() {},
            };
          },
        });
      case "rename":
        return monaco.languages.registerRenameProvider(language, {
          provideRenameEdits: async (model, position, newName) => {
            const result = (await call(model, { position: fromPosition(position), newName })) as FileEdit[] | null;
            if (!result?.length) return { edits: [], rejectReason: "Nothing to rename" };
            await applyWorkspaceEdit(toLspEdit(result));
            return { edits: [] };
          },
          resolveRenameLocation: async (model, position) => {
            const word = model.getWordAtPosition(position);
            const fallback = word
              ? { range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }, text: word.word }
              : null;
            const result = (await call(model, { position: fromPosition(position), prepare: true })) as { range: Range0; placeholder?: string } | null;
            if (result?.range) return { range: toRange(result.range), text: result.placeholder ?? model.getValueInRange(toRange(result.range)) };
            return fallback ?? { range: toRange({ start: fromPosition(position), end: fromPosition(position) }), text: "", rejectReason: "Nothing to rename here" };
          },
        });
      case "documentLink":
        return monaco.languages.registerLinkProvider(language, {
          provideLinks: async (model) => ({
            links: ((await call(model, {})) as { range: Range0; target?: string; tooltip?: string }[] | null ?? [])
              .filter((link) => link.target)
              .map((link) => ({ range: toRange(link.range), url: link.target, tooltip: link.tooltip })),
          }),
        });
      case "foldingRange":
        return monaco.languages.registerFoldingRangeProvider(language, {
          provideFoldingRanges: async (model) =>
            ((await call(model, {})) as { start: number; end: number; kind?: string }[] | null ?? []).map((range) => ({
              start: range.start + 1,
              end: range.end + 1,
              kind: range.kind ? new monaco.languages.FoldingRangeKind(range.kind) : undefined,
            })),
        });
      case "inlayHint":
        return monaco.languages.registerInlayHintsProvider(language, {
          provideInlayHints: async (model, range) => ({
            hints: ((await call(model, { range: fromRange(range) })) as { position: Position0; label: string; kind?: number; paddingLeft?: boolean; paddingRight?: boolean; tooltip?: string }[] | null ?? []).map((hint) => ({
              position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
              label: hint.label,
              kind: hint.kind,
              paddingLeft: hint.paddingLeft,
              paddingRight: hint.paddingRight,
              tooltip: hint.tooltip,
            })),
            dispose() {},
          }),
        });
      case "color":
        return monaco.languages.registerColorProvider(language, {
          provideDocumentColors: async (model) =>
            ((await call(model, { op: "colors" })) as { range: Range0; color: { red: number; green: number; blue: number; alpha: number } }[] | null ?? []).map((item) => ({
              range: toRange(item.range),
              color: item.color,
            })),
          provideColorPresentations: async (model, info) =>
            ((await call(model, { op: "presentations", color: info.color, range: fromRange(info.range) })) as { label: string }[] | null ?? []).map((presentation) => ({
              label: presentation.label,
            })),
        });
      default:
        throw new Error(`Unknown provider kind ${kind}`);
    }
  });
}

const codeLensRefreshers = new Map<string, () => void>();

// --- Decorations ---------------------------------------------------------------------

type DecorationOptions = Record<string, unknown> & {
  light?: Record<string, unknown>;
  dark?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/** VS Code theme colour ids Sable has an equivalent for. */
const THEME_COLORS: Record<string, string> = {
  "editorError.foreground": "var(--danger)",
  "editorWarning.foreground": "var(--git-modified, #d29922)",
  "editorInfo.foreground": "var(--accent)",
  "editor.foreground": "var(--text)",
  "editorLineNumber.foreground": "var(--text-muted)",
  "editorCodeLens.foreground": "var(--text-muted)",
  "editor.findMatchHighlightBackground": "rgba(234, 184, 57, 0.3)",
  "editor.wordHighlightBackground": "rgba(120, 120, 255, 0.18)",
  "editor.selectionHighlightBackground": "rgba(120, 120, 255, 0.18)",
  "editor.rangeHighlightBackground": "rgba(255, 255, 255, 0.06)",
};

function cssColor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const id = (value as { id?: string } | null)?.id;
  return id ? (THEME_COLORS[id] ?? undefined) : undefined;
}

function cssFor(options: Record<string, unknown> | undefined): string {
  if (!options) return "";
  const rules: string[] = [];
  const add = (property: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") rules.push(`${property}: ${value} !important;`);
  };
  add("background-color", cssColor(options.backgroundColor));
  add("color", cssColor(options.color));
  add("border", options.border);
  add("border-color", cssColor(options.borderColor));
  add("border-style", options.borderStyle);
  add("border-width", options.borderWidth);
  add("border-radius", options.borderRadius);
  add("border-spacing", options.borderSpacing);
  add("outline", options.outline);
  add("outline-color", cssColor(options.outlineColor));
  add("font-style", options.fontStyle);
  add("font-weight", options.fontWeight);
  add("text-decoration", options.textDecoration);
  add("letter-spacing", options.letterSpacing);
  add("opacity", options.opacity);
  add("cursor", options.cursor);
  return rules.join(" ");
}

function attachmentCss(attachment: Record<string, unknown> | undefined): string {
  if (!attachment) return "";
  const rules: string[] = [];
  const add = (property: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") rules.push(`${property}: ${value} !important;`);
  };
  add("color", cssColor(attachment.color));
  add("background-color", cssColor(attachment.backgroundColor));
  add("border", attachment.border);
  add("margin", attachment.margin);
  add("font-style", attachment.fontStyle);
  add("font-weight", attachment.fontWeight);
  add("text-decoration", attachment.textDecoration);
  add("width", attachment.width);
  add("height", attachment.height);
  return rules.join(" ");
}

interface DecorationType {
  className: string;
  options: DecorationOptions;
  style: HTMLStyleElement;
  /** Applied decorations, by file. */
  applied: Map<string, string[]>;
}

const decorationTypes = new Map<string, DecorationType>();
const isLightTheme = () => document.documentElement.style.colorScheme === "light";

function createDecorationType(rt: RuntimeAccess, key: string, options: DecorationOptions) {
  const className = `plugin-deco-${rt.id.replace(/[^\w-]/g, "-")}-${key.replace(/[^\w-]/g, "-")}`;
  const themed = { ...options, ...(isLightTheme() ? options.light : options.dark) };
  const style = document.createElement("style");
  const before = { ...options.before, ...(themed as DecorationOptions).before };
  const after = { ...options.after, ...(themed as DecorationOptions).after };
  style.textContent = [
    `.monaco-editor .${className} { ${cssFor(themed)} }`,
    `.monaco-editor .${className}-before { ${attachmentCss(before)} }`,
    `.monaco-editor .${className}-after { ${attachmentCss(after)} }`,
  ].join("\n");
  document.head.appendChild(style);
  decorationTypes.set(`${rt.id}:${key}`, { className, options: themed as DecorationOptions, style, applied: new Map() });
}

interface DecorationItem {
  range: Range0;
  hoverMessage?: string;
  renderOptions?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
}

async function setDecorations(rt: RuntimeAccess, path: string | null, key: string, items: DecorationItem[]) {
  const type = decorationTypes.get(`${rt.id}:${key}`);
  if (!type) return;
  const monaco = await whenMonaco();
  const model = path
    ? monaco.editor.getModels().find((candidate) => candidate.uri.scheme === "file" && pathFromUri(candidate.uri) === path)
    : getEditor()?.getModel();
  if (!model) return;
  const filePath = pathFromUri(model.uri);
  const options = type.options;
  const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = (items ?? []).map((item) => {
    const beforeText = (item.renderOptions?.before?.contentText ?? options.before?.contentText) as string | undefined;
    const afterText = (item.renderOptions?.after?.contentText ?? options.after?.contentText) as string | undefined;
    // A whole-line decoration covers its lines, as in VS Code, so its
    // `after` text (Error Lens's message) goes at the end of the line,
    // not where the range happens to end.
    let range = toRange(item.range);
    if (options.isWholeLine && afterText) {
      const line = Math.min(range.endLineNumber, model.getLineCount());
      range = { ...range, endLineNumber: line, endColumn: model.getLineMaxColumn(line) };
    }
    return {
      range,
      options: {
        isWholeLine: Boolean(options.isWholeLine),
        className: options.isWholeLine ? type.className : undefined,
        inlineClassName: options.isWholeLine ? undefined : type.className,
        hoverMessage: item.hoverMessage ? { value: String(item.hoverMessage) } : undefined,
        before: beforeText ? { content: beforeText, inlineClassName: `${type.className}-before` } : undefined,
        after: afterText ? { content: afterText, inlineClassName: `${type.className}-after` } : undefined,
        overviewRuler: options.overviewRulerColor
          ? { color: cssColor(options.overviewRulerColor) ?? "#888", position: monaco.editor.OverviewRulerLane.Right }
          : undefined,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        // Text added at a point (an empty range), as Error Lens does, still shows.
        showIfCollapsed: true,
      },
    };
  });
  type.applied.set(filePath, model.deltaDecorations(type.applied.get(filePath) ?? [], decorations));
}

async function disposeDecorationType(rt: RuntimeAccess, key: string) {
  const type = decorationTypes.get(`${rt.id}:${key}`);
  if (!type) return;
  decorationTypes.delete(`${rt.id}:${key}`);
  type.style.remove();
  const monaco = await whenMonaco();
  for (const [path, ids] of type.applied) {
    const model = monaco.editor.getModels().find((candidate) => candidate.uri.scheme === "file" && pathFromUri(candidate.uri) === path);
    model?.deltaDecorations(ids, []);
  }
}

// --- Terminals ------------------------------------------------------------------------

/** Plugin terminal ids → Sable terminal sessions. */
const terminals = new Map<string, string>();

async function createPluginTerminal(options: { name?: string; cwd?: string; shellPath?: string; shellArgs?: string[]; env?: Record<string, string | null> }): Promise<string> {
  const store = useTerminalStore.getState();
  let sessionId: string;
  if (options.shellPath) {
    await store.startCommandSession({ args: [options.shellPath, ...(options.shellArgs ?? [])], cwd: options.cwd ?? null, env: options.env ?? null }, options.name ?? "Terminal");
    sessionId = useTerminalStore.getState().activeId;
  } else {
    sessionId = store.newTerminal();
    if (options.name) store.setTitle(sessionId, options.name);
  }
  const id = `t${Math.random().toString(36).slice(2)}`;
  terminals.set(id, sessionId);
  return id;
}

async function sendText(id: string, text: string, newline: boolean) {
  const sessionId = terminals.get(id);
  if (!sessionId) throw new Error("That terminal is closed");
  // The shell starts when its view first shows: wait for it.
  useUiStore.getState().setTerminalVisible(true);
  for (let attempt = 0; attempt < 50; attempt++) {
    const session = useTerminalStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    if (session?.isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeTerminal(sessionId, newline ? `${text}\r` : text);
}

// --- Languages a plugin adds -------------------------------------------------------------

interface ContributedLanguage {
  id: string;
  extensions?: string[];
  filenames?: string[];
  aliases?: string[];
  /** language-configuration.json's content. */
  configuration?: Record<string, unknown> | null;
}

/** "(\\w+)" strings from language-configuration.json → RegExps. */
function regex(value: unknown): RegExp | undefined {
  if (typeof value === "string") {
    try {
      return new RegExp(value);
    } catch {
      return undefined;
    }
  }
  const pattern = value as { pattern?: string; flags?: string } | undefined;
  if (pattern?.pattern) {
    try {
      return new RegExp(pattern.pattern, pattern.flags);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Register languages (and their grammars) a plugin contributes. */
async function contributeLanguages(languages: ContributedLanguage[], grammars: { language: string; grammar: Record<string, unknown> }[]) {
  const monaco = await whenMonaco();
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const language of languages ?? []) {
    if (!language?.id) continue;
    if (!known.has(language.id)) {
      monaco.languages.register({ id: language.id, extensions: language.extensions, filenames: language.filenames, aliases: language.aliases });
      known.add(language.id);
    }
    const config = language.configuration;
    if (config) {
      const comments = config.comments as { lineComment?: string; blockComment?: [string, string] } | undefined;
      const pairs = (list: unknown) =>
        Array.isArray(list)
          ? list.map((pair) => (Array.isArray(pair) ? { open: pair[0], close: pair[1] } : (pair as { open: string; close: string }))).filter((pair) => pair?.open)
          : undefined;
      monaco.languages.setLanguageConfiguration(language.id, {
        comments,
        brackets: Array.isArray(config.brackets) ? (config.brackets as [string, string][]) : undefined,
        autoClosingPairs: pairs(config.autoClosingPairs),
        surroundingPairs: pairs(config.surroundingPairs),
        wordPattern: regex(config.wordPattern),
        folding: config.folding as never,
        indentationRules: config.indentationRules
          ? {
              increaseIndentPattern: regex((config.indentationRules as Record<string, unknown>).increaseIndentPattern) ?? /^$/,
              decreaseIndentPattern: regex((config.indentationRules as Record<string, unknown>).decreaseIndentPattern) ?? /^$/,
            }
          : undefined,
      });
    }
    // Files already open with this extension switch to the language.
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "file" || model.getLanguageId() !== "plaintext") continue;
      const path = pathFromUri(model.uri);
      const name = path.split(/[/\\]/).pop() ?? "";
      if (language.extensions?.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase())) || language.filenames?.includes(name)) {
        monaco.editor.setModelLanguage(model, language.id);
      }
    }
  }
  for (const { language, grammar } of grammars ?? []) {
    if (language && grammar) await addTextmateGrammar(language, grammar).catch((error) => console.warn(`Grammar for ${language} failed to load`, error));
  }
}

// --- The calls --------------------------------------------------------------------------

/** Handle a call this module knows; `handled: false` for anything else. */
export async function handleExtended(rt: RuntimeAccess, method: string, args: unknown[]): Promise<{ handled: boolean; value?: unknown }> {
  const done = (value: unknown = null) => ({ handled: true, value });
  switch (method) {
    case "languages.registerProvider": {
      const [handler, kind, language] = args as [number, string, string];
      await registerProvider(rt, handler, kind, language);
      return done();
    }
    case "languages.contribute":
      await contributeLanguages((args[0] ?? []) as ContributedLanguage[], (args[1] ?? []) as { language: string; grammar: Record<string, unknown> }[]);
      return done();
    case "languages.refreshCodeLenses":
      for (const [key, refresh] of codeLensRefreshers) if (key.startsWith(`${rt.id}:`)) refresh();
      return done();
    case "languages.getDiagnostics": {
      const monaco = await whenMonaco();
      const path = args[0] ? String(args[0]) : null;
      const severity = { 8: 0, 4: 1, 2: 2, 1: 3 } as Record<number, number>;
      const markers = monaco.editor.getModelMarkers({});
      const byPath = new Map<string, unknown[]>();
      for (const marker of markers) {
        if (marker.resource.scheme !== "file") continue;
        const file = pathFromUri(marker.resource);
        if (path && file !== path) continue;
        byPath.set(file, [
          ...(byPath.get(file) ?? []),
          { range: fromRange(marker), message: marker.message, severity: severity[marker.severity] ?? 0, source: marker.source, code: typeof marker.code === "string" ? marker.code : marker.code?.value },
        ]);
      }
      return done([...byPath].map(([file, diagnostics]) => ({ path: file, diagnostics })));
    }

    case "editor.createDecorationType":
      rt.require("editor");
      createDecorationType(rt, String(args[0]), (args[1] ?? {}) as DecorationOptions);
      return done();
    case "editor.setDecorations":
      rt.require("editor");
      await setDecorations(rt, (args[0] as string | null) ?? null, String(args[1]), (args[2] ?? []) as DecorationItem[]);
      return done();
    case "editor.disposeDecorationType":
      await disposeDecorationType(rt, String(args[0]));
      return done();

    case "terminal.create":
      rt.require("shell");
      return done(await createPluginTerminal((args[0] ?? {}) as Parameters<typeof createPluginTerminal>[0]));
    case "terminal.sendText":
      rt.require("shell");
      await sendText(String(args[0]), String(args[1]), args[2] !== false);
      return done();
    case "terminal.show": {
      const sessionId = terminals.get(String(args[0]));
      if (sessionId) {
        useTerminalStore.getState().setActive(sessionId);
        useUiStore.getState().setBottomPanel("terminal");
      }
      return done();
    }
    case "terminal.dispose": {
      const sessionId = terminals.get(String(args[0]));
      terminals.delete(String(args[0]));
      if (sessionId) await killTerminal(sessionId).catch(() => {});
      return done();
    }

    case "webview.create": {
      const [handler, id, options] = args as [number, string, { title?: string; enableScripts?: boolean; view?: boolean }];
      usePluginViewsStore.getState().upsertWebview({
        id,
        pluginId: rt.id,
        title: options?.title ?? rt.name,
        html: "",
        enableScripts: options?.enableScripts !== false,
        onMessage: (message) => void rt.callback(handler, [{ type: "message", message }], "event").catch(() => {}),
        onDispose: () => void rt.callback(handler, [{ type: "dispose" }], "event").catch(() => {}),
      });
      if (!options?.view) useTabsStore.getState().openWebview(id, options?.title ?? rt.name);
      return done();
    }
    case "webview.setHtml":
      usePluginViewsStore.getState().updateWebview(String(args[0]), { html: String(args[1] ?? "") });
      return done();
    case "webview.setTitle":
      usePluginViewsStore.getState().updateWebview(String(args[0]), { title: String(args[1] ?? "") });
      useTabsStore.getState().renameWebview(String(args[0]), String(args[1] ?? ""));
      return done();
    case "webview.postMessage":
      return done(postToWebview(String(args[0]), args[1]));
    case "webview.reveal":
      useTabsStore.getState().openWebview(String(args[0]), usePluginViewsStore.getState().webviews[String(args[0])]?.title ?? rt.name);
      return done();
    case "webview.dispose":
      useTabsStore.getState().closeWebview(String(args[0]));
      usePluginViewsStore.getState().removeWebview(String(args[0]));
      return done();

    case "views.declare": {
      // [handler, [{ id, name, kind }]]: requests for every view go to `handler`.
      const [handler, views] = args as [number, { id: string; name: string; kind: "tree" | "webview" }[]];
      usePluginViewsStore.getState().declareViews(
        rt.id,
        (views ?? []).map((view) => ({
          id: view.id,
          pluginId: rt.id,
          pluginName: rt.name,
          name: view.name,
          kind: view.kind,
          version: 0,
          children: (nodeId?: string) =>
            rt.callback(handler, [{ op: "children", viewId: view.id, nodeId }], "completions").then((nodes) => (nodes as TreeNode[]) ?? []),
          resolve: () => rt.callback(handler, [{ op: "resolve", viewId: view.id }], "event").then(() => undefined),
          run: (command) => void rt.executeCommand(command.id, command.arguments ?? []).catch((error) => useUiStore.getState().setLastError(String(error))),
        })),
      );
      return done();
    }
    case "views.refresh": {
      const view = usePluginViewsStore.getState().views.find((candidate) => candidate.id === args[0] && candidate.pluginId === rt.id);
      if (view) usePluginViewsStore.getState().updateView(view.id, { version: view.version + 1 });
      return done();
    }
    case "views.reveal":
      useUiStore.getState().setSidebarView("pluginViews");
      return done();

    case "workspace.listDirectory": {
      rt.require("workspace:read");
      const path = await confinedPath(rt.root(), String(args[0] ?? "."));
      return done((await readDirectory(path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory })));
    }
    case "workspace.createDirectory": {
      rt.require("workspace:write");
      await createDirectory(await confinedPath(rt.root(), String(args[0]))).catch(() => {});
      return done();
    }
    case "workspace.delete": {
      rt.require("workspace:write");
      await deletePath(await confinedPath(rt.root(), String(args[0])));
      return done();
    }
    case "workspace.rename": {
      rt.require("workspace:write");
      const from = await confinedPath(rt.root(), String(args[0]));
      const to = await confinedPath(rt.root(), String(args[1]));
      const toName = to.split(/[/\\]/).pop() ?? to;
      const sameFolder = from.slice(0, from.lastIndexOf("/")) === to.slice(0, to.lastIndexOf("/"));
      if (!sameFolder) throw new Error("Renaming into another folder isn't supported yet");
      await renamePath(from, toName);
      return done();
    }
  }
  return { handled: false };
}

/** Clean up what a plugin left behind when it stops. */
export function cleanupPlugin(pluginId: string): void {
  runners.delete(pluginId);
  for (const [key, type] of decorationTypes) {
    if (!key.startsWith(`${pluginId}:`)) continue;
    type.style.remove();
    void whenMonaco().then((monaco) => {
      for (const [path, ids] of type.applied) {
        monaco.editor.getModels().find((model) => model.uri.scheme === "file" && pathFromUri(model.uri) === path)?.deltaDecorations(ids, []);
      }
    });
    decorationTypes.delete(key);
  }
  for (const key of [...codeLensRefreshers.keys()]) if (key.startsWith(`${pluginId}:`)) codeLensRefreshers.delete(key);
  usePluginViewsStore.getState().removePlugin(pluginId);
  for (const id of Object.keys(usePluginViewsStore.getState().webviews)) {
    if (usePluginViewsStore.getState().webviews[id]?.pluginId === pluginId) useTabsStore.getState().closeWebview(id);
  }
}
