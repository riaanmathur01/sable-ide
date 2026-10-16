# Coding agents

Sable works with coding agents in two ways, which you can use side by side:

- **The agent panel** — agents run inside Sable's own panel through the
  [Agent Client Protocol](https://agentclientprotocol.com): **Claude
  Code** (your installed `claude` CLI, run headless), **Claude Agent**
  (Anthropic's Agent SDK, with an API key, a Console account or a cloud
  provider), **Codex** (your ChatGPT plan, an OpenAI key, Amazon Bedrock,
  Azure OpenAI or a local model), **Kimi Code** (your Kimi account or an
  API key), **Cursor** (your Cursor account or a Cursor API key), and any
  other agent in the ACP registry.
  See [The agent panel](#the-agent-panel-acp).
- **Claude Code in the terminal** — run Anthropic's CLI interactively in
  a Sable terminal, with Sable as the IDE it connects to (diff review,
  selection, open files, problems). See
  [Claude Code in the terminal](#claude-code-in-the-terminal-ide-integration).

## The agent panel (ACP)

Sable runs external coding agents in its agent panel through the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) — the open
protocol Zed and JetBrains IDEs use to embed agents. An agent is a
program Sable starts on your machine (or on the remote machine, in a
remote window); it talks JSON-RPC over its stdin/stdout, and Sable gives
it your workspace: the files (through the editor, unsaved changes
included), terminals, permission prompts, and a place to show its work.

Sable's own agent (API keys, ⌘L) stays in the same panel: the header's
agent picker switches between **Sable Agent** and the external agents.

### Agents

| Agent | Status | How it's installed |
| ----- | ------ | ------------------ |
| **Claude Agent** — Anthropic's Claude Agent SDK, through `@agentclientprotocol/claude-agent-acp` | Integrated | npm package, run with your Node.js |
| **Claude Code** — your own installed `claude` CLI, unmodified | Integrated | not installed by Sable: found on your machine |
| **Codex** — OpenAI's Codex CLI, through `@agentclientprotocol/codex-acp` | Integrated | npm package (with the native `codex` it ships), run with your Node.js |
| **Kimi Code** — Moonshot AI's Kimi Code CLI (`@moonshot-ai/kimi-code`, `kimi acp`) | Integrated | npm package, Node.js 22.19 or later (listed by Sable: the registry's `kimi` entry is the archived Kimi CLI, which Sable hides) |
| **Cursor** — Cursor's CLI (`cursor-agent acp`) | Integrated | download from Cursor, only after you agree to its notice — or your own installed `cursor-agent` |
| Everything else in the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) | Generic | npm, download or uv |

