# Sable

A fast, minimal, dark code editor in the spirit of VS Code — built with
[Tauri 2](https://tauri.app) (Rust backend + native OS webview) and
React + TypeScript. No Electron, no telemetry. Everything runs locally;
the only network calls are the ones you make on purpose (git
push/pull/fetch, and the AI agent when you message it).

## Features

- **Editor** — Monaco with tabs, a minimap (with errors, search matches
  and breakpoints marked), split editor (up to three groups),
  auto-save, format on save, bracket-pair colors, sticky scroll, font
  zoom, Back/Forward through the places you've been (⌘[ / ⌘], ⌃- / ⌃⇧-,
  mouse side buttons), and session restore. JetBrains Mono is bundled; the font picker
  lists every monospace font installed on your machine.
- **Highlighting** — the same TextMate grammars VS Code uses (via
  [Shiki](https://shiki.style)), plus semantic highlighting from the
  language servers (parameters, `self`, fields, mutable bindings,
  declarations vs. calls). Themes: Sable Dark, Catppuccin Mocha, and three
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
- **Run configurations** — per-file program arguments, environment
  variables and working directory (the sliders button next to Run, or
  "Run: Edit Configuration…"), used by both Run and Debug.
- **Language intelligence** — squiggles, a Problems panel, quick fixes
  (⌘.), completions, hover, go-to-definition, and signature help over LSP:
  Python (basedpyright or Pyright), TypeScript/JavaScript
  (typescript-language-server, project-aware), Java (jdtls), Rust
  (rust-analyzer), Go (gopls), and C/C++ (clangd). Python gets extra
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

  Right-click a line in the gutter for a **conditional breakpoint**, a
  **hit count** ("stop the 3rd time"), or a **logpoint** (prints a
  message with `{expressions}` and keeps running). **Watch expressions**
  re-evaluate at every pause. **Attach to Process…** debugs a program
  that's already running — Python (`python -m debugpy --listen 5678`),
  Node (`--inspect`), Java (JDWP port), or a Go / C / C++ / Rust process
  picked from a list; stopping detaches and leaves it running.

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
- **Settings** — a searchable settings page (⌘,) backed by a plain
  `settings.json`.

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

The full list is in **Settings → Keyboard Shortcuts** (⌘,). The
essentials:

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
| `⌘J` | Toggle the bottom panel (terminal / debug console) |
| `⌘B` / `⌥⌘A` | Toggle sidebar / agent panel |
| `⇧⇧` | Search Everywhere |
| `⌥⌘O`, `⌘F12`, `⌘E` | Go to symbol, file structure, recent files |
| `⌥F7`, `⌥⌘B`, `⌃⌥H` | Find usages, go to implementation, call hierarchy |
| `⌃Tab`, `⌘1…9`, `⇧⌘T` | Switch tabs, jump to tab N, reopen closed tab |
| `⌘=` / `⌘-` / `⌘0` | Editor zoom |
| `F5`, `F9`, `F10`/`F11` | Debug start/continue, toggle breakpoint, step |

## Testing

```sh
cd src-tauri && cargo test --lib   # shell runner, search, AI streaming, debugger, git
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
script (e.g. puppeteer) that forwards `invoke()` to it and stands in for
what needs the app window (terminals, language servers).

## Installers and updates

`npm run tauri build` builds installers for the machine you're on
(`src-tauri/target/release/bundle/`): a `.dmg` and `.app` on macOS, an
`.msi` and NSIS `.exe` on Windows, `.deb`, `.rpm` and `.AppImage` on
Linux.

**Releases.** Pushing a version tag builds all of them on GitHub Actions
(`.github/workflows/release.yml`) — macOS (Apple silicon and Intel),
Windows and Linux — into a draft release:

```sh
# bump "version" in package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
git tag v0.2.0 && git push origin v0.2.0
```

Publish the draft and installed copies of Sable offer the update
(“Check for Updates…”, and a status-bar note on startup). Updates are
signed: the workflow needs the `TAURI_SIGNING_PRIVATE_KEY` secret (the
private key matching the public key in `tauri.conf.json`); without it
the installers build but can't update themselves.

**Code signing** (optional, but without it users see a warning once):
macOS needs an Apple Developer ID certificate and notarization (secrets
listed at the top of the workflow); Windows, a code-signing certificate.

The app icon's source is `src-tauri/icons-source/icon.html` (rendered to
`icon.png`); `npx tauri icon src-tauri/icons-source/icon.png` regenerates
every size.
