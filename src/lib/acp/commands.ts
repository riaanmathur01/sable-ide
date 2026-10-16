import { pendingReviewCount, useAcpStore, type Mention } from "../../store/acpStore";
import { acpRegistryCache, agentDisplayName, useAgentHubStore } from "../../store/agentHubStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { getEditor, whenMonaco } from "../editorRegistry";
import { SABLE_AGENT_ID, agentName } from "./agents";

/**
 * Commands for external agents: the palette, rebindable shortcuts
 * (lib/shortcuts.ts) and the editor's context menu all run these.
 */

/** The agent to use when the panel shows Sable's own: the last external one, else the first installed. */
function externalAgent(): string {
  const panel = useAcpStore.getState().panelAgent;
  if (panel !== SABLE_AGENT_ID) return panel;
  try {
    const last = localStorage.getItem("sable.agents.lastExternal");
    if (last) return last;
  } catch {
    /* private mode */
  }
  return acpRegistryCache().installedIds[0] ?? "claude-acp";
}

useAcpStore.subscribe((state) => {
  if (state.panelAgent !== SABLE_AGENT_ID) {
    try {
      localStorage.setItem("sable.agents.lastExternal", state.panelAgent);
    } catch {
      /* private mode */
    }
  }
});

export function focusExternalAgent() {
  const agentId = externalAgent();
  const store = useAcpStore.getState();
  if (store.panelAgent !== agentId) store.setPanelAgent(agentId);
  useUiStore.getState().focusAgent();
}

export async function newAgentThread() {
  const agentId = externalAgent();
  useUiStore.getState().focusAgent();
  await useAcpStore.getState().newThread(agentId);
}

export async function switchAgent() {
  await useAgentHubStore.getState().load();
  const { installed, registry } = useAgentHubStore.getState();
  const ids = [SABLE_AGENT_ID, ...installed.map((agent) => agent.id)];
  const labels = ids.map((id) => ({
    label: id === SABLE_AGENT_ID ? "Sable Agent" : agentName(id, registry?.agents.find((entry) => entry.id === id)?.name),
    detail: id === useAcpStore.getState().panelAgent ? "current" : id === SABLE_AGENT_ID ? "built in" : undefined,
  }));
  const choice = await useUiStore.getState().openPick([...labels, { label: "Install more agents…", detail: "Settings → AI Agents" }], "Switch the agent panel to…");
  if (choice === null) return;
  if (choice === ids.length) {
    useTabsStore.getState().openSettings("agents");
    return;
  }
  useAcpStore.getState().setPanelAgent(ids[choice]);
  useUiStore.getState().focusAgent();
}

/** The editor's selection (or current line) as context for the agent. */
function selectionMention(): Mention | null {
  const editor = getEditor();
  const model = editor?.getModel();
  const path = useTabsStore.getState().lastFilePath;
  if (!editor || !model || !path) return null;
  const name = path.split(/[/\\]/).pop() ?? path;
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) {
    return { kind: "file", path, label: name };
  }
  const start = selection.startLineNumber;
  const end = selection.endColumn === 1 && selection.endLineNumber > start ? selection.endLineNumber - 1 : selection.endLineNumber;
  return { kind: "selection", path, label: `${name}:${start}${end !== start ? `-${end}` : ""}`, startLine: start, endLine: end, text: model.getValueInRange(selection) };
}

export async function sendSelectionToAgent() {
  const mention = selectionMention();
  if (!mention) {
    focusExternalAgent();
    return;
  }
  await useAcpStore.getState().ask("", [mention], { agentId: externalAgent() });
}

export async function explainSelection() {
  const mention = selectionMention();
  await useAcpStore.getState().ask(mention?.kind === "selection" ? "Explain this code." : "Explain this file.", mention ? [mention] : [], { send: true, agentId: externalAgent() });
}

export async function fixSelection() {
  const mention = selectionMention();
  await useAcpStore.getState().ask(
    mention?.kind === "selection" ? "Find and fix the problems in this code." : "Find and fix the problems in this file.",
    mention ? [mention] : [],
    { send: true, agentId: externalAgent() },
  );
}

export const hasPendingEdits = () => pendingReviewCount() > 0;

export function acceptAllEdits() {
  useAcpStore.getState().acceptAll();
  useUiStore.getState().showStatus("Accepted the agent's changes");
}

export async function rejectAllEdits() {
  await useAcpStore.getState().rejectAll();
  useUiStore.getState().showStatus("Rejected the agent's changes");
}

/** Stop the running turn in the panel's thread. */
export function cancelAgent(): boolean {
  const { activeThreadId, threads, cancel } = useAcpStore.getState();
  const thread = activeThreadId ? threads[activeThreadId] : null;
  if (thread?.status !== "running") return false;
  cancel(thread.id);
  return true;
}

export const agentRunning = () => {
  const { activeThreadId, threads } = useAcpStore.getState();
  return Boolean(activeThreadId && threads[activeThreadId]?.status === "running");
};

// The editor's right-click menu: "Agent" group.
void whenMonaco().then((monaco) => {
  const name = () => agentDisplayName(externalAgent());
  const actions: { id: string; label: string; run: () => unknown; order: number }[] = [
    { id: "sable.acp.sendSelection", label: "Agent: Send Selection to Agent", run: sendSelectionToAgent, order: 1 },
    { id: "sable.acp.explain", label: "Agent: Explain", run: explainSelection, order: 2 },
    { id: "sable.acp.fix", label: "Agent: Fix", run: fixSelection, order: 3 },
  ];
  for (const action of actions) {
    monaco.editor.addEditorAction({
      id: action.id,
      label: action.label,
      contextMenuGroupId: "9_agent",
      contextMenuOrder: action.order,
      run: () => void Promise.resolve(action.run()).catch((error) => useUiStore.getState().setLastError(`${name()}: ${String(error)}`)),
    });
  }
});