Generic agents run through the same protocol support; when one says
sign-in is required, the panel lists the methods it offers (see
[Other agents](#other-agents)).

### Claude Code via your installed CLI

This entry runs the Claude Code CLI you installed yourself
([setup](https://code.claude.com/docs/en/setup)), exactly as it is, with
its own sign-in — so it can use your Claude Pro/Max/Team subscription,
which Anthropic allows for its own unmodified CLI. Sable never passes
credentials or auth flags and never reads Claude Code's credentials.

- **Found automatically**: `~/.claude/local/claude`, `~/.local/bin/claude`,
  `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, npm globals, your
  login shell's PATH; or set its location on the card.
- **Signing in**: if `claude auth status` says you're signed out, the panel
  (and the card's **Sign in**) opens a Sable terminal running `claude`;
  type `/login` there (Anthropic's own sign-in), then the panel retries.
- **How it runs**: Sable's adapter (`src-tauri/src/acp/claude_code_adapter.mjs`,
  written to `agents/claude-code/adapter.mjs`) runs
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages` with `--permission-mode`, `--model`, `--effort`,
  and `--session-id` / `--resume` for history. Permission prompts use the
  documented `--permission-prompt-tool`: an MCP tool the adapter serves,
  which asks you in the panel. Claude Code edits files itself; Sable shows
  Edit/Write as diff cards, refreshes open editors, and keeps the edits
  reviewable. Changing the mode, model or effort restarts `claude` with
  `--resume` at your next message. History comes from Claude Code's own
  transcripts (`~/.claude/projects`). Images go as image blocks.
- This is separate from running Claude Code interactively in a terminal
  with Sable as its IDE ([below](#claude-code-in-the-terminal-ide-integration));
  the panel doesn't need that, and you can use either or both.

### Claude Agent

Claude Agent is built on Anthropic's Agent SDK. Anthropic doesn't allow
third-party apps to offer claude.ai sign-in or to use Claude Pro/Max
plan credentials, so Sable always starts it with `--hide-claude-auth`:
it never uses a Claude subscription, and if your only Claude login is a
subscription it asks you to pick one of these:

- **Anthropic Console account** (default) — **Sign in** opens a terminal
  running the agent's own `auth login --console`; usage is billed to that
  Console account's API credits. The card shows who is signed in
  (`auth status`) and has **Sign out**.
- **Anthropic API key** — a key from console.anthropic.com
  (`ANTHROPIC_API_KEY`); optionally a model.
- **Amazon Bedrock** — `CLAUDE_CODE_USE_BEDROCK=1` and your AWS
  credentials: the default chain (environment, `~/.aws`, SSO), a named
  profile (`AWS_PROFILE`), access keys (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) or a Bedrock API key
  (`AWS_BEARER_TOKEN_BEDROCK`); region (`AWS_REGION`), model or
  inference profile (`ANTHROPIC_MODEL`), small/fast model
  (`ANTHROPIC_DEFAULT_HAIKU_MODEL`), custom endpoint
  (`ANTHROPIC_BEDROCK_BASE_URL`).
- **Google Vertex AI** — `CLAUDE_CODE_USE_VERTEX=1`, project
  (`ANTHROPIC_VERTEX_PROJECT_ID`), region (`CLOUD_ML_REGION`, default
  `global`), Application Default Credentials or a key file
  (`GOOGLE_APPLICATION_CREDENTIALS`).
- **Microsoft Foundry** — `CLAUDE_CODE_USE_FOUNDRY=1`, resource
  (`ANTHROPIC_FOUNDRY_RESOURCE`), an API key
  (`ANTHROPIC_FOUNDRY_API_KEY`) or, without one, Entra ID (`az login`).
- **Custom gateway** — `ANTHROPIC_BASE_URL`, a bearer token
  (`ANTHROPIC_AUTH_TOKEN`), custom headers (`ANTHROPIC_CUSTOM_HEADERS`).

Whichever you choose, the variables the *other* methods use are removed
from the agent's environment, so a stray exported key can't take over.

### Codex

Codex is OpenAI's coding agent; Sable runs the Codex CLI's app-server
through the `codex-acp` adapter (Apache-2.0, both). Pick how it signs in
on its card in **Settings → AI Agents**:

- **ChatGPT account** (default) — your ChatGPT plan (Plus, Pro, Business,
  Edu, Enterprise); no API billing. Codex keeps the sign-in in `~/.codex`
  (or your `CODEX_HOME`), shared with the Codex CLI and its IDE
  extensions — if you've signed in there, you're signed in here. To sign
  in: the panel's **Sign in with ChatGPT** (Codex opens ChatGPT's sign-in
  in your browser and waits for it), **Sign in with a one-time code** (for
  a browser on another device: Sable shows the code and the page's
  address, and opens the page when you say so; device-code sign-in must
  be allowed in your ChatGPT security settings), or the card's **Sign in
  with ChatGPT** / **Use a one-time code**, which run `codex login` /
  `codex login --device-auth` in a terminal. The card shows whether
  you're signed in (`codex login status`) and has **Sign out**
  (`codex logout`).
- **OpenAI API key** — billed per token. The key (in your keychain) goes
  to Codex as `CODEX_API_KEY` with `DEFAULT_AUTH_REQUEST={"methodId":"api-key"}`,
  and Codex holds the login in memory only
  (`cli_auth_credentials_store = "ephemeral"`): it's never written to
  disk, and a ChatGPT sign-in in `~/.codex` is untouched. Optional: a
  model, and an API base URL (`openai_base_url`) for a proxy.
- **Amazon Bedrock** — OpenAI models on Bedrock through your AWS account,
  no ChatGPT or OpenAI key: Bedrock Runtime (cross-Region inference,
  `amazon-bedrock-runtime`) or Bedrock Mantle (`amazon-bedrock`, with
  hosted web search); region (required); credentials: the AWS default
  chain, a named profile (`AWS_PROFILE`, also in Codex's provider
  settings), access keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`) or a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`);
  optionally a model (`global.openai.gpt-6.1-sol`…). The panel's model
  picker lists Bedrock's catalog.
- **Azure OpenAI** — your resource's endpoint (`…openai.azure.com/openai`),
  API key (`AZURE_OPENAI_API_KEY`), deployment, API version.
- **Local model (Ollama, LM Studio)** — Codex's built-in `ollama` /
  `lmstudio` providers; the model you've pulled; optionally the server
  URL (`CODEX_OSS_BASE_URL`). Nothing leaves your machine.
- **OpenAI-compatible endpoint** — any gateway that serves the OpenAI
  **Responses** API (OpenRouter, LiteLLM, vLLM…): base URL, key, model.

For every method but ChatGPT, Sable starts Codex with a settings folder
of its own — `CODEX_HOME` = `agents/.data/codex-acp/codex-home` in
Sable's data folder — and writes its `config.toml` there from your
choices (`model_provider`, the provider's settings, `model`); keys never
go in it, only into Codex's environment. That's needed because Codex
decides whether a ChatGPT/API-key sign-in is required from
`config.toml`'s `model_provider`: codex-acp's `CODEX_CONFIG` variable
only reaches each thread, so a provider set there still asks for a
ChatGPT login. Your own `~/.codex` is never written. Threads made with
these methods are kept in that folder.

The panel's mode picker has Codex's modes (Read-only, Workspace access,
Auto review, Full access); the model picker its models; the options menu
reasoning effort, fast mode and collaboration mode (plan). `/review`,
`/compact`, `/status` and Codex's other commands are in `/`.

### Kimi Code

Kimi Code is Moonshot AI's current CLI (MIT). Sable lists it itself — the
ACP registry's `kimi` entry is the archived Python Kimi CLI, which Sable
hides — and installs `@moonshot-ai/kimi-code` with npm (it needs Node.js
22.19 or later; Sable checks the minor version too). Sign-in methods:

- **Kimi account** (default) — your Kimi Code plan. Signing in (the
  panel's **Sign in with your Kimi account**, or the card's **Sign in**)
  opens a terminal running `kimi acp --login`, Kimi Code's own device-code
  flow: confirm the code in your browser, and the panel reconnects and
  retries. **Account region** adds `--region global` (kimi.ai) or
  `--region mainland-cn` (kimi.com) to it. Kimi Code keeps the sign-in in
  `~/.kimi-code`, shared with the `kimi` CLI. **Sign out** uses Kimi
  Code's ACP `logout` (there's no `kimi logout` command).
- **Kimi Platform API key** (platform.kimi.ai or platform.kimi.com),
  **Anthropic API key**, **OpenAI or compatible API** (Chat Completions or
  Responses), **Google Gemini API key**, **Local model** (Ollama,
  LM Studio, vLLM — any OpenAI-compatible server; a placeholder key is
  sent if you give none): these go to Kimi Code as its `KIMI_MODEL_*`
  variables (`KIMI_MODEL_PROVIDER_TYPE`, `KIMI_MODEL_BASE_URL`,
  `KIMI_MODEL_API_KEY`, `KIMI_MODEL_NAME`, `KIMI_MODEL_MAX_CONTEXT_SIZE`),
  which define that model in memory and make it the default — Sable never
  edits `~/.kimi-code/config.toml`. A model id is required.

Kimi Code doesn't support Amazon Bedrock. Pickers: its model, thinking
(off/on or effort) and modes (Default, Plan, Auto, YOLO).

### Cursor

Cursor's CLI is **proprietary software** from Anysphere (Cursor's Terms of
Service apply). Sable doesn't bundle or re-host it: **Install…** shows a
notice first — what it is, that it's downloaded from Cursor's servers
(about 170 MB, 600 MB unpacked), whose terms apply — and downloads only
once you tick **I agree** and press **Download and install** (the backend
refuses a Cursor download without that). The registry gives no checksum
for it, so Sable records the archive's SHA-256 on the first download and
refuses different bytes for the same version later. If you've installed
Cursor's CLI yourself (`~/.local/bin/cursor-agent`), the notice offers
**Use it instead** — no download, and it keeps updating itself.

- **Cursor account** (default) — your Cursor plan. The panel's **Sign in
  with Cursor** asks Cursor to sign in (it opens your browser and waits);
  if it can't open one (over SSH, say), the card says so and offers **Sign
  in in a terminal** (`cursor-agent login`, which prints a link). The
  card shows who's signed in (`cursor-agent status --format json`) and has
  **Sign in** / **Sign out** (`cursor-agent login` / `logout`). Cursor keeps
  the sign-in in its own store (the macOS Keychain, or
  `~/.config/cursor/auth.json`); Sable never reads it.
- **Cursor API key** — from the Cursor dashboard; goes to Cursor as
  `CURSOR_API_KEY`. A key Cursor refuses shows on the sign-in card.

Both take an optional **Model**, passed as `--model` when Cursor starts —
for when switching in the panel's picker doesn't stick (a known Cursor
CLI limitation). Every request goes through Cursor's service, so there's
no bring-your-own-provider option (Cursor's Bedrock support is a team
setting in Cursor itself). Pickers: Agent / Plan / Ask, and your models.

### Other agents

Agents without a profile in Sable sign in their own way: when one says
sign-in is required, the panel lists the methods it offers — **terminal**
methods run the agent's own login in a Sable terminal (then Sable
reconnects and retries your message), and **agent** methods run inside the
agent (often a browser sign-in; a device-code page it asks to open is
shown first, with its address and the code).

### Installing

**Settings → AI Agents** (or **Plugins → Marketplace → AI Agents**, or
picking an agent that isn't installed in the panel) → **Install**.

- **npm packages** are installed with your Node.js (`npm install` into a
  private folder — nothing global). They need Node.js (Claude Agent needs
  Node 22 or later); if it's missing, Sable says so and links to
  [nodejs.org](https://nodejs.org).
- **Downloads** are fetched from the registry's URL for your platform,
  checked against the registry's SHA-256 when it gives one (a mismatch
  installs nothing), unpacked, and made executable. Without one, the
  first download's SHA-256 is recorded and the same version must match
  it. Proprietary downloads (Cursor) need your agreement first.
- npm sometimes skips a package's per-platform build without saying so
  (Codex's native `codex`); Sable checks for it after installing and
  fetches it explicitly.
- **uv** packages run through your `uvx`.

Where: Sable's data folder, `agents/<id>/<version>/` with
`agents/<id>/sable-agent.json` describing how to run it
(`~/Library/Application Support/com.riaanmathur.sable/agents` on a Mac;
`~/.sable/agents` on a remote machine). Installing a newer version
replaces the old one; **Update to x.y.z** appears on the card when the
registry has a newer version (the registry is re-read every 6 hours, or
with the refresh button). **Uninstall** removes the folder.

### Signing in

Each agent card has **Sign-in & providers**: choose a method, fill in
what it needs, **Save**. A running agent restarts with the new settings.

### Where secrets live

API keys, AWS keys, tokens: in the **system keychain** (macOS Keychain,
Windows Credential Manager, Linux Secret Service), under
`com.riaanmathur.sable` / `acp-<agent>-<method>.<field>`. They are only
read when an agent starts, and only go into that agent's process
environment — never to the panel, never into a file. Non-secret choices
(method, region, project, model…) are in `agents/config.json` in Sable's
data folder. Sign-in an agent does itself (a Console login, ChatGPT, a
Kimi or Cursor account) is kept by that agent in its own store (Claude
Code's, `~/.codex`, `~/.kimi-code`, Cursor's); Sable never reads it.
Config files Sable writes for an agent (Codex's `config.toml`, under
`agents/.data/`, readable only by you) name where keys come from but
never contain them.

### Using an agent

- **Threads**: ⇧⌘⎋ (or the new-thread button) starts one; tabs switch
  between open threads; **History** lists this folder's threads (saved
  by Sable) and the agent's own earlier sessions. A thread reopens live
  when the agent can reload it (`session/load`); otherwise read-only.
- **Context**: `@` picks files, folders and symbols; the file you're in
  (or your selection) is offered as a chip — click × to leave it out;
  paste or drop images. `/` lists the agent's commands.
- **Modes, models, options** are the agent's own (`configOptions`):
  pickers under the input; ⇧Tab cycles modes.
- **Permissions**: the card asks inline — Allow once (⌘⏎), Always allow
  (⌥⌘⏎), Reject (⌘⌫).
- **Edits**: every file an agent changes is remembered as it was; the
  review bar lists them with +/− counts. **Review** opens Sable's diff
  view with Accept / Reject above each change and Accept / Reject file
  in its toolbar; **Accept** / **Reject** (⇧⌘Y / ⌥⇧⌘Y) do all of them.
  Follow along (Settings → AI Agents) opens files as the agent edits
  them.
- From the editor: right-click → **Agent: Send Selection to Agent**
  (⌥⌘K — which goes to Claude Code in the terminal instead while one is
  connected to the window), **Agent: Explain**, **Agent: Fix** (also in
  the palette).
- **Stop**: the stop button or Esc.

### Remote windows

In an SSH, WSL or container window, agents are installed and run on the
remote machine (`~/.sable/agents`, with the remote's Node.js), next to
the code, through Sable's remote agent. Keys still come from this
computer's keychain and are passed to the agent's process when it
starts. A remote sign-in terminal runs on the remote too.

### Troubleshooting

- **"needs Node.js 22 or later"** — install the current LTS from
  [nodejs.org](https://nodejs.org) (Homebrew's `node` works too), then
  Install again. Sable finds Node in the usual places
  (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.nvm`…) and your login
  shell's PATH.
- **"isn't available for darwin-x86_64"** — the registry has no build of
  that agent for your platform.
- **The agent exits right away** — the panel shows its last error output.
  Check the sign-in method's fields; for Bedrock/Vertex, check the cloud
  CLI works (`aws sts get-caller-identity`, `gcloud auth list`).
- **Claude Agent says it can't use a claude.ai subscription** — sign in
  with a Console account or choose an API key or cloud provider, or use the
  **Claude Code** entry (your installed `claude`), which can use it.
- **Claude Code isn't found** — install it, run `claude` once, then
  **Look again** on its card (or set its location there).
- **Sign-in completed but the panel still asks** — press **I've signed in
  — try again**; Sable restarts the agent, which re-reads its login.
- **Codex: "Sign-in did not complete"** — try again, or use a one-time
  code. If the code page refuses, enable device-code sign-in in your
  ChatGPT security settings (workspace admins may have to allow it).
- **Codex: signed in with an API key in `~/.codex`** — the card says so;
  sign in with ChatGPT to use your plan (or choose OpenAI API key).
- **Codex with Bedrock** — check the model is available to your account
  in that region, and your AWS credentials (`aws sts get-caller-identity`
  with the same profile).
- **Kimi Code signs in to the wrong region** — set **Account region**
  on its card and sign in again.
- **Cursor can't open a browser** — use **Sign in in a terminal** on the
  sign-in card, or a Cursor API key.
- **Behind a proxy** — set `HTTPS_PROXY` in the shell you start Sable from
  (agents inherit it) or in the agent's own settings.
- Agent logs: Claude Agent writes `agent.log` when started with
  `CLAUDE_AGENT_LOGS=<dir>` in its environment.

## Claude Code in the terminal (IDE integration)

Claude Code is Anthropic's command-line coding agent. Sable can run it in
its integrated terminal and act as the editor it connects to, the same
way Anthropic's VS Code and JetBrains integrations work with the CLI:

- **Proposed edits open in Sable's diff view.** When Claude Code wants to
  change a file, the change opens as a tab (`app.ts (Proposed)`) with
  **Accept** and **Reject**. You can edit the right side before
  accepting. Accepting puts the text into the open editor as an undoable
  edit (⌘Z brings the old text back) and Claude Code writes the file;
  rejecting leaves the file as it is. Closing the tab rejects. You can
  also answer in the terminal as usual: the diff then closes by itself.
- **Your selection is shared.** As you select code, Claude Code sees the
  selection (the terminal shows "⧉ Selected N lines from …").
  While Claude Code is connected, **⌥⌘K** (Windows/Linux: Ctrl+Alt+K), or
  **Send Selection to Claude Code** in the editor's context menu, inserts
  an @-mention of the file and lines into its prompt. (With no CLI
  connected, ⌥⌘K sends the selection to the agent panel instead.)
- **It sees open files and problems.** Claude Code can ask which files
  are open, which folders are in the workspace (all of them, in a
  multi-root workspace), and what errors and warnings the editor shows
  (TypeScript, language servers — the Problems panel), so it can check
  its own edits. Open files follow what it writes to disk.
- **Status bar.** "Claude Code connected" shows while a CLI is connected
  to the window; click it to show its terminal.

Sable doesn't include Claude Code, change it, or wrap it: it runs the
`claude` program Anthropic publishes, as it is.

### Running it

**Terminal: Run Claude Code** in the command palette opens a terminal tab titled **claude** running
the CLI in the workspace folder (in a multi-root workspace, the folder of
the file you're in). Running it again shows the same tab. Sable starts it
through your login shell, so it has the same `PATH` as in a terminal.

You can also type `claude` in any Sable terminal (or another terminal in
the same folder) and connect with Claude Code's `/ide` command: Sable's
window is listed as **Sable**.

Sable looks for `claude` on your `PATH`, then where Anthropic's
installers put it: `~/.local/bin/claude` (the native installer),
`~/.claude/local/claude`, Homebrew (`/opt/homebrew/bin`,
`/usr/local/bin`) and npm's global folders. Set **Settings → Claude Code
(Anthropic's CLI) → CLI Path** if it's somewhere else.

It has no default shortcut (⌘⎋ and ⇧⌘⎋ belong to the agent panel); bind
one to `sable.claudeCode.run` in **Settings → Keyboard Shortcuts** if you
like.

### Installing it

If Sable can't find it, it shows a panel explaining what Claude Code is,
with Anthropic's install command (`curl -fsSL https://claude.ai/install.sh
| bash`; on Windows `irm https://claude.ai/install.ps1 | iex`), a link to
Anthropic's install instructions
([code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup)),
and a button that runs that command in a new terminal — only when you
click it, in a terminal you can see.

### Signing in to it

Claude Code signs in by itself: run `/login` in it (or follow its prompt
the first time) and complete Anthropic's sign-in in your browser. Your
Claude subscription or API key is between you and Claude Code — **Sable
never sees, reads, stores or passes on Claude credentials**, and it
doesn't set anything that changes how the CLI signs in. The only things
Sable gives the CLI are two environment variables that tell it which
Sable window to connect to (`CLAUDE_CODE_SSE_PORT`,
`ENABLE_IDE_INTEGRATION`).

### Settings

**Settings → Claude Code (Anthropic's CLI):**

- **CLI Path** — the `claude` program to run (empty: find it).
- **Connect Automatically** (on) — Claude Code started from Sable
  connects to the window at once, and each window can be found by
  `/ide`. Off: Sable's connection point starts only when you run Claude
  Code from Sable, and the CLI connects when you run `/ide` in it.
- **Review Edits in a Diff** (on) — off: Sable doesn't open diffs;
  Claude Code edits files directly once you approve them in its
  terminal (or by itself, in its auto-accept mode). Open files still
  follow the changes.

Claude Code's own settings apply too — for example `/config` → *Diff
tool* (`auto` opens diffs in the IDE, `terminal` keeps them in the CLI).

### How it works

Each Sable window runs a small local server for the CLI, as Anthropic's
editor integrations do: a WebSocket on `127.0.0.1` (a random port), which
only accepts a connection that presents a random token. Sable writes the
port and token to a lock file, `~/.claude/ide/<port>.lock` (or
`$CLAUDE_CONFIG_DIR/ide/` if you set `CLAUDE_CONFIG_DIR`), readable only
by you (0600 in a 0700 folder), and removes it when the window closes or
Sable quits; lock files left behind by a Sable that crashed are cleaned
up next time. The CLI reads the lock file, connects, and calls the
editor's tools over MCP (opening files and diffs, reading the selection,
open editors and diagnostics).

### In remote windows

In a remote window (SSH, WSL, a container), **Run Claude Code** starts
`claude` in a terminal on the remote machine, where your files are — so
install and sign in to Claude Code there. Sable's editor integration
(diff review, selection sharing, diagnostics) isn't available for remote
workspaces yet: the CLI would need a connection point on the remote
machine (or a port forwarded from it back to Sable), and Sable's remote
agent only forwards ports the other way today. Claude Code works there
as it does in any terminal.

### Troubleshooting the terminal integration

- **"Claude Code isn't installed"** although it is: set **CLI Path** in
  Settings (run `which claude` in a terminal to find it), or use **Check
  again** after installing — a fresh install may only be on the `PATH` of
  new terminals.
- **The status bar never says connected.** Run `/ide` in Claude Code and
  pick **Sable**. If Sable isn't listed, check **Connect Automatically**
  is on (or run Claude Code from Sable once), that the folder you started
  `claude` in is inside the workspace, and that `~/.claude/ide/` has a
  `<port>.lock` file naming Sable. If you use `CLAUDE_CONFIG_DIR`, Sable
  must see the same value (start Sable from a shell that has it).
- **Diffs show in the terminal, not in Sable.** Check **Review Edits in a
  Diff** in Sable's settings and Claude Code's `/config` → *Diff tool*
  (`auto`).
- **Edits don't appear in an open file.** Sable takes a file's new
  contents from disk when it has no unsaved changes; with unsaved
  changes, it keeps yours. Save or revert, then reopen the file.
- **Signing in.** Run `/login` in Claude Code; `/status` shows the
  account. Sable is not involved, so sign-in problems are Claude Code's
  ([Anthropic's troubleshooting guide](https://code.claude.com/docs/en/troubleshooting)).
- **Logs.** `claude --debug` writes the CLI's log (the IDE connection is
  under `MCP server "ide"`).

## Keyboard shortcuts

| Shortcut | Action |
| -------- | ------ |
| ⌘⎋ (Ctrl+Esc) | Focus the agent panel's external agent (Claude Code, Claude Agent…) |
| ⇧⌘⎋ (Ctrl+Shift+Esc) | New agent thread |
| ⌥⌘K (Ctrl+Alt+K) | Send the selection: to Claude Code in the terminal while one is connected, otherwise to the agent panel |
| ⇧⌘Y / ⌥⇧⌘Y | Accept / reject all of the panel agent's edits |
| — (command palette) | Terminal: Run Claude Code |

All of them can be changed in **Settings → Keyboard Shortcuts**.

## For developers

The backend (`src-tauri/src/acp/`) is agent-agnostic: registry,
install, process relay (stdout lines as `acp:message` events), client
terminals, and the sign-in table (`env.rs`: each method's fields and what
they produce — environment variables, a flag at launch (`arg`), a flag
for its sign-in (`loginArg`), settings in a config file of Sable's own
(`config` + `home`, written into `agents/.data/<agent>/` where the agent
runs, `${SABLE_AGENT_DATA}` in values) — plus the agent's account
commands (status, login, one-time-code login, logout, or ACP `logout`)).
Sable-listed agents that aren't in the registry go in
`extra_agents.json`. The protocol client is `src/lib/acp/` (JSON-RPC
peer, types) and `src/store/acpStore.ts` (sessions, updates, permission
prompts, files through the editor, the edit review, sign-in);
per-agent touches (name, how its ACP auth methods read, what its errors
mean, the install notice) are in `src/lib/acp/agents.ts`.

Tests: `cargo test --lib acp` (the table, config files, installs,
consent); `node scripts/unit-test/acp.mjs`; the UI suite
`scripts/ui-test/agents.mjs`, whose fake agent
(`fixtures/fake-acp-agent.mjs`, `FAKE_ACP_AS=codex|kimi|cursor`) answers
like each real one (auth methods, sign-in flows, config options, errors);
and, against the real agents (ignored by default; temp HOME and config
folders; never a prompt), `cargo test --lib acp::real_tests --
--ignored --nocapture` — `real_codex_handshake`,
`real_kimi_code_handshake`, `real_cursor_handshake` (which downloads
Cursor's CLI into a temp folder unless `SABLE_CURSOR_PACKAGE` points at
an unpacked one).

The terminal integration is `src-tauri/src/claude_code.rs` (the lock
file and the WebSocket MCP server) and `src/lib/claudeCode/` (the IDE
tools, selection tracking, proposals), with its UI in
`src/components/ClaudeCode/`.

Claude Code is a product of Anthropic; Sable is not made, endorsed or
supported by Anthropic. Using Claude Code is subject to Anthropic's terms.
