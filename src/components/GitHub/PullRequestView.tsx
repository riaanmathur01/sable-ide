import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleCheck,
  CircleX,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import { github, timeAgo, type Check as CheckRun, type PrDetails, type PrFile } from "../../lib/github/api";
import { act, prKey, useGitHubStore } from "../../store/githubStore";
import { useGitStore } from "../../store/gitStore";
import { checkoutPullRequest, openPrFile } from "../../lib/github/actions";
import { Avatar, CheckBadge, checkTitle, openExternal, StatePill } from "./common";
import { CommentView, Composer, PendingView, ThreadView } from "./Thread";
import { ChoiceBlock, LabelList, PeopleList, repoAssignees, repoLabels } from "./Pickers";

type Section = "conversation" | "commits" | "checks" | "files";

/** A pull request's page: description, timeline, commits, checks, files, actions. */
export function PullRequestView({ root, number }: { root: string; number: number }) {
  const key = prKey(root, number);
  const state = useGitHubStore((store) => store.prs[key]);
  const pending = useGitHubStore((store) => store.pending[key]) ?? [];
  const repoUrl = useGitHubStore((store) => store.status?.repo?.url);
  const branch = useGitStore((store) => store.branch);
  const [section, setSection] = useState<Section>("conversation");
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void useGitHubStore.getState().checkStatus();
    void useGitHubStore.getState().loadPr(root, number);
  }, [root, number]);

  const pr = state?.details;
  const reload = () => useGitHubStore.getState().loadPr(root, number);

  if (!pr) {
    return (
      <div className="gh-page">
        <div className="gh-page-status">
          {state?.error ? (
            <>
              <div className="gh-error-text">{state.error}</div>
              <button className="gh-button" onClick={() => void reload()}>
                Try again
              </button>
            </>
          ) : (
            "Loading pull request…"
          )}
        </div>
      </div>
    );
  }

  const run = async (name: string, action: () => Promise<unknown>, done: string) => {
    setBusy(name);
    const result = await act(action, done);
    setBusy(null);
    if (result !== undefined) {
      await reload();
      void useGitHubStore.getState().refreshLists(true);
    }
  };
  const isOpen = pr.state === "OPEN";
  const checkedOut = branch === pr.headRefName;
  const threads = state.threads?.threads ?? [];
  const files = state.files ?? [];
  const reviewerStates = Object.fromEntries(pr.reviewers.map((reviewer) => [reviewer.login, reviewer.state]));

  return (
    <div className="gh-page gh-pr" data-pr={pr.number}>
      <div className="gh-page-scroll">
        <header className="gh-page-header">
          <h1 className="gh-page-title">
            {pr.title} <span className="gh-page-number">#{pr.number}</span>
          </h1>
          <div className="gh-page-subtitle">
            <StatePill state={pr.state} isDraft={pr.isDraft} />
            <Avatar login={pr.author} size={18} />
            <span>
              <strong>{pr.author}</strong> wants to merge {pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"} into <code className="gh-ref">{pr.baseRefName}</code> from{" "}
              <code className="gh-ref">{pr.headRefName}</code>
            </span>
            <span className="gh-muted">· {timeAgo(pr.createdAt)}</span>
          </div>
          <div className="gh-actions">
            {checkedOut ? (
              <span className="gh-checked-out" title="This pull request's branch is checked out">
                <Check size={13} strokeWidth={2} /> Checked out
              </span>
            ) : (
              <button className="gh-button" disabled={!!busy} onClick={() => void run("checkout", () => checkoutPullRequest(number, root), "")}>
                <GitBranch size={13} strokeWidth={1.75} /> Checkout
              </button>
            )}
            {isOpen && pr.isDraft && (
              <button className="gh-button" disabled={!!busy} onClick={() => void run("ready", () => github.setState(root, "pr", number, "ready"), `#${number} is ready for review`)}>
                Ready for review
              </button>
            )}
            {isOpen && (
              <button className="gh-button" disabled={!!busy} onClick={() => void run("close", () => github.setState(root, "pr", number, "close"), `Closed #${number}`)}>
                Close
              </button>
            )}
            {pr.state === "CLOSED" && (
              <button className="gh-button" disabled={!!busy} onClick={() => void run("reopen", () => github.setState(root, "pr", number, "reopen"), `Reopened #${number}`)}>
                Reopen
              </button>
            )}
            <button className="gh-button" onClick={() => openExternal(pr.url)}>
              <ExternalLink size={13} strokeWidth={1.75} /> Open on GitHub
            </button>
            <button className="gh-button icon" title="Refresh" onClick={() => void reload()}>
              <RefreshCw size={13} strokeWidth={1.75} className={state.loading ? "spinning" : undefined} />
            </button>
            <span className="gh-actions-spacer" />
            {isOpen && (
              <button className="gh-button merge" disabled={!!busy || pr.isDraft} title={pr.isDraft ? "Draft pull requests can't be merged" : undefined} onClick={() => setMerging(true)}>
                <GitMerge size={13} strokeWidth={1.75} /> Merge…
              </button>
            )}
          </div>
          <nav className="gh-tabs">
            {(
              [
                ["conversation", "Conversation", pr.timeline.length + threads.length, MessageSquare],
                ["commits", "Commits", pr.commits.length, GitCommitHorizontal],
                ["checks", "Checks", pr.checks.length, CircleCheck],
                ["files", "Files changed", files.length || pr.changedFiles, FileDiff],
              ] as const
            ).map(([id, label, count, Icon]) => (
              <button key={id} className={section === id ? "gh-tab active" : "gh-tab"} onClick={() => setSection(id)}>
                <Icon size={13} strokeWidth={1.75} />
                {label}
                <span className="gh-count">{count}</span>
                {id === "checks" && <CheckBadge state={pr.checkState} size={12} />}
              </button>
            ))}
          </nav>
        </header>
        {state.error && <div className="gh-banner error">{state.error}</div>}
        <div className="gh-page-body">
          <main className="gh-page-main">
            {section === "conversation" && (
              <>
                <div className="gh-card">
                  <CommentView author={pr.author} body={pr.body} createdAt={pr.createdAt} repoUrl={repoUrl} />
                </div>
                <Timeline root={root} pr={pr} />
                <ReviewComposer root={root} pr={pr} pendingCount={pending.length} />
              </>
            )}
            {section === "commits" && <Commits pr={pr} />}
            {section === "checks" && <Checks checks={pr.checks} />}
            {section === "files" && <FilesChanged root={root} pr={pr} files={files} />}
          </main>
          <aside className="gh-page-side">
            <ChoiceBlock
              title="Reviewers"
              selected={pr.reviewers.map((reviewer) => reviewer.login)}
              empty="No reviews"
              render={(people) => <PeopleList people={people} states={reviewerStates} />}
              load={async () => (await repoAssignees(root)).map((value) => ({ value }))}
            />
            <ChoiceBlock
              title="Assignees"
              selected={pr.assignees}
              empty="No one"
              render={(people) => <PeopleList people={people} />}
              load={async () => (await repoAssignees(root)).map((value) => ({ value }))}
              onApply={(add, remove) => github.edit(root, "pr", number, { addAssignees: add, removeAssignees: remove }).then(reload)}
            />
            <ChoiceBlock
              title="Labels"
              selected={pr.labels.map((label) => label.name)}
              empty="None yet"
              render={(names) => <LabelList labels={pr.labels.filter((label) => names.includes(label.name))} />}
              load={async () => (await repoLabels(root)).map((label) => ({ value: label.name, label }))}
              onApply={(add, remove) => github.edit(root, "pr", number, { addLabels: add, removeLabels: remove }).then(reload)}
            />
            {pr.milestone && (
              <div className="gh-side-block">
                <div className="gh-side-title">Milestone</div>
                <div>{pr.milestone}</div>
              </div>
            )}
            <div className="gh-side-block">
              <div className="gh-side-title">Checks</div>
              <div className="gh-side-checks" title={checkTitle(pr.checkState)}>
                <CheckBadge state={pr.checkState} />
                {pr.checks.length === 0 ? "No checks" : `${pr.checks.filter((check) => check.state === "success" || check.state === "neutral" || check.state === "skipped").length} of ${pr.checks.length} passed`}
              </div>
            </div>
            <div className="gh-side-block">
              <div className="gh-side-title">Changes</div>
              <div>
                <span className="gh-additions">+{pr.additions}</span> <span className="gh-deletions">−{pr.deletions}</span> in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
              </div>
            </div>
          </aside>
        </div>
      </div>
      {merging && <MergeDialog root={root} pr={pr} onClose={() => setMerging(false)} onMerged={() => void reload()} />}
    </div>
  );
}

