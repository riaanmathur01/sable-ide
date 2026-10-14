import { create } from "zustand";
import {
  github,
  type GhStatus,
  type IssueDetails,
  type IssueSummary,
  type PendingComment,
  type PrDetails,
  type PrFile,
  type PrSummary,
  type PrThreads,
} from "../lib/github/api";
import { repositoryRoot, useGitStore } from "./gitStore";
import { useUiStore } from "./uiStore";

/**
 * GitHub state for the open repository: whether gh is ready, the sidebar's
 * lists (cached briefly), the current branch's pull request, opened pull
 * requests and issues, and review comments not yet submitted.
 */

export const PR_CATEGORIES = [
  { id: "review", label: "Waiting for my review" },
  { id: "assigned", label: "Assigned to me" },
  { id: "created", label: "Created by me" },
  { id: "all", label: "All open" },
] as const;

export const ISSUE_CATEGORIES = [
  { id: "assigned", label: "Assigned to me" },
  { id: "created", label: "Created by me" },
  { id: "mentioned", label: "Mentioned" },
  { id: "open", label: "Open" },
] as const;

/** Lists younger than this aren't fetched again (unless forced). */
const LIST_TTL_MS = 60_000;
/** Status (gh installed / signed in) is re-checked after this. */
const STATUS_TTL_MS = 5 * 60_000;

export interface ListState<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  fetchedAt: number;
}

export interface PrState {
  details: PrDetails | null;
  files: PrFile[] | null;
  threads: PrThreads | null;
  loading: boolean;
  error: string | null;
}

export interface IssueState {
  details: IssueDetails | null;
  loading: boolean;
  error: string | null;
}

interface GitHubState {
  /** The repository folder everything below belongs to. */
  root: string | null;
  status: GhStatus | null;
  statusLoading: boolean;
  statusCheckedAt: number;
  search: string;
  prLists: Record<string, ListState<PrSummary>>;
  issueLists: Record<string, ListState<IssueSummary>>;
  /** The current branch's pull request (status bar). */
  branchPr: PrSummary | null;
  branchPrFor: string | null;
  prs: Record<string, PrState>;
  issues: Record<string, IssueState>;
  /** Review comments to submit with the next review, by pull request. */
  pending: Record<string, PendingComment[]>;
  checkStatus: (force?: boolean) => Promise<GhStatus | null>;
  setSearch: (search: string) => void;
  refreshLists: (force?: boolean) => Promise<void>;
  refreshBranchPr: (force?: boolean) => Promise<void>;
  /** Everything again (palette "GitHub: Refresh", the view's button). */
  refreshAll: () => Promise<void>;
  loadPr: (root: string, number: number, parts?: { details?: boolean; files?: boolean; threads?: boolean }) => Promise<void>;
  loadIssue: (root: string, number: number) => Promise<void>;
  addPending: (key: string, comment: Omit<PendingComment, "id">) => void;
  updatePending: (key: string, id: string, body: string) => void;
  removePending: (key: string, id: string) => void;
  clearPending: (key: string) => void;
}

export const prKey = (root: string, number: number) => `${root}#${number}`;

const emptyList = <T,>(): ListState<T> => ({ items: [], loading: false, error: null, fetchedAt: 0 });

let pendingCounter = 0;

