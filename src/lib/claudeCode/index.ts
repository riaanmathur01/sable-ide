import { listen } from "../events";
import { isRemoteActive } from "../backend";
import { readFile } from "../ipc";
import { getModelValue, isModelDirty, markSaved, replaceModelContent, whenMonaco } from "../editorRegistry";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { useRemoteStore } from "../../store/remoteStore";
import { respond, setServerFolders, stopServer, toolError, type ToolRequest } from "./backend";
import { useClaudeCodeStore } from "./store";
import { runTool, setMonaco } from "./tools";
import { cancelProposal } from "./proposals";
import { resendSelection, trackSelections } from "./selection";
import { ensureServer, flushQueuedMention, installCommand, INSTALL_PAGE, runClaudeCode, sendSelectionToClaude } from "./launch";

/**
 * Claude Code (Anthropic's CLI) in Sable: the window is the IDE the CLI
 * connects to (src-tauri/src/claude_code.rs). This wires the backend's
 * relayed tool calls to the editor, follows the editor selection, and
 * keeps the server's lock file in step with the workspace.
 */

let started = false;

export function initClaudeCode() {
  if (started) return;
  started = true;

  void listen<ToolRequest>("claude-code:request", async (event) => {
    const { id, tool, arguments: args } = event.payload;
    let result;
    try {
      result = await runTool(id, tool, args ?? {});
    } catch (error) {
      result = toolError(`Sable couldn't run ${tool}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await respond(id, result).catch(() => {});
  });

  void listen<{ id: string }>("claude-code:cancel", (event) => cancelProposal(event.payload.id));

  void listen<{ clients: number; pids: number[] }>("claude-code:clients", (event) => {
    const before = useClaudeCodeStore.getState().clients;
    useClaudeCodeStore.setState({ clients: event.payload.clients, pids: event.payload.pids });
    if (event.payload.clients > before) {
      resendSelection();
      flushQueuedMention();
    }
  });

  // Claude Code writes files itself: open files it changed follow the disk.
  void listen<string[]>("fs:changed", (event) => {
    if (useClaudeCodeStore.getState().clients > 0) void followDiskChanges(event.payload);
  });

  void whenMonaco().then((monaco) => {
    setMonaco(monaco);
    trackSelections(monaco);
    monaco.editor.addEditorAction({
      id: "sable.claudeCode.sendSelection",
      label: "Send Selection to Claude Code",
      contextMenuGroupId: "9_claude",
      contextMenuOrder: 1,
      // No keybinding here: ⌥⌘K is Sable's sable.acp.sendSelection, which
      // sends to a connected Claude Code CLI first, else to the agent panel.
      run: () => sendSelectionToClaude(),
    });
  });

  // The server runs while a local folder is open (Settings → Claude Code →
  // Connect Automatically), so `claude` in any terminal can find it.
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.folders !== previous.folders) syncServer();
  });
  useSettingsStore.subscribe((state, previous) => {
    if (state.loaded !== previous.loaded || state.values["claudeCode.autoConnect"] !== previous.values["claudeCode.autoConnect"]) syncServer();
  });
  useRemoteStore.subscribe((state, previous) => {
    if (state.status !== previous.status) syncServer();
  });
  syncServer();
}

let syncing: Promise<void> = Promise.resolve();

/** Start, update or stop the IDE server to match the window. */
function syncServer() {
  syncing = syncing.then(async () => {
    const { folders, rootPath } = useWorkspaceStore.getState();
    const running = useClaudeCodeStore.getState().port !== null;
    try {
      if (isRemoteActive()) {
        // A remote workspace's folders aren't on this machine.
        if (running) {
          await stopServer();
          useClaudeCodeStore.setState({ port: null, clients: 0, pids: [] });
        }
      } else if (running) {
        await setServerFolders(folders);
      } else if (rootPath && useSettingsStore.getState().loaded && getSetting("claudeCode.autoConnect")) {
        await ensureServer();
      }
    } catch {
      // Not fatal: "Run Claude Code" tries again and says why.
    }
  });
}

const parentOf = (path: string) => path.replace(/[/\\][^/\\]*$/, "");

/** Open, unmodified files in changed folders: take the disk's version
 *  (an undoable edit, so ⌘Z brings the old text back). */
async function followDiskChanges(directories: string[]) {
  const changed = new Set(directories);
  const files = new Set(
    useTabsStore
      .getState()
      .groups.flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === "file" && changed.has(parentOf(tab.path)))
      .map((tab) => tab.path),
  );
  for (const path of files) {
    if (isModelDirty(path)) continue;
    const current = getModelValue(path);
    if (current === null) continue;
    const onDisk = await readFile(path).catch(() => null);
    if (onDisk === null || onDisk === current || isModelDirty(path)) continue;
    replaceModelContent(path, onDisk);
    markSaved(path);
    useTabsStore.getState().syncDirtyState(path);
  }
}

/** Command palette entries. */
export function claudeCodeCommands(): { id: string; label: string; detail?: string; run: () => void }[] {
  return [
    { id: "sable.claudeCode.run", label: "Terminal: Run Claude Code", run: () => void runClaudeCode() },
    { id: "sable.claudeCode.sendSelection", label: "Claude Code: Send Selection to Claude Code", detail: "⌥⌘K when connected", run: () => void sendSelectionToClaude() },
    {
      id: "sable.claudeCode.install",
      label: "Claude Code: Install Anthropic's CLI…",
      run: () => useClaudeCodeStore.getState().showInstall(),
    },
  ];
}

export { runClaudeCode, sendSelectionToClaude, installCommand, INSTALL_PAGE };
