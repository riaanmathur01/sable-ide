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

### Permissions

| Permission | Allows |
| ---------- | ------ |
| *(none)* | Commands, status-bar items, messages, save/open events |
| `editor` | Reading and changing the open file; formatters, completions and diagnostics |
| `workspace:read` | Reading files in the open folder |
| `workspace:write` | Creating and changing files in the open folder |
| `shell` | Running commands (in your login shell, in the open folder) |
| `network` | `fetch`, `WebSocket` and the other network APIs |

A call without its permission throws an error naming the permission to
add.

## How plugins run

Each plugin runs in its own Web Worker. A worker can't reach Sable's
backend, so the `sable` API is all a plugin can do, and the host checks
every call against the plugin's permissions. File access is confined to
the open folder, including through symlinks. Without `network`, the
worker's network APIs are removed. Everything a plugin registers
(commands, formatters, diagnostics, its status item) is removed when it
stops.

The sandbox keeps plugins to what they declare, but it isn't a security
boundary against a determined attacker. Only install plugins you trust.

`main.js` runs as a single module, so it can't import other files.
Bundle dependencies into it:

```sh
npx esbuild src/index.ts --bundle --format=esm --outfile=main.js
```

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
- `register(id, title, run)` adds *Plugin Name: title* to the command
  palette. Returns a `Disposable`.
- `execute(id)` runs one of your commands.

### `sable.window`
- `showMessage(text)`, `showError(text)`: status-bar messages.
- `showQuickPick(items, { placeholder? })` asks the user to choose from
  a list, shown like the command palette and filterable as they type.
  Items are strings or `{ label, description?, detail? }`. It resolves to
  the chosen item as you passed it, or `null` if dismissed.

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

### `sable.workspace`
- `root`: the open folder, or `null`. It stays current when the folder
  changes.
- `readFile(path)` (`workspace:read`): sees unsaved edits.
- `writeFile(path, text)` (`workspace:write`): creates folders as needed.
  Open files update undoably.
- `listFiles()` (`workspace:read`): every file (respecting `.gitignore`),
  as relative paths.

### `sable.events`
- `onDidSave(listener)`, `onDidOpen(listener)`: the listener gets
  `{ path }`. Returns a `Disposable`.

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

### `sable.shell` (needs `shell`)
- `run(command, { timeoutSeconds? })` returns
  `{ stdout, stderr, exitCode, timedOut }`. It runs non-interactively in
  your login shell, in the open folder.

### Other
- `sable.manifest`: your manifest.
- `sable.version`: Sable's version.

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
