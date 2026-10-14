import {
  checkoutPullRequestPicker,
  createPullRequest,
  newIssue,
  openPullRequestPicker,
  refreshGitHub,
} from "./actions";

/** The command palette's GitHub commands. */
export function githubPaletteCommands(): { id: string; label: string; run: () => void }[] {
  return [
    { id: "github-open-pr", label: "GitHub: Open Pull Request…", run: () => void openPullRequestPicker() },
    { id: "github-create-pr", label: "GitHub: Create Pull Request", run: createPullRequest },
    { id: "github-new-issue", label: "GitHub: New Issue", run: newIssue },
    { id: "github-checkout-pr", label: "GitHub: Checkout Pull Request…", run: () => void checkoutPullRequestPicker() },
    { id: "github-refresh", label: "GitHub: Refresh", run: refreshGitHub },
  ];
}
