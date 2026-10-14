import { useEffect } from "react";
import { GitPullRequest } from "lucide-react";
import { startGitHubRefresh, useGitHubStore } from "../../store/githubStore";
import { useGitStore } from "../../store/gitStore";
import { openPullRequest } from "../../lib/github/actions";
import { CheckBadge, checkTitle } from "./common";
import "./GitHub.css";

/** "PR #123 ✓" in the status bar when the current branch has a pull request. */
export function GitHubStatusItem() {
  const pr = useGitHubStore((state) => state.branchPr);
  const isRepo = useGitStore((state) => state.isRepo);
  const branch = useGitStore((state) => state.branch);

  useEffect(() => {
    startGitHubRefresh();
  }, []);
  useEffect(() => {
    if (isRepo && branch) void useGitHubStore.getState().refreshBranchPr();
  }, [isRepo, branch]);

  if (!pr || !isRepo || pr.headRefName !== branch) return null;
  return (
    <button
      className="status-bar-button gh-status-item"
      title={`Pull request #${pr.number}: ${pr.title}\n${checkTitle(pr.checks)} — click to open`}
      onClick={() => openPullRequest(pr.number, pr.title)}
    >
      <GitPullRequest size={13} strokeWidth={1.5} />
      PR #{pr.number}
      <CheckBadge state={pr.checks} size={12} />
    </button>
  );
}
