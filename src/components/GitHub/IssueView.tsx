import { useEffect, useState } from "react";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { github, issueBranchName, timeAgo } from "../../lib/github/api";
import { act, prKey, useGitHubStore } from "../../store/githubStore";
import { useGitStore } from "../../store/gitStore";
import { useUiStore } from "../../store/uiStore";
import { Avatar, openExternal, StatePill } from "./common";
import { CommentView, Composer } from "./Thread";
import { ChoiceBlock, LabelList, PeopleList, repoAssignees, repoLabels } from "./Pickers";

/** An issue's page: body, comments, labels, assignees; comment, close/reopen, start working. */
export function IssueView({ root, number }: { root: string; number: number }) {
  const key = prKey(root, number);
  const state = useGitHubStore((store) => store.issues[key]);
  const repoUrl = useGitHubStore((store) => store.status?.repo?.url);
  const user = useGitHubStore((store) => store.status?.user?.login ?? "");
  const branch = useGitStore((store) => store.branch);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useGitHubStore.getState().checkStatus();
    void useGitHubStore.getState().loadIssue(root, number);
  }, [root, number]);

  const issue = state?.details;
  const reload = () => useGitHubStore.getState().loadIssue(root, number);
  if (!issue) {
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
            "Loading issue…"
          )}
        </div>
      </div>
    );
  }

  const isOpen = issue.state === "OPEN";
  const branchName = issueBranchName(user, issue.number, issue.title);
  const onBranch = branch === branchName;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const result = await act(action, done);
    setBusy(false);
    if (result !== undefined) {
      await reload();
      void useGitHubStore.getState().refreshLists(true);
    }
    return result !== undefined;
  };

  const startWorking = async () => {
    const git = useGitStore.getState();
    await git.loadBranches();
    const exists = useGitStore.getState().branches.some((candidate) => candidate.name === branchName);
    if (exists) await git.switchBranch(branchName);
    else await git.createBranch(branchName);
    await git.refreshNow();
    if (useGitStore.getState().branch === branchName) useUiStore.getState().showStatus(`Working on #${issue.number} on ${branchName}`);
  };

  const sendComment = async (thenClose = false) => {
    if (comment.trim() && !(await run(() => github.comment(root, "issue", number, comment), "Comment posted"))) return;
    setComment("");
    if (thenClose) await run(() => github.setState(root, "issue", number, "close"), `Closed #${number}`);
  };

  return (
    <div className="gh-page gh-issue" data-issue={issue.number}>
      <div className="gh-page-scroll">
        <header className="gh-page-header">
          <h1 className="gh-page-title">
            {issue.title} <span className="gh-page-number">#{issue.number}</span>
          </h1>
          <div className="gh-page-subtitle">
            <StatePill state={issue.state} issue />
            <Avatar login={issue.author} size={18} />
            <span>
              <strong>{issue.author}</strong> opened this issue {timeAgo(issue.createdAt)} · {issue.comments.length} comment{issue.comments.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="gh-actions">
            {onBranch ? (
              <span className="gh-checked-out">
                <GitBranch size={13} strokeWidth={1.75} /> On {branchName}
              </span>
            ) : (
              <button className="gh-button primary" disabled={busy || !isOpen} title={`Create and check out ${branchName}`} onClick={() => void startWorking()}>
                <GitBranch size={13} strokeWidth={1.75} /> Start working on issue
              </button>
            )}
            <button className="gh-button" onClick={() => openExternal(issue.url)}>
              <ExternalLink size={13} strokeWidth={1.75} /> Open on GitHub
            </button>
            <button className="gh-button icon" title="Refresh" onClick={() => void reload()}>
              <RefreshCw size={13} strokeWidth={1.75} className={state.loading ? "spinning" : undefined} />
            </button>
          </div>
        </header>
        {state.error && <div className="gh-banner error">{state.error}</div>}
        <div className="gh-page-body">
          <main className="gh-page-main">
            <div className="gh-card">
              <CommentView author={issue.author} body={issue.body} createdAt={issue.createdAt} repoUrl={repoUrl} />
            </div>
            <div className="gh-timeline">
              {issue.comments.map((entry) => (
                <div key={entry.id} className="gh-card">
                  <CommentView author={entry.author} body={entry.body} createdAt={entry.createdAt} repoUrl={repoUrl} />
                </div>
              ))}
            </div>
            <div className="gh-card gh-composer" data-composer="issue">
              <Composer placeholder="Leave a comment" value={comment} onChange={setComment} onSubmit={() => void sendComment()} rows={4} />
              <div className="gh-buttons">
                <span className="gh-muted gh-composer-hint">Markdown · ⌘Enter to comment</span>
                <span className="gh-actions-spacer" />
                {isOpen ? (
                  <button className="gh-button" disabled={busy} onClick={() => void sendComment(true)}>
                    {comment.trim() ? "Close with comment" : "Close issue"}
                  </button>
                ) : (
                  <button className="gh-button" disabled={busy} onClick={() => void run(() => github.setState(root, "issue", number, "reopen"), `Reopened #${number}`)}>
                    Reopen issue
                  </button>
                )}
                <button className="gh-button primary" disabled={busy || !comment.trim()} onClick={() => void sendComment()}>
                  Comment
                </button>
              </div>
            </div>
          </main>
          <aside className="gh-page-side">
            <ChoiceBlock
              title="Assignees"
              testId="assignees"
              selected={issue.assignees}
              empty="No one"
              render={(people) => <PeopleList people={people} />}
              load={async () => (await repoAssignees(root)).map((value) => ({ value }))}
              onApply={(add, remove) => github.edit(root, "issue", number, { addAssignees: add, removeAssignees: remove }).then(reload)}
            />
            <ChoiceBlock
              title="Labels"
              testId="labels"
              selected={issue.labels.map((label) => label.name)}
              empty="None yet"
              render={(names) => <LabelList labels={issue.labels.filter((label) => names.includes(label.name))} />}
              load={async () => (await repoLabels(root)).map((label) => ({ value: label.name, label }))}
              onApply={(add, remove) => github.edit(root, "issue", number, { addLabels: add, removeLabels: remove }).then(reload)}
            />
            <div className="gh-side-block">
              <div className="gh-side-title">Milestone</div>
              {issue.milestone ? <div>{issue.milestone}</div> : <div className="gh-muted gh-side-empty">No milestone</div>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
