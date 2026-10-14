// A stand-in for the GitHub CLI (gh) in UI tests: answers the calls Sable
// makes with recorded JSON fixtures (fixtures/github, a fictional
// repository) and logs every call — its arguments and stdin — so a test
// can check what would have been sent. It never touches the network.
//
//   FAKE_GH_DIR=<dir> node fake-gh.mjs <gh arguments…>
//
// <dir>/state.json: { loggedIn, baseSha, headSha, head1Sha } (written by
// the test); calls are appended to <dir>/calls.jsonl.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
let stdin = "";
try {
  stdin = fs.readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
if (dir) fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\n");
const state = dir && fs.existsSync(path.join(dir, "state.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) : { loggedIn: true };

const fill = (text) =>
  text
    .replaceAll("{{BASE_SHA}}", state.baseSha ?? "")
    .replaceAll("{{HEAD_SHA}}", state.headSha ?? "")
    .replaceAll("{{HEAD1_SHA}}", state.head1Sha ?? "");
const read = (name) => fill(fs.readFileSync(path.join(fixtures, name), "utf8"));
const json = (name) => JSON.parse(read(name));
const out = (value) => {
  // Synchronously: a pipe write may not finish before exit otherwise.
  fs.writeSync(1, typeof value === "string" ? value : JSON.stringify(value));
  process.exit(0);
};
const fail = (message, code = 1) => {
  fs.writeSync(2, message + "\n");
  process.exit(code);
};
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const REPO = "https://github.com/sable-test/demo";

/** A list fixture for a search: by its qualifier ("" = everything), then filtered by its words. */
function list(name, search = "") {
  const all = json(name);
  const words = search.split(/\s+/).filter(Boolean);
  const qualifier = words.find((word) => word.includes(":")) ?? "";
  const text = words.filter((word) => !word.includes(":")).join(" ").toLowerCase();
  let items = all[qualifier];
  if (!Array.isArray(items)) {
    const seen = new Map();
    for (const [key, value] of Object.entries(all)) if (Array.isArray(value) && key) for (const item of value) seen.set(item.number, item);
    items = [...seen.values()].sort((a, b) => b.number - a.number);
  }
  return text ? items.filter((item) => item.title.toLowerCase().includes(text)) : items;
}

/** A pull request: #42 recorded in full, others from the list with its details. */
function pullRequest(number) {
  const pr = json("pr-42.json");
  delete pr._comment;
  if (number === 42) return pr;
  const listed = list("pr-list.json").find((item) => item.number === number);
  return { ...pr, ...(listed ?? {}), number, url: `${REPO}/pull/${number}`, comments: [], reviews: [], latestReviews: [], reviewRequests: [] };
}

if (args[0] === "--version") out("gh version 2.62.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n");
if (!state.loggedIn && args[0] !== "auth") {
  fail("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.", 4);
}
const [command, sub] = args;
const repo = json("repo.json");

if (command === "repo" && sub === "view") out(repo.repo);
if (command === "label" && sub === "list") out(repo.labels);

if (command === "pr") {
  const number = Number(args[2]);
  switch (sub) {
    case "list":
      out(list("pr-list.json", flag("--search")));
      break;
    case "view": {
      if (Number.isInteger(number) && number > 0) out(pullRequest(number));
      // The current branch's pull request.
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
      if (branch === "feature/login") out(pullRequest(42));
      fail(`no pull requests found for branch "${branch}"`);
      break;
    }
    case "checkout":
      out(`Switched to branch '${list("pr-list.json").find((item) => item.number === number)?.headRefName ?? `pr-${number}`}'\n`);
      break;
    case "merge":
      out(`✓ Merged pull request #${number} (${pullRequest(number).title})\n`);
      break;
    case "close":
    case "reopen":
    case "ready":
      out(`✓ ${sub} pull request #${number}\n`);
      break;
    case "comment":
      out(`${REPO}/pull/${number}#issuecomment-99\n`);
      break;
    case "edit":
      out(`${REPO}/pull/${number}\n`);
      break;
    case "create":
      out(`\nCreating pull request for ${flag("--head")} into ${flag("--base")} in sable-test/demo\n\n${REPO}/pull/46\n`);
      break;
  }
}

if (command === "issue") {
  const number = Number(args[2]);
  switch (sub) {
    case "list":
      out(list("issue-list.json", flag("--search")));
      break;
    case "view": {
      const issue = json("issue-7.json");
      delete issue._comment;
      if (number === 7) out(issue);
      const listed = list("issue-list.json").find((item) => item.number === number);
      out({ ...issue, ...(listed ?? { title: `Issue ${number}` }), number, comments: [], body: "", url: `${REPO}/issues/${number}` });
      break;
    }
    case "comment":
      out(`${REPO}/issues/${number}#issuecomment-98\n`);
      break;
    case "edit":
    case "close":
    case "reopen":
      out(`${REPO}/issues/${number}\n`);
      break;
    case "create":
      out(`\nCreating issue in sable-test/demo\n\n${REPO}/issues/12\n`);
      break;
  }
}

if (command === "api") {
  const endpoint = sub;
  if (endpoint === "user") out(repo.user);
  if (endpoint === "graphql") {
    const query = args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
    const variable = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    if (query.includes("reviewThreads")) {
      if (variable("number") === "42") out(read("pr-42-threads.json"));
      out({ data: { repository: { pullRequest: { id: `PR_${variable("number")}`, files: { nodes: [] }, reviewThreads: { nodes: [] } } } } });
    }
    for (const mutation of ["resolveReviewThread", "unresolveReviewThread"]) {
      if (query.includes(`${mutation}(`)) out({ data: { [mutation]: { thread: { id: variable("id"), isResolved: mutation === "resolveReviewThread" } } } });
    }
    for (const mutation of ["markFileAsViewed", "unmarkFileAsViewed"]) {
      if (query.includes(`${mutation}(`)) out({ data: { [mutation]: { clientMutationId: null } } });
    }
    fail("GraphQL: unexpected query (fake gh)");
  }
  let match;
  if ((match = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/files/.exec(endpoint))) out(match[1] === "42" ? read("pr-42-files.json") : "[]");
  if (/^repos\/\{owner\}\/\{repo\}\/pulls\/\d+\/reviews$/.test(endpoint)) {
    const review = JSON.parse(stdin || "{}");
    out({ id: 77, node_id: "PRR_new", state: review.event === "APPROVE" ? "APPROVED" : review.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", body: review.body });
  }
  if (/^repos\/\{owner\}\/\{repo\}\/pulls\/\d+\/comments\/\d+\/replies$/.test(endpoint)) out({ id: 2001, body: JSON.parse(stdin || "{}").body });
  if (endpoint.startsWith("repos/{owner}/{repo}/assignees")) out(repo.assignees);
  if ((match = /^repos\/\{owner\}\/\{repo\}\/contents\/([^?]+)\?ref=(.+)$/.exec(endpoint))) {
    // Files the test repository doesn't have (at any ref).
    const file = path.join(fixtures, "contents", decodeURIComponent(match[1]));
    if (fs.existsSync(file)) out(fs.readFileSync(file, "utf8"));
    fail(`HTTP 404: Not Found (https://api.github.com/${endpoint})`);
  }
  if (endpoint.includes("/compare/")) out(`${state.baseSha}\n`);
}

fail(`fake gh: unexpected arguments: ${args.join(" ")}`);
