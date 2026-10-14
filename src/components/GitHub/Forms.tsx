import { useEffect, useState } from "react";
import { CircleAlert, GitPullRequestCreate, Plus, Upload } from "lucide-react";
import { github, type BranchInfo, type IssueTemplate } from "../../lib/github/api";
import { useGitHubStore } from "../../store/githubStore";
import { useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import { gitPush } from "../../lib/ipc";
import { githubTabKey } from "../../lib/github/types";
import { openIssue, openPullRequest } from "../../lib/github/actions";
import { Composer } from "./Thread";
import { ChoiceBlock, LabelList, PeopleList, repoAssignees, repoLabels } from "./Pickers";

/** "feature/add-login" → "Add login". */
function titleFromBranch(branch: string): string {
  const words = (branch.split("/").pop() ?? branch).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** Defaults from the branch's commits: one commit → its message; several → a list. */
export function defaultsFromCommits(info: BranchInfo): { title: string; body: string } {
  if (info.commits.length === 1) return { title: info.commits[0].subject, body: info.template ?? info.commits[0].body };
  const list = [...info.commits].reverse().map((commit) => `- ${commit.subject}`).join("\n");
  return { title: titleFromBranch(info.branch), body: info.template ?? list };
}

function closeFormTab(target: Parameters<typeof githubTabKey>[0]) {
  const key = githubTabKey(target);
  const group = useTabsStore.getState().groups.find((candidate) => candidate.tabs.some((tab) => tab.path === key));
  if (group) void useTabsStore.getState().closeTab(key, group.id);
}

/** Create Pull Request: title, description, base, head, draft, reviewers. */
export function CreatePullRequestForm({ root }: { root: string }) {
  const status = useGitHubStore((store) => store.status);
  const branches = useGitStore((store) => store.branches);
  const [base, setBase] = useState("");
  const [info, setInfo] = useState<BranchInfo | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    void useGitHubStore.getState().checkStatus();
    void useGitStore.getState().loadBranches();
  }, []);
  useEffect(() => {
    if (!base && status?.repo) setBase(status.repo.defaultBranch);
  }, [status, base]);
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    github.branchInfo(root, base).then(
      (loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        if (!touched) {
          const defaults = defaultsFromCommits(loaded);
          setTitle(defaults.title);
          setBody(defaults.body);
        }
      },
      (failure) => !cancelled && setError(String(failure)),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, base]);

  const head = info?.branch ?? "";
  const needsPush = !!info && (!info.upstream || info.unpushed > 0);

  const create = async (push: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (push) {
        await gitPush(root);
        await useGitStore.getState().refreshNow();
      }
      const created = await github.createPr(root, { title, body, base, head, draft, reviewers });
      setConfirmPush(false);
      closeFormTab({ view: "createPr", root });
      void useGitHubStore.getState().refreshAll();
      if (created.number) openPullRequest(created.number, title, root);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const baseChoices = [...new Set([status?.repo?.defaultBranch ?? "", ...branches.map((branch) => branch.name.replace(/^origin\//, ""))])].filter((name) => name && name !== head);

  return (
    <div className="gh-page gh-form" data-form="create-pr">
      <div className="gh-page-scroll">
        <header className="gh-page-header">
          <h1 className="gh-page-title">
            <GitPullRequestCreate size={18} strokeWidth={1.75} /> Create Pull Request
          </h1>
          <div className="gh-page-subtitle gh-muted">{status?.repo?.nameWithOwner}</div>
        </header>
        <div className="gh-page-body">
          <main className="gh-page-main">
            <div className="gh-card gh-form-card">
              <div className="gh-form-row">
                <label className="gh-field">
                  <span>Base</span>
                  <input className="gh-input" list="gh-base-branches" value={base} onChange={(event) => setBase(event.target.value)} spellCheck={false} name="base" />
                  <datalist id="gh-base-branches">
                    {baseChoices.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
                <span className="gh-form-arrow">←</span>
                <label className="gh-field">
                  <span>Compare</span>
                  <input className="gh-input" value={head} readOnly name="head" title="The current branch (check out another to change it)" />
                </label>
              </div>
              {info && (
                <div className="gh-muted gh-form-note">
                  {info.commits.length} commit{info.commits.length === 1 ? "" : "s"} on <code className="gh-ref">{head}</code> not in <code className="gh-ref">{base}</code>
                  {needsPush && (
                    <span className="gh-form-warn">
                      {" "}
                      · {info.upstream ? `${info.unpushed} not pushed yet` : "not on GitHub yet"} — it's pushed when you create the pull request
                    </span>
                  )}
                </div>
              )}
              <label className="gh-field">
                <span>Title</span>
                <input
                  className="gh-input"
                  name="title"
                  value={title}
                  onChange={(event) => {
                    setTouched(true);
                    setTitle(event.target.value);
                  }}
                />
              </label>
              <label className="gh-field">
                <span>Description</span>
                <Composer
                  placeholder="Describe the change (Markdown)"
                  value={body}
                  onChange={(value) => {
                    setTouched(true);
                    setBody(value);
                  }}
                  rows={10}
                  className="gh-form-body"
                />
              </label>
              <label className="gh-checkbox">
                <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} name="draft" />
                Create as draft
              </label>
              {error && <pre className="gh-error-text">{error}</pre>}
              {confirmPush ? (
                <div className="gh-banner warning gh-confirm" data-confirm="push">
                  <CircleAlert size={14} strokeWidth={1.75} />
                  <span>
                    Push <code className="gh-ref">{head}</code> to origin first?
                  </span>
                  <span className="gh-actions-spacer" />
                  <button className="gh-button" onClick={() => setConfirmPush(false)}>
                    Cancel
                  </button>
                  <button className="gh-button primary" disabled={busy} onClick={() => void create(true)}>
                    <Upload size={13} strokeWidth={1.75} /> {busy ? "Pushing…" : "Push and create"}
                  </button>
                </div>
              ) : (
                <div className="gh-buttons">
                  <span className="gh-actions-spacer" />
                  <button className="gh-button" onClick={() => closeFormTab({ view: "createPr", root })}>
                    Cancel
                  </button>
                  <button className="gh-button primary" disabled={busy || !title.trim() || !head || !base || head === base} onClick={() => (needsPush ? setConfirmPush(true) : void create(false))}>
                    {busy ? "Creating…" : draft ? "Create draft pull request" : "Create pull request"}
                  </button>
                </div>
              )}
            </div>
            {info && info.commits.length > 0 && (
              <div className="gh-card gh-list-card">
                {info.commits.map((commit) => (
                  <div key={commit.hash} className="gh-list-row">
                    <code className="gh-sha">{commit.hash.slice(0, 7)}</code>
                    <span className="gh-list-main">{commit.subject}</span>
                  </div>
                ))}
              </div>
            )}
          </main>
          <aside className="gh-page-side">
            <ChoiceBlock
              title="Reviewers"
              testId="reviewers"
              selected={reviewers}
              empty="No reviewers"
              render={(people) => <PeopleList people={people} />}
              load={async () => (await repoAssignees(root)).filter((login) => login !== status?.user?.login).map((value) => ({ value }))}
              onApply={async (add, remove) => setReviewers((current) => [...current.filter((login) => !remove.includes(login)), ...add])}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

/** New Issue: from a template (.github/ISSUE_TEMPLATE) or blank. */
export function NewIssueForm({ root }: { root: string }) {
  const status = useGitHubStore((store) => store.status);
  const [templates, setTemplates] = useState<IssueTemplate[] | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [labelColors, setLabelColors] = useState<Record<string, string>>({});

  useEffect(() => {
    void useGitHubStore.getState().checkStatus();
    github.issueTemplates(root).then(setTemplates, () => setTemplates([]));
    repoLabels(root).then((all) => setLabelColors(Object.fromEntries(all.map((label) => [label.name, label.color]))), () => {});
  }, [root]);

  const choose = (chosen: IssueTemplate | null) => {
    setTemplate(chosen?.file ?? "");
    setTitle(chosen?.title ?? "");
    setBody(chosen?.body ?? "");
    setLabels(chosen?.labels ?? []);
    setAssignees(chosen?.assignees ?? []);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await github.createIssue(root, { title, body, labels, assignees });
      closeFormTab({ view: "newIssue", root });
      void useGitHubStore.getState().refreshLists(true);
      if (created.number) openIssue(created.number, title, root);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const choosing = template === null && templates !== null && templates.length > 0;
  return (
    <div className="gh-page gh-form" data-form="new-issue">
      <div className="gh-page-scroll">
        <header className="gh-page-header">
          <h1 className="gh-page-title">
            <Plus size={18} strokeWidth={1.75} /> New Issue
          </h1>
          <div className="gh-page-subtitle gh-muted">{status?.repo?.nameWithOwner}</div>
        </header>
        {choosing ? (
          <div className="gh-page-body">
            <main className="gh-page-main">
              <div className="gh-card gh-list-card gh-templates">
                {templates.map((candidate) => (
                  <div key={candidate.file} className="gh-list-row gh-template" onClick={() => choose(candidate)}>
                    <span className="gh-list-main">
                      <span className="gh-template-name">{candidate.name}</span>
                      {candidate.about && <span className="gh-muted gh-template-about">{candidate.about}</span>}
                    </span>
                    <button className="gh-button primary">Get started</button>
                  </div>
                ))}
                <div className="gh-list-row gh-template" onClick={() => choose(null)}>
                  <span className="gh-list-main">
                    <span className="gh-template-name">Blank issue</span>
                    <span className="gh-muted gh-template-about">Start from scratch</span>
                  </span>
                  <button className="gh-button">Open</button>
                </div>
              </div>
            </main>
          </div>
        ) : (
          <div className="gh-page-body">
            <main className="gh-page-main">
              <div className="gh-card gh-form-card">
                <label className="gh-field">
                  <span>Title</span>
                  <input className="gh-input" name="title" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label className="gh-field">
                  <span>Description</span>
                  <Composer placeholder="Describe the issue (Markdown)" value={body} onChange={setBody} rows={12} className="gh-form-body" />
                </label>
                {error && <pre className="gh-error-text">{error}</pre>}
                <div className="gh-buttons">
                  {templates && templates.length > 0 && (
                    <button className="gh-button" onClick={() => setTemplate(null)}>
                      Choose another template
                    </button>
                  )}
                  <span className="gh-actions-spacer" />
                  <button className="gh-button" onClick={() => closeFormTab({ view: "newIssue", root })}>
                    Cancel
                  </button>
                  <button className="gh-button primary" disabled={busy || !title.trim()} onClick={() => void create()}>
                    {busy ? "Creating…" : "Create issue"}
                  </button>
                </div>
              </div>
            </main>
            <aside className="gh-page-side">
              <ChoiceBlock
                title="Assignees"
                testId="assignees"
                selected={assignees}
                empty="No one"
                render={(people) => <PeopleList people={people} />}
                load={async () => (await repoAssignees(root)).map((value) => ({ value }))}
                onApply={async (add, remove) => setAssignees((current) => [...current.filter((login) => !remove.includes(login)), ...add])}
              />
              <ChoiceBlock
                title="Labels"
                testId="labels"
                selected={labels}
                empty="None yet"
                render={(names) => <LabelList labels={names.map((name) => ({ name, color: labelColors[name] ?? "8b949e" }))} />}
                load={async () => (await repoLabels(root)).map((label) => ({ value: label.name, label }))}
                onApply={async (add, remove) => setLabels((current) => [...current.filter((name) => !remove.includes(name)), ...add])}
              />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
