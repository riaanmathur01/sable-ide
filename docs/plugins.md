# Writing Sable plugins

A Sable plugin is a folder with two files:

```
my-plugin/
├── sable-plugin.json   the manifest
└── main.js             one ES module exporting activate(sable)
```

The quickest start is **Settings → Plugins → Create** (or *Plugins: Create New
Plugin…* in the command palette). Sable writes a working plugin with the
API's type definitions (`sable.d.ts`), loads it in development mode, and
opens `main.js`. It reloads every time you save a file in its folder, and
`console.log` output shows in its log under **Settings → Plugins → Installed**.

## The manifest

```json
{
  "id": "word-count",
  "name": "Word Count",
  "version": "1.0.0",
  "description": "Counts the words in the open file",
  "author": "You",
  "main": "main.js",
  "permissions": ["editor"],
  "minSableVersion": "0.3.2"
}
```

| Field | |
| ----- | --- |
| `id` | Lowercase letters, digits, `-` and `.`. Unique; installing a plugin with the same id updates it. |
| `name`, `version` | Required. `version` is `major.minor.patch`. |
| `main` | The module to run (default `main.js`), inside the folder. |
| `permissions` | What the plugin may do (below). Shown to users before they install it. |
| `minSableVersion` | Optional: the oldest Sable it works with. |
| `description`, `author`, `homepage` | Optional, shown in Settings → Plugins. |
| `keybindings` | Optional keyboard shortcuts for your commands (below). |
| `runtime` | Optional: `"node"` runs the plugin in Node.js instead of a worker (below). Needs the `node` permission. |

### Keyboard shortcuts

```json
"keybindings": [
  { "command": "convert", "key": "ctrl+alt+c", "mac": "cmd+alt+c" }
]
```

`command` is an id you pass to `sable.commands.register`. Keys use VS
Code's notation: `ctrl`, `shift`, `alt`, `cmd` (or `ctrlcmd` for ⌘ on a
Mac and Ctrl elsewhere), and a key — a letter, digit, `f1`–`f19`,
`up`/`down`/`left`/`right`, `enter`, `tab`, `escape`, or punctuation.
`mac` is used on a Mac instead of `key`. Sable's own shortcuts win if
they clash; chords (`ctrl+k ctrl+c`) aren't supported. Users can rebind
your commands in **Settings → Keyboard Shortcuts**, like any other.

### Permissions

| Permission | Allows |
| ---------- | ------ |
| *(none)* | Commands, status-bar items, messages, save/open events |
| `editor` | Reading and changing the open file; formatters, completions and diagnostics |
| `workspace:read` | Reading files in the open folder |
| `workspace:write` | Creating and changing files in the open folder |
| `shell` | Running commands (in your login shell, in the open folder) |
| `network` | `fetch`, `WebSocket` and the other network APIs |
| `node` | Running in Node.js, with full access to your files, processes and network (converted VS Code extensions that need Node) |

A call without its permission throws an error naming the permission to
add.

## How plugins run

Each plugin runs in its own Web Worker (unless it uses the Node runtime,
below). A worker can't reach Sable's backend, so the `sable` API is all a
plugin can do, and the host checks every call against the plugin's
permissions. File access is confined to the open folder, including
through symlinks. Without `network`, the worker's network APIs are
removed. Everything a plugin registers (commands, formatters,
diagnostics, decorations, views, its status item) is removed when it
stops.

The sandbox keeps plugins to what they declare, but it isn't a security
boundary against a determined attacker. Only install plugins you trust.

`main.js` runs as a single module, so it can't import other files.
Bundle dependencies into it:

```sh
npx esbuild src/index.ts --bundle --format=esm --outfile=main.js
```

### The Node runtime

A plugin with `"runtime": "node"` and the `node` permission runs in a
Node.js process instead, as VS Code extensions do. It gets the same
`sable` API over the same protocol, but also Node itself — `require`,
`fs`, `child_process`, its own `node_modules` — so the sandbox doesn't
apply. Installing one shows that it has full access to your computer.
Sable runs the `node` on your `PATH`. If there isn't one, the plugin runs
in the worker instead and its log explains what's missing. This runtime
is mainly for converted VS Code extensions (below). A plugin you write
yourself is usually better off in the sandbox.

