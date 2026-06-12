# Sable

A fast, minimal, dark code editor in the spirit of VS Code — built with
[Tauri 2](https://tauri.app) (Rust backend + native OS webview) and
React + TypeScript. No Electron, no telemetry, no network calls.
Everything runs locally.

## Status

| Phase | Scope | State |
| ----- | ----- | ----- |
| 0 | Scaffold, dark theme tokens, shell layout | ✅ done |
| 1 | File explorer (native open-folder dialog, virtualized tree) | ⏳ next |
| 2 | Monaco editor, tabs, save | — |
| 3 | Command palette & keybindings | — |
| 4 | Integrated terminal (portable-pty + xterm.js) | — |
| 5 | File operations, watcher, project-wide search | — |

## Prerequisites

- **Rust** (stable) — install via [rustup](https://rustup.rs)
- **Node.js** 18+ and npm
- macOS: Xcode Command Line Tools (`xcode-select --install`)
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

## Keyboard shortcuts

Added in Phase 3.

## Bundle size

Reported after the first production build (Phase 5).
