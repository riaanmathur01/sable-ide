> Converted from the VS Code extension **deadraid.genesis-vscode** 0.6.19 by Sable. Choose a theme in Settings → Editor Appearance → Color Theme, or with "Color Theme: …" in the command palette (⇧⌘P).

Themes:

- Genesis Dark
- Genesis Light
- Monikai Dark
- Monikai Light
- Tokyo Night Dark
- Tokyo Night Light
- Nord Dark
- Nord Light
- Solarized Dark
- Solarized Light
- Vesper Dark
- Vesper Light

# Genesis for VS Code

Universal autonomous agent with multi-agent swarm execution, directly in your editor.

<!-- TODO: Replace with actual screenshot -->
<!-- ![Genesis VS Code](https://github.com/deadraid/genesis/raw/HEAD/../../docs/screenshots/vscode-overview.png) -->

## Features

- **Chat** -- session-based conversation with streamed markdown responses
- **Markdown** -- full rendering with syntax highlighting, KaTeX math, Mermaid diagrams, and GFM tables
- **Swarm** -- multi-agent execution with real-time progress tracking
- **Tools** -- trace timeline, file diff previews, permission and question workflows
- **Sessions** -- create, switch, rename, delete sessions from the sidebar
- **Settings** -- manage providers, MCP servers, channels, secrets vault, and permission modes
- **File attachment** -- attach workspace files to prompts (drag-drop, paste, file picker)
- **Voice input** -- speech-to-text via microphone button
- **Vision** -- image/video attachment with vision fallback for non-vision models
- **Themes** -- 6 Genesis themes (dark/light) synced with VS Code workbench

<!-- TODO: Add VS Code chat demo video. -->

### Chat

<!-- TODO: Replace with actual screenshot -->
<!-- ![Chat](https://github.com/deadraid/genesis/raw/HEAD/../../docs/screenshots/vscode-chat.png) -->

Streaming markdown responses with:

- Syntax-highlighted code blocks with copy button
- Mermaid diagram rendering
- KaTeX math rendering
- Collapsible thinking blocks
- Tool step trace with status indicators
- Compaction summaries

### Settings Panel

<!-- TODO: Replace with actual screenshot -->
<!-- ![Settings](https://github.com/deadraid/genesis/raw/HEAD/../../docs/screenshots/vscode-settings.png) -->

Right-side panel with tabs:

- Providers and accounts
- Model selection
- Vision model override
- Voice input configuration
- Reasoning mode and budget
- Permission mode and sandbox
- MCP servers
- Channel management
- Secrets vault

### Swarm Mode

<!-- TODO: Replace with actual screenshot -->
<!-- ![Swarm](https://github.com/deadraid/genesis/raw/HEAD/../../docs/screenshots/vscode-swarm.png) -->

Multi-agent execution with progress panel showing:

- Agent roles (architect, scout, worker, reviewer, integrator)
- Per-agent activity and tool counts
- Cycle progress

## Requirements

Genesis server must be available. Install via npm:

```bash
npm i -g @genesis-agent/cli
```

The extension automatically discovers the genesis binary. You can also configure a custom path in settings (`genesis.executablePath`).

## Settings

| Setting | Description |
| --- | --- |
| `genesis.executablePath` | Custom path to genesis binary |
| `genesis.projectPath` | Path to genesis project root (for dev builds) |
| `genesis.defaultProvider` | Provider for new sessions (default: `anthropic`) |
| `genesis.defaultModel` | Model override for new sessions |
| `genesis.permissionMode` | Permission mode: `safe`, `normal`, `auto`, `yolo` |
| `genesis.swarm.agentCount` | Agent count for swarm runs (1-64) |
| `genesis.swarm.maxCycles` | Max cycles for swarm runs (1-12) |
| `genesis.server.extraArgs` | Extra CLI args for the genesis server process |
| `genesis.applyWorkbenchTheme` | Sync Genesis theme with VS Code workbench (default: `false`) |

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` / `Cmd+Enter` | Send message |
| `Shift+Enter` | New line in input |

## Development

```bash
bun install
bun run build
npx @vscode/vsce package --no-dependencies
```