In a remote window (SSH, WSL, a container), Node plugins still run on
your machine, not the remote one.

## Example

```js
// @ts-check
/** @typedef {import("./sable").Sable} Sable */

/** @param {Sable} sable */
export async function activate(sable) {
  // A command in the palette: "Word Count: Count Words".
  sable.commands.register("count", "Count Words", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const words = editor.text.split(/\s+/).filter(Boolean).length;
    await sable.statusBar.set(`${words} words`, { command: "count" });
  });

  // A linter: flag TODOs whenever a file is saved.
  sable.events.onDidSave(async ({ path }) => {
    const editor = await sable.editor.active();
    if (!editor || editor.path !== path) return;
    const diagnostics = editor.text.split("\n").flatMap((line, index) =>
      line.includes("TODO") ? [{ line: index + 1, message: "Unfinished TODO", severity: "info" }] : [],
    );
    await sable.languages.setDiagnostics(path, diagnostics);
  });
}

export function deactivate() {}
```

## API

Every method returns a Promise. Paths are absolute, or relative to the
open folder. Lines and columns are 1-based, like the editor.

### `sable.commands`
- `register(id, title, run, { hidden? })` adds *Plugin Name: title* to
  the command palette (`hidden: true` keeps it out of the palette, for
  commands only a status item, code lens or tree item runs). Returns a
  `Disposable`.
- `execute(id)` runs one of your commands.

### `sable.window`
- `showMessage(text)`, `showError(text)`: status-bar messages.
- `showWarning(text)`: a status-bar warning.
- `showQuickPick(items, { placeholder? })` asks the user to choose from
  a list, shown like the command palette and filterable as they type.
  Items are strings or `{ label, description?, detail? }`. It resolves to
  the chosen item as you passed it, or `null` if dismissed.
- `showInputBox({ prompt?, placeholder?, value? })` asks for a line of
  text; resolves to it, or `null` if dismissed.

### `sable.statusBar`
- `set(text, { tooltip?, command? })`: your status-bar item. Clicking it
  runs `command`, one of your command ids.
- `clear()`

### `sable.editor` (needs `editor`)
- `active()` returns the focused file:
  `{ path, language, text, selection: { start, end, text } | null }`, or
  `null`.
- `replaceSelection(text)`: replace the selection, or insert at the
  cursor. Undoable.
- `setText(text)`: replace the whole file. Undoable.
- `applyEdits([{ range: { start, end }, text }])`: several edits as one
  undo step. Ranges refer to the text before any of the edits.
- `setSelection({ start, end })`: select a range (or place the cursor)
  and scroll to it.
- `executeAction(id)`: run an editor action — Monaco's ids are VS Code's
  (`editor.action.formatDocument`, `editor.action.commentLine`, …).
- `open(path, { line? })` (`workspace:read`): open a file of the folder.
- `createDecorationType(key, options)`, `setDecorations(path, key, items)`,
  `disposeDecorationType(key)`: styled ranges in the editor (VS Code's
  text-editor decorations). `options` are VS Code's
  `DecorationRenderOptions` — `color`, `backgroundColor`,
  `fontWeight`, `fontStyle`, `textDecoration`, `border`, `isWholeLine`,
  `overviewRulerColor`, `before`/`after` (`contentText`, `color`, …),
  `light`/`dark` — and colours can be VS Code theme ids
  (`{ id: "editorError.foreground" }`). Items are `{ range, hoverMessage?,
  renderOptions? }`, with **0-based** `{ line, character }` positions as in
  VS Code. `path: null` means the active file. Setting a key again
  replaces that key's decorations.

### `sable.env`
- `clipboard.readText()`, `clipboard.writeText(text)`.
- `openExternal(url)`: open an http(s) or mailto link in the browser.

