import type { PluginPermission } from "./types";

/**
 * The files of a new plugin ("Plugins: Create New Plugin…"): a manifest,
 * a working main.js, the API's type definitions (so editors autocomplete
 * `sable.`), and a README.
 */

/** The plugin API, as TypeScript declarations (also its reference docs). */
export const API_TYPES = `/**
 * Sable's plugin API — the \`sable\` object passed to your activate().
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
  /** insertText uses snippet syntax: $1, \${2:placeholder}, $0. */
  snippet?: boolean;
  detail?: string;
  documentation?: string;
  kind?: "function" | "method" | "variable" | "field" | "class" | "interface" | "module" | "property"
    | "keyword" | "snippet" | "constant" | "value" | "file" | "color";
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
  };

  statusBar: {
    /** Your plugin's item in the status bar; clicking runs \`command\` (one of yours). */
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
`;

export function pluginId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "my-plugin"
  );
}

export function scaffoldFiles(options: {
  id: string;
  name: string;
  author: string;
  permissions: PluginPermission[];
  sableVersion: string;
}): Record<string, string> {
  const { id, name, author, permissions, sableVersion } = options;
  const manifest = {
    id,
    name,
    version: "0.1.0",
    description: "",
    author,
    main: "main.js",
    permissions,
    ...(sableVersion ? { minSableVersion: sableVersion } : {}),
  };
  const usesEditor = permissions.includes("editor");
  const main = `// @ts-check
/** @typedef {import("./sable").Sable} Sable */

/**
 * Called when the plugin starts. Everything you register is removed
 * automatically when it stops (disabled, reloaded or uninstalled).
 * @param {Sable} sable
 */
export async function activate(sable) {
  sable.commands.register("hello", "Say Hello", async () => {
    await sable.window.showMessage(\`Hello from ${name}!\`);
  });
${
  usesEditor
    ? `
  // Counts words in the focused file (needs the "editor" permission).
  sable.commands.register("count-words", "Count Words", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const words = editor.text.split(/\\s+/).filter(Boolean).length;
    await sable.statusBar.set(\`\${words} words\`, { tooltip: "Click to recount", command: "count-words" });
  });

  // A formatter for plain-text files: Format Document (⇧⌥F) trims
  // trailing spaces.
  sable.languages.registerFormatter("plaintext", ({ text }) =>
    text.replace(/[ \\t]+$/gm, ""),
  );
`
    : ""
}
  console.log("${name} is running"); // shows in the Plugins view's log
}

/** Optional: called before the plugin stops. */
export function deactivate() {}
`;
  const readme = `# ${name}

A plugin for [Sable](https://github.com/riaanmathur01/sable-ide).

## Developing

This folder is *linked*: Sable runs the plugin from here and reloads it
every time you save a file in it (in Sable). \`console.log\` output shows
in the Plugins view (click the plugin to expand its log).

- \`sable-plugin.json\` — the manifest: id, name, version, and the
  \`permissions\` the plugin needs (\`editor\`, \`workspace:read\`,
  \`workspace:write\`, \`shell\`, \`network\`). Users see them before
  installing.
- \`main.js\` — one ES module that exports \`activate(sable)\` (and
  optionally \`deactivate()\`). It runs in a sandboxed worker, so it can't
  import other files: bundle dependencies into it (e.g. \`esbuild src/index.ts
  --bundle --format=esm --outfile=main.js\`).
- \`sable.d.ts\` — the API, for autocomplete and reference.

## Sharing

Push this folder to a GitHub repository. Others install it with
**Plugins → Install from URL** and the repository's URL (or a link to a
\`.zip\` / \`.tar.gz\` of the folder).
`;
  return {
    "sable-plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "main.js": main,
    "sable.d.ts": API_TYPES,
    "README.md": readme,
  };
}
