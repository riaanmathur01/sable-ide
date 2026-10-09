import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useGitStore } from "../../store/gitStore";
import type { CommitInfo, RebaseStep } from "../../lib/ipc";
import "./RebaseDialog.css";

const ACTIONS: { value: RebaseStep["action"]; label: string; hint: string }[] = [
  { value: "pick", label: "Pick", hint: "Keep the commit" },
  { value: "reword", label: "Reword", hint: "Keep it, with a new message" },
  { value: "squash", label: "Squash", hint: "Fold into the commit above, keeping both messages" },
  { value: "fixup", label: "Fixup", hint: "Fold into the commit above, dropping this message" },
  { value: "drop", label: "Drop", hint: "Remove the commit" },
];

interface Row {
  commit: CommitInfo;
  action: RebaseStep["action"];
  message: string;
}

/** History → right-click → Interactive Rebase from Here…: reorder,
 *  reword, squash, fixup or drop the commits after a commit. */
export function RebaseDialog() {
  const dialog = useGitStore((state) => state.rebaseDialog);
  return dialog ? <Dialog base={dialog.base} commits={dialog.commits} /> : null;
}

function Dialog({ base, commits }: { base: string; commits: CommitInfo[] }) {
  const close = () => useGitStore.getState().setRebaseDialog(null);
  const [rows, setRows] = useState<Row[]>(() =>
    commits.map((commit) => ({
      commit,
      action: "pick",
      message: commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary,
    })),
  );
  const update = (index: number, change: Partial<Row>) =>
    setRows(rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    setRows(next);
  };
  const firstKept = rows.find((row) => row.action !== "drop");
  const problem =
    firstKept && (firstKept.action === "squash" || firstKept.action === "fixup")
      ? "The first commit can't be squashed — there's nothing above it to fold into"
      : rows.some((row) => row.action === "reword" && !row.message.trim())
        ? "A reworded commit needs a message"
        : null;
  const unchanged = rows.every((row, index) => row.action === "pick" && row.commit === commits[index]);

  const start = () => {
    if (problem || unchanged) return;
    close();
    void useGitStore.getState().rebaseInteractive(
      base,
      rows.map((row) => ({
        action: row.action,
        hash: row.commit.hash,
        ...(row.action === "reword" && { message: row.message }),
      })),
    );
  };

  return (
    <div className="rebase-backdrop" onMouseDown={close}>
      <div className="rebase-dialog" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && close()}>
        <div className="rebase-title">Interactive Rebase</div>
        <p className="rebase-note">
          Oldest first. Rewrites these {rows.length} commit{rows.length === 1 ? "" : "s"} on top of {base.slice(0, 7)} — don't
          rewrite commits others have already pulled.
        </p>
        <div className="rebase-rows">
          {rows.map((row, index) => (
            <div key={row.commit.hash} className={`rebase-row ${row.action}`}>
              <select
                value={row.action}
                onChange={(event) => update(index, { action: event.target.value as RebaseStep["action"] })}
                title={ACTIONS.find((action) => action.value === row.action)?.hint}
              >
                {ACTIONS.map((action) => (
                  <option key={action.value} value={action.value} title={action.hint}>
                    {action.label}
                  </option>
                ))}
              </select>
              <span className="rebase-hash">{row.commit.shortHash}</span>
              {row.action === "reword" ? (
                <textarea
                  autoFocus
                  rows={Math.min(6, row.message.split("\n").length + 1)}
                  value={row.message}
                  onChange={(event) => update(index, { message: event.target.value })}
                />
              ) : (
                <span className="rebase-summary">{row.commit.summary}</span>
              )}
              <span className="rebase-move">
                <button disabled={index === 0} onClick={() => move(index, -1)} title="Move up (earlier)">
                  <ArrowUp size={12} strokeWidth={1.75} />
                </button>
                <button disabled={index === rows.length - 1} onClick={() => move(index, 1)} title="Move down (later)">
                  <ArrowDown size={12} strokeWidth={1.75} />
                </button>
              </span>
            </div>
          ))}
        </div>
        {problem && <div className="rebase-problem">{problem}</div>}
        <div className="rebase-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!!problem || unchanged} onClick={start}>
            Start Rebase
          </button>
        </div>
      </div>
    </div>
  );
}