### `sable.terminal` (needs `shell`)
- `create({ name?, cwd?, shellPath?, shellArgs?, env? })` opens a
  terminal and resolves to its id. With `shellPath`, it runs that program
  instead of your shell.
- `sendText(id, text, addNewLine = true)`, `show(id)`, `dispose(id)`.

### `sable.webview`
HTML pages in an editor tab, or in a sidebar view (below). Each page is a
sandboxed frame with its own origin. It can't reach Sable, and it talks
to your plugin with messages. `acquireVsCodeApi()` works inside it
(`postMessage`, `getState`, `setState`), VS Code's `--vscode-*` CSS
theme variables are set from Sable's theme, and `<body>` gets
`vscode-dark` or `vscode-light`.
- `create(id, { title?, enableScripts?, view? }, listener)`: `listener`
  gets `{ type: "message", message }` for the page's messages and
  `{ type: "dispose" }` when the user closes it. `view: true` is for a
  sidebar view's page: it doesn't open a tab.
- `setHtml(id, html)`, `setTitle(id, title)`, `postMessage(id, message)`,
  `reveal(id)`, `dispose(id)`.

Links to `sable-resource:<absolute path>` (what a converted extension's
`asWebviewUri` returns) are inlined, so a page can use your plugin's
images, scripts and styles.

### `sable.views`
Views in the sidebar's **Plugin Views** section (its activity-bar icon
appears once a plugin declares one).
- `declare(views, handler)`: `views` are `{ id, name, kind }`, where
  `kind` is `"tree"` or `"webview"`. `handler` gets requests:
  `{ op: "children", viewId, nodeId }` (`nodeId` undefined for the top
  level), answered with nodes `{ id, label, description?, tooltip?,
  collapsible, icon?, command? }` (`collapsible`: 0 none, 1 collapsed,
  2 expanded; `command`: `{ id, arguments? }`, one of your commands, run
  on click). For a webview view it gets `{ op: "resolve", viewId }`: create
  a webview with that id and `view: true`.
- `refresh(id)` asks for a view's nodes again. `reveal(id)` shows the
  Plugin Views section.

### `sable.storage`
Values kept for your plugin between runs (JSON, 1 MB in all).
- `get(key)` (or `null`), `set(key, value)` (`null` removes it), `keys()`.

### `sable.workspace`
- `root`: the open folder, or `null`. It stays current when the folder
  changes.
- `readFile(path)` (`workspace:read`): sees unsaved edits.
- `writeFile(path, text)` (`workspace:write`): creates folders as needed.
  Open files update undoably.
- `listFiles()` (`workspace:read`): every file (respecting `.gitignore`),
  as relative paths.
- `listDirectory(path)` (`workspace:read`): `{ name, isDirectory }[]`.
- `createDirectory(path)`, `delete(path)`, `rename(from, to)`
  (`workspace:write`).
- `onDidChangeRoot(listener)`: the folder changed; gets the new root (or
  `null`).

### `sable.events`
- `onDidSave(listener)`, `onDidOpen(listener)`: the listener gets
  `{ path }`. Returns a `Disposable`.
- `onDidChange(listener)`: a file's text changed (after typing pauses);
  gets `{ path }`.
- `onDidChangeActiveEditor(listener)`: a different file is in front;
  gets `{ path }` (`null` for none).
- `onDidChangeSelection(listener)`: the selection or cursor moved
  (settled); gets `{ path, selection }`.
- `onDidChangeDiagnostics(listener)`: problems changed (from any source:
  language servers, linters, plugins).

### `sable.languages` (needs `editor`)
Language ids are Monaco's (`python`, `typescript`, `rust`, `plaintext`, …);
`"*"` means every language.
- `registerFormatter(language, ({ path, language, text }) => newText)`
  plugs into Format Document (⇧⌥F) and format on save.
- `registerCompletions(language, request => items, { triggerCharacters? })`.
  The request is `{ path, language, text, line, column, linePrefix, word }`.
  Items are `{ label, insertText?, snippet?, detail?, documentation?, kind?, replace? }`.
  `replace` is how many characters before the cursor the item replaces;
  by default it replaces the word being typed. The editor asks once (at a
  trigger character or the start of a word) and narrows the list itself
  as the user types on, so return every candidate, not just the best few.
