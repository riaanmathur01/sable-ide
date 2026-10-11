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

export interface Sable {
  /** Your sable-plugin.json. */
  readonly manifest: { id: string; name: string; version: string; permissions: string[] };
  /** Sable's version ("0.3.2"). */
  readonly version: string;

  commands: {
    /** Add a command to the command palette (⇧⌘P), shown as "Plugin Name: title". */
    register(id: string, title: string, run: () => unknown): Disposable;
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
  };

  events: {
    onDidSave(listener: (event: { path: string }) => unknown): Disposable;
    onDidOpen(listener: (event: { path: string }) => unknown): Disposable;
    /** The text of a file changed (after typing pauses). */
    onDidChange(listener: (event: { path: string }) => unknown): Disposable;
    /** A different file is in front (path null: none). */
    onDidChangeActiveEditor(listener: (event: { path: string | null }) => unknown): Disposable;
    /** The selection or cursor moved (settled, not every keystroke). */
    onDidChangeSelection(listener: (event: { path: string; selection: ActiveEditor["selection"] }) => unknown): Disposable;
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
