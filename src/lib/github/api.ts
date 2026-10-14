import { invoke, isRemoteActive } from "../backend";
import { getSetting } from "../../store/settingsStore";

/**
 * GitHub through the GitHub CLI: every call is `github_call` (Rust,
 * src-tauri/src/github.rs), run in the repository's folder — on the remote
 * machine in a remote workspace. Sable stores no tokens; gh is signed in.
 */

export interface Label {
  name: string;
  color: string;
}

/** Overall check state: ✓ / ✗ / ●, or none. */
export type CheckState = "success" | "failure" | "pending" | "none";

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  labels: Label[];
  isDraft: boolean;
  checks: CheckState;
  reviewDecision: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  state: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  author: string;
  labels: Label[];
  milestone: string | null;
  assignees: string[];
  updatedAt: string;
  url: string;
  state: string;
}

export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "neutral" | "skipped";
  description: string;
  url: string;
  workflow: string;
}

export interface TimelineEntry {
  kind: "comment" | "review";
  id: string;
  author: string;
  body: string;
  state?: string;
  createdAt: string;
  url: string;
}

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft: boolean;
  labels: Label[];
  assignees: string[];
  reviewers: { login: string; state: string }[];
  checks: Check[];
  checkState: CheckState;
  commits: { oid: string; headline: string; author: string; date: string }[];
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  isCrossRepository: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  url: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  milestone: string | null;
  timeline: TimelineEntry[];
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged" | string;
  additions: number;
  deletions: number;
}

export interface ThreadComment {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  comments: ThreadComment[];
}

export interface PrThreads {
  pullId: string;
  threads: ReviewThread[];
  viewed: Record<string, boolean>;
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  stateReason: string;
  labels: Label[];
  assignees: string[];
  milestone: string | null;
  comments: TimelineEntry[];
  url: string;
  createdAt: string;
}

export interface GhStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  /** gh said "not signed in" (vs. some other failure, e.g. offline). */
  authProblem?: boolean;
  error?: string;
  user?: { login: string; name: string; avatarUrl: string };
  repo?: { nameWithOwner: string; url: string; defaultBranch: string; viewerPermission: string } | null;
  repoError?: string | null;
  /** The repository's top folder (PR file paths are relative to it). */
  topLevel?: string | null;
}

export interface IssueTemplate {
  file: string;
  name: string;
  about: string;
  title: string;
  labels: string[];
  assignees: string[];
  body: string;
}

export interface BranchInfo {
  branch: string;
  upstream: string | null;
  unpushed: number;
  commits: { hash: string; subject: string; body: string }[];
  template: string | null;
}

/** A pending (not yet submitted) review comment. */
export interface PendingComment {
  id: string;
  path: string;
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** The gh to run: the `github.ghPath` setting (local workspaces only). */
function ghPath(): string | null {
  if (isRemoteActive()) return null;
  return getSetting("github.ghPath")?.trim() || null;
}

export function gh<T>(root: string, op: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("github_call", { root, op, args, ghPath: ghPath() });
}

export const github = {
  status: (root: string) => gh<GhStatus>(root, "status"),
  listPrs: (root: string, category: string, search = "") => gh<PrSummary[]>(root, "list_prs", { category, search, limit: 100 }),
  listIssues: (root: string, category: string, search = "") => gh<IssueSummary[]>(root, "list_issues", { category, search, limit: 100 }),
  prView: (root: string, number: number) => gh<PrDetails>(root, "pr_view", { number }),
  prForBranch: (root: string) => gh<PrSummary | null>(root, "pr_for_branch"),
  prFiles: (root: string, number: number) => gh<PrFile[]>(root, "pr_files", { number }),
  prThreads: (root: string, number: number) => gh<PrThreads>(root, "pr_threads", { number }),
  fileText: (root: string, ref: string, path: string) => gh<{ text: string; binary: boolean }>(root, "file_text", { ref, path }),
  mergeBase: (root: string, base: string, head: string) => gh<string>(root, "merge_base", { base, head }),
  checkout: (root: string, number: number) => gh<string>(root, "pr_checkout", { number }),
  review: (root: string, number: number, event: "approve" | "requestChanges" | "comment", body: string, commitId: string, comments: PendingComment[]) =>
    gh<unknown>(root, "pr_review", {
      number,
      event,
      body,
      commitId,
      comments: comments.map(({ path, line, startLine, side, body }) => ({ path, line, startLine, side, body })),
    }),
  reply: (root: string, number: number, commentId: number, body: string) => gh<unknown>(root, "pr_reply", { number, commentId, body }),
  resolveThread: (root: string, threadId: string, resolve: boolean) => gh<unknown>(root, "thread_resolve", { threadId, resolve }),
  markViewed: (root: string, pullId: string, path: string, viewed: boolean) => gh<unknown>(root, "mark_viewed", { pullId, path, viewed }),
  merge: (root: string, number: number, method: "merge" | "squash" | "rebase", deleteBranch: boolean) => gh<string>(root, "pr_merge", { number, method, deleteBranch }),
  setState: (root: string, kind: "pr" | "issue", number: number, action: "close" | "reopen" | "ready" | "draft") => gh<string>(root, "set_state", { kind, number, action }),
  comment: (root: string, kind: "pr" | "issue", number: number, body: string) => gh<string>(root, "comment", { kind, number, body }),
  edit: (root: string, kind: "pr" | "issue", number: number, changes: { addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[] }) =>
    gh<unknown>(root, "edit", { kind, number, ...changes }),
  createPr: (root: string, fields: { title: string; body: string; base: string; head: string; draft: boolean; reviewers: string[] }) =>
    gh<{ url: string; number: number | null }>(root, "pr_create", fields),
  createIssue: (root: string, fields: { title: string; body: string; labels: string[]; assignees: string[] }) => gh<{ url: string; number: number | null }>(root, "issue_create", fields),
  issueView: (root: string, number: number) => gh<IssueDetails>(root, "issue_view", { number }),
  labels: (root: string) => gh<Label[]>(root, "labels"),
  assignees: (root: string) => gh<string[]>(root, "assignees"),
  issueTemplates: (root: string) => gh<IssueTemplate[]>(root, "issue_templates"),
  branchInfo: (root: string, base: string) => gh<BranchInfo>(root, "branch_info", { base }),
};

/** "2 days ago"-style relative time. */
export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24 * 7, "week"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** The branch name "Start working on issue" creates: `<user>/issue-<n>-<slug>`. */
export function issueBranchName(user: string, number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${user || "me"}/issue-${number}${slug ? `-${slug}` : ""}`;
}
