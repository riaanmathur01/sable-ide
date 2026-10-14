/** What a GitHub tab shows (tabsStore kind "github"). */
export interface GitHubTabTarget {
  view: "pr" | "issue" | "createPr" | "newIssue";
  /** The repository's workspace folder (gh runs there). */
  root: string;
  number?: number;
}

/** A pull request's file, compared between its base and head (a diff tab). */
export interface PrDiffSource {
  kind: "pr";
  /** The file in the workspace (absolute; picks the language and folder). */
  filePath: string;
  root: string;
  number: number;
  /** Repository-relative path, as GitHub has it. */
  path: string;
  previousPath: string | null;
  status: string;
  baseSha: string;
  headSha: string;
}

export function githubTabKey(target: GitHubTabTarget): string {
  return target.number !== undefined ? `github:${target.view}:${target.root}#${target.number}` : `github:${target.view}:${target.root}`;
}
