import { pathExists, readFile } from "../ipc";
import { getModelValue, hasModel, markSaved, replaceModelContent } from "../editorRegistry";
import { useTabsStore } from "../../store/tabsStore";
import { useClaudeCodeStore, type ProposalInfo } from "./store";
import { text, type ToolResult } from "./backend";

/**
 * Proposed changes from Claude Code (the CLI's openDiff): each opens as a
 * diff tab (DiffView, source kind "claude") with Accept / Reject. The CLI
 * waits for the answer: FILE_SAVED with the final text (the user may have
 * edited the proposal), or DIFF_REJECTED. The CLI then writes the file
 * itself, as with Anthropic's own IDE integrations; Sable puts the
 * accepted text into the open editor first, as an undoable edit.
 */

interface Proposal {
  id: string;
  filePath: string;
  tabName: string;
  contents: string;
  isNewFile: boolean;
  resolve: (result: ToolResult) => void;
}

const pending = new Map<string, Proposal>();
/** Proposed text by id (kept after settling, for a diff tab still showing). */
const contentsById = new Map<string, string>();
/** Tabs Sable is closing itself (not a "the user closed it" rejection). */
const closingQuietly = new Set<string>();

export const proposalTabKey = (id: string) => `diff:claude:${id}`;

function setInfo(id: string, info: ProposalInfo | null) {
  useClaudeCodeStore.setState((state) => {
    const proposals = { ...state.proposals };
    if (info) proposals[id] = info;
    else delete proposals[id];
    return { proposals };
  });
}

function tabIsOpen(id: string): boolean {
  const key = proposalTabKey(id);
  return useTabsStore.getState().groups.some((group) => group.tabs.some((tab) => tab.path === key));
}

function closeTab(id: string) {
  const key = proposalTabKey(id);
  closingQuietly.add(id);
  const tabs = useTabsStore.getState();
  const closing = tabs.groups.filter((group) => group.tabs.some((tab) => tab.path === key)).map((group) => tabs.closeTab(key, group.id));
  void Promise.all(closing).finally(() => {
    closingQuietly.delete(id);
    contentsById.delete(id);
    setInfo(id, null);
  });
}

/** Answer the CLI (if it's still waiting) and close the tab. */
function settle(id: string, status: ProposalInfo["status"], result: ToolResult | null) {
  const proposal = pending.get(id);
  if (!proposal) return;
  pending.delete(id);
  setInfo(id, { filePath: proposal.filePath, tabName: proposal.tabName, isNewFile: proposal.isNewFile, status });
  if (result) proposal.resolve(result);
  closeTab(id);
}

/** Show a proposed change and wait for the user's answer. */
export async function openProposal(id: string, args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(args.new_file_path || args.old_file_path || "");
  const tabName = String(args.tab_name || filePath);
  const contents = typeof args.new_file_contents === "string" ? args.new_file_contents : "";
  if (!filePath) return { content: [{ type: "text", text: "openDiff needs a file path" }], isError: true };
  const isNewFile = !(await pathExists(filePath).catch(() => false));
  // The same tab again (the CLI retried): the old request is over.
  for (const other of pending.values()) {
    if (other.tabName === tabName) settle(other.id, "closed", text("TAB_CLOSED"));
  }
  return new Promise<ToolResult>((resolve) => {
    pending.set(id, { id, filePath, tabName, contents, isNewFile, resolve });
    contentsById.set(id, contents);
    setInfo(id, { filePath, tabName, isNewFile, status: "pending" });
    useTabsStore.getState().openDiff({ kind: "claude", filePath, proposalId: id, tabName });
  });
}

/** The proposed text a diff tab shows. */
export function proposalContents(id: string): string | null {
  return contentsById.get(id) ?? null;
}

/** Whether the original side is empty (Claude Code proposes a new file). */
export function proposalIsNewFile(id: string): boolean {
  return useClaudeCodeStore.getState().proposals[id]?.isNewFile ?? false;
}

/** Accept: the open editor gets the text (undoable), the CLI writes the file. */
export function acceptProposal(id: string, finalText: string) {
  const proposal = pending.get(id);
  if (!proposal) return;
  const path = proposal.filePath;
  const open = hasModel(path);
  if (open) {
    replaceModelContent(path, finalText);
    useTabsStore.getState().syncDirtyState(path);
  }
  settle(id, "accepted", {
    content: [
      { type: "text", text: "FILE_SAVED" },
      { type: "text", text: finalText },
    ],
  });
  if (open) void markSavedOnceWritten(path, finalText);
}

/** Reject: the CLI leaves the file as it is. */
export function rejectProposal(id: string) {
  const proposal = pending.get(id);
  if (!proposal) return;
  settle(id, "rejected", {
    content: [
      { type: "text", text: "DIFF_REJECTED" },
      { type: "text", text: proposal.tabName },
    ],
  });
}

/** The CLI withdrew the request (answered in its terminal, or quit). */
export function cancelProposal(id: string) {
  settle(id, "closed", null);
}

/** close_tab: the CLI is done with a diff. */
export function closeProposalTab(tabName: string): boolean {
  let found = false;
  for (const proposal of [...pending.values()]) {
    if (proposal.tabName !== tabName) continue;
    found = true;
    settle(proposal.id, "closed", text("TAB_CLOSED"));
  }
  return found;
}

/** closeAllDiffTabs: close every Claude Code diff (not Sable's own diffs). */
export function closeAllProposals(): number {
  const ids = new Set([...pending.keys(), ...Object.keys(useClaudeCodeStore.getState().proposals)]);
  let count = 0;
  for (const id of ids) {
    if (pending.has(id)) settle(id, "closed", text("TAB_CLOSED"));
    else if (tabIsOpen(id)) closeTab(id);
    else continue;
    count += 1;
  }
  return count;
}

/** When the CLI has written the accepted text, the editor is clean again. */
async function markSavedOnceWritten(path: string, finalText: string) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const onDisk = await readFile(path).catch(() => null);
    if (onDisk === finalText) {
      if (getModelValue(path) === finalText) {
        markSaved(path);
        useTabsStore.getState().syncDirtyState(path);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// A proposal's tab closed by the user is a rejection (as in VS Code).
useTabsStore.subscribe((state, previous) => {
  if (state.groups === previous.groups || pending.size === 0) return;
  for (const id of [...pending.keys()]) {
    if (closingQuietly.has(id)) continue;
    const key = proposalTabKey(id);
    const was = previous.groups.some((group) => group.tabs.some((tab) => tab.path === key));
    const is = state.groups.some((group) => group.tabs.some((tab) => tab.path === key));
    if (was && !is) rejectProposal(id);
  }
});
