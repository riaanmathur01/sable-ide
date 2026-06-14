import { useMemo, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import { iconForFile } from "../../lib/fileIcons";
import type { GitFileStatus } from "../../lib/ipc";
import "./SourceControlPanel.css";

/** Single-letter badge + color class per status (mirrors the tree). */
const STATUS_BADGE: Record<
  GitFileStatus,
  { letter: string; colorClass: string }
> = {
  modified: { letter: "M", colorClass: "git-modified" },
  added: { letter: "A", colorClass: "git-added" },
  untracked: { letter: "U", colorClass: "git-added" },
  deleted: { letter: "D", colorClass: "git-deleted" },
  renamed: { letter: "R", colorClass: "git-modified" },
};

interface ChangeRow {
  path: string;
  name: string;
  status: GitFileStatus;
}

/**
 * Source-control view: staged/unstaged sections, per-file and bulk
 * stage/unstage, a commit message box, and the commit action. All git
 * work goes through gitStore → Rust (git2).
 */
export function SourceControlPanel() {
  const isRepo = useGitStore((state) => state.isRepo);
  const branch = useGitStore((state) => state.branch);
  const statusByPath = useGitStore((state) => state.statusByPath);
  const stage = useGitStore((state) => state.stage);
  const unstage = useGitStore((state) => state.unstage);
  const stageAll = useGitStore((state) => state.stageAll);
  const unstageAll = useGitStore((state) => state.unstageAll);
  const commit = useGitStore((state) => state.commit);
  const setIdentity = useGitStore((state) => state.setIdentity);
  const openDiff = useTabsStore((state) => state.openDiff);

  const [message, setMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [identityPrompt, setIdentityPrompt] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");

  // Split the flat status map into the two sections. A file can be in
  // both (staged, then edited again), so we don't treat them exclusively.
  const { staged, unstaged } = useMemo(() => {
    const stagedRows: ChangeRow[] = [];
    const unstagedRows: ChangeRow[] = [];
    for (const [path, entry] of Object.entries(statusByPath)) {
      const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
      if (entry.staged) {
        stagedRows.push({ path, name, status: entry.staged });
      }
      if (entry.unstaged) {
        unstagedRows.push({ path, name, status: entry.unstaged });
      }
    }
    const byName = (a: ChangeRow, b: ChangeRow) =>
      a.name.localeCompare(b.name);
    return {
      staged: stagedRows.sort(byName),
      unstaged: unstagedRows.sort(byName),
    };
  }, [statusByPath]);

  if (!isRepo) {
    return (
      <div className="scm-empty">
        This folder isn’t a Git repository.
      </div>
    );
  }

  const canCommit = staged.length > 0 && message.trim().length > 0;

  async function onCommit() {
    if (!canCommit || isCommitting) return;
    setIsCommitting(true);
    const outcome = await commit(message);
    setIsCommitting(false);
    if (outcome.ok) {
      setMessage("");
      setConfirmation(`Committed ${staged.length} file${staged.length === 1 ? "" : "s"}`);
      setTimeout(() => setConfirmation(null), 3000);
    } else if (outcome.needsIdentity) {
      setIdentityPrompt(true);
    } else {
      setConfirmation(outcome.message);
      setTimeout(() => setConfirmation(null), 5000);
    }
  }

  async function onSaveIdentity() {
    if (!identityName.trim() || !identityEmail.trim()) return;
    const ok = await setIdentity(identityName, identityEmail);
    if (ok) {
      setIdentityPrompt(false);
      void onCommit(); // retry the commit now that identity is set
    }
  }

  return (
    <div className="scm-panel">
      <div className="scm-commit-box">
        <textarea
          className="scm-message"
          placeholder={`Message (commit to ${branch ?? "HEAD"})`}
          value={message}
          rows={2}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter commits.
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void onCommit();
            }
          }}
        />
        <button
          className="scm-commit-button"
          disabled={!canCommit || isCommitting}
          onClick={onCommit}
        >
          <Check size={13} strokeWidth={1.5} />
          {staged.length > 0 ? `Commit ${staged.length}` : "Commit"}
        </button>
        {confirmation && <div className="scm-confirmation">{confirmation}</div>}
      </div>

      {identityPrompt && (
        <div className="scm-identity">
          <div className="scm-identity-title">Set your Git identity</div>
          <input
            className="scm-identity-input"
            placeholder="Your Name"
            value={identityName}
            onChange={(event) => setIdentityName(event.target.value)}
          />
          <input
            className="scm-identity-input"
            placeholder="you@example.com"
            value={identityEmail}
            onChange={(event) => setIdentityEmail(event.target.value)}
          />
          <div className="scm-identity-actions">
            <button className="scm-mini-button" onClick={onSaveIdentity}>
              Save & Commit
            </button>
            <button
              className="scm-mini-button ghost"
              onClick={() => setIdentityPrompt(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ChangeSection
        title="Staged Changes"
        rows={staged}
        actionIcon={<Minus size={14} strokeWidth={1.5} />}
        actionTitle="Unstage"
        onAction={unstage}
        onActionAll={staged.length > 0 ? unstageAll : undefined}
        actionAllTitle="Unstage all"
        onOpenDiff={(path) => openDiff(path, true)}
      />
      <ChangeSection
        title="Changes"
        rows={unstaged}
        actionIcon={<Plus size={14} strokeWidth={1.5} />}
        actionTitle="Stage"
        onAction={stage}
        onActionAll={unstaged.length > 0 ? stageAll : undefined}
        actionAllTitle="Stage all"
        onOpenDiff={(path) => openDiff(path, false)}
      />

      {staged.length === 0 && unstaged.length === 0 && (
        <div className="scm-clean">No changes</div>
      )}
    </div>
  );
}

interface ChangeSectionProps {
  title: string;
  rows: ChangeRow[];
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (path: string) => void;
  onActionAll?: () => void;
  actionAllTitle: string;
  onOpenDiff: (path: string) => void;
}

function ChangeSection({
  title,
  rows,
  actionIcon,
  actionTitle,
  onAction,
  onActionAll,
  actionAllTitle,
  onOpenDiff,
}: ChangeSectionProps) {
  if (rows.length === 0) return null;
  return (
    <div className="scm-section">
      <div className="scm-section-header">
        <span>
          {title} <span className="scm-count">{rows.length}</span>
        </span>
        {onActionAll && (
          <button
            className="scm-section-action"
            title={actionAllTitle}
            onClick={onActionAll}
          >
            {actionIcon}
          </button>
        )}
      </div>
      {rows.map((row) => {
        const badge = STATUS_BADGE[row.status];
        const FileIcon = iconForFile(row.name);
        return (
          <div
            className="scm-row"
            key={`${title}:${row.path}`}
            title={`${row.path} — click to view diff`}
            onClick={() => onOpenDiff(row.path)}
          >
            <FileIcon size={14} strokeWidth={1.5} className="scm-row-icon" />
            <span className={`scm-row-name ${badge.colorClass}`}>
              {row.name}
            </span>
            <button
              className="scm-row-action"
              title={actionTitle}
              onClick={(event) => {
                event.stopPropagation();
                onAction(row.path);
              }}
            >
              {actionIcon}
            </button>
            <span className={`scm-row-badge ${badge.colorClass}`}>
              {badge.letter}
            </span>
          </div>
        );
      })}
    </div>
  );
}