/** Comments, reviews and review threads, oldest first. */
function Timeline({ root, pr }: { root: string; pr: PrDetails }) {
  const state = useGitHubStore((store) => store.prs[prKey(root, pr.number)]);
  const repoUrl = useGitHubStore((store) => store.status?.repo?.url);
  const entries = useMemo(() => {
    const items: { at: string; node: React.ReactNode }[] = pr.timeline.map((entry) => ({
      at: entry.createdAt,
      node: (
        <div key={`t:${entry.id}`} className={`gh-card${entry.kind === "review" ? ` review ${entry.state?.toLowerCase()}` : ""}`}>
          <CommentView
            author={entry.author}
            body={entry.body}
            createdAt={entry.createdAt}
            repoUrl={repoUrl}
            badge={entry.kind === "review" ? <span className={`gh-tag ${entry.state?.toLowerCase()}`}>{reviewVerb(entry.state ?? "")}</span> : undefined}
          />
        </div>
      ),
    }));
    for (const thread of state?.threads?.threads ?? []) {
      const file = state?.files?.find((candidate) => candidate.path === thread.path);
      items.push({
        at: thread.comments[0]?.createdAt ?? "",
        node: (
          <div key={`r:${thread.id}`} className="gh-card thread">
            <ThreadView root={root} number={pr.number} thread={thread} repoUrl={repoUrl} showPath onOpen={() => file && void openPrFile(root, pr, file)} />
          </div>
        ),
      });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.node);
  }, [pr, state?.threads, state?.files, root, repoUrl]);
  return <div className="gh-timeline">{entries}</div>;
}

