/**
 * Sable's plugin API — the `sable` object passed to your activate().
 * Every call returns a Promise. Methods marked with a permission need it
 * in sable-plugin.json's "permissions"; without it they throw.
 */

export interface Disposable {
  dispose(): Promise<void>;
}

export interface Position {
  /** 1-based, like the editor. */
  line: number;
  column: number;
}

export interface ActiveEditor {
  /** Absolute path of the file. */
  path: string;
  /** Monaco language id: "python", "typescript", "rust", … */
  language: string;
  /** The editor's text (unsaved changes included). */
  text: string;
  selection: { start: Position; end: Position; text: string } | null;
}

export interface Diagnostic {
  /** 1-based. */
  line: number;
  column?: number;
  endLine?: number;
  /** Default: the end of endLine. */
  endColumn?: number;
  message: string;
  /** Default "error". */
  severity?: "error" | "warning" | "info" | "hint";
  /** Shown after the message; default: your plugin's name. */
  source?: string;
}

export interface CompletionItem {
  label: string;
  /** Default: the label. */
  insertText?: string;
  /** insertText uses snippet syntax: $1, ${2:placeholder}, $0. */
  snippet?: boolean;
  /** Replace this many characters before the cursor (default: the word being typed). */
  replace?: number;
  detail?: string;
  documentation?: string;
  kind?: "function" | "method" | "variable" | "field" | "class" | "interface" | "module" | "property"
    | "keyword" | "snippet" | "constant" | "value" | "file" | "color";
}

export interface QuickPickItem {
  label: string;
  /** Dim text shown after the label. */
  description?: string;
  detail?: string;
}

export interface Range {
  /** 1-based, like the editor; end is exclusive. */
  start: Position;
  end: Position;
}

export interface TextEdit {
  range: Range;
  text: string;
}

export interface HoverRequest {
  path: string;
  language: string;
  text: string;
  line: number;
  column: number;
  /** The whole line's text. */
  lineText: string;
  /** The word under the pointer ("" if none). */
  word: string;
}

export interface CompletionRequest {
  path: string;
  language: string;
  text: string;
  line: number;
  column: number;
  /** The line's text before the cursor. */
  linePrefix: string;
  /** The word being typed (before the cursor). */
  word: string;
}

/** A 0-based position, as in VS Code (used by the VS Code-level APIs). */
export interface Position0 {
  line: number;
  character: number;
}

export interface Range0 {
  start: Position0;
  end: Position0;
}

export interface DecorationItem {
  range: Range0;
  hoverMessage?: string;
  renderOptions?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
}

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** 0 none, 1 collapsed, 2 expanded. */
  collapsible: number;
  /** A codicon name ("file", "bookmark", …). */
  icon?: string;
  /** One of your commands, run on click. */
  command?: { id: string; title?: string; arguments?: unknown[] };
}

export interface Sable {
  /** Your sable-plugin.json. */
  readonly manifest: { id: string; name: string; version: string; permissions: string[] };
  /** Sable's version ("0.3.2"). */
  readonly version: string;

  commands: {
    /** Add a command to the command palette (⇧⌘P), shown as "Plugin Name: title". */
    register(id: string, title: string, run: () => unknown, options?: { hidden?: boolean }): Disposable;
    /** Run one of your commands. */
    execute(id: string): Promise<void>;
  };

  window: {
    /** A message in the status bar. */
    showMessage(text: string): Promise<void>;
    showError(text: string): Promise<void>;
    /**
     * Ask the user to choose from a list (shown like the command palette,
     * filterable). Resolves to the chosen item as you passed it, or null
     * if they dismissed it.
     */
    showQuickPick<T extends string | QuickPickItem>(items: T[], options?: { placeholder?: string }): Promise<T | null>;
    showWarning(text: string): Promise<void>;
    /** Ask for a line of text (Enter to accept); null if dismissed. */
    showInputBox(options?: { prompt?: string; placeholder?: string; value?: string }): Promise<string | null>;
  };

  statusBar: {
    /** Your plugin's item in the status bar; clicking runs `command` (one of yours). */
    set(text: string, options?: { tooltip?: string; command?: string }): Promise<void>;
    clear(): Promise<void>;
  };

