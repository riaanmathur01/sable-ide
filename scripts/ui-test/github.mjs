// End-to-end test of GitHub pull requests and issues, against the real
// backend with a FAKE gh: `github.ghPath` points at scripts/ui-test/
// fake-gh.mjs, which answers with recorded JSON fixtures (a fictional
// repository) and logs every call. Nothing here talks to GitHub or touches
// a real repository: the workspace is a throwaway git repository in a temp
// folder whose "origin" is a bare repository beside it.
//
// Covers: the signed-out state (Sign in opens `gh auth login`), the lists,
// the status bar's PR item, a PR tab (description, checks, reviewers),
// Files changed → a diff with an inline review thread, replying and
// resolving, a new line comment kept pending and submitted with Approve
// (the fake gh got the review's JSON), checkout, the merge dialog, the
// create-PR form (pushes the branch after asking), an issue tab with a
// comment and a label edit, "Start working on issue", New Issue from a
// template. Screenshots in the dark theme and a light one (Catppuccin Latte).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/github.mjs
//
// with Vite and the bridge running (README → Testing), e.g.
//   npx vite --port 1584 --strictPort
//   (cd src-tauri && SABLE_UI_BRIDGE_PORT=1585 SABLE_UI_PLUGINS_DIR=<tmp> SABLE_UI_HISTORY_DIR=<tmp> cargo test --lib ui_bridge -- --ignored)
//   SABLE_UI_VITE_PORT=1584 SABLE_UI_BRIDGE_PORT=1585 node scripts/ui-test/github.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSable, extraStandins, sleep, clickText, unknownCommands } from "./driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-github-shots");
fs.mkdirSync(shots, { recursive: true });
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-gh-")));
const workspace = path.join(temp, "demo");
const remote = path.join(temp, "remote.git");
const ghDir = path.join(temp, "gh");
fs.mkdirSync(workspace);
fs.mkdirSync(ghDir);