function reviewVerb(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "dismissed";
    default:
      return "reviewed";
  }
}

/** Comment, or review (Approve / Request changes) with the pending comments. */
function ReviewComposer({ root, pr, pendingCount }: { root: string; pr: PrDetails; pendingCount: number }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const key = prKey(root, pr.number);
  const pending = useGitHubStore((store) => store.pending[key]) ?? [];

  const submit = async (event: "comment" | "approve" | "requestChanges") => {
    setBusy(true);
    const store = useGitHubStore.getState();
    const comments = store.pending[key] ?? [];
    // A plain comment without a review in progress is a conversation comment.
    const done =
      event === "comment" && comments.length === 0
        ? await act(() => github.comment(root, "pr", pr.number, body), "Comment posted")
        : await act(
            () => github.review(root, pr.number, event, body, pr.headRefOid, comments),
            event === "approve" ? "Approved" : event === "requestChanges" ? "Requested changes" : "Review submitted",
          );
    setBusy(false);
    if (done !== undefined) {
      setBody("");
      store.clearPending(key);
      await store.loadPr(root, pr.number);
    }
  };

  return (
    <div className="gh-card gh-composer" data-composer="review">
      {pending.length > 0 && (
        <div className="gh-pending-list">
          <div className="gh-pending-title">
            {pendingCount} pending comment{pendingCount === 1 ? "" : "s"} — submitted with your review
          </div>
          {pending.map((comment) => (
            <div key={comment.id} className="gh-pending-item">
              <div className="gh-muted gh-pending-where">
                {comment.path} · {comment.startLine ? `lines ${comment.startLine}–${comment.line}` : `line ${comment.line}`}
                {comment.side === "LEFT" ? " (original)" : ""}
              </div>
              <PendingView root={root} number={pr.number} comment={comment} />
            </div>
          ))}
        </div>
      )}
      <Composer placeholder={pending.length ? "Leave a review comment (optional)" : "Leave a comment"} value={body} onChange={setBody} onSubmit={() => void submit("comment")} rows={4} />
      <div className="gh-buttons">
        <span className="gh-muted gh-composer-hint">Markdown · ⌘Enter to comment</span>
        <span className="gh-actions-spacer" />
        <button className="gh-button" disabled={busy || (!body.trim() && pending.length === 0)} onClick={() => void submit("comment")}>
          {pending.length ? "Submit review" : "Comment"}
        </button>
        <button className="gh-button" disabled={busy} onClick={() => void submit("requestChanges")}>
          <CircleX size={13} strokeWidth={1.75} /> Request changes
        </button>
        <button className="gh-button primary" disabled={busy} onClick={() => void submit("approve")}>
          <Check size={13} strokeWidth={2} /> Approve
        </button>
      </div>
    </div>
  );
}