  /** Permission: "editor". */
  editor: {
    /** The focused file, or null. */
    active(): Promise<ActiveEditor | null>;
    /** Replace the selection (or insert at the cursor). Undoable. */
    replaceSelection(text: string): Promise<void>;
    /** Replace the whole file's text. Undoable. */
    setText(text: string): Promise<void>;
    /** Several edits at once, as one undo step (ranges refer to the text before any of them). */
    applyEdits(edits: TextEdit[]): Promise<void>;
    /** Select a range (an empty one places the cursor) and scroll to it. */
    setSelection(range: Range): Promise<void>;
    /** Run an editor action by id — Monaco shares VS Code's: "editor.action.formatDocument", "editor.action.commentLine", … */
    executeAction(id: string): Promise<void>;
    /** Permission: "workspace:read". Open a file of the folder, optionally at a line. */
    open(path: string, options?: { line?: number }): Promise<void>;
    /**
     * A decoration type: VS Code's DecorationRenderOptions (color,
     * backgroundColor, border, fontWeight, isWholeLine, overviewRulerColor,
     * before/after: { contentText, color, … }, light/dark). Colours may be
     * theme ids: { id: "editorError.foreground" }.
     */
    createDecorationType(key: string, options: Record<string, unknown>): Promise<void>;
    /** Decorate a file (null: the active one); replaces that key's earlier decorations. 0-based positions. */
    setDecorations(path: string | null, key: string, items: DecorationItem[]): Promise<void>;
    disposeDecorationType(key: string): Promise<void>;
  };

  /** Permission: "shell". Terminals in the panel. */
  terminal: {
    /** Resolves to the terminal's id. With shellPath, runs that program instead of your shell. */
    create(options?: { name?: string; cwd?: string; shellPath?: string; shellArgs?: string[]; env?: Record<string, string | null> }): Promise<string>;
    sendText(id: string, text: string, addNewLine?: boolean): Promise<void>;
    show(id: string): Promise<void>;
    dispose(id: string): Promise<void>;
  };

  /**
   * HTML pages in a sandboxed frame — an editor tab, or a sidebar view
   * (view: true). The page has acquireVsCodeApi() and VS Code's theme
   * variables.
   */
  webview: {
    create(
      id: string,
      options: { title?: string; enableScripts?: boolean; view?: boolean },
      listener: (event: { type: "message"; message: unknown } | { type: "dispose" }) => unknown,
    ): Promise<void>;
    setHtml(id: string, html: string): Promise<void>;
    setTitle(id: string, title: string): Promise<void>;
    postMessage(id: string, message: unknown): Promise<boolean>;
    reveal(id: string): Promise<void>;
    dispose(id: string): Promise<void>;
  };

  /** Views in the sidebar's Plugin Views section. */
  views: {
    declare(
      views: { id: string; name: string; kind: "tree" | "webview" }[],
      handler: (request: { op: "children"; viewId: string; nodeId?: string } | { op: "resolve"; viewId: string }) => TreeNode[] | void | Promise<TreeNode[] | void>,
    ): Promise<void>;
    /** Ask for a view's nodes again. */
    refresh(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
  };

  env: {
    clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
    /** Open an http(s) or mailto link in the browser. */
    openExternal(url: string): Promise<void>;
  };

  /** Values kept for your plugin between runs (JSON; 1 MB in all). */
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    /** null removes the key. */
    set(key: string, value: unknown): Promise<void>;
    keys(): Promise<string[]>;
  };