- `registerHover(language, request => markdown | null)` shows a tooltip
  when the pointer rests on text. The request is `{ path, language, text,
  line, column, lineText, word }`; return Markdown (or
  `{ contents, range? }`), or `null` for no tooltip.
- `registerRenameSuggestions(language, ({ path, language, name, line }) => names)`
  lists names under the rename box (F2, or ⇧F6) as soon as it opens; the
  user picks one with ↓ and Enter, or keeps typing. `language` can be `"*"`
  for every language. Case Converter uses it to offer the symbol in other
  cases.
- `setDiagnostics(path, diagnostics)` sets squiggles and Problems entries,
  replacing your earlier ones for that file. A diagnostic is
  `{ line, column?, endLine?, endColumn?, message, severity?, source? }`,
  where severity is `"error"` (the default), `"warning"`, `"info"` or
  `"hint"`.
- `clearDiagnostics(path?)` clears one file's diagnostics, or all of them.
- `getDiagnostics(path?)`: every problem Sable knows of, from every
  source, as `{ path, diagnostics: [{ range, message, severity, source?,
  code? }] }[]` (0-based ranges; severity 0 error … 3 hint, as in VS Code).

The rest of VS Code's language features go through one call, with
VS Code's shapes and **0-based** positions:

- `registerProvider(kind, language, provide)`, where `kind` is
  `definition`, `declaration`, `typeDefinition`, `implementation`,
  `references`, `documentHighlight`, `documentSymbol`, `codeAction`,
  `codeLens`, `signatureHelp`, `rename`, `documentLink`, `foldingRange`,
  `inlayHint` or `color`. `provide` gets `{ path, language, text,
  position?, range?, … }` and returns what VS Code's provider of that kind
  returns, as plain objects. The VS Code layer is the reference:
  `src-tauri/src/vscode_shim.js`.
- `refreshCodeLenses()` asks the editor for your code lenses again.
- `contribute(languages, grammars)` adds languages (VS Code's
  `contributes.languages`: ids, extensions, file names, comments,
  brackets) and their TextMate grammars (JSON).

### `sable.shell` (needs `shell`)
- `run(command, { timeoutSeconds? })` returns
  `{ stdout, stderr, exitCode, timedOut }`. It runs non-interactively in
  your login shell, in the open folder.

### Other
- `sable.manifest`: your manifest.
- `sable.version`: Sable's version.

## Converting a VS Code extension

Many VS Code extensions run in Sable unchanged. **Settings → Plugins →
Create → Convert a VS Code extension** (or **Plugins: Convert VS Code
Extension…** in the command palette) takes:

