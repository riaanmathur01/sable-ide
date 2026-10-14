# Sable

A fast, minimal, dark code editor in the spirit of VS Code — built with
[Tauri 2](https://tauri.app) (Rust backend + native OS webview) and
React + TypeScript. No Electron, no telemetry. Everything runs locally;
the only network calls are the ones you make on purpose (git
push/pull/fetch, and the AI agent when you message it).

## Download

**[Get the latest release →](https://github.com/riaanmathur01/sable-ide/releases/latest)**

| Your computer | Download |
| ------------- | -------- |
| Mac with Apple silicon (M1 or later) | `Sable_<version>_macOS_Apple-Silicon.dmg` |
| Mac with an Intel processor | `Sable_<version>_macOS_Intel.dmg` |
| Windows 10/11 (64-bit) | `Sable_<version>_Windows_x64-setup.exe` (or the `.msi`) |
| Linux (64-bit), Debian / Ubuntu | `Sable_<version>_Linux_x64.deb` |
| Linux (64-bit), Fedora / RHEL / openSUSE | `Sable_<version>_Linux_x64.rpm` |
| Linux (64-bit), any distribution | `Sable_<version>_Linux_x64.AppImage` |

Not sure which Mac you have? Apple menu → About This Mac: "Chip: Apple M…"
means Apple silicon. The `.app.tar.gz`, `.sig` and `latest.json` files
are for automatic updates; you don't need them. Once installed, Sable
offers new versions itself (“Check for Updates…”).

The builds aren't code-signed yet. The first time you open Sable, macOS
says it can't verify the developer. Right-click the app → Open, or go to
System Settings → Privacy & Security → Open Anyway. Windows SmartScreen
may ask once too (More info → Run anyway).

## Features

- **Editor** — Monaco with tabs, a minimap (with errors, search matches
  and breakpoints marked), split editor (up to three groups),
  auto-save, format on save, bracket-pair colors, sticky scroll, font
  zoom, Back/Forward through the places you've been (⌘[ / ⌘], ⌃- / ⌃⇧-,
  mouse side buttons), and session restore. JetBrains Mono is bundled; the font picker
  lists every monospace font installed on your machine.
- **Vim mode** — normal, insert, visual and visual-line modes, motions,
  operators, counts, registers, marks, macros, `/` search, `.` repeat, and
  `:w`, `:q`, `:wq`, `:s` and other ex commands, with a mode line under
  the editor. Turn it on in Settings → Editor → Vim Mode, or with
  “View: Toggle Vim Mode”. On Windows and Linux, the Ctrl keys Vim uses
  (Ctrl+R, Ctrl+O, Ctrl+V, Ctrl+D, …) go to Vim while it's on.
- **Highlighting** — the same TextMate grammars VS Code uses (via
  [Shiki](https://shiki.style)), plus semantic highlighting from the
  language servers (parameters, `self`, fields, mutable bindings,
  declarations vs. calls). Themes: Sable Dark, all four Catppuccin flavours (Latte — light —
  Frappé, Macchiato and Mocha), and three
  JetBrains themes — Darcula, Dark, and Islands Dark — with the exact
  colors each JetBrains IDE uses for its language (PyCharm for Python,
  WebStorm for JS/TS, GoLand, RustRover, CLion, IntelliJ IDEA for Java and
  Kotlin, PhpStorm, RubyMine, Rider for C#), extracted from the IDEs
  themselves (`scripts/jetbrains-colors/`).
- **Explorer** — virtualized, lazily loaded file tree with
  create/rename/delete/drag-to-move and a live file watcher.
- **Search** — project-wide content + file-name search and replace
  (ripgrep engine), with case/word/regex options.
- **Formatting** — Format Document (⇧⌥F) and format on save for every
  supported language: Go, Rust, C/C++ and Java through their language
  servers (gofmt, rustfmt, clang-format, Eclipse's formatter), Python
  through Ruff (from your venv, PATH, or one-click install) or Black, and
  TS/JS, JSON, CSS and HTML built in.
- **Terminal** — real PTY shells (xterm.js), several at once; ⌘R runs the
  active file.
- **Notebooks** — `.ipynb` files open in a notebook editor (“Notebook:
  Open as Text” shows the JSON): code cells are small Monaco editors,
  Markdown cells render until you edit them, and cells run on a real
  Jupyter kernel started with the workspace's Python interpreter (via
  `jupyter_client`; one click installs `ipykernel` if it's missing).
  JupyterLab's keys (Shift/⌘/Alt+Enter, Esc/Enter, A/B, D D, Z, M/Y,
  I I, 0 0), Run All / Above / Below, Interrupt, Restart (& Run All),
  Clear Outputs, a kernel picker, `[n]` counts with run times, kernel
  completions and hover, and `input()`. Outputs: streams and tracebacks
  with ANSI colors, images, SVG, HTML (scripted HTML such as Plotly in a
  sandboxed frame), Markdown, JSON, `clear_output` and updatable
  displays. Saves nbformat 4 as Jupyter does, keeping metadata, cell ids
  and attachments; works in remote workspaces too.
- **SQLite databases** — `.db`, `.sqlite`, `.sqlite3`, `.db3` files (and
  any file starting with SQLite's header) open in a database editor like
  DB Browser for SQLite: **Database Structure** (tables with their
  columns, PK/NN/U/AI/foreign-key markers and defaults, indexes, views,
  triggers and their CREATE statements; Create / Modify / Delete Table,
  Create Index), **Browse Data** (a virtualized grid that pages through
  millions of rows, sort, a filter under each column — text contains,
  `=x`, `>x`, `<=x`, `<>x`, `x~y`, `NULL` — and across all columns,
  inline editing, an Edit Cell pane with JSON, hex and image views and
  blob import/export, New/Delete Record, copy as TSV, click a foreign key
  to jump to its row), **Edit Pragmas** and **Execute SQL** (tabs, Run
  All ⌘↵ / Run Current ⇧⌘↵, results, timings, errors with their line,
  history). Edits stay in a transaction until **Write Changes** (⌘S);
  **Revert Changes** drops them, and closing asks. Export CSV, JSON or a
  SQL dump, import CSV, Integrity Check, Vacuum. Read-only files open
  read-only; works in remote workspaces too.
- **Run configurations** — per-file program arguments, environment
  variables and working directory (the sliders button next to Run, or
  "Run: Edit Configuration…"), used by both Run and Debug.
- **Language intelligence** — squiggles, a Problems panel, quick fixes
  (⌘.), completions, hover, go-to-definition, and signature help over LSP:
  Python (basedpyright or Pyright), TypeScript/JavaScript
  (typescript-language-server, project-aware), Java (jdtls), Rust
  (rust-analyzer), Go (gopls), C/C++ (clangd), PHP (Intelephense —
  one-click install), Ruby (Ruby LSP or Solargraph), C# (csharp-ls) and
  Kotlin (JetBrains' Kotlin LSP, in Gradle/Maven projects). Python gets extra
  quick fixes Pyright lacks: add a missing import, remove unused imports,
  `pip install` a missing package. Any error can also be sent to the AI
  agent ("Fix with Agent").
- **Code navigation** (JetBrains shortcuts) — Search Everywhere (⇧⇧),
  Go to Symbol (⌥⌘O), File Structure (⌘F12), Recent Files / Locations
  (⌘E / ⇧⌘E), Find Usages (⌥F7) in a results panel, Go to Implementation
  / Type Declaration (⌥⌘B / ⇧⌘B), Call Hierarchy (⌃⌥H), and inlay hints
  (argument names) — through the language servers for Python, JS/TS, Java,
  Go, Rust and C/C++.
- **Rename refactoring** — F2 or ⇧F6 (JetBrains' shortcut) renames a
  symbol everywhere it's used in the project, through the language server:
  Python, TypeScript/JavaScript, Java (a class's file is renamed too),
  Rust, Go, C and C++. CSS, SCSS, Less and HTML use Monaco's built-in
  rename; other languages (Kotlin, PHP, Ruby, C#, …) rename within the
  file, skipping strings and comments.
- **Refactorings** (JetBrains shortcuts) — Extract Variable (⌥⌘V),
  Extract Method (⌥⌘M), Extract Constant (⌥⌘C), Inline (⌥⌘N), and
  Refactor This (⌃T) for everything available at the cursor. An
  extraction then renames the new name in place. Go, Rust, C/C++, Java
  and TypeScript/JavaScript refactor through their language servers;
  Python through [Rope](https://github.com/python-rope/rope) (installed
  into Sable's tools folder on first use), with two safety nets: an
  inlined value keeps its meaning (`x = 2 + 3; x * 2` → `(2 + 3) * 2`),
  and a result that doesn't parse is refused.
- **Safe Delete, Change Signature, Move** (JetBrains' deeper
  refactorings; also in ⌃T, the light bulb and the palette). **Safe
  Delete** (⌘⌫ on a declaration's name / Alt+Delete; Explorer → Safe
  Delete… for a file) looks for usages first: none, and it's deleted
  (with its decorators, doc comment and blank line); otherwise a dialog
  lists them by file — Delete Anyway, View Usages, Cancel. On a
  parameter it removes the argument at every call too. **Change
  Signature** (⌘F6 / Ctrl+F6): name, parameters (rename, type, default,
  reorder, add with a value for existing calls, remove; Python's
  keyword-only), return type, with a live preview; every call follows
  (keyword arguments too), and overrides. **Move** (F6) moves a
  top-level class, function or constant to another file — existing or
  new — taking the imports it needs, importing it where it's used and
  dropping imports the source no longer needs. Renaming or dragging a
  file in the Explorer offers to update its imports. Each shows a
  Refactoring Preview (a diff of every file, problems such as a name
  clash or a removed parameter still in use listed first) and applies as
  one step, undone in every file at once (the Undo after it, or
  *Refactor: Undo Last Refactoring*). Python works through Rope;
  TypeScript/JavaScript through the TypeScript language service (Monaco's
  TypeScript, over the workspace's files — with or without
  typescript-language-server); other languages (Java, Go, Rust, C/C++,
  C#, Kotlin, PHP, Ruby) on their language server's references with text
  rewriting, labeled best effort (Move: Python and TS/JS only).
- **Debugger** — breakpoints (saved per project, and they follow your
  edits), continue/step/pause, call stack, variables, debug console, and
  stop on uncaught exceptions, for:

  | Language | Debug adapter | Setup |
  | -------- | ------------- | ----- |
  | Python | debugpy | one-click install into the selected interpreter |
  | JavaScript, TypeScript | js-debug (VS Code's) | one-click install |
  | Go | Delve | `brew install go delve` |
  | Java | java-debug inside jdtls | one-click install |
  | C, C++, Rust | lldb-dap | Xcode Command Line Tools / rustup |

  Programs being debugged run in a terminal tab, so they can read
  keyboard input (`input()`, `scanf`, `bufio.Reader`, …).

  While paused, each variable's value shows **inline** at the end of the
  last line that uses it, and **Stop on Exceptions** chooses which
  exceptions pause (the kinds each debugger offers — e.g. Python's raised /
  uncaught / user-uncaught), remembered per debugger.

  Right-click a line in the gutter for a **conditional breakpoint**, a
  **hit count** ("stop the 3rd time"), or a **logpoint** (prints a
  message with `{expressions}` and keeps running). **Watch expressions**
  re-evaluate at every pause. **Attach to Process…** debugs a program
  that's already running — Python (`python -m debugpy --listen 5678`),
  Node (`--inspect`), Java (JDWP port), or a Go / C / C++ / Rust process
  picked from a list; stopping detaches and leaves it running.

  **launch.json.** Projects with `.vscode/launch.json` (or a
  `.code-workspace` file's `launch`) debug with their own configurations:
  the Run and Debug view's dropdown lists them (`Name (folder)` in
  multi-root workspaces) and F5 starts the selected one. VS Code's
  variables (`${workspaceFolder}`, `${file}`, `${env:…}`, `${input:…}`,
  `${command:pickProcess}`, …), `envFile`, `preLaunchTask` /
  `postDebugTask` from `.vscode/tasks.json`, and `compounds` work; types
  map onto Sable's debuggers (debugpy, js-debug incl. Chrome, Delve,
  lldb-dap for `lldb`/`cppdbg`/`codelldb`, java-debug). The gear opens
  launch.json (creating one from a template), **Add Configuration…**
  inserts snippets.

  C, C++, and Rust files are compiled with debug info first (Cargo
  projects build with `cargo build`). TypeScript runs directly on Node 22.18+
  (type stripping keeps line numbers, so no source maps are needed).
- **Tests** — "▶ Run | Debug" above every test, with ✓/✗ from the last
  run, and a Tests panel (rerun, rerun failed, failure details) for
  pytest, Vitest, Jest, Go, Cargo and JUnit (Maven/Gradle). ⌃⇧R / ⌃⇧D
  run or debug the test at the cursor — debugging works for every one of
  them (Java tests: Maven/Gradle start the test JVM, which connects to
  Sable, and java-debug attaches through it). **Run with Coverage** marks
  each line that ran green, partly ran amber, or didn't red, with the
  percentage in the Tests panel — pytest (pytest-cov), Vitest
  (@vitest/coverage-v8), Jest and Go.
- **Git** — status, stage/commit, diffs, history, blame, branches,
  push/pull/fetch, and:
  - **partial commits** — "Stage hunk" / "Unstage hunk" above each change
    in a diff, so one file's changes can go into different commits;
  - **merges** — merge a branch from the branch picker; conflicts get
    "Accept Current | Accept Incoming | Accept Both" in the editor and a
    three-way merge tool (current / result / incoming). Commits made
    during a merge record both parents; a merge can be aborted;
  - **stash** — stash changes (with a message, optionally new files too),
    see a stash's files and diffs, apply / pop / drop;
  - **cherry-pick and revert** — the History view shows any branch's
    commits; right-click one to cherry-pick it onto the current branch
    (keeping its author) or revert it. Conflicts go to the merge tool;
  - **rebase** — onto another branch (branch picker) or a commit, and
    **interactive rebase** (History → right-click → Interactive Rebase
    from Here…): reorder, reword, squash, fixup or drop. A rebase that
    stops for conflicts shows Continue / Skip / Abort;
  - **commit graph** — History draws branches and merges, with branch
    and tag labels; "All branches" shows every branch at once.
- **Tasks** — the project's scripts under the file tree, and "Run Task"
  in the command palette: npm/pnpm/yarn/bun scripts, Makefile targets,
  just recipes, pyproject scripts, Deno and Composer tasks, and the usual
  Cargo, Go, Maven and Gradle commands. Each runs in its own terminal tab.
- **Inline AI completions** — grey suggestions as you type; Tab accepts.
  Uses the agent's provider with a fast model (Claude Haiku 4.5 by
  default). Off by default — each suggestion is an API call on your key:
  Settings → AI Completions, or “AI: Toggle Inline Completions”.
- **Color picker** — wherever a color goes (a hex code, `rgb()`/`hsl()`,
  an empty CSS color value, an empty string for something named like a
  color, a `#` just typed), the light bulb (⌘.) offers **Pick a Color…**;
  colors in the code also get a swatch that opens it. Pick by eye, with
  the eyedropper, or by typing any CSS color; the code shows it as you go,
  Enter puts in the hex (Escape puts back what was there), and the same
  color is listed in every format to copy or insert: RGB, HSL, HSV, HWB,
  OKLCH, CMYK, CSS names, SwiftUI/UIKit, Android, Flutter, Unity, .NET.
- **Markdown preview** — ⇧⌘V (or the book icon) shows a `.md` file
  rendered beside it, updating as you type: GitHub-flavored Markdown
  (tables, task lists), code in the editor's colors, the file's images,
  links that open in Sable or the browser.
- **Snippets** — built-in templates (psvm, sout, fori, ifmain, iferr, …)
  and your own in VS Code's format: “Snippets: Configure User Snippets”
  opens `snippets/<language>.json` next to settings.json (`global.json`
  for every language).
- **Breadcrumbs** — above each editor: the file's path in its workspace
  folder, then the symbols around the cursor (`src › lib › themes.ts ›
  themeById`, from the language server or Monaco's own outline). Click a
  folder for its files, a symbol for its neighbours; ⇧⌘. focuses them
  (←/→, Enter, Esc). “View: Toggle Breadcrumbs” hides them.
- **Emmet** — `ul>li*3`, `.card>h2+p`, `m10`, `df`, `jcsb` … in HTML,
  JSX/TSX (`className`, `<img />`), Vue, Svelte, XML and CSS/SCSS/Less:
  Tab expands (tab stops become placeholders), and the expansion shows in
  the suggestion list with a preview. Never in plain JavaScript, strings
  or comments. Wrap with Abbreviation, Balance outward/inward, Go to
  Matching Pair, Remove Tag and Update Tag in the command palette.
- **Spell check** — comments, strings, identifiers (`getUserProfleId` is
  checked as get/User/Profle/Id) and Markdown/plain text, against a
  bundled US or UK English dictionary plus programming terms; code
  keywords, URLs, hex, UUIDs and short words are skipped. The quick fix
  (⌘.) suggests corrections, or adds the word to your dictionary, the
  workspace's (`cSpell.words` in `.vscode/settings.json`, shared with VS
  Code's Code Spell Checker; `cspell.json` is read too) or ignores it in
  the file. Spelling stays out of the Problems panel.
- **Compare** — any two files (Explorer → Select for Compare / Compare
  with …, or “File: Compare Active File With…”), a file's unsaved changes
  (“Compare with Saved”), or a file against the clipboard.
- **Local history** — every version Sable saves of a file is kept
  (also the original before your first save, and a file's contents when
  it's deleted), git or not: right-click a file → Local History to compare
  any version with the current one and revert; "Local History: Recover
  Deleted File…" brings deleted files back. Up to 100 versions per file
  for 30 days; rapid auto-saves merge into one version per minute.
- **AI agent** — a chat panel (⌘L) that can read, search, and edit your
  code, run commands, and use git and the GitHub CLI. Replies stream in;
  chats are saved per project, and you can keep several. Works with
  Anthropic, OpenAI (or any OpenAI-compatible API), and Google Gemini.
- **Plugins** — add commands, formatters, completions, linters
  (squiggles), and status-bar items in JavaScript. **Settings → Plugins**
  (or the puzzle icon) has a **Marketplace** to browse and install from,
  and also installs from a GitHub repository, a `.zip` /
  `.tar.gz` link, or a folder; turns them on and off; updates, reloads and
  uninstalls them; and shows each one's permissions and log. **Details**
  opens a plugin's page in an editor tab, like VS Code's: its README,
  permissions, and Install / Update / Uninstall. **Create…**
  writes a working plugin to start from, which reloads every time you
  save it. Each plugin runs sandboxed in its own worker with only the
  permissions it declares (`editor`, `workspace:read`, `workspace:write`,
  `shell`, `network`, `node`), and you see them before installing. The
  Marketplace has over 30 tool plugins (JSON and CSV tools, Markdown TOC, tables
  and lint, color, number and timestamp hovers, bookmarks, snippets, a
  clock, a pomodoro timer, and Pets: pixel-art pets that live in a
  sidebar view and chase the ball you throw). **121 color-theme plugins**
  (539 themes: Dracula, One Dark Pro, GitHub, Night Owl, Gruvbox, Tokyo
  Night, Rosé Pine, Nord, Solarized, VS Code's own…) are in the
  Marketplace's Color Themes tab, each card showing a sample in its
  colors. **VS Code extensions run** too: give Sable
  an extension id or a `.vsix`, and it runs the extension in Node.js
  (as VS Code does) through a compatibility layer for VS Code's API,
  covering language features (go to definition, references, symbols,
  code actions, code lenses, inlay hints, …), decorations, webviews, tree
  views, terminals and the languages and grammars an extension adds.
  Better Comments, Bookmarks, Error Lens, REST Client and Code Runner
  work unchanged. Guide and API reference:
  [docs/plugins.md](docs/plugins.md).
- **Remote development** — open a folder on an SSH host (Linux, macOS or
  Windows), in WSL, or in a running Docker/Podman container — or reopen a
  folder in its dev container — and edit, search, run, debug, test, and
  use git and the terminal there as if it were local. Ports the remote
  opens are forwarded to localhost by themselves; passwords and one-time
  codes are asked for in Sable; files drag in and download out. Click the
  remote button at the left of the status bar (or **Remote: Connect to
  SSH Host…** in the command palette). Sable uses your own `ssh`
  (`~/.ssh/config`, keys and agents) and copies a small agent to the
  remote the first time. Guide: [docs/remote.md](docs/remote.md).
- **Windows and multi-root workspaces** — each window has its own
  folders, tabs, terminals, language servers and remote connection: File:
  New Window (⇧⌘N), Open Folder in New Window, or right-click a folder →
  Open in New Window. Every window open at quit comes back at launch. A
  window can hold several folders (Workspaces: Add Folder to Workspace…):
  the Explorer shows each, and search, Go to File, language servers, the
  AI agent and plugins cover them all, while Source Control shows the
  active file's repository (or the one you pick). VS Code's
  `.code-workspace` files open and save (File: Open Workspace from File…,
  Save Workspace As…). Settings, shortcuts and plugins changed in one
  window apply to all.
- **Layout** — switch views (Explorer, Search, Source Control, History,
  Run and Debug, Plugins) from a VS Code-style activity bar at the left
  edge, from icons in the sidebar header, or from a ☰ menu: Settings →
  Editor Appearance → View Switcher.
- **GitHub pull requests and issues** — a GitHub view (like VS Code's
  extension): pull requests waiting for your review, assigned to you,
  created by you and all open ones, and issues assigned to you, created by
  you, mentioning you and open — with labels, check state (✓ ✗ ●), review
  state, search and refresh. A pull request opens in a tab: its
  description, timeline with review threads, commits, checks, reviewers;
  Checkout, Approve / Request changes / Comment, Merge (merge, squash or
  rebase), Close / Reopen, Ready for review. Files changed open as diffs
  with the review threads inline: reply, resolve, and add line comments
  from the + in the gutter (select lines for a range) into a review you
  submit; mark files viewed. Issues open in a tab too (comment, close,
  labels, assignees, “Start working on issue” makes a
  `<you>/issue-<n>-<title>` branch). Create Pull Request (pushes the branch
  first, after asking) and New Issue (from `.github/ISSUE_TEMPLATE`).
  The status bar shows the current branch's pull request. It all runs the
  GitHub CLI (`gh`) you've signed in with (`gh auth login`) — Sable stores
  no tokens; in a remote workspace, gh runs on the remote.
- **Settings** — a searchable settings page (⌘,) backed by a plain
  `settings.json`.
- **Rebindable shortcuts** — Settings → Keyboard Shortcuts lists every
  command (Sable's, the editor's and plugins'). Click a shortcut and press
  the new keys to change it, remove it, or reset it; clashes are flagged.
  Changes go to `keybindings.json` beside `settings.json`, in VS Code's
  format (`{ "key": "cmd+k", "command": "…" }`, `-command` to unbind),
  so VS Code bindings can be pasted in. “Preferences: Open Keyboard
  Shortcuts (JSON)” opens it.

## Prerequisites

- **Rust** (stable) — install via [rustup](https://rustup.rs)
- **Node.js** 18+ and npm
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Optional, per language (Sable tells you what's missing and how to get
  it): `npm install -g pyright`, the TypeScript server (“TypeScript:
  Install Language Server” in the command palette — it pins TypeScript 5,
  as TypeScript 7 lacks the `tsserver` the server needs),
  `brew install jdtls`, `rustup component add rust-analyzer`,
  `brew install go delve` (gopls: `go install golang.org/x/tools/gopls@latest`).
  clangd and lldb-dap come with the Xcode Command Line Tools.
- Windows: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and WebView2 (preinstalled on Windows 10/11)

## Run

```sh
npm install
npm run tauri dev
```

Production build (`npm run tauri build`) produces a native bundle in
`src-tauri/target/release/bundle/`.

## Architecture

```
src/          React + TypeScript frontend (UI, editor state, theming)
src-tauri/    Rust backend (everything that touches the OS)
```

The boundary is strict: the frontend **never** touches the filesystem or
spawns processes directly. All OS work — reading directories, file I/O,
PTY sessions, search, file watching — lives behind Rust functions exposed
as Tauri commands (`#[tauri::command]`), which the frontend calls via
`invoke()`. Long-running streams (terminal output, search results) arrive
as Tauri events rather than blocking calls.

**Remote workspaces: the same commands, run elsewhere.** The workspace
half of the backend (files, search, git, terminals, language servers,
the watcher) also builds without the desktop parts, as `sable-agent`
(`src-tauri/agent/`). The app runs it on the remote over `ssh`,
`wsl.exe` or `docker exec` and speaks JSON lines to it
(`src-tauri/src/remote.rs`, `src-tauri/src/agent.rs`); the frontend's
`invoke()` (`src/lib/backend.ts`) sends workspace commands there and the
agent's events come back under their usual names.

Frontend state is held in small [zustand](https://github.com/pmndrs/zustand)
stores under `src/store/`. Design tokens (colors, typography, motion) are
CSS variables in `src/lib/theme.css` — components never hard-code colors.

**Search: ripgrep's crates, not the ripgrep binary.** Project search uses
`ignore` (gitignore-aware parallel walk) + `grep-searcher`/`grep-regex`
(the matching engine ripgrep itself is built on) compiled into the app,
rather than shelling out to an `rg` binary. Same speed class, but it
works on every machine with nothing extra installed, and results stream
to the UI in batches over Tauri events with stale-search cancellation.

**Settings: a schema, a file, and the keychain.** Every setting is
declared once in `src/store/settingsStore.ts` (type, default, label);
the Settings page is generated from that schema. Only values you change
are written to `settings.json` in the OS app-config directory
(`~/Library/Application Support/com.riaanmathur.sable/` on macOS), so
it can also be edited by hand — saving it in Sable applies it
immediately. API keys never go in that file: they live in the system
keychain (`src-tauri/src/commands/ai.rs`) and never reach the webview.
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` are used as
fallbacks.

**Plugins: Rust installs, a worker runs, the host decides.**
`src-tauri/src/plugins.rs` downloads, unpacks, validates and installs
plugins, and keeps `plugins/registry.json` in the app data folder (on,
off, linked, source URL). The frontend runs each enabled plugin in its own
Web Worker (`src/lib/plugins/`). The worker gets a `sable` API whose every
method is a message to `PluginRuntime` (`host.ts`), which checks the
plugin's permissions and acts through the editor's own plumbing: edits
are undoable, writes respect unsaved buffers, and diagnostics go through
Monaco markers into the Problems panel. Workers can't reach Tauri's IPC,
so the host's API is the plugin's whole reach.

**AI agent: loop in TypeScript, keys and HTTP in Rust.** The agent loop
(`src/store/agentStore.ts`) alternates model calls and tool calls until
the model is done. `src/lib/ai/providers.ts` translates one
provider-neutral transcript to each API's wire format, so you can switch
provider mid-chat. Tools (`src/lib/ai/tools.ts`) are confined to the
workspace and reuse the editor's own plumbing — reads see unsaved
buffers, writes to open files are undoable with ⌘Z, and every edit can be
reverted from the chat. File edits are auto-approved by default and
commands always ask (both configurable); read-only git/gh commands never
ask. Commands run non-interactively in your login shell with a timeout
that kills the whole process group (`src-tauri/src/commands/shell.rs`).

**Language servers and debuggers: external processes, relayed by Rust.**
`src-tauri/src/lsp/` spawns one server per language and relays LSP
messages to the frontend, where `src/lib/lsp/` wires them into Monaco
(diagnostics, completions, code actions, semantic tokens).
`src-tauri/src/debug.rs` does the same for the Debug Adapter Protocol: it
runs the launch handshake (breakpoints are sent only after the adapter's
`initialized` event), talks to adapters over stdio or TCP, and opens the
child sessions js-debug asks for. The UI always drives the newest
session. Tools Sable installs itself (basedpyright, js-debug, java-debug)
go in a private folder, `~/Library/Application Support/com.riaanmathur.sable/tools`,
never into your global environment.

**JetBrains colors: extracted, not eyeballed.** JetBrains colors code by
*key* (`PY.SELF_PARAMETER`, `GO_PACKAGE`, …), each with a fallback chain
that ends in a "language default". `scripts/jetbrains-colors/extract.py`
reads the schemes and the fallback chains out of the IDEs' jars and
resolves them the way IntelliJ does, into
`src/lib/jetbrains/schemes.generated.ts`. `src/lib/jetbrains/scopes.ts`
maps TextMate scopes to those keys (starting from IntelliJ's own TextMate
table), and the semantic-token classifier maps each language server's
tokens to the key the matching JetBrains IDE uses.

**Highlighting: Shiki tokens + semantic tokens.** `src/lib/shikiMonaco.ts`
replaces Monaco's tokenizers with TextMate grammars; tokens are named by
the theme's exact color index, so colors match the theme exactly.
Semantic tokens from each server are mapped into a small fixed set of
categories (`src/lib/lsp/semanticTokens.ts`) that every theme styles, so
themes don't need to know each server's vocabulary.

**File tree: custom virtualization instead of react-arborist.** The tree
only ever renders the rows inside the viewport (fixed 24px rows, windowed
on scroll), and directory contents load lazily from Rust one level at a
time. That's ~120 lines in `FileTree.tsx`; react-arborist would add a
dependency plus drag-to-reorder machinery we don't need, and its
controlled-tree model fights the lazy-loading-from-Rust design.

## Keyboard shortcuts

The full list is in **Settings → Keyboard Shortcuts** (⌘,), where each
one can be changed. The defaults:

| Shortcut | Action |
| -------- | ------ |
| `⇧⌘P` / `⌘P` | Command palette / go to file |
| `⌘,` | Settings |
| `⌘L` | Ask the AI agent |
| `⌘S` | Save (auto-save also runs after typing stops) |
| `⌘R` | Run the active file in the terminal |
| `⇧⌥F` | Format document |
| `⌘[` / `⌘]` | Back / forward |
| `⌃⇧R` / `⌃⇧D` | Run / debug the test at the cursor |
| `⌘\` | Split editor right |
| `⌘.`, `F8` | Quick fix, next problem |
| `F2` / `⇧F6` | Rename symbol (project-wide) |
| `⌃T` | Refactor This |
| `⌥⌘V` / `⌥⌘M` / `⌥⌘C` / `⌥⌘N` | Extract variable / method / constant, inline |
| `⌘⌫` (on a declaration) / `⌘F6` / `F6` | Safe delete / change signature / move |
| `⌘J` | Toggle the bottom panel (terminal / debug console) |
| `⌘B` / `⌥⌘A` | Toggle sidebar / agent panel |
| `⇧⇧` | Search Everywhere |
| `⇧⌘N` / `⇧⌘W` | New window / close window |
| `⌥⌘O`, `⌘F12`, `⌘E` | Go to symbol, file structure, recent files |
| `⌥F7`, `⌥⌘B`, `⌃⌥H` | Find usages, go to implementation, call hierarchy |
| `⌃Tab`, `⌘1…9`, `⇧⌘T` | Switch tabs, jump to tab N, reopen closed tab |
| `⌘=` / `⌘-` / `⌘0` | Editor zoom |
| `⇧⌘.` | Focus the breadcrumbs |
| `Tab` | Expand an Emmet abbreviation (HTML, JSX, CSS…) |
| `F5`, `F9`, `F10`/`F11` | Debug start/continue, toggle breakpoint, step |

## Testing

```sh
cd src-tauri && cargo test --lib   # shell runner, search, AI streaming, debugger, git, remote
npx tsc --noEmit                    # type-check the frontend
```

The debugger tests are end-to-end: each starts the real adapter, stops
at a breakpoint, reads a local variable, steps, and continues to the end.
A test whose adapter isn't installed is skipped (it prints why). Useful
variables:

- `SABLE_TEST_PYTHON=/path/to/python` — an interpreter with debugpy
- `SABLE_TEST_INSTALL_JS_DEBUG=1`, `SABLE_TEST_INSTALL_JAVA_DEBUG=1` —
  download js-debug / java-debug into Sable's tools folder first
- `SABLE_TEST_PYTEST_PYTHON=/path/to/python` — an interpreter with pytest
  and debugpy (debugging a single pytest test)
- `SABLE_TEST_VITEST_DIR=/path/to/project` — a project with Vitest in
  `node_modules` (debugging a single Vitest test)
- `SABLE_TEST_INSTALL_RUFF=1` — download Ruff for the formatter test
- `SABLE_TEST_INSTALL_ROPE=1` — install Rope for the Python refactoring test
- `SABLE_TEST_JUPYTER_PYTHON=/path/to/python` — an interpreter with
  `ipykernel` (the notebook kernel test; default: `python3` if it has it)
- `SABLE_TEST_INSTALL_TS_SERVER=1` — install the TypeScript server
- `SABLE_TEST_MAVEN=/path/to/mvn`, `SABLE_TEST_GRADLE=/path/to/gradle` —
  debugging a single JUnit test

**UI tests against the real backend.** `src-tauri/src/ui_bridge.rs` serves
the backend's commands (files, git, shell, local history, refactoring)
over local HTTP:

```sh
SABLE_UI_BRIDGE_PORT=1531 cargo test --lib ui_bridge -- --ignored
```

so the frontend can run in Chrome (`npx vite --port 1530`), driven by a
script using `scripts/ui-test/driver.mjs` (puppeteer), which forwards
`invoke()` to it and stands in for what needs the app window (terminals,
language servers). To use other ports, set `SABLE_UI_VITE_PORT` and
`SABLE_UI_BRIDGE_PORT` for the driver script (and the bridge).
`node scripts/ui-test/database.mjs` tests the database editor end to end
(it builds a sample database with `python3`; `SHOTS=/dir` keeps its
screenshots).
`node scripts/ui-test/launch-json.mjs` tests launch.json debugging end
to end (debugpy, and js-debug if installed); `node --test
scripts/unit-test/launch-json.test.mjs` unit-tests its parsing,
variables and launch requests. `node scripts/ui-test/editor-extras.mjs`
tests the breadcrumbs, Emmet and the spell checker the same way, and
`node scripts/unit-test/editor-extras.mjs` unit-tests their pure parts
(no servers needed). `node scripts/ui-test/github.mjs` tests pull
requests and issues against a fake `gh` (`scripts/ui-test/fake-gh.mjs`,
recorded fixtures, every call logged) in a throwaway repository — it
never talks to GitHub; `SABLE_GH_THEME=catppuccin-latte` for light
screenshots.
`SABLE_TEST_ROPE_PYTHON=/venv/bin/python node scripts/ui-test/refactorings.mjs`
tests Safe Delete, Change Signature and Move end to end (Python through
Rope in that virtualenv, TypeScript through the TypeScript language
service), and `node scripts/ui-test/refactorings-engines.mjs` (no
browser) their TypeScript and text-based engines;
`SABLE_TEST_ROPE_PYTHON=… cargo test --lib refactor_deep` tests the Rope
side.

**Running every UI suite.** `node scripts/ui-test/run-all.mjs` starts
Vite (port 1550) and, for each suite, a fresh bridge (port 1551) with
empty plugins and history folders, runs all the suites in
`scripts/ui-test/` and prints a PASS/FAIL/SKIP line per suite with its
failing checks; it exits non-zero if any failed. `--only a,b` (or
`--skip a,b`, `--list`, `--verbose`); `SABLE_RUN_VITE_PORT` /
`SABLE_RUN_BRIDGE_PORT` for other ports. Each suite's log and
screenshots are kept in the run folder it prints. Suites whose
prerequisites are missing are skipped and say why: `notebook` needs
`SABLE_TEST_JUPYTER_PYTHON`, `refactorings` `SABLE_TEST_ROPE_PYTHON`,
`launch-json` a Python with debugpy (`SABLE_TEST_PYTHON`),
`popular-plugins` and `vscode-real` the network (npm, Open VSX). Every
suite also runs on its own with Vite and a bridge already running (see
its header), e.g. `SABLE_UI_VITE_PORT=1550 SABLE_UI_BRIDGE_PORT=1551
node scripts/ui-test/marketplace.mjs`; `plugin-units.mjs` and
`plugin-smoke.mjs` (the bundled plugins in a fake host) need neither.

## Installers and updates

`npm run tauri build` builds installers for the machine you're on
(`src-tauri/target/release/bundle/`): a `.dmg` and `.app` on macOS, an
`.msi` and NSIS `.exe` on Windows, `.deb`, `.rpm` and `.AppImage` on
Linux.

**Releases.** Pushing a version tag builds all of them on GitHub Actions
(`.github/workflows/release.yml`): macOS (Apple silicon and Intel),
Windows and Linux. Each file is named for the computer it's for
(`Sable_0.3.2_macOS_Apple-Silicon.dmg`, `…_Windows_x64-setup.exe`,
`…_Linux_x64.deb`, …). The release is published once every platform has
built:

```sh
# bump "version" in package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
git tag v0.3.2 && git push origin v0.3.2
```

Installed copies of Sable then offer the update (“Check for Updates…”,
and a status-bar note on startup). Updates are
signed: the workflow needs the `TAURI_SIGNING_PRIVATE_KEY` secret (the
private key matching the public key in `tauri.conf.json`); without it
the installers build but can't update themselves.

**Code signing** (optional, but without it users see a warning once):
macOS needs an Apple Developer ID certificate and notarization (secrets
listed at the top of the workflow); Windows, a code-signing certificate.

The app icon's source is `src-tauri/icons-source/icon.html` (rendered to
`icon.png`); `npx tauri icon src-tauri/icons-source/icon.png` regenerates
every size.