  workspace: {
    /** The open folder, or null. Kept up to date. */
    readonly root: string | null;
    /** Permission: "workspace:read". Paths are relative to the folder (or absolute inside it). */
    readFile(path: string): Promise<string>;
    /** Permission: "workspace:write". Creates folders as needed; open files update (undoably). */
    writeFile(path: string, text: string): Promise<void>;
    /** Permission: "workspace:read". Every file (respecting .gitignore), relative paths. */
    listFiles(): Promise<string[]>;
    /** Permission: "workspace:read". */
    listDirectory(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
    /** Permission: "workspace:write". */
    createDirectory(path: string): Promise<void>;
    /** Permission: "workspace:write". */
    delete(path: string): Promise<void>;
    /** Permission: "workspace:write". */
    rename(from: string, to: string): Promise<void>;
    /** The open folder changed. */
    onDidChangeRoot(listener: (root: string | null) => void): Disposable;
  };

  events: {
    onDidSave(listener: (event: { path: string }) => unknown): Disposable;
    onDidOpen(listener: (event: { path: string }) => unknown): Disposable;
    /** The text of a file changed (after typing pauses). */
    onDidChange(listener: (event: { path: string }) => unknown): Disposable;
    /** Every edit as it happens (not debounced): what changed, with 0-based ranges in the text before it, as VS Code's onDidChangeTextDocument. */
    onDidChangeContent(
      listener: (event: {
        path: string;
        changes: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; rangeOffset: number; rangeLength: number; text: string }[];
        isUndoing: boolean;
        isRedoing: boolean;
      }) => unknown,
    ): Disposable;
    /** A different file is in front (path null: none). */
    onDidChangeActiveEditor(listener: (event: { path: string | null }) => unknown): Disposable;
    /** The selection or cursor moved (settled, not every keystroke). */
    onDidChangeSelection(listener: (event: { path: string; selection: ActiveEditor["selection"] }) => unknown): Disposable;
    /** Problems changed (from any source). */
    onDidChangeDiagnostics(listener: (event: unknown) => unknown): Disposable;
  };

  /** Permission: "editor". Language ids are Monaco's; "*" means every language. */
  languages: {
    /** Format Document (⇧⌥F) and format on save: return the new text. */
    registerFormatter(language: string, format: (document: { path: string; language: string; text: string }) => string | Promise<string>): Disposable;
    registerCompletions(
      language: string,
      provide: (request: CompletionRequest) => CompletionItem[] | Promise<CompletionItem[]>,
      options?: { triggerCharacters?: string[] },
    ): Disposable;
    /** A tooltip when the pointer rests on text: return Markdown, or null for none. */
    registerHover(
      language: string,
      provide: (request: HoverRequest) => string | { contents: string; range?: Range } | null | Promise<string | { contents: string; range?: Range } | null>,
    ): Disposable;
    /**
     * Names to offer under the rename box (F2 / ⇧F6): return the
     * suggestions for the symbol being renamed. Language "*" means all.
     */
    registerRenameSuggestions(
      language: string,
      provide: (request: { path: string; language: string; name: string; line: number }) => string[] | Promise<string[]>,
    ): Disposable;
    /** Squiggles (and Problems entries) for a file; replaces your previous ones for it. */
    setDiagnostics(path: string, diagnostics: Diagnostic[]): Promise<void>;
    /** Remove your diagnostics for one file, or all of them. */
    clearDiagnostics(path?: string): Promise<void>;
    /** Every problem, from every source. 0-based ranges; severity 0 error … 3 hint, as in VS Code. */
    getDiagnostics(path?: string): Promise<{ path: string; diagnostics: { range: Range0; message: string; severity: number; source?: string; code?: string }[] }[]>;
    /**
     * VS Code's other language features, with VS Code's shapes and 0-based
     * positions: definition, declaration, typeDefinition, implementation,
     * references, documentHighlight, documentSymbol, codeAction, codeLens,
     * signatureHelp, rename, documentLink, foldingRange, inlayHint, color.
     */
    registerProvider(kind: string, language: string, provide: (request: { path: string; language: string; text: string; version: number; [key: string]: unknown }) => unknown): Disposable;
    /** Ask the editor for your code lenses again. */
    refreshCodeLenses(): Promise<void>;
    /** Languages (VS Code's contributes.languages) and their TextMate grammars (JSON). */
    contribute(languages: unknown[], grammars?: { language: string; scopeName?: string; grammar: Record<string, unknown> }[]): Promise<void>;
  };

  /** Permission: "shell". Runs in your login shell, in the open folder. */
  shell: {
    run(command: string, options?: { timeoutSeconds?: number }): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>;
  };
}