- an extension id, `publisher.name` (e.g. `Tyriar.sort-lines`), or its
  [Open VSX](https://open-vsx.org) or VS Code Marketplace link — Sable
  downloads it from Open VSX, the open registry VS Code-compatible
  editors use;
- or a `.vsix` file you downloaded (the Marketplace page's *Download
  Extension* link), via **Choose .vsix…**.

Sable reads the extension's `package.json` — name, version, commands
(with their titles), keybindings, settings defaults, languages and
grammars, with `%placeholders%` translated — and writes a Sable plugin
around its code with a compatibility layer
(`src-tauri/src/vscode_shim.js`) that answers `require("vscode")`. It
installs like any plugin (you see its permissions first), and **Update**
fetches the latest version again.

**Where it runs.** An extension with a `main` entry (most of them) runs
**in Node.js**, as in VS Code, with its whole folder and `node_modules`.
`fs`, `child_process`, `http`, `path` and the rest of Node work, so
extensions that read files, run programs or make requests work too. It
gets the `node` permission, which the install dialog warns about. An
extension with only a `browser` entry (made for VS Code for the Web)
runs in the sandboxed worker. Without Node.js installed, Node extensions
fall back to the worker, where the parts that need Node fail.

**What works:**

- Commands (`registerCommand`, `registerTextEditorCommand`,
  `executeCommand` for its own commands, `editor.action.*` and common
  `workbench.*` ones) and keybindings.
- The active editor and its document (`getText`, `lineAt`, `offsetAt`,
  `positionAt`, `getWordRangeAtPosition`, …), `editor.edit`,
  `WorkspaceEdit` and `applyEdit`, selections, `visibleTextEditors`, and
  document and editor events.
- **Language features:** completion, hover, formatting, diagnostics
  (`createDiagnosticCollection`, `getDiagnostics`,
  `onDidChangeDiagnostics`), definition, declaration, type definition,
  implementation, references, document highlights, document symbols
  (the outline and Go to Symbol), code actions (quick fixes, with their
  edits and commands), code lenses, signature help, rename, document
  links, folding ranges, inlay hints and colour pickers.
- **Languages and grammars** from `contributes.languages` and
  `contributes.grammars` (JSON grammars), so an extension that adds a
  language gets its highlighting, comments and brackets. Sable also
  supplies what VS Code's built-in language extensions declare
  (comment syntax for common languages) for extensions that read it.
- **Decorations** (`createTextEditorDecorationType`, `setDecorations`):
  colours, backgrounds, borders, whole-line styles, overview-ruler marks,
  and `before`/`after` text, as Error Lens and Better Comments use.
- **Webviews:** `createWebviewPanel` in an editor tab and
  `registerWebviewViewProvider` in the sidebar, with messages both ways,
  `getState`/`setState`, theme variables and `asWebviewUri` resources.
- **Tree views:** `registerTreeDataProvider` and `createTreeView`, in the
  sidebar's Plugin Views section, with expandable nodes, icons,
  descriptions, tooltips, click commands and refresh.
- **Terminals:** `createTerminal` (with `shellPath`, `cwd`, `env`),
  `sendText`, `show`, `dispose`.
- Messages with buttons, `showQuickPick`, `showInputBox`,
  `createQuickPick`, `createInputBox`, status-bar items, output channels
  (to the plugin log), `withProgress`.
- `workspace.getConfiguration` (defaults from `package.json`; `update`
  remembers values), `workspace.fs` (all of it), `findFiles`,
  `openTextDocument`, `workspaceFolders`, `getWorkspaceFolder`,
  `asRelativePath`, the clipboard, `openExternal`,
  `globalState`, `workspaceState`, `secrets` and the extension context's
  paths.

These have been tried end to end: Better Comments, Bookmarks, Error
Lens, REST Client, Code Runner and Sort Lines.

**What doesn't (yet):** custom editors, notebooks, debug adapters
(Sable's debugger has its own), file-system watchers, source-control
providers, authentication
providers, tasks, testing, `vscode.lm`/chat, plist (`.tmLanguage`) and
YAML grammars, and extensions that depend on another extension's API.
Calls into these are accepted and do nothing, so the extension still
loads, and its log notes what it skipped. Themes and snippet-only
extensions have no code to run and aren't converted.

To check what a converted extension is doing, open it in **Settings →
Plugins → Installed** and look at its log.

## Sharing a plugin

Push the plugin folder to a GitHub repository, with `sable-plugin.json` at
the top. Others install it from **Settings → Plugins → Marketplace →
Install from elsewhere** with the repository
URL, which installs the default branch. A `/tree/<branch-or-tag>` URL
installs that version, and `/tree/<branch>/<folder>` installs a plugin in
a subfolder, so one repository can hold several. A link to a `.zip` or
`.tar.gz` of the folder also works. Plugins installed from a URL get an
**Update** button that downloads them again.

### The Marketplace

**Settings → Plugins → Marketplace** lists the plugins in a catalogue,
[`plugins/registry.json`](../plugins/registry.json) in this repository.
To list yours, open a pull request adding an entry. The format is in
[`plugins/README.md`](../plugins/README.md). Each plugin's **Details**
page shows its `README.md`, so include one. Users get an **Update**
button when the catalogue lists a newer version than theirs. A team can
run a private marketplace by pointing **Marketplace URL** (on the same
page) at its own catalogue file.
