import { useEffect, useState } from "react";
import {
  Check,
  Download,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useGitStore } from "../../store/gitStore";
import "./BranchPicker.css";

/**
 * Branch switcher + sync controls. Branch operations are local (git2);
 * Fetch/Pull/Push shell out to `git` for credentials. Anchored above the
 * status-bar branch button.
 */
export function BranchPicker({ onClose }: { onClose: () => void }) {
  const branches = useGitStore((state) => state.branches);
  const hasRemote = useGitStore((state) => state.hasRemote);
  const isSyncing = useGitStore((state) => state.isSyncing);
  const syncMessage = useGitStore((state) => state.syncMessage);
  const loadBranches = useGitStore((state) => state.loadBranches);
  const switchBranch = useGitStore((state) => state.switchBranch);
  const createBranch = useGitStore((state) => state.createBranch);
  const deleteBranch = useGitStore((state) => state.deleteBranch);
  const merge = useGitStore((state) => state.merge);
  const rebase = useGitStore((state) => state.rebase);
  const fetch = useGitStore((state) => state.fetch);
  const pull = useGitStore((state) => state.pull);
  const push = useGitStore((state) => state.push);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(false);
    setNewName("");
    await createBranch(name);
    onClose();
  }

  return (
    <div className="branch-backdrop" onMouseDown={onClose}>
      <div
        className="branch-popover"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="branch-sync-row">
          <button
            className="branch-sync-button"
            disabled={!hasRemote || isSyncing}
            title="Fetch"
            onClick={() => fetch()}
          >
            <Download size={13} strokeWidth={1.5} /> Fetch
          </button>
          <button
            className="branch-sync-button"
            disabled={!hasRemote || isSyncing}
            title="Pull"
            onClick={() => pull()}
          >
            <Download size={13} strokeWidth={1.5} /> Pull
          </button>
          <button
            className="branch-sync-button"
            disabled={!hasRemote || isSyncing}
            title="Push"
            onClick={() => push()}
          >
            <Upload size={13} strokeWidth={1.5} /> Push
          </button>
        </div>
        {!hasRemote && (
          <div className="branch-note">No remote configured</div>
        )}
        {(isSyncing || syncMessage) && (
          <div className="branch-note branch-message">
            {isSyncing ? "Working…" : syncMessage}
          </div>
        )}

        <div className="branch-divider" />
        <div className="branch-header">Branches</div>

        {branches.map((branch) => (
          <div
            key={branch.name}
            className="branch-item"
            onClick={() => {
              if (!branch.isCurrent) {
                void switchBranch(branch.name);
                onClose();
              }
            }}
          >
            <span className="branch-check">
              {branch.isCurrent && <Check size={13} strokeWidth={2} />}
            </span>
            <GitBranch size={13} strokeWidth={1.5} className="branch-icon" />
            <span className="branch-name">{branch.name}</span>
            {!branch.isCurrent && (
              <button
                className="branch-delete branch-merge"
                title={`Merge ${branch.name} into the current branch`}
                disabled={isSyncing}
                onClick={(event) => {
                  event.stopPropagation();
                  void merge(branch.name);
                }}
              >
                <GitMerge size={12} strokeWidth={1.5} />
              </button>
            )}
            {!branch.isCurrent && (
              <button
                className="branch-delete branch-merge"
                title={`Rebase the current branch onto ${branch.name}`}
                disabled={isSyncing}
                onClick={(event) => {
                  event.stopPropagation();
                  void rebase(branch.name);
                  onClose();
                }}
              >
                <GitPullRequestArrow size={12} strokeWidth={1.5} />
              </button>
            )}
            {!branch.isCurrent && (
              <button
                className="branch-delete"
                title="Delete branch"
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteBranch(branch.name);
                }}
              >
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
            )}
          </div>
        ))}

        <div className="branch-divider" />
        {creating ? (
          <input
            className="branch-create-input"
            autoFocus
            placeholder="new branch name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onCreate();
              if (event.key === "Escape") setCreating(false);
            }}
            onBlur={() => setCreating(false)}
          />
        ) : (
          <button
            className="branch-item branch-create"
            onClick={() => setCreating(true)}
          >
            <span className="branch-check">
              <Plus size={13} strokeWidth={1.5} />
            </span>
            <span className="branch-name">Create new branch…</span>
          </button>
        )}
      </div>
    </div>
  );
}
