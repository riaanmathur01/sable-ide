import type { GitHubTabTarget } from "../../lib/github/types";
import { PullRequestView } from "./PullRequestView";
import { IssueView } from "./IssueView";
import { CreatePullRequestForm, NewIssueForm } from "./Forms";
import "./GitHub.css";

/** A GitHub editor tab: a pull request, an issue, or a Create/New form. */
export default function GitHubTab({ target }: { target: GitHubTabTarget }) {
  switch (target.view) {
    case "pr":
      return <PullRequestView root={target.root} number={target.number ?? 0} />;
    case "issue":
      return <IssueView root={target.root} number={target.number ?? 0} />;
    case "createPr":
      return <CreatePullRequestForm root={target.root} />;
    case "newIssue":
      return <NewIssueForm root={target.root} />;
  }
}