function Commits({ pr }: { pr: PrDetails }) {
  return (
    <div className="gh-card gh-list-card">
      {pr.commits.map((commit) => (
        <div key={commit.oid} className="gh-list-row" title={commit.oid}>
          <GitCommitHorizontal size={14} strokeWidth={1.75} className="gh-muted" />
          <span className="gh-list-main">{commit.headline}</span>
          <Avatar login={commit.author} size={16} />
          <span className="gh-muted">{commit.author}</span>
          <code className="gh-sha">{commit.oid.slice(0, 7)}</code>
          <span className="gh-muted gh-list-time">{timeAgo(commit.date)}</span>
        </div>
      ))}
    </div>
  );
}

function Checks({ checks }: { checks: CheckRun[] }) {
  if (checks.length === 0) return <div className="gh-card gh-muted gh-empty-card">No checks reported for this pull request.</div>;
  return (
    <div className="gh-card gh-list-card">
      {checks.map((check, index) => (
        <div key={`${check.name}:${index}`} className="gh-list-row">
          <span className="gh-check-cell" title={check.state}>
            <CheckBadge state={check.state} />
          </span>
          <span className="gh-list-main">
            {check.workflow && <span className="gh-muted">{check.workflow} / </span>}
            {check.name}
          </span>
          <span className="gh-muted">{check.description}</span>
          {check.url && (
            <button className="gh-link-button" title="Details" onClick={() => openExternal(check.url)}>
              Details <ExternalLink size={11} strokeWidth={1.75} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const STATUS_LETTER: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M" };

/** The changed files; each opens a diff with its review threads. Viewed checkboxes. */
function FilesChanged({ root, pr, files }: { root: string; pr: PrDetails; files: PrFile[] }) {
  const state = useGitHubStore((store) => store.prs[prKey(root, pr.number)]);
  const pending = useGitHubStore((store) => store.pending[prKey(root, pr.number)]) ?? [];
  const viewed = state?.threads?.viewed ?? {};
  const pullId = state?.threads?.pullId ?? "";
  const viewedCount = files.filter((file) => viewed[file.path]).length;

  const setViewed = async (file: PrFile, value: boolean) => {
    // Show it at once; GitHub follows.
    useGitHubStore.setState((store) => {
      const current = store.prs[prKey(root, pr.number)];
      if (!current?.threads) return {};
      return { prs: { ...store.prs, [prKey(root, pr.number)]: { ...current, threads: { ...current.threads, viewed: { ...current.threads.viewed, [file.path]: value } } } } };
    });
    await act(() => github.markViewed(root, pullId, file.path, value));
  };

  if (!state?.files) return <div className="gh-card gh-muted gh-empty-card">{state?.loading ? "Loading files…" : "No files"}</div>;
  return (
    <div className="gh-card gh-list-card gh-files">
      <div className="gh-files-head gh-muted">
        {viewedCount} of {files.length} file{files.length === 1 ? "" : "s"} viewed
      </div>
      {files.map((file) => {
        const comments = (state.threads?.threads ?? []).filter((thread) => thread.path === file.path).length + pending.filter((comment) => comment.path === file.path).length;
        const slash = file.path.lastIndexOf("/");
        return (
          <div key={file.path} className={`gh-list-row gh-file${viewed[file.path] ? " viewed" : ""}`} data-file={file.path} onClick={() => void openPrFile(root, pr, file)}>
            <span className={`gh-file-status ${file.status}`} title={file.status}>
              {STATUS_LETTER[file.status] ?? "M"}
            </span>
            <span className="gh-list-main gh-file-name" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
              {file.path.slice(slash + 1)}
              <span className="gh-muted gh-file-dir">{slash > 0 ? file.path.slice(0, slash) : ""}</span>
            </span>
            {comments > 0 && (
              <span className="gh-file-comments" title={`${comments} comment${comments === 1 ? "" : "s"}`}>
                <MessageSquare size={12} strokeWidth={1.75} />
                {comments}
              </span>
            )}
            <span className="gh-additions">+{file.additions}</span>
            <span className="gh-deletions">−{file.deletions}</span>
            <label className="gh-viewed" title="Mark as viewed" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={!!viewed[file.path]} disabled={!pullId} onChange={(event) => void setViewed(file, event.target.checked)} />
              Viewed
            </label>
          </div>
        );
      })}
    </div>
  );
}

/** Merge / squash / rebase, optionally deleting the branch. */
function MergeDialog({ root, pr, onClose, onMerged }: { root: string; pr: PrDetails; onClose: () => void; onMerged: () => void }) {
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await github.merge(root, pr.number, method, deleteBranch);
      onClose();
      onMerged();
      void useGitHubStore.getState().refreshLists(true);
      void useGitStore.getState().refreshNow();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const warning =
    pr.mergeable === "CONFLICTING"
      ? "This branch has conflicts that must be resolved first."
      : pr.mergeStateStatus === "BLOCKED"
        ? "Merging is blocked (required reviews or checks). GitHub may refuse."
        : pr.checkState === "failure"
          ? "Some checks failed."
          : pr.checkState === "pending"
            ? "Some checks haven't finished."
            : null;
  const methods = [
    ["merge", "Create a merge commit", "All commits are added to the base branch with a merge commit."],
    ["squash", "Squash and merge", "The commits are combined into one commit on the base branch."],
    ["rebase", "Rebase and merge", "The commits are rebased and added onto the base branch."],
  ] as const;
  return (
    <div className="gh-modal-backdrop" onMouseDown={onClose}>
      <div className="gh-modal" role="dialog" aria-label="Merge pull request" onMouseDown={(event) => event.stopPropagation()}>
        <div className="gh-modal-title">
          Merge pull request #{pr.number}
          <button className="gh-link-button" onClick={onClose} title="Cancel">
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div className="gh-modal-body">
          <div className="gh-muted">
            Into <code className="gh-ref">{pr.baseRefName}</code> from <code className="gh-ref">{pr.headRefName}</code>
          </div>
          {warning && <div className="gh-banner warning">{warning}</div>}
          {methods.map(([value, label, hint]) => (
            <label key={value} className={`gh-radio${method === value ? " on" : ""}`}>
              <input type="radio" name="merge-method" value={value} checked={method === value} onChange={() => setMethod(value)} />
              <span>
                <span className="gh-radio-label">{label}</span>
                <span className="gh-muted gh-radio-hint">{hint}</span>
              </span>
            </label>
          ))}
          <label className="gh-checkbox">
            <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
            Delete the branch <code className="gh-ref">{pr.headRefName}</code> after merging
          </label>
          {error && <pre className="gh-error-text">{error}</pre>}
        </div>
        <div className="gh-modal-footer">
          <span className="gh-actions-spacer" />
          <button className="gh-button" onClick={onClose}>
            Cancel
          </button>
          <button className="gh-button merge" disabled={busy} onClick={() => void merge()}>
            <GitMerge size={13} strokeWidth={1.75} /> {busy ? "Merging…" : methods.find(([value]) => value === method)![1]}
          </button>
        </div>
      </div>
    </div>
  );
}
