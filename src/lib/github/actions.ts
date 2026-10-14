import { github, type PrDetails, type PrFile, type PrSummary } from "./api";
import { act, PR_CATEGORIES, useGitHubStore } from "../../store/githubStore";
import { repositoryRoot, useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useTerminalStore } from "../../store/terminalStore";
import { getSetting } from "../../store/settingsStore";
import { loginShellArgs } from "../shell";
import { shellQuote } from "../runConfig";
import { isRemoteActive } from "../backend";

/** Commands the GitHub view, the palette and the status bar share. */

function requireRoot(): string | null {
  const root = repositoryRoot();
  if (!root) useUiStore.getState().setLastError("Open a folder with a GitHub repository first");
  return root;
}

export function openPullRequest(number: number, title?: string, root = repositoryRoot()): void {
  if (!root) return;
  useTabsStore.getState().openGitHub({ view: "pr", root, number }, title ? `#${number} ${title}` : `Pull Request #${number}`);
}

export function openIssue(number: number, title?: string, root = repositoryRoot()): void {
  if (!root) return;
  useTabsStore.getState().openGitHub({ view: "issue", root, number }, title ? `#${number} ${title}` : `Issue #${number}`);
}

export function createPullRequest(): void {
  const root = requireRoot();
  if (root) useTabsStore.getState().openGitHub({ view: "createPr", root }, "Create Pull Request");
}

export function newIssue(): void {
  const root = requireRoot();
  if (root) useTabsStore.getState().openGitHub({ view: "newIssue", root }, "New Issue");
}

export async function checkoutPullRequest(number: number, root = repositoryRoot()): Promise<boolean> {
  if (!root) return false;
  const done = await act(() => github.checkout(root, number), `Checked out pull request #${number}`);
  await useGitStore.getState().refreshNow();
  void useGitHubStore.getState().refreshBranchPr(true);
  return done !== undefined;
}

/** All open pull requests, to choose one from the palette. */
async function choosePullRequest(placeholder: string): Promise<PrSummary | null> {
  const root = requireRoot();
  if (!root) return null;
  const store = useGitHubStore.getState();
  const status = await store.checkStatus();
  if (!status?.loggedIn) {
    useUiStore.getState().setSidebarView("github");
    return null;
  }
  await store.refreshLists();
  const seen = new Set<number>();
  const prs: PrSummary[] = [];
  for (const category of [...PR_CATEGORIES].reverse()) {
    for (const pr of useGitHubStore.getState().prLists[category.id]?.items ?? []) {
      if (!seen.has(pr.number)) {
        seen.add(pr.number);
        prs.push(pr);
      }
    }
  }
  prs.sort((a, b) => b.number - a.number);
  if (prs.length === 0) {
    useUiStore.getState().showStatus("No open pull requests");
    return null;
  }
  const choice = await useUiStore.getState().openPick(
    prs.map((pr) => ({ label: `#${pr.number} ${pr.title}`, detail: `${pr.author} · ${pr.headRefName}${pr.isDraft ? " · draft" : ""}` })),
    placeholder,
  );
  return choice === null ? null : prs[choice];
}

export async function openPullRequestPicker(): Promise<void> {
  const pr = await choosePullRequest("Open a pull request…");
  if (pr) openPullRequest(pr.number, pr.title);
}

export async function checkoutPullRequestPicker(): Promise<void> {
  const pr = await choosePullRequest("Check out a pull request…");
  if (pr) await checkoutPullRequest(pr.number);
}

/** Open a terminal running `gh auth login`; when it ends, look again. */
export function signIn(): void {
  const root = repositoryRoot();
  const gh = (!isRemoteActive() && getSetting("github.ghPath")?.trim()) || "gh";
  let started = false;
  const unsubscribe = useTerminalStore.subscribe((state) => {
    const session = state.sessions.find((candidate) => candidate.reuseKey === "gh-auth");
    if (session?.isRunning) started = true;
    else if (started) {
      unsubscribe();
      void useGitHubStore.getState().refreshAll();
    }
  });
  void useTerminalStore
    .getState()
    .startCommandSession({ args: loginShellArgs(`${shellQuote(gh)} auth login`), cwd: root, env: null }, "gh auth login", "gh-auth")
    .catch((error) => useUiStore.getState().setLastError(String(error)));
}

export function refreshGitHub(): void {
  void useGitHubStore.getState().refreshAll();
}

/** Merge bases already looked up, by "base..head". */
const mergeBases = new Map<string, string>();

/** Open a pull request's file as a diff between its base and head. */
export async function openPrFile(root: string, pr: PrDetails, file: PrFile): Promise<void> {
  const key = `${pr.baseRefOid}..${pr.headRefOid}`;
  let base = mergeBases.get(key);
  if (!base) {
    base = (await github.mergeBase(root, pr.baseRefOid, pr.headRefOid).catch(() => "")) || pr.baseRefOid;
    mergeBases.set(key, base);
  }
  const top = useGitHubStore.getState().status?.topLevel ?? root;
  useTabsStore.getState().openDiff({
    kind: "pr",
    filePath: `${top.replace(/[/\\]+$/, "")}/${file.path}`,
    root,
    number: pr.number,
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    baseSha: base,
    headSha: pr.headRefOid,
  });
}
