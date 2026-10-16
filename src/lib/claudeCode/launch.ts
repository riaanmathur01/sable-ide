import { isRemoteActive } from "../backend";
import { getEditor } from "../editorRegistry";
import { useTerminalStore, type TerminalCommand } from "../../store/terminalStore";
import { useTabsStore } from "../../store/tabsStore";
import { folderOf, useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { getSetting } from "../../store/settingsStore";
import { useRemoteStore } from "../../store/remoteStore";
import { findCli, notify, startServer, type ClaudeCli } from "./backend";
import { useClaudeCodeStore } from "./store";
import { atMentionOf } from "./selection";

/**
 * "Run Claude Code": Anthropic's `claude` CLI, unmodified, in a terminal
 * tab titled "claude", started in the workspace folder with the IDE
 * integration's environment so it connects to this window. Sable passes
 * nothing about signing in: the CLI does that itself (`/login`).
 */

/** Terminal tabs running Claude Code share this key (one at a time). */
export const CLAUDE_TERMINAL_KEY = "claude-code";

/** Anthropic's documented install commands (code.claude.com/docs/en/setup). */
export const INSTALL_PAGE = "https://code.claude.com/docs/en/setup";
export function installCommand(): string {
  return /Win/.test(navigator.platform || navigator.userAgent)
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash";
}

/** Start (or update) the window's IDE server; its port. */
export async function ensureServer(): Promise<number | null> {
  if (isRemoteActive()) return null;
  const { folders } = useWorkspaceStore.getState();
  const status = await startServer(folders);
  useClaudeCodeStore.setState({ port: status.port, clients: status.clients, pids: status.clientPids });
  return status.port;
}

const ui = () => useUiStore.getState();

/** The Claude Code terminal tab, if one is running. */
function claudeSession() {
  return useTerminalStore.getState().sessions.find((session) => session.reuseKey === CLAUDE_TERMINAL_KEY && session.isRunning);
}

/** Show the Claude Code terminal (true if there is one). */
export function focusClaudeTerminal(): boolean {
  const session = claudeSession();
  if (!session) return false;
  useTerminalStore.getState().setActive(session.id);
  ui().setBottomPanel("terminal");
  return true;
}

/** The program and arguments that start the CLI: through the user's login
 *  shell on macOS/Linux (so it has their PATH), else directly. */
function commandLine(cli: ClaudeCli): string[] {
  const shell = cli.shell;
  if (shell && !/fish$/.test(shell) && !/Win/.test(navigator.platform)) {
    return [shell, "-l", "-c", 'exec "$0"', cli.path];
  }
  return [cli.path];
}

/** Find the CLI, or show where to get it. */
async function locateCli(): Promise<ClaudeCli | null> {
  const configured = getSetting("claudeCode.path").trim();
  try {
    const cli = await findCli(configured || null);
    if (!cli) useClaudeCodeStore.getState().showInstall();
    return cli;
  } catch (error) {
    useClaudeCodeStore.getState().showInstall(String(error));
    return null;
  }
}

/** A remote window: the CLI belongs on the remote machine. */
function runOnRemote() {
  const label = useRemoteStore.getState().label ?? "the remote";
  const terminals = useTerminalStore.getState();
  terminals.newTerminal();
  terminals.enqueueCommand("claude");
  ui().showStatus(
    `Claude Code runs on ${label} in this terminal. Sable's IDE integration (diff review, selection) isn't available for remote workspaces yet.`,
  );
}

/** Terminal: Run Claude Code (command palette). Shows the running one if there is one. */
export async function runClaudeCode(): Promise<void> {
  if (focusClaudeTerminal()) return;
  if (isRemoteActive()) {
    runOnRemote();
    return;
  }
  const workspace = useWorkspaceStore.getState();
  if (!workspace.rootPath) {
    ui().setLastError("Open a folder to run Claude Code in it");
    return;
  }
  const cli = await locateCli();
  if (!cli) return;
  let env: Record<string, string | null> | null = null;
  try {
    const port = await ensureServer();
    // The CLI connects to this window straight away (otherwise: /ide).
    if (port && getSetting("claudeCode.autoConnect")) {
      env = { CLAUDE_CODE_SSE_PORT: String(port), ENABLE_IDE_INTEGRATION: "true" };
    }
  } catch (error) {
    ui().showStatus(`Claude Code will run without Sable's IDE integration: ${error}`);
  }
  const active = useTabsStore.getState().lastFilePath;
  const cwd = (active && folderOf(active)) || workspace.rootPath;
  const command: TerminalCommand = { args: commandLine(cli), cwd, env };
  const started = useTerminalStore.getState().startCommandSession(command, "claude", CLAUDE_TERMINAL_KEY);
  // Keep the tab's name: the CLI sets its own terminal title.
  useTerminalStore.setState((state) => ({
    sessions: state.sessions.map((session) => (session.reuseKey === CLAUDE_TERMINAL_KEY ? { ...session, fixedTitle: true } : session)),
  }));
  await started.catch((error) => ui().setLastError(`Couldn't start Claude Code: ${error}`));
}

/** A mention waiting for the CLI to connect. */
let queuedMention: { filePath: string; lineStart?: number; lineEnd?: number } | null = null;

/** Send the selection (or the file) to Claude Code as an @-mention (⌥⌘K while it is connected). */
export async function sendSelectionToClaude(): Promise<void> {
  const mention = atMentionOf(getEditor());
  if (!mention) {
    ui().showStatus("Open a file and select some code to send it to Claude Code");
    return;
  }
  if (useClaudeCodeStore.getState().clients === 0) {
    queuedMention = mention;
    await runClaudeCode();
    return;
  }
  await notify("at_mentioned", mention).catch((error) => ui().setLastError(String(error)));
  focusClaudeTerminal();
}

/** A CLI connected: deliver a mention made before it was running. */
export function flushQueuedMention() {
  const mention = queuedMention;
  queuedMention = null;
  if (mention) void notify("at_mentioned", mention).catch(() => {});
}
