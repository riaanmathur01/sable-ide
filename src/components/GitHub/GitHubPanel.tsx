import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  GitPullRequestCreate,
  LogIn,
  GitBranch,
  Milestone,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import { ISSUE_CATEGORIES, PR_CATEGORIES, useGitHubStore, type ListState } from "../../store/githubStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import type { IssueSummary, PrSummary } from "../../lib/github/api";
import { timeAgo } from "../../lib/github/api";
import { checkoutPullRequest, createPullRequest, newIssue, openIssue, openPullRequest, signIn } from "../../lib/github/actions";
import { Avatar, CheckBadge, checkTitle, IssueStateIcon, LabelChip, openExternal, reviewDecisionText } from "./common";
import "./GitHub.css";

const COLLAPSED_KEY = "sable.github.collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/**
 * The GitHub view: pull requests and issues of the open repository, by
 * category (collapsible, with counts), a search, refresh, and Create Pull
 * Request / New Issue. Without gh (or signed out) it says how to set up.
 */
export function GitHubPanel() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const isRepo = useGitStore((state) => state.isRepo);
  const status = useGitHubStore((state) => state.status);
  const statusLoading = useGitHubStore((state) => state.statusLoading);
  const prLists = useGitHubStore((state) => state.prLists);
  const issueLists = useGitHubStore((state) => state.issueLists);
  const search = useGitHubStore((state) => state.search);
  const [query, setQuery] = useState(search);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    void useGitHubStore.getState().refreshLists();
  }, [rootPath]);

  // Search as you stop typing.
  useEffect(() => {
    if (query === useGitHubStore.getState().search) return;
    const timer = setTimeout(() => useGitHubStore.getState().setSearch(query), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* storage full */
      }
      return next;
    });
  };

  const loading = statusLoading || Object.values(prLists).some((list) => list.loading) || Object.values(issueLists).some((list) => list.loading);
  const ready = !!status?.loggedIn && !!status.repo;

  return (
    <div className="gh-panel">
      {ready && (
        <div className="gh-toolbar">
          <label className="gh-search">
            <Search size={13} strokeWidth={1.5} />
            <input
              placeholder="Search pull requests and issues"
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") useGitHubStore.getState().setSearch(query);
                if (event.key === "Escape") setQuery("");
              }}
            />
            {query && (
              <button className="gh-search-clear" title="Clear" onClick={() => setQuery("")}>
                <X size={12} strokeWidth={1.75} />
              </button>
            )}
          </label>
          <button className="icon-button" title="Create Pull Request" onClick={createPullRequest}>
            <GitPullRequestCreate size={15} strokeWidth={1.5} />
          </button>
          <button className="icon-button" title="New Issue" onClick={newIssue}>
            <Plus size={15} strokeWidth={1.5} />
          </button>
          <button className="icon-button" title="Refresh" onClick={() => void useGitHubStore.getState().refreshAll()}>
            <RefreshCw size={14} strokeWidth={1.5} className={loading ? "spinning" : undefined} />
          </button>
        </div>
      )}
      {!rootPath ? (
        <SetupMessage title="No folder opened">Open a folder with a GitHub repository to see its pull requests and issues.</SetupMessage>
      ) : !status ? (
        <div className="gh-empty">Checking GitHub…</div>
      ) : !status.installed ? (
        <SetupMessage title="GitHub CLI not found" icon>
          <p>Sable talks to GitHub through the GitHub CLI (gh), signed in with your account. Sable stores no tokens.</p>
          <div className="gh-setup-actions">
            <button className="gh-button primary" onClick={() => openExternal("https://cli.github.com")}>
              <Download size={13} strokeWidth={1.75} /> Install GitHub CLI
            </button>
            <button className="gh-button" onClick={() => useTabsStore.getState().openSettings()}>
              <Settings size={13} strokeWidth={1.75} /> Set its path
            </button>
            <button className="gh-button" onClick={() => void useGitHubStore.getState().refreshAll()}>
              Try again
            </button>
          </div>
          {status.error && <pre className="gh-error-text">{status.error}</pre>}
        </SetupMessage>
      ) : !status.loggedIn ? (
        <SetupMessage title={status.authProblem ? "Sign in to GitHub" : "Couldn't reach GitHub"} icon>
          <p>
            {status.authProblem
              ? "The GitHub CLI isn't signed in. Sign in once in the terminal; Sable uses gh's sign-in and stores no tokens."
              : "gh couldn't get your GitHub account:"}
          </p>
          <div className="gh-setup-actions">
            {status.authProblem && (
              <button className="gh-button primary" onClick={signIn}>
                <LogIn size={13} strokeWidth={1.75} /> Sign in
              </button>
            )}
            <button className="gh-button" onClick={() => void useGitHubStore.getState().refreshAll()}>
              Try again
            </button>
          </div>
          {status.error && !status.authProblem && <pre className="gh-error-text">{status.error}</pre>}
        </SetupMessage>
      ) : !isRepo || !status.repo ? (
        <SetupMessage title="Not a GitHub repository" icon>
          <p>This folder's repository has no GitHub remote gh recognizes.</p>
          {status.repoError && <pre className="gh-error-text">{status.repoError}</pre>}
        </SetupMessage>
      ) : (
        <div className="gh-lists">
          <div className="gh-repo" title={status.repo.url}>
            <span>{status.repo.nameWithOwner}</span>
            <button className="gh-link-button" title="Open on GitHub" onClick={() => openExternal(status.repo!.url)}>
              <ExternalLink size={12} strokeWidth={1.75} />
            </button>
            {status.user && (
              <span className="gh-repo-user" title={`Signed in as ${status.user.login}`}>
                <Avatar login={status.user.login} size={14} />
              </span>
            )}
          </div>
          <SectionHeader label="Pull Requests" />
          {PR_CATEGORIES.map((category) => (
            <Category key={category.id} id={`pr:${category.id}`} label={category.label} list={prLists[category.id]} collapsed={!!collapsed[`pr:${category.id}`]} onToggle={toggle}>
              {(prLists[category.id]?.items ?? []).map((pr) => (
                <PrRow key={pr.number} pr={pr} />
              ))}
            </Category>
          ))}
          <SectionHeader label="Issues" />
          {ISSUE_CATEGORIES.map((category) => (
            <Category key={category.id} id={`issue:${category.id}`} label={category.label} list={issueLists[category.id]} collapsed={!!collapsed[`issue:${category.id}`]} onToggle={toggle}>
              {(issueLists[category.id]?.items ?? []).map((issue) => (
                <IssueRow key={issue.number} issue={issue} />
              ))}
            </Category>
          ))}
        </div>
      )}
    </div>
  );
}

