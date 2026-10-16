import { Check, FileDiff, X } from "lucide-react";
import type { DiffSource } from "../../store/tabsStore";
import { useClaudeCodeStore } from "../../lib/claudeCode/store";
import { acceptProposal, proposalContents, proposalIsNewFile, rejectProposal } from "../../lib/claudeCode/proposals";
import "./ClaudeCode.css";

type ProposalSource = Extract<DiffSource, { kind: "claude" }>;

/** A proposal's two sides: the file as the editor has it (empty for a
 *  new file), and what Claude Code proposes. */
export async function loadProposalSides(
  source: ProposalSource,
  currentText: (path: string) => Promise<string>,
): Promise<{ original: string; modified: string; isBinary: boolean }> {
  const modified = proposalContents(source.proposalId) ?? "";
  const original = proposalIsNewFile(source.proposalId) ? "" : await currentText(source.filePath).catch(() => "");
  return { original, modified, isBinary: false };
}

/** The diff toolbar of a change Claude Code proposes: Accept / Reject. */
export function ProposalToolbar({ source, modifiedText }: { source: ProposalSource; modifiedText: () => string | null }) {
  const info = useClaudeCodeStore((state) => state.proposals[source.proposalId]);
  const pending = info?.status === "pending";
  const id = source.proposalId;
  return (
    <div className="claude-proposal-bar">
      <span className="claude-proposal-label" title={source.filePath}>
        <FileDiff size={14} strokeWidth={1.5} />
        <span>Proposed change from Claude Code{info?.isNewFile ? " (new file)" : ""}</span>
        {pending && <span className="claude-proposal-hint">— edit the right side before accepting if you like</span>}
        {info && !pending && <span className="claude-proposal-hint">— {info.status}</span>}
      </span>
      <button className="claude-proposal-button reject" disabled={!pending} title="Reject the change (Claude Code keeps the file as it is)" onClick={() => rejectProposal(id)}>
        <X size={14} strokeWidth={1.75} />
        <span>Reject</span>
      </button>
      <button
        className="claude-proposal-button accept"
        disabled={!pending}
        title="Accept the change (Claude Code writes it; ⌘Z in the editor undoes it)"
        onClick={() => acceptProposal(id, modifiedText() ?? proposalContents(id) ?? "")}
      >
        <Check size={14} strokeWidth={1.75} />
        <span>Accept</span>
      </button>
    </div>
  );
}
