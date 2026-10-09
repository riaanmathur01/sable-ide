import { useEffect, useMemo, useState } from "react";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { Archive, ArrowDownToLine, Check, ChevronDown, ChevronRight, GitMerge, Minus, Plus, Trash2 } from "lucide-react";
import { useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import { iconForFile } from "../../lib/fileIcons";
import { gitCommitFiles, type CommitFile, type GitFileStatus, type StashInfo } from "../../lib/ipc";
import { useWorkspaceStore } from "../../store/workspaceStore";
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
  conflicted: { letter: "!", colorClass: "git-conflicted" },
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
  const openMerge = useTabsStore((state) => state.openMerge);
  const operation = useGitStore((state) => state.operation);
  const mergeMessage = useGitStore((state) => state.mergeMessage);
  const abort = useGitStore((state) => state.abort);

  const [message, setMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [identityPrompt, setIdentityPrompt] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");

  // Split the flat status map into the two sections. A file can be in
  // both (staged, then edited again), so we don't treat them exclusively.
  const { staged, unstaged, conflicted } = useMemo(() => {
    const stagedRows: ChangeRow[] = [];
    const unstagedRows: ChangeRow[] = [];
    const conflictedRows: ChangeRow[] = [];
    for (const [path, entry] of Object.entries(statusByPath)) {
      const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
      if (entry.staged) {
        stagedRows.push({ path, name, status: entry.staged });
      }
      if (entry.unstaged === "conflicted") {
        conflictedRows.push({ path, name, status: entry.unstaged });
      } else if (entry.unstaged) {
        unstagedRows.push({ path, name, status: entry.unstaged });
      }
    }
    const byName = (a: ChangeRow, b: ChangeRow) =>
      a.name.localeCompare(b.name);
    return {
      staged: stagedRows.sort(byName),
      unstaged: unstagedRows.sort(byName),
      conflicted: conflictedRows.sort(byName),
    };
  }, [statusByPath]);

  // Finishing a merge: start from the message Git prepared.
  useEffect(() => {
    if (operation && mergeMessage) setMessage((current) => current || mergeMessage);
  }, [operation, mergeMessage]);

  if (!isRepo) {
    return (
      <div className="scm-empty">
        This folder isn’t a Git repository.
      </div>
    );
  }

  // A merge can be committed with nothing staged (every conflict resolved
  // to the current side), but not while conflicts remain.
  // During a rebase, Continue (not Commit) moves it on.
  const canCommit =
    operation !== "rebase" &&
    (staged.length > 0 || operation === "merge") &&
    conflicted.length === 0 &&
    message.trim().length > 0;

  async function onCommit() {
    if (!canCommit || isCommitting) return;
    setIsCommitting(true);
    const outcome = await commit(message);
    setIsCommitting(false);
    if (outcome.ok) {
      setMessage("");
      setConfirmation(
        operation === "merge" ? "Merge committed" : `Committed ${staged.length} file${staged.length === 1 ? "" : "s"}`,
      );
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
          {operation === "merge" ? "Commit Merge" : staged.length > 0 ? `Commit ${staged.length}` : "Commit"}
        </button>
        {confirmation && <div className="scm-confirmation">{confirmation}</div>}
      </div>

      {operation && (
        <div className="scm-operation">
          <GitMerge size={13} strokeWidth={1.5} />
          <span className="scm-operation-text">
            {conflicted.length > 0
              ? `${capitalize(operation)} in progress — resolve ${conflicted.length} conflict${conflicted.length === 1 ? "" : "s"}, then ${operation === "rebase" ? "Continue" : "commit"}`
              : operation === "rebase"
                ? "Rebase stopped — Continue when ready"
                : `${capitalize(operation)} in progress — commit to finish it`}
          </span>
          {operation === "rebase" && (
            <>
              <button
                className="scm-mini-button"
                disabled={conflicted.length > 0}
                title={conflicted.length ? "Resolve the conflicts first" : "Go on with the rebase"}
                onClick={() => void useGitStore.getState().continueRebase()}
              >
                Continue
              </button>
              <button
                className="scm-mini-button ghost"
                title="Leave out the commit that stopped, and go on"
                onClick={() => void useGitStore.getState().continueRebase(true)}
              >
                Skip
              </button>
            </>
          )}
          <button
            className="scm-mini-button ghost"
            title={`Abandon the ${operation}: back to how things were before it`}
            onClick={() => {
              void confirmNative(`Abort the ${operation}? Changes made while resolving it are discarded.`, {
                title: `Abort ${capitalize(operation)}`,
                kind: "warning",
              }).then((yes) => {
                if (yes) void abort();
              });
            }}
          >
            Abort
          </button>
        </div>
      )}

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
        title="Merge Conflicts"
        rows={conflicted}
        actionIcon={<Check size={14} strokeWidth={1.5} />}
        actionTitle="Mark as resolved (stage)"
        onAction={stage}
        actionAllTitle=""
        rowTitle="click to open the merge tool"
        onOpenDiff={(path) => openMerge(path)}
      />
      <ChangeSection
        title="Staged Changes"
        rows={staged}
        actionIcon={<Minus size={14} strokeWidth={1.5} />}
        actionTitle="Unstage"
        onAction={unstage}
        onActionAll={staged.length > 0 ? unstageAll : undefined}
        actionAllTitle="Unstage all"
        onOpenDiff={(path) =>
          openDiff({ kind: "working", filePath: path, staged: true })
        }
      />
      <ChangeSection
        title="Changes"
        rows={unstaged}
        actionIcon={<Plus size={14} strokeWidth={1.5} />}
        actionTitle="Stage"
        onAction={stage}
        onActionAll={unstaged.length > 0 ? stageAll : undefined}
        actionAllTitle="Stage all"
        onOpenDiff={(path) =>
          openDiff({ kind: "working", filePath: path, staged: false })
        }
      />

      {staged.length === 0 && unstaged.length === 0 && conflicted.length === 0 && (
        <div className="scm-clean">No changes</div>
      )}

      <StashSection hasChanges={staged.length + unstaged.length > 0} />
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
  /** Hover hint for a row (default: view its diff). */
  rowTitle?: string;
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
  rowTitle = "click to view diff",
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
            title={`${row.path} — ${rowTitle}`}
            onClick={() => onOpenDiff(row.path)}
            role="button"
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** Stashes: save the working changes aside, bring them back later. */
function StashSection({ hasChanges }: { hasChanges: boolean }) {
  const stashes = useGitStore((state) => state.stashes);
  const loadStashes = useGitStore((state) => state.loadStashes);
  const stashSave = useGitStore((state) => state.stashSave);
  const stashApply = useGitStore((state) => state.stashApply);
  const stashDrop = useGitStore((state) => state.stashDrop);
  const statusByPath = useGitStore((state) => state.statusByPath);
  const openDiff = useTabsStore((state) => state.openDiff);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, CommitFile[]>>({});

  // The list changes with the working tree (and stash commands).
  useEffect(() => {
    void loadStashes();
  }, [loadStashes, statusByPath]);

  const save = async () => {
    setComposing(false);
    await stashSave(message.trim() || null, includeUntracked);
    setMessage("");
  };

  const toggle = async (stash: StashInfo) => {
    if (expanded === stash.hash) return setExpanded(null);
    setExpanded(stash.hash);
    const root = useWorkspaceStore.getState().rootPath;
    if (root && !files[stash.hash]) {
      const changed = await gitCommitFiles(root, stash.hash).catch(() => []);
      setFiles((current) => ({ ...current, [stash.hash]: changed }));
    }
  };

  if (stashes.length === 0 && !hasChanges) return null;
  return (
    <div className="scm-section">
      <div className="scm-section-header">
        <span>
          Stashes <span className="scm-count">{stashes.length}</span>
        </span>
        {hasChanges && (
          <button className="scm-section-action" title="Stash changes…" onClick={() => setComposing((value) => !value)}>
            <Archive size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {composing && (
        <div className="scm-stash-compose">
          <input
            className="scm-identity-input"
            autoFocus
            placeholder="Message (optional) — Enter to stash"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setComposing(false);
            }}
          />
          <label className="scm-stash-option">
            <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
            Include new (untracked) files
          </label>
        </div>
      )}
      {stashes.map((stash) => {
        const Chevron = expanded === stash.hash ? ChevronDown : ChevronRight;
        return (
          <div key={stash.hash}>
            <div className="scm-row scm-stash-row" title={stash.message} onClick={() => void toggle(stash)} role="button">
              <Chevron size={13} strokeWidth={1.5} className="scm-row-icon" />
              <span className="scm-row-name">{stash.message.replace(/^(WIP )?[Oo]n [^:]+: /, "")}</span>
              <span className="scm-stash-time">{relativeTime(stash.timestamp)}</span>
              <button
                className="scm-row-action"
                title="Apply (keep the stash)"
                onClick={(event) => {
                  event.stopPropagation();
                  void stashApply(stash.index, false);
                }}
              >
                <ArrowDownToLine size={14} strokeWidth={1.5} />
              </button>
              <button
                className="scm-row-action"
                title="Pop (apply, then drop the stash)"
                onClick={(event) => {
                  event.stopPropagation();
                  void stashApply(stash.index, true);
                }}
              >
                <Check size={14} strokeWidth={1.5} />
              </button>
              <button
                className="scm-row-action"
                title="Drop (delete the stash)"
                onClick={(event) => {
                  event.stopPropagation();
                  void confirmNative("Delete this stash? Its changes are lost.", { title: "Drop Stash", kind: "warning" }).then(
                    (yes) => {
                      if (yes) void stashDrop(stash.index);
                    },
                  );
                }}
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>
            {expanded === stash.hash &&
              (files[stash.hash] ?? []).map((file) => (
                <div
                  key={file.path}
                  className="scm-row scm-stash-file"
                  title={file.path}
                  onClick={() => openDiff({ kind: "commit", filePath: file.path, hash: stash.hash, shortHash: `stash@{${stash.index}}` })}
                  role="button"
                >
                  <span className="scm-row-name">{file.path.split(/[/\\]/).pop()}</span>
                  <span className={`scm-row-badge ${STATUS_BADGE[file.status]?.colorClass ?? ""}`}>
                    {STATUS_BADGE[file.status]?.letter ?? ""}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