// --- The throwaway repository ------------------------------------------------------------------
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "The Octocat",
  GIT_AUTHOR_EMAIL: "octocat@example.com",
  GIT_COMMITTER_NAME: "The Octocat",
  GIT_COMMITTER_EMAIL: "octocat@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (args, cwd = workspace) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(workspace, file), text);
};
git(["init", "-q", "-b", "main"]);
write("README.md", "# Demo\n\nA fictional repository for Sable's GitHub tests.\n");
write(
  "src/auth.ts",
  `export function check(name: string, password: string): boolean {
  if (!name) return false;
  return password.length > 0;
}

export function logout(): void {
  sessionStorage.clear();
}
`,
);
write(
  ".github/ISSUE_TEMPLATE/bug_report.md",
  `---
name: Bug report
about: Something doesn't work
title: "[Bug] "
labels: bug
assignees: ''
---

**What happened**

**Steps to reproduce**
1.
`,
);
write(".github/ISSUE_TEMPLATE/feature_request.md", "---\nname: Feature request\nabout: Suggest an idea\nlabels: enhancement\n---\n\n**The idea**\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "Initial commit"]);
const baseSha = git(["rev-parse", "HEAD"]);
git(["init", "-q", "--bare", remote], temp);
git(["remote", "add", "origin", remote]);
git(["push", "-q", "-u", "origin", "main"]);
git(["switch", "-q", "-c", "feature/login"]);
write(
  "src/login.ts",
  `import { check } from "./auth";

export function renderLogin(root: HTMLElement): void {
  root.innerHTML = \`
    <form class="login">
      <label>Name <input name="name" /></label>
      <label>Password <input name="password" type="password" /></label>
      <button>Sign in</button>
    </form>\`;
  const form = root.querySelector("form")!;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const ok = await check(String(data.get("name")), String(data.get("password")));
    form.classList.toggle("failed", !ok);
  });
}
`,
);
git(["add", "-A"]);
git(["commit", "-q", "-m", "Add login form"]);
const head1Sha = git(["rev-parse", "HEAD"]);
write(
  "src/auth.ts",
  `export async function check(name: string, password: string): Promise<boolean> {
  if (!name) return false;
  if (password.length < 8) return false;
  return verify(name, password);
}

async function verify(name: string, password: string): Promise<boolean> {
  const response = await fetch("/api/login", { method: "POST", body: JSON.stringify({ name, password }) });
  return response.ok;
}

export function logout(): void {
  sessionStorage.clear();
}
`,
);
git(["add", "-A"]);
git(["commit", "-q", "-m", "Validate the password"]);
const headSha = git(["rev-parse", "HEAD"]);

// --- The fake gh ---------------------------------------------------------------------------------
const setState = (patch) => {
  const file = path.join(ghDir, "state.json");
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }));
};
setState({ loggedIn: false, baseSha, headSha, head1Sha });
const fakeGh = path.join(ghDir, "gh");
fs.writeFileSync(fakeGh, `#!/bin/sh\nFAKE_GH_DIR='${ghDir}' exec '${process.execPath}' '${path.join(here, "fake-gh.mjs")}' "$@"\n`);
fs.chmodSync(fakeGh, 0o755);
/** The calls the fake gh got since the last look. */
let seen = 0;
const ghCalls = () => {
  const file = path.join(ghDir, "calls.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const newCalls = () => {
  const all = ghCalls();
  const fresh = all.slice(seen);
  seen = all.length;
  return fresh;
};
const findCall = (calls, prefix) => calls.find((call) => prefix.every((word, index) => call.args[index] === word));

// --- Helpers ---------------------------------------------------------------------------------------
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};
async function waitFor(page, fn, args = [], timeout = 15000, what = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Wait until the fake gh got a call starting with `prefix` (and passing `test`); returns it. */
async function waitForCall(prefix, timeout = 10000, test = () => true) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const call = ghCalls()
      .slice(seen)
      .find((candidate) => findCall([candidate], prefix) && test(candidate));
    if (call) return call;
    await sleep(80);
  }
  return null;
}
const graphqlWith = (text) => (call) => call.args.some((arg) => arg.includes(text));
const mod = process.platform === "darwin" ? "Meta" : "Control";
const chord = async (page, key, modifiers = [mod]) => {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
};
async function palette(page, text) {
  await chord(page, "p", [mod, "Shift"]);
  await waitFor(page, () => !!document.querySelector(".palette-input"), [], 3000, "palette");
  await page.keyboard.type(text);
  await sleep(200);
  await page.keyboard.press("Enter");
}
const visible = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((element) => element.offsetParent !== null)`;
const textOf = (page, selector) => page.evaluate((selector) => [...document.querySelectorAll(selector)].filter((element) => element.offsetParent !== null).map((element) => element.innerText).join("\n"), selector);
/** Center of the gutter's glyph margin on a line of the diff's modified side. */
const glyphPoint = (page, line) =>
  page.evaluate((line) => {
    const editor = document.querySelector(".monaco-diff-editor .editor.modified");
    const number = [...editor.querySelectorAll(".line-numbers")].find((element) => element.textContent.trim() === String(line));
    const margin = editor.querySelector(".margin").getBoundingClientRect();
    const box = number.getBoundingClientRect();
    return { x: margin.left + 9, y: box.top + box.height / 2 };
  }, line);

// Avatars come from GitHub's image host: answered here with a drawn one.
async function stubAvatars(page) {
  // A CDP Fetch session of our own, not page.setRequestInterception():
  // puppeteer's interception also pauses the requests of the page's web
  // workers without ever reporting them, so Monaco's editor worker never
  // loaded and diffs were never computed ("timed out waiting for diff
  // colors"). Only requests leaving the machine are paused here, so
  // Vite's (localhost) and blob:/data: URLs are never touched.
  const client = await page.createCDPSession();
  client.on("Fetch.requestPaused", ({ requestId, request }) => {
    const url = request.url;
    if (url.startsWith("https://avatars.githubusercontent.com/")) {
      const login = decodeURIComponent(new URL(url).pathname.slice(1));
      const hue = [...login].reduce((sum, char) => sum + char.charCodeAt(0) * 37, 0) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue},45%,55%)"/><circle cx="32" cy="26" r="12" fill="hsl(${hue},45%,85%)"/><rect x="14" y="42" width="36" height="22" rx="11" fill="hsl(${hue},45%,85%)"/></svg>`;
      void client
        .send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/svg+xml" }], body: Buffer.from(svg).toString("base64") })
        .catch(() => {});
    } else if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
      void client.send("Fetch.continueRequest", { requestId }).catch(() => {});
    } else {
      // Nothing else leaves the machine.
      void client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }, { urlPattern: "http://*" }, { urlPattern: "ws://*" }, { urlPattern: "wss://*" }] });
}

