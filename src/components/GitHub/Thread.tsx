import { useState } from "react";
import { CheckCheck, RotateCcw } from "lucide-react";
import { github, timeAgo, type PendingComment, type ReviewThread, type ThreadComment } from "../../lib/github/api";
import { act, prKey, useGitHubStore } from "../../store/githubStore";
import { Avatar } from "./common";
import { Markdown } from "./Markdown";

export function CommentView({ author, body, createdAt, repoUrl, badge }: { author: string; body: string; createdAt: string; repoUrl?: string; badge?: React.ReactNode }) {
  return (
    <div className="gh-comment">
      <div className="gh-comment-head">
        <Avatar login={author} size={18} />
        <span className="gh-comment-author">{author}</span>
        {badge}
        <span className="gh-comment-time" title={createdAt}>
          {timeAgo(createdAt)}
        </span>
      </div>
      {body.trim() ? <Markdown text={body} repoUrl={repoUrl} className="gh-comment-body" /> : <div className="gh-comment-body gh-muted">No description provided.</div>}
    </div>
  );
}

/** A textarea that grows, with ⌘Enter to submit. */
export function Composer({
  placeholder,
  value,
  onChange,
  onSubmit,
  autoFocus,
  rows = 3,
  className,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      className={`gh-textarea ${className ?? ""}`}
      placeholder={placeholder}
      value={value}
      rows={rows}
      autoFocus={autoFocus}
      spellCheck
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

/**
 * A review thread: its comments, a reply box, and Resolve / Unresolve.
 * Shown in the pull request's conversation and inline in its diffs.
 */
export function ThreadView({ root, number, thread, repoUrl, showPath, onOpen }: { root: string; number: number; thread: ReviewThread; repoUrl?: string; showPath?: boolean; onOpen?: () => void }) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const first: ThreadComment | undefined = thread.comments[0];
  const reload = () => useGitHubStore.getState().loadPr(root, number, { threads: true });

  const sendReply = async () => {
    if (!reply.trim() || !first) return;
    setBusy(true);
    const done = await act(() => github.reply(root, number, first.databaseId, reply), "Reply posted");
    setBusy(false);
    if (done !== undefined) {
      setReply("");
      setReplying(false);
      await reload();
    }
  };
  const toggleResolved = async () => {
    setBusy(true);
    await act(() => github.resolveThread(root, thread.id, !thread.isResolved), thread.isResolved ? "Conversation reopened" : "Conversation resolved");
    setBusy(false);
    await reload();
  };

  const lines = thread.startLine && thread.line && thread.startLine !== thread.line ? `lines ${thread.startLine}–${thread.line}` : `line ${thread.line ?? "?"}`;
  return (
    <div className={`gh-thread${thread.isResolved ? " resolved" : ""}`} data-thread={thread.id}>
      {(showPath || thread.isResolved || thread.isOutdated) && (
        <div className="gh-thread-head" onClick={() => setExpanded((value) => !value)}>
          {showPath && (
            <button
              className="gh-thread-path"
              title="Show in the diff"
              onClick={(event) => {
                event.stopPropagation();
                onOpen?.();
              }}
            >
              {thread.path}
              <span className="gh-muted"> · {lines}</span>
            </button>
          )}
          {thread.isOutdated && <span className="gh-tag">Outdated</span>}
          {thread.isResolved && <span className="gh-tag resolved">Resolved</span>}
          {!showPath && <span className="gh-thread-toggle gh-muted">{expanded ? "Hide" : `Show ${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"}`}</span>}
        </div>
      )}
      {(expanded || showPath) && (
        <>
          {thread.comments.map((comment) => (
            <CommentView key={comment.id} author={comment.author} body={comment.body} createdAt={comment.createdAt} repoUrl={repoUrl} />
          ))}
          <div className="gh-thread-actions">
            {replying ? (
              <div className="gh-reply">
                <Composer placeholder="Reply…" value={reply} onChange={setReply} onSubmit={() => void sendReply()} autoFocus rows={2} />
                <div className="gh-buttons">
                  <button className="gh-button primary" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>
                    Reply
                  </button>
                  <button
                    className="gh-button"
                    onClick={() => {
                      setReplying(false);
                      setReply("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <input className="gh-reply-placeholder" placeholder="Reply…" readOnly onFocus={() => setReplying(true)} onClick={() => setReplying(true)} />
                <button className="gh-button" disabled={busy} onClick={() => void toggleResolved()}>
                  {thread.isResolved ? <RotateCcw size={12} strokeWidth={1.75} /> : <CheckCheck size={12} strokeWidth={1.75} />}
                  {thread.isResolved ? "Unresolve" : "Resolve"}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A comment waiting for the review to be submitted. */
export function PendingView({ root, number, comment }: { root: string; number: number; comment: PendingComment }) {
  const key = prKey(root, number);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const login = useGitHubStore((state) => state.status?.user?.login ?? "you");
  return (
    <div className="gh-thread pending" data-pending={comment.id}>
      {editing ? (
        <div className="gh-reply">
          <Composer
            placeholder="Comment…"
            value={text}
            onChange={setText}
            autoFocus
            onSubmit={() => {
              useGitHubStore.getState().updatePending(key, comment.id, text);
              setEditing(false);
            }}
          />
          <div className="gh-buttons">
            <button
              className="gh-button primary"
              disabled={!text.trim()}
              onClick={() => {
                useGitHubStore.getState().updatePending(key, comment.id, text);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button className="gh-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <CommentView author={login} body={comment.body} createdAt={new Date().toISOString()} badge={<span className="gh-tag pending">Pending</span>} />
          <div className="gh-thread-actions">
            <button className="gh-button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="gh-button" onClick={() => useGitHubStore.getState().removePending(key, comment.id)}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