export const useGitHubStore = create<GitHubState>((set, get) => ({
  root: null,
  status: null,
  statusLoading: false,
  statusCheckedAt: 0,
  search: "",
  prLists: {},
  issueLists: {},
  branchPr: null,
  branchPrFor: null,
  prs: {},
  issues: {},
  pending: {},

  checkStatus: async (force = false) => {
    const root = repositoryRoot();
    if (!root) return null;
    const state = get();
    if (state.root !== root) {
      // Another repository: forget the old one's lists.
      set({ root, status: null, statusCheckedAt: 0, prLists: {}, issueLists: {}, branchPr: null, branchPrFor: null });
    } else if (!force && state.status && Date.now() - state.statusCheckedAt < STATUS_TTL_MS) {
      return state.status;
    }
    if (get().statusLoading && !force) return get().status;
    set({ statusLoading: true });
    try {
      const status = await github.status(root);
      if (repositoryRoot() === root) set({ status, statusCheckedAt: Date.now() });
      return status;
    } catch (error) {
      const status: GhStatus = { installed: false, error: String(error) };
      set({ status, statusCheckedAt: Date.now() });
      return status;
    } finally {
      set({ statusLoading: false });
    }
  },

  setSearch: (search) => {
    set({ search, prLists: {}, issueLists: {} });
    void get().refreshLists(true);
  },

  refreshLists: async (force = false) => {
    const status = await get().checkStatus();
    const root = get().root;
    if (!root || !status?.loggedIn || !status.repo) return;
    const search = get().search;
    const fetchList = async <T,>(kind: "prLists" | "issueLists", category: string, load: () => Promise<T[]>) => {
      const current = (get()[kind] as Record<string, ListState<T>>)[category];
      if (!force && current && (current.loading || Date.now() - current.fetchedAt < LIST_TTL_MS)) return;
      set((state) => ({ [kind]: { ...state[kind], [category]: { ...(current ?? emptyList<T>()), loading: true, error: null } } }) as Partial<GitHubState>);
      try {
        const items = await load();
        if (get().root !== root || get().search !== search) return;
        set((state) => ({ [kind]: { ...state[kind], [category]: { items, loading: false, error: null, fetchedAt: Date.now() } } }) as Partial<GitHubState>);
      } catch (error) {
        set((state) => ({ [kind]: { ...state[kind], [category]: { ...(current ?? emptyList<T>()), loading: false, error: String(error), fetchedAt: Date.now() } } }) as Partial<GitHubState>);
      }
    };
    await Promise.all([
      ...PR_CATEGORIES.map((category) => fetchList("prLists", category.id, () => github.listPrs(root, category.id, search))),
      ...ISSUE_CATEGORIES.map((category) => fetchList("issueLists", category.id, () => github.listIssues(root, category.id, search))),
    ]);
  },

  refreshBranchPr: async (force = false) => {
    const branch = useGitStore.getState().branch;
    const status = await get().checkStatus();
    const root = get().root;
    if (!root || !branch || !status?.loggedIn || !status.repo) {
      set({ branchPr: null, branchPrFor: null });
      return;
    }
    const forKey = `${root}@${branch}`;
    if (!force && get().branchPrFor === forKey) return;
    try {
      const pr = await github.prForBranch(root);
      set({ branchPr: pr, branchPrFor: forKey });
    } catch {
      set({ branchPr: null, branchPrFor: forKey });
    }
  },

  refreshAll: async () => {
    await get().checkStatus(true);
    await Promise.all([get().refreshLists(true), get().refreshBranchPr(true)]);
  },

  loadPr: async (root, number, parts = { details: true, files: true, threads: true }) => {
    const key = prKey(root, number);
    const update = (patch: Partial<PrState>) =>
      set((state) => ({ prs: { ...state.prs, [key]: { ...(state.prs[key] ?? { details: null, files: null, threads: null, loading: false, error: null }), ...patch } } }));
    update({ loading: true, error: null });
    const errors: string[] = [];
    await Promise.all([
      parts.details &&
        github.prView(root, number).then(
          (details) => update({ details }),
          (error) => errors.push(String(error)),
        ),
      parts.files &&
        github.prFiles(root, number).then(
          (files) => update({ files }),
          (error) => errors.push(String(error)),
        ),
      parts.threads &&
        github.prThreads(root, number).then(
          (threads) => update({ threads }),
          (error) => errors.push(String(error)),
        ),
    ]);
    update({ loading: false, error: errors[0] ?? null });
  },

  loadIssue: async (root, number) => {
    const key = prKey(root, number);
    set((state) => ({ issues: { ...state.issues, [key]: { details: state.issues[key]?.details ?? null, loading: true, error: null } } }));
    try {
      const details = await github.issueView(root, number);
      set((state) => ({ issues: { ...state.issues, [key]: { details, loading: false, error: null } } }));
    } catch (error) {
      set((state) => ({ issues: { ...state.issues, [key]: { details: state.issues[key]?.details ?? null, loading: false, error: String(error) } } }));
    }
  },

  addPending: (key, comment) =>
    set((state) => ({ pending: { ...state.pending, [key]: [...(state.pending[key] ?? []), { ...comment, id: `pending-${++pendingCounter}` }] } })),
  updatePending: (key, id, body) =>
    set((state) => ({ pending: { ...state.pending, [key]: (state.pending[key] ?? []).map((comment) => (comment.id === id ? { ...comment, body } : comment)) } })),
  removePending: (key, id) => set((state) => ({ pending: { ...state.pending, [key]: (state.pending[key] ?? []).filter((comment) => comment.id !== id) } })),
  clearPending: (key) => set((state) => ({ pending: { ...state.pending, [key]: [] } })),
}));

/** Run a GitHub action: errors go to the status bar's error, success to its message. */
export async function act<T>(run: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const result = await run();
    if (done) useUiStore.getState().showStatus(done);
    return result;
  } catch (error) {
    useUiStore.getState().setLastError(String(error));
    return undefined;
  }
}

// --- Keeping it fresh ---------------------------------------------------------------------
// The current branch's pull request follows the branch; lists refresh on
// focus and every few minutes while someone looks at them.

let started = false;
const REFRESH_EVERY_MS = 3 * 60_000;

export function startGitHubRefresh(): void {
  if (started) return;
  started = true;
  let lastBranch = useGitStore.getState().branch;
  let lastRoot = useGitStore.getState().repoRoot;
  useGitStore.subscribe((state) => {
    if (state.branch !== lastBranch || state.repoRoot !== lastRoot) {
      lastBranch = state.branch;
      lastRoot = state.repoRoot;
      void useGitHubStore.getState().refreshBranchPr(true);
    }
  });
  let lastRefresh = Date.now();
  const refresh = () => {
    // Focus comes and goes often: at most every half minute.
    if (Date.now() - lastRefresh < 30_000) return;
    lastRefresh = Date.now();
    const github = useGitHubStore.getState();
    void github.refreshBranchPr(true);
    if (useUiStore.getState().sidebarView === "github" && useUiStore.getState().sidebarVisible) void github.refreshLists();
  };
  window.addEventListener("focus", refresh);
  setInterval(refresh, REFRESH_EVERY_MS);
}