// Terminals need the app window: record what would run.
const terminals = [];
extraStandins.create_command_terminal = (args) => {
  terminals.push(args.args);
  return 4242;
};
extraStandins.create_terminal = 4243;
extraStandins.write_terminal = null;
extraStandins.resize_terminal = null;
extraStandins.kill_terminal = null;

const theme = process.env.SABLE_GH_THEME;
const settings = { "github.ghPath": fakeGh, "files.autoSave": false };
if (theme) settings["workbench.colorTheme"] = theme;
extraStandins.load_settings = settings;

const missing = [];
const failed = [];
const watch404 = (page) =>
  page.on("response", (response) => {
    if (response.status() === 404) missing.push(response.url());
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
// Not the app's: the dev server's missing favicon, requests the test blocks
// from leaving the machine, and Vite refusing a font outside its allow list
// when node_modules is a symlink to another checkout.
const ownErrors = (errors) => {
  let favicons = missing.filter((url) => url.endsWith("/favicon.ico")).length;
  let refused = failed.filter((entry) => entry.startsWith("403 ") && entry.includes("/@fs/")).length;
  return errors.filter(
    (error) =>
      !(
        error.startsWith("Failed to load resource") &&
        (error.includes("404") ? favicons-- > 0 : error.includes("403") ? refused-- > 0 : error.includes("net::ERR_FAILED"))
      ),
  );
};

const prefix = theme ? `${theme}-` : "";
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${prefix}${name}.png`) });

const { browser, page, errors } = await openSable(workspace, {
  width: 1500,
  height: 940,
  beforeLoad: async (page) => {
    watch404(page);
    await stubAvatars(page);
  },
});
try {
  await sleep(1200);
  await page.click('.activity-bar-item[title="GitHub"]');

  // --- Not signed in ----------------------------------------------------------------------------
  await waitFor(page, () => !!document.querySelector(".gh-setup"), [], 15000, "the setup message");
  const setup = await textOf(page, ".gh-setup");
  check(setup.includes("Sign in to GitHub"), "signed out: the view says to sign in");
  check(!!(await page.$(".gh-setup .gh-button.primary")), "signed out: a Sign in button");
  await shot(page, "1-signed-out");
  await clickText(page, "Sign in", ".gh-setup .gh-button");
  await waitFor(page, () => true);
  const started = Date.now();
  while (!terminals.length && Date.now() - started < 5000) await sleep(80);
  const terminal = terminals[0]?.join(" ") ?? "";
  check(terminal.includes(`${fakeGh} auth login`), `Sign in opens a terminal running gh auth login (${terminal})`);
  // (Hide the terminal panel again, for the screenshots.)
  await page.click(".status-bar-button[title^='Toggle Terminal']");

  // --- Signed in: the lists ------------------------------------------------------------------------
  setState({ loggedIn: true });
  newCalls();
  await clickText(page, "Try again", ".gh-setup .gh-button");
  await waitFor(page, () => document.querySelectorAll(".gh-row").length >= 4, [], 15000, "list rows");
  await waitFor(page, () => ![...document.querySelectorAll(".gh-category-spinner")].length, [], 15000, "lists loaded");
  const counts = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll(".gh-category")].map((category) => [category.dataset.category, category.querySelector(".gh-count")?.textContent])),
  );
  check(
    counts["pr:review"] === "2" && counts["pr:assigned"] === "1" && counts["pr:created"] === "1" && counts["pr:all"] === "3",
    `pull request categories with counts (${JSON.stringify(counts)})`,
  );
  check(counts["issue:assigned"] === "1" && counts["issue:mentioned"] === "0" && counts["issue:open"] === "2", "issue categories with counts");
  const listCalls = newCalls();
  check(!!findCall(listCalls, ["pr", "list", "--state", "open"]) && listCalls.some((call) => call.args.includes("review-requested:@me")), "gh pr list --search review-requested:@me");
  check(listCalls.some((call) => call.args[0] === "issue" && call.args.includes("mentions:@me")), "gh issue list --search mentions:@me");
  const row42 = await page.evaluate(() => document.querySelector('.gh-category[data-category="pr:review"] .gh-row[data-number="42"]')?.innerText ?? "");
  check(row42.includes("#42") && row42.includes("Add login form") && row42.includes("enhancement") && row42.includes("Review required"), "a PR row: number, title, labels, review state");
  check(await page.evaluate(() => !!document.querySelector('.gh-category[data-category="pr:review"] .gh-row[data-number="42"] .gh-check.pending')), "a PR row: ● for running checks");
  check(await page.evaluate(() => !!document.querySelector('.gh-category[data-category="pr:created"] .gh-row[data-number="45"] .gh-check.failure')), "a PR row: ✗ for failed checks, and Draft");
  check(await page.evaluate(() => !!document.querySelector('.gh-category[data-category="pr:review"] .gh-row[data-number="38"] .gh-check.success')), "a PR row: ✓ for passed checks");
  await waitFor(page, () => [...document.querySelectorAll(".gh-row img.gh-avatar")].some((image) => image.complete && image.naturalWidth > 0), [], 5000, "avatars").catch(() => {});
  check(
    await page.evaluate(() => document.querySelectorAll(".gh-row img.gh-avatar").length > 0 && [...document.querySelectorAll(".gh-row img.gh-avatar")].every((image) => image.complete && image.naturalWidth > 0)),
    "author avatars load",
  );
  const issueRow = await page.evaluate(() => document.querySelector('.gh-category[data-category="issue:assigned"] .gh-row[data-number="7"]')?.innerText ?? "");
  check(issueRow.includes("Crash when the password is empty") && issueRow.includes("v1.0") && issueRow.includes("bug"), "an issue row: labels and milestone");
  // Collapse a category.
  await page.click('.gh-category[data-category="pr:all"] .gh-category-header');
  check(await page.evaluate(() => !document.querySelector('.gh-category[data-category="pr:all"] .gh-row')), "categories collapse");
  await page.click('.gh-category[data-category="pr:all"] .gh-category-header');
  // Search.
  await page.type(".gh-search input", "README");
  await waitFor(page, () => document.querySelector('.gh-category[data-category="pr:all"] .gh-count')?.textContent === "1", [], 8000, "search results");
  check(newCalls().some((call) => call.args.includes("README") || call.args.some((arg) => arg.endsWith(" README"))), "search goes to gh --search");
  await page.click(".gh-search-clear");
  await waitFor(page, () => document.querySelector('.gh-category[data-category="pr:all"] .gh-count')?.textContent === "3", [], 8000, "search cleared");
  await shot(page, "2-lists");

  // --- The status bar ---------------------------------------------------------------------------------
  await waitFor(page, () => /PR #42/.test(document.querySelector(".gh-status-item")?.innerText ?? ""), [], 10000, "status bar PR item");
  check(await page.evaluate(() => !!document.querySelector(".gh-status-item .gh-check.pending")), "status bar: PR #42 with its check state");
  await page.click(".gh-status-item");

  // --- The pull request tab ---------------------------------------------------------------------------
  await waitFor(page, () => !!document.querySelector('.gh-pr[data-pr="42"] .gh-page-title'), [], 10000, "PR tab");
  check((await textOf(page, ".editor-tab.active")).includes("#42 Add login form"), "clicking it opens the PR tab");
  const header = await textOf(page, ".gh-pr .gh-page-header");
  check(header.includes("Add login form") && header.includes("Open") && header.includes("feature/login") && header.includes("main"), "PR header: title, state, branches");
  await waitFor(page, () => !!document.querySelector(".gh-pr .gh-markdown li input[type=checkbox]"), [], 5000, "description markdown");
  check(await page.evaluate(() => !!document.querySelector(".gh-pr .gh-markdown strong") && !!document.querySelector(".gh-pr .gh-markdown pre code")), "description rendered as Markdown (bold, task list, code)");
  check(await page.evaluate(() => [...document.querySelectorAll(".gh-pr .gh-markdown a")].some((link) => link.getAttribute("href") === "https://github.com/sable-test/demo/issues/7")), "#7 links to the issue");
  const side = await textOf(page, ".gh-pr .gh-page-side");
  check(side.includes("bob") && side.includes("Approved") && side.includes("alice") && side.includes("Requested"), "reviewers with their review state");
  check(side.includes("enhancement") && side.includes("v1.0"), "labels and milestone");
  const timeline = await textOf(page, ".gh-pr .gh-timeline");
  check(timeline.includes("Can you add a test") && timeline.includes("Looks great") && timeline.includes("Should 8 be a named constant?") && timeline.includes("I'll add MIN_PASSWORD_LENGTH"), "timeline: comment, review, review thread with its reply");
  await waitFor(page, () => !!document.querySelector(".gh-pr .gh-card.thread"), [], 3000, "threads");
  await shot(page, "3-pr");
  await clickText(page, /^Checks/, ".gh-pr .gh-tab");
  const checks = await textOf(page, ".gh-pr .gh-list-card");
  check(checks.includes("build") && checks.includes("test (ubuntu-latest)") && checks.includes("Details"), "checks with status and links");
  check(await page.evaluate(() => document.querySelectorAll(".gh-pr .gh-list-card .gh-check").length === 3), "each check has its ✓/●");
  await clickText(page, /^Commits/, ".gh-pr .gh-tab");
  check((await textOf(page, ".gh-pr .gh-list-card")).includes("Validate the password"), "commits listed");

  // --- Files changed → diff with the inline thread ----------------------------------------------------------
  await clickText(page, /^Files changed/, ".gh-pr .gh-tab");
  await waitFor(page, () => document.querySelectorAll(".gh-file").length === 3, [], 8000, "files");
  check((await textOf(page, ".gh-files-head")).includes("1 of 3 files viewed"), "viewed state from GitHub");
  newCalls();
  await page.click('.gh-file[data-file="src/auth.ts"] .gh-viewed input');
  const viewedCall = await waitForCall(["api", "graphql"], 10000, graphqlWith("markFileAsViewed("));
  check(!!viewedCall && viewedCall.args.some((arg) => arg.includes("markFileAsViewed(")) && viewedCall.args.includes("path=src/auth.ts"), "Viewed checkbox: markFileAsViewed");
  newCalls();
  await page.click('.gh-file[data-file="src/auth.ts"] .gh-list-main');
  await waitFor(page, () => !!document.querySelector(".monaco-diff-editor .editor.modified .view-lines"), [], 15000, "diff editor");
  await waitFor(page, () => [...document.querySelectorAll(".gh-zone")].some((zone) => zone.innerText.includes("named constant")), [], 10000, "inline thread");
  check((await textOf(page, ".editor-tab.active")).includes("auth.ts (#42)"), "a PR file opens as a diff tab");
  const diffText = await page.evaluate(() => document.querySelector(".monaco-diff-editor .editor.modified .view-lines").innerText.replace(/\u00a0/g, " "));
  check(diffText.includes("password.length < 8") && diffText.includes("verify"), "the diff shows the head version");
  const original = await page.evaluate(() => document.querySelector(".monaco-diff-editor .editor.original .view-lines").innerText.replace(/\u00a0/g, " "));
  check(original.includes("password.length > 0"), "…against the base version (from the local repository)");
  const zone = await page.evaluate(() => {
    const element = [...document.querySelectorAll(".gh-zone")].find((zone) => zone.innerText.includes("named constant"));
    return { line: element.dataset.line, side: element.dataset.side, replies: element.querySelectorAll(".gh-comment").length };
  });
  check(zone.line === "3" && zone.side === "RIGHT" && zone.replies === 2, `the thread sits under line 3 of the new side with both comments (${JSON.stringify(zone)})`);
  await waitFor(page, () => !!document.querySelector(".monaco-diff-editor .editor.modified .line-insert, .monaco-diff-editor .editor.modified .char-insert"), [], 5000, "diff colors");
  await sleep(300);
  await shot(page, "4-diff-thread");

  // Reply and resolve in the diff.
  newCalls();
  await page.click(".gh-zone .gh-reply-placeholder");
  await page.waitForSelector(".gh-zone .gh-reply textarea");
  await page.type(".gh-zone .gh-reply textarea", "Done in the next commit.");
  await clickText(page, "Reply", ".gh-zone .gh-reply .gh-button");
  const replyCall = await waitForCall(["api", "repos/{owner}/{repo}/pulls/42/comments/1001/replies"]);
  check(!!replyCall && JSON.parse(replyCall.stdin).body === "Done in the next commit.", "reply: POST …/comments/1001/replies with the text");
  await waitFor(page, () => !document.querySelector(".gh-zone .gh-reply textarea"), [], 5000, "reply sent");
  newCalls();
  await clickText(page, "Resolve", ".gh-zone .gh-button");
  const resolveCall = await waitForCall(["api", "graphql"], 10000, graphqlWith("resolveReviewThread("));
  check(!!resolveCall && resolveCall.args.some((arg) => arg.includes("resolveReviewThread(")) && resolveCall.args.includes("id=PRRT_kwDOA_1"), "resolve: resolveReviewThread on the thread");

  // A new line comment, pending, then submitted with the review.
  // (The thread above may still be settling after the resolve: aim again until the + shows.)
  let plus = null;
  for (let attempt = 0; attempt < 15 && !plus; attempt++) {
    await sleep(200);
    const point = await glyphPoint(page, 4);
    await page.mouse.move(point.x + 40, point.y, { steps: 2 });
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await sleep(150);
    const shown = await page.evaluate((y) => {
      const glyph = document.querySelector(".monaco-diff-editor .editor.modified .gh-add-comment-glyph");
      const box = glyph?.getBoundingClientRect();
      return !!box && y >= box.top && y <= box.bottom;
    }, point.y);
    if (shown) plus = point;
  }
  check(!!plus, "hovering a changed line shows + in the gutter");
  if (!plus) throw new Error("no + in the gutter");
  await page.mouse.down();
  await page.mouse.up();
  await waitFor(page, () => !!document.querySelector('.gh-zone [data-draft="true"] textarea'), [], 5000, "comment box");
  await sleep(300);
  await page.click('.gh-zone [data-draft="true"] textarea');
  await page.keyboard.type("Return early here?");
  check((await page.$eval('.gh-zone [data-draft="true"] textarea', (element) => element.value)) === "Return early here?", "clicking + opens a comment box on that line");
  await sleep(150);
  await shot(page, "5-new-comment");
  await clickText(page, "Start a review", '.gh-zone [data-draft="true"] .gh-button');
  await waitFor(page, () => [...document.querySelectorAll(".gh-zone")].some((zone) => zone.innerText.includes("Pending") && zone.innerText.includes("Return early here?")), [], 5000, "pending comment");
  check(true, "the comment shows inline as Pending");
  check((await textOf(page, ".gh-diff-toolbar")).includes("1 pending"), "the diff toolbar counts the pending comment");
  await clickText(page, /Finish review/, ".gh-diff-toolbar .gh-button");
  await waitFor(page, () => !!document.querySelector('.gh-pr [data-composer="review"] .gh-pending-item'), [], 5000, "pending list in the PR tab");
  await page.type('.gh-pr [data-composer="review"] textarea:not(.gh-reply textarea)', "Nice work — one suggestion.");
  newCalls();
  await clickText(page, "Approve", '.gh-pr [data-composer="review"] .gh-button');
  const reviewCall = await waitForCall(["api", "repos/{owner}/{repo}/pulls/42/reviews", "--method", "POST", "--input", "-"]);
  const review = reviewCall ? JSON.parse(reviewCall.stdin) : {};
  check(review.event === "APPROVE" && review.body === "Nice work — one suggestion." && review.commit_id === headSha, `review submitted: APPROVE with its body on the head commit`);
  check(
    review.comments?.length === 1 && review.comments[0].path === "src/auth.ts" && review.comments[0].line === 4 && review.comments[0].side === "RIGHT" && review.comments[0].body === "Return early here?",
    `…with the pending line comment (${JSON.stringify(review.comments)})`,
  );
  await waitFor(page, () => !document.querySelector(".gh-pr .gh-pending-item"), [], 5000, "pending cleared");

  // The added file GitHub has but the local repository doesn't: from gh's contents API.
  await clickText(page, /^Files changed/, ".gh-pr .gh-tab");
  newCalls();
  await page.click('.gh-file[data-file="docs/login.md"] .gh-list-main');
  await waitFor(page, () => (document.querySelector(".monaco-diff-editor .editor.modified .view-lines")?.innerText ?? "").replace(/\u00a0/g, " ").includes("Signing in"), [], 10000, "remote file");
  check(newCalls().some((call) => call.args[1]?.startsWith("repos/{owner}/{repo}/contents/docs/login.md?ref=")), "a file not in the local repository comes from gh api …/contents");

  // --- Checkout (palette) ----------------------------------------------------------------------------------
  newCalls();
  await palette(page, "GitHub: Checkout Pull Request");
  await waitFor(page, () => [...document.querySelectorAll(".palette-item")].some((item) => item.innerText.includes("#38")), [], 8000, "PR picker");
  await clickText(page, /^#38 /, ".palette-item-label");
  const checkoutCall = await waitForCall(["pr", "checkout", "38"]);
  check(!!checkoutCall, "GitHub: Checkout Pull Request… → gh pr checkout 38");

  // --- Merge dialog -----------------------------------------------------------------------------------------
  await clickText(page, /#42 Add login form/, ".editor-tab-name");
  await waitFor(page, () => !!document.querySelector(".gh-pr .gh-button.merge"), [], 5000, "merge button");
  await page.click(".gh-pr .gh-actions .gh-button.merge");
  await waitFor(page, () => !!document.querySelector(".gh-modal"), [], 3000, "merge dialog");
  await page.click('.gh-modal input[value="squash"]');
  check((await textOf(page, ".gh-modal-footer")).includes("Squash and merge"), "merge dialog: choosing squash");
  await sleep(150);
  await shot(page, "6-merge");
  newCalls();
  await page.click(".gh-modal-footer .gh-button.merge");
  const mergeCall = await waitForCall(["pr", "merge", "42"]);
  check(!!mergeCall && mergeCall.args.includes("--squash") && mergeCall.args.includes("--delete-branch"), `merge: gh pr merge 42 --squash --delete-branch (${mergeCall?.args.join(" ")})`);
  await waitFor(page, () => !document.querySelector(".gh-modal"), [], 5000, "dialog closed");

  // --- Create Pull Request ----------------------------------------------------------------------------------
  await palette(page, "GitHub: Create Pull Request");
  await waitFor(page, () => !!document.querySelector('[data-form="create-pr"] input[name="head"]')?.value, [], 10000, "create PR form");
  await waitFor(page, () => document.querySelector('[data-form="create-pr"] input[name="title"]')?.value, [], 5000, "title default");
  const form = await page.evaluate(() => ({
    base: document.querySelector('[data-form="create-pr"] input[name="base"]').value,
    head: document.querySelector('[data-form="create-pr"] input[name="head"]').value,
    title: document.querySelector('[data-form="create-pr"] input[name="title"]').value,
    body: document.querySelector('[data-form="create-pr"] textarea').value,
  }));
  check(form.base === "main" && form.head === "feature/login", `create PR: base main ← feature/login (${form.base} ← ${form.head})`);
  check(form.title === "Login" && form.body.includes("- Add login form") && form.body.includes("- Validate the password"), `create PR: title and description from the commits (${form.title})`);
  check((await textOf(page, '[data-form="create-pr"] .gh-form-note')).includes("not on GitHub yet"), "create PR: says the branch isn't pushed");
  await page.click('[data-form="create-pr"] input[name="title"]');
  await page.keyboard.press("End");
  for (let index = 0; index < form.title.length; index++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Add a login form");
  await page.click('[data-form="create-pr"] input[name="draft"]');
  await page.click('[data-block="reviewers"] .gh-link-button');
  await waitFor(page, () => [...document.querySelectorAll(".gh-popover-item")].some((item) => item.innerText.includes("alice")), [], 5000, "reviewer choices");
  await clickText(page, "alice", ".gh-popover-item span");
  await clickText(page, "Apply", ".gh-popover .gh-button");
  await shot(page, "7-create-pr");
  await clickText(page, /Create draft pull request/, '[data-form="create-pr"] .gh-button');
  await waitFor(page, () => !!document.querySelector('[data-confirm="push"]'), [], 3000, "push confirmation");
  check(true, "creating asks to push the branch first");
  await shot(page, "8-push-confirm");
  newCalls();
  await clickText(page, /Push and create/, '[data-confirm="push"] .gh-button');
  const createCall = await waitForCall(["pr", "create"], 20000);
  check(
    !!createCall &&
      createCall.args.join(" ").includes("--title Add a login form --body-file - --base main --head feature/login --draft --reviewer alice") &&
      createCall.stdin.includes("- Validate the password"),
    `gh pr create with title, body on stdin, base, head, draft, reviewer (${createCall?.args.join(" ")})`,
  );
  check(git(["ls-remote", "--heads", remote, "feature/login"]).includes(headSha), "the branch was pushed to origin (a local bare repository) first");
  await waitFor(page, () => (document.querySelector(".editor-tab.active")?.innerText ?? "").includes("#46"), [], 8000, "the new PR's tab");
  check(true, "the new pull request opens");

  // --- Issue tab ---------------------------------------------------------------------------------------------
  await page.click('.gh-category[data-category="issue:assigned"] .gh-row[data-number="7"]');
  await waitFor(page, () => !!document.querySelector('.gh-issue[data-issue="7"] .gh-markdown'), [], 10000, "issue tab");
  await sleep(200);
  await shot(page, "9-issue");
  const issue = await textOf(page, ".gh-issue");
  check(issue.includes("Crash when the password is empty") && issue.includes("empty password") && issue.includes("Reproduced on main"), "issue tab: body and comments");
  check((await textOf(page, ".gh-issue .gh-page-side")).includes("octocat") && (await textOf(page, ".gh-issue .gh-page-side")).includes("bug") && (await textOf(page, ".gh-issue .gh-page-side")).includes("v1.0"), "issue tab: assignees, labels, milestone");
  newCalls();
  await page.type('.gh-issue [data-composer="issue"] textarea', "Fixed by #42.");
  await clickText(page, "Comment", '.gh-issue [data-composer="issue"] .gh-button');
  const commentCall = await waitForCall(["issue", "comment", "7", "--body-file", "-"]);
  check(!!commentCall && commentCall.stdin === "Fixed by #42.", "issue comment: gh issue comment 7 with the text on stdin");
  newCalls();
  await page.click('.gh-issue [data-block="labels"] .gh-link-button');
  await waitFor(page, () => [...document.querySelectorAll(".gh-popover-item")].some((item) => item.innerText.includes("docs")), [], 5000, "label choices");
  await clickText(page, "docs", ".gh-popover-item .gh-label");
  await clickText(page, "Apply", ".gh-popover .gh-button");
  const editCall = await waitForCall(["issue", "edit", "7"]);
  check(!!editCall && editCall.args.join(" ") === "issue edit 7 --add-label docs", `labels: gh issue edit 7 --add-label docs (${editCall?.args.join(" ")})`);
  // Close.
  newCalls();
  await clickText(page, "Close issue", '.gh-issue [data-composer="issue"] .gh-button');
  check(!!(await waitForCall(["issue", "close", "7"])), "Close issue: gh issue close 7");
  // Start working on it: a branch <user>/issue-<n>-<slug>.
  await clickText(page, /Start working on issue/, ".gh-issue .gh-button");
  const branchName = "octocat/issue-7-crash-when-the-password-is-empty";
  const startedBranch = Date.now();
  while (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== branchName && Date.now() - startedBranch < 8000) await sleep(100);
  check(git(["rev-parse", "--abbrev-ref", "HEAD"]) === branchName, `Start working on issue checks out ${branchName}`);
  // The status bar's PR item goes with the branch.
  await waitFor(page, () => !document.querySelector(".gh-status-item"), [], 8000, "status bar item gone");
  check(true, "on a branch without a pull request, the status bar has no PR item");

  // --- New Issue from a template ------------------------------------------------------------------------------
  await palette(page, "GitHub: New Issue");
  await waitFor(page, () => !!document.querySelector('[data-form="new-issue"] .gh-template'), [], 8000, "templates");
  check((await textOf(page, '[data-form="new-issue"]')).includes("Bug report") && (await textOf(page, '[data-form="new-issue"]')).includes("Feature request"), "New Issue offers the repository's templates");
  await clickText(page, "Bug report", '[data-form="new-issue"] .gh-template-name');
  await waitFor(page, () => document.querySelector('[data-form="new-issue"] input[name="title"]')?.value === "[Bug] ", [], 3000, "template title");
  check((await textOf(page, '[data-form="new-issue"] .gh-page-side')).includes("bug"), "the template's labels are chosen");
  await page.type('[data-form="new-issue"] input[name="title"]', "Sign in button does nothing");
  newCalls();
  await clickText(page, "Create issue", '[data-form="new-issue"] .gh-button');
  const issueCall = await waitForCall(["issue", "create"]);
  check(
    !!issueCall && issueCall.args.join(" ") === "issue create --title [Bug] Sign in button does nothing --body-file - --label bug" && issueCall.stdin.includes("**Steps to reproduce**"),
    `gh issue create with the template (${issueCall?.args.join(" ")})`,
  );

  const unexpected = ghCalls().filter((call) => call.args.join(" ").includes("unexpected"));
  check(unexpected.length === 0, "the fake gh understood every call");
  check(![...unknownCommands].includes("github_call"), "the bridge serves github_call");
  const own = ownErrors(errors);
  check(own.length === 0, `no page errors (${own.slice(0, 3).join(" | ")}${failed.length ? ` — ${failed.join(", ")}` : ""})`);
} catch (error) {
  console.log(`  FAIL ${error.message}`);
  failures.push(error.message);
  await shot(page, "error").catch(() => {});
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${shots}`);
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("all passed");
fs.rmSync(temp, { recursive: true, force: true });