function SetupMessage({ title, icon, children }: { title: string; icon?: boolean; children: React.ReactNode }) {
  return (
    <div className="gh-setup">
      <div className="gh-setup-title">
        {icon && <CircleAlert size={14} strokeWidth={1.75} />}
        {title}
      </div>
      <div className="gh-setup-body">{children}</div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <div className="gh-section-header">{label}</div>;
}

function Category<T>({
  id,
  label,
  list,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  list: ListState<T> | undefined;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const count = list?.items.length ?? 0;
  return (
    <div className="gh-category" data-category={id}>
      <div className="gh-category-header" onClick={() => onToggle(id)} role="button" aria-expanded={!collapsed}>
        <Chevron size={13} strokeWidth={1.75} />
        <span className="gh-category-label">{label}</span>
        {list?.loading && !list.fetchedAt ? <RefreshCw size={11} strokeWidth={1.75} className="spinning gh-category-spinner" /> : <span className="gh-count">{count >= 100 ? "100+" : count}</span>}
      </div>
      {!collapsed && (
        <div className="gh-category-body">
          {list?.error ? (
            <div className="gh-row-error" title={list.error}>
              {list.error.split("\n")[0]}
            </div>
          ) : count === 0 && list && !list.loading ? (
            <div className="gh-row-empty">None</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: PrSummary }) {
  const decision = reviewDecisionText(pr.reviewDecision);
  return (
    <div
      className="gh-row"
      data-number={pr.number}
      title={`#${pr.number} ${pr.title}\n${pr.author} · ${pr.headRefName} → ${pr.baseRefName}${decision ? `\n${decision}` : ""}\nUpdated ${timeAgo(pr.updatedAt)}`}
      onClick={() => openPullRequest(pr.number, pr.title)}
    >
      <Avatar login={pr.author} size={16} />
      <span className="gh-row-main">
        <span className="gh-row-title">
          <span className="gh-row-number">#{pr.number}</span>
          {pr.title}
        </span>
        {(pr.labels.length > 0 || pr.isDraft || decision) && (
          <span className="gh-row-meta">
            {pr.isDraft && <span className="gh-draft">Draft</span>}
            {decision && <span className={`gh-decision ${pr.reviewDecision.toLowerCase()}`}>{decision}</span>}
            {pr.labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </span>
        )}
      </span>
      <span className="gh-row-trail">
        <span title={checkTitle(pr.checks)} className="gh-row-check">
          <CheckBadge state={pr.checks} />
        </span>
        <span className="gh-row-actions">
          <button
            className="gh-link-button"
            title="Check out"
            onClick={(event) => {
              event.stopPropagation();
              void checkoutPullRequest(pr.number);
            }}
          >
            <GitBranch size={12} strokeWidth={1.75} />
          </button>
          <button
            className="gh-link-button"
            title="Open on GitHub"
            onClick={(event) => {
              event.stopPropagation();
              openExternal(pr.url);
            }}
          >
            <ExternalLink size={12} strokeWidth={1.75} />
          </button>
        </span>
      </span>
    </div>
  );
}

function IssueRow({ issue }: { issue: IssueSummary }) {
  return (
    <div
      className="gh-row"
      data-number={issue.number}
      title={`#${issue.number} ${issue.title}\n${issue.author}${issue.assignees.length ? ` · assigned to ${issue.assignees.join(", ")}` : ""}\nUpdated ${timeAgo(issue.updatedAt)}`}
      onClick={() => openIssue(issue.number, issue.title)}
    >
      <IssueStateIcon state={issue.state} size={14} />
      <span className="gh-row-main">
        <span className="gh-row-title">
          <span className="gh-row-number">#{issue.number}</span>
          {issue.title}
        </span>
        {(issue.labels.length > 0 || issue.milestone) && (
          <span className="gh-row-meta">
            {issue.milestone && (
              <span className="gh-milestone" title={`Milestone: ${issue.milestone}`}>
                <Milestone size={11} strokeWidth={1.75} />
                {issue.milestone}
              </span>
            )}
            {issue.labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </span>
        )}
      </span>
      <span className="gh-row-trail">
        {issue.assignees.slice(0, 2).map((login) => (
          <Avatar key={login} login={login} size={14} />
        ))}
        <span className="gh-row-actions">
          <button
            className="gh-link-button"
            title="Open on GitHub"
            onClick={(event) => {
              event.stopPropagation();
              openExternal(issue.url);
            }}
          >
            <ExternalLink size={12} strokeWidth={1.75} />
          </button>
        </span>
      </span>
    </div>
  );
}

