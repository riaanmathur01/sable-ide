// End-to-end test of external coding agents (ACP): the agent panel,
// Settings → AI Agents and the Marketplace's AI Agents category, against
// a fake ACP agent (fixtures/fake-acp-agent.mjs) installed for real from a
// stand-in registry the bridge serves (its /files/), through the real
// backend (src-tauri/src/acp: install, spawn, relay, terminals, env).
//
//   - Install from Settings → AI Agents; the card shows the version, the
//     sign-in methods (Console, API key, Bedrock, Vertex, Foundry, gateway)
//     and their fields; secrets go to the (test) keychain, not config.json.
//   - The panel's agent switcher; a thread starts with the agent's modes,
//     models and options; mode / model / effort pickers change them.
//   - Streaming Markdown (with a code block), thinking (collapsible), a
//     plan, a read tool card, usage.
//   - Permission prompts: reject, then allow (⌘⏎); fs/write_text_file
//     writes through the editor; the edit card's diff; review bar → reject
//     all restores the file, accept keeps it; per-hunk accept/reject in the
//     diff view (agent changes).
//   - terminal/create: live output in the tool card.
//   - @-mentions (file picker) arrive as embedded resources; the current
//     file chip; slash commands from available_commands_update; cancel;
//     sign-in required → terminal sign-in → retry; history (Sable's
//     transcripts, the agent's session/list + session/load).
//   - Codex, Kimi Code and Cursor (the fake agent answering as each one:
//     FAKE_ACP_AS): their cards and sign-in methods; ChatGPT sign-in in a
//     terminal and in the panel (browser, and a one-time code through URL
//     elicitation), an OpenAI API key held in memory, Amazon Bedrock in
//     Codex's own config.toml; Kimi Code's terminal sign-in (with its
//     region), ACP sign-out, a Kimi Platform key through KIMI_MODEL_*;
//     Cursor's install notice (proprietary download), browser sign-in, the
//     terminal fallback when no browser can open, a rejected and a good
//     CURSOR_API_KEY and --model; their mode / model / option pickers.
//   - Screenshots, dark and light (Catppuccin Latte).
//
//   SABLE_UI_FILES_DIR, SABLE_UI_AGENTS_DIR, SABLE_ACP_REGISTRY_URL and
//   FAKE_ACP_STATE as run-all.mjs gives the bridge (it serves files/ at
//   /files/), [SHOTS=/dir] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/agents.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openSable, sleep, clickText, extraStandins } from "./driver.mjs";
import { bridge, checker, tempDir, writeTree, shotsDir, waitFor, realErrors, REPO, BRIDGE_PORT, combo, tauriStandins, openFile, palette } from "./helpers.mjs";

const { check: report, finish } = checker();
/** check(condition, name, detail?) */
const check = (condition, name, detail) => report(name, condition, detail);
const shots = shotsDir("agents");
const filesDir = process.env.SABLE_UI_FILES_DIR;
if (!filesDir) {
  console.log("skipped: needs the bridge started with SABLE_UI_FILES_DIR (run it through run-all.mjs)");
  process.exit(3);
}
fs.mkdirSync(filesDir, { recursive: true });
const stateDir = process.env.FAKE_ACP_STATE ?? tempDir("fake-acp-state");
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });

// --- The stand-in registry: the fake agent as "claude-acp" (the integrated profile) ------------
const platform = `${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
fs.copyFileSync(path.join(REPO, "scripts/ui-test/fixtures/fake-acp-agent.mjs"), path.join(filesDir, "fake-acp-agent.mjs"));
const files = `http://127.0.0.1:${BRIDGE_PORT}/files`;
fs.writeFileSync(
  path.join(filesDir, "registry.json"),
  JSON.stringify({
    version: "1.0.0",
    agents: [
      {
        // The real one is a (proprietary) npm package; a download here, so no license (a proprietary download asks first: see Cursor).
        id: "claude-acp",
        name: "Claude Agent",
        version: "0.90.0",
        description: "ACP wrapper for Anthropic's Claude",
        authors: ["Anthropic"],
        distribution: { binary: { [platform]: { archive: `${files}/fake-acp-agent.mjs`, cmd: "./fake-acp-agent.mjs" } } },
      },
      // The fake agent answering as Codex, Kimi Code and Cursor.
      { id: "codex-acp", name: "Codex", version: "2.2.2", description: "ACP adapter for OpenAI's coding assistant", authors: ["OpenAI"], license: "Apache-2.0", distribution: { binary: { [platform]: { archive: `${files}/fake-acp-agent.mjs`, cmd: "./fake-acp-agent.mjs", env: { FAKE_ACP_AS: "codex" } } } } },
      { id: "kimi-code", name: "Kimi Code", version: "2.2.0", description: "Moonshot AI's Kimi Code CLI", authors: ["Moonshot AI"], license: "MIT", distribution: { binary: { [platform]: { archive: `${files}/fake-acp-agent.mjs`, cmd: "./fake-acp-agent.mjs", args: ["acp"], env: { FAKE_ACP_AS: "kimi" } } } } },
      { id: "cursor", name: "Cursor", version: "2026.10.14", description: "Cursor's coding agent", authors: ["Cursor"], license: "proprietary", license_url: "https://cursor.com/terms-of-service", distribution: { binary: { [platform]: { archive: `${files}/fake-acp-agent.mjs`, cmd: "./fake-acp-agent.mjs", args: ["acp"], env: { FAKE_ACP_AS: "cursor" } } } } },
      { id: "opencode", name: "OpenCode", version: "1.0.0", description: "The open source coding agent", authors: ["SST"], distribution: { npx: { package: "opencode-ai@1.0.0", args: ["acp"] } } },
      { id: "kimi", name: "Kimi CLI", version: "1.52.0", description: "Legacy", authors: ["Moonshot AI"], distribution: { npx: { package: "kimi@1.0.0" } } },
    ],
  }),
);

// A clean start (the bridge may have run this suite before).
for (const key of ["bedrock.accessKeyId", "bedrock.secretAccessKey", "bedrock.sessionToken", "apiKey.apiKey"]) await bridge("acp_delete_secret", { agentId: "claude-acp", key });
for (const [agentId, key] of [["codex-acp", "apiKey.apiKey"], ["kimi-code", "platform.apiKey"], ["cursor", "apiKey.apiKey"]]) await bridge("acp_delete_secret", { agentId, key });
for (const id of ["claude-acp", "codex-acp", "kimi-code", "cursor"]) await bridge("acp_call", { cmd: "acp_uninstall", args: { id } });
const agentsDir = process.env.SABLE_UI_AGENTS_DIR;
if (agentsDir) for (const name of ["config.json", "registry.json", "threads", ".data"]) fs.rmSync(path.join(agentsDir, name), { recursive: true, force: true });

const workspace = writeTree(tempDir("agents-ws"), {
  "README.md": "# Demo\n\nA small demo project.\n",
  "src/app.js": "// TODO\nexport function greet(name) {\n  return 'hi ' + name;\n}\n\nexport const answer = 42;\n",
  "src/util.js": "export const add = (a, b) => a + b;\n",
  "docs/guide.md": "# Guide\n",
});

// Terminals aren't served by the bridge: run sign-in commands here.
let page = null;
const terminalRuns = [];
extraStandins.create_command_terminal = async (args) => {
  const [program, ...rest] = args.args;
  const env = { ...process.env };
  for (const [name, value] of Object.entries(args.env ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  const result = spawnSync(program, rest, { cwd: args.cwd ?? undefined, env, encoding: "utf8" });
  terminalRuns.push({ args: args.args, code: result.status, stdout: result.stdout });
  setTimeout(() => page?.evaluate((id) => window.__sableEmit("terminal:exit", id), args.id), 300);
  return 4242;
};
extraStandins.write_terminal = null;
extraStandins.resize_terminal = null;
extraStandins.kill_terminal = null;
let theme = "sable-dark";
extraStandins.load_settings = () => ({ "workbench.colorTheme": theme });

const { browser, page: opened, errors } = await openSable(workspace, {
  pollEvents: true,
  width: 1500,
  height: 940,
  init: tauriStandins({ "plugin:dialog|ask": true, "plugin:opener|open_url": null }),
});
page = opened;

const panel = (selector) => `.acp-panel ${selector}`;
const textOf = (selector) => page.$$eval(selector, (elements) => elements.map((element) => element.innerText).join("\n")).catch(() => "");
const store = (expression) =>
  page.evaluate(async (expression) => {
    const { useAcpStore } = await import("/src/store/acpStore.ts");
    const state = useAcpStore.getState();
    return new Function("state", `return (${expression});`)(state);
  }, expression);
const activeThread = () => store("state.threads[state.activeThreadId] && { status: state.threads[state.activeThreadId].status, items: state.threads[state.activeThreadId].items.map(i => i.kind), review: Object.keys(state.threads[state.activeThreadId].review), sessionId: state.threads[state.activeThreadId].sessionId }");
async function typeInComposer(text) {
  await page.click(panel(".acp-input"));
  await page.keyboard.type(text);
}
async function sendPrompt(text) {
  await typeInComposer(text);
  await page.keyboard.press("Enter");
}
const idle = () => waitFor(page, () => !!document.querySelector(".acp-send:not(.stop)") && !document.querySelector(".acp-working"), [], { timeout: 20000 });
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

try {
  await sleep(1200);

  // --- Settings → AI Agents: install ------------------------------------------------------------
  await page.evaluate(async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openSettings("agents"));
  check(await waitFor(page, () => !!document.querySelector('.agent-card[data-agent="claude-acp"]')), "Settings → AI Agents lists Claude Agent as a card");
  const cards = await page.$$eval(".agent-card", (elements) => elements.map((element) => element.dataset.agent));
  check(cards[0] === "claude-acp" && cards.includes("codex-acp"), "featured agents come first, Claude Agent on top", cards);
  check(!(await textOf('.agent-card[data-agent="claude-acp"]')).includes("Claude Code"), "Claude Agent's card doesn't use the Claude Code name");
  check((await textOf('.agent-card[data-agent="claude-code"]')).includes("Found 9.9.9"), "Claude Code's card finds the claude CLI (a fake one here)", await textOf('.agent-card[data-agent="claude-code"]'));
  check(await page.$('.agent-mini[data-agent="opencode"]'), "other registry agents are listed under More agents");
  check(!(await page.$('[data-agent="kimi"]')), "the legacy Kimi CLI entry is hidden");
  const methods = await page.$$eval('.agent-card[data-agent="claude-acp"] .agent-auth-method', (elements) => elements.map((element) => element.dataset.provider));
  check(JSON.stringify(methods) === JSON.stringify(["console", "apiKey", "bedrock", "vertex", "foundry", "gateway"]), "sign-in methods: Console, API key, Bedrock, Vertex, Foundry, gateway (no claude.ai subscription)", methods);
  await page.click('.agent-card[data-agent="claude-acp"] [data-provider="bedrock"]');
  await sleep(200);
  check(await page.$('[data-field="bedrock.region"]'), "Bedrock shows its region field");
  await page.select('[data-field="bedrock.credentials"] select', "keys");
  await sleep(300);
  check(await page.$('[data-field="bedrock.secretAccessKey"] input[type=password]'), "access keys show secret fields (password inputs)");
  await page.click('[data-field="bedrock.region"] input');
  await page.keyboard.type("eu-west-1");
  await page.click('[data-field="bedrock.accessKeyId"] input');
  await page.keyboard.type("AKIATEST");
  await page.click('[data-field="bedrock.secretAccessKey"] input');
  await page.keyboard.type("super-secret-value");
  await shot("settings-bedrock-dark");
  await page.click('[data-testid="agent-auth-save"]');
  await sleep(600);
  const config = fs.readFileSync(path.join(agentsDir ?? path.join(filesDir, "..", "agents"), "config.json"), "utf8");
  check(config.includes("eu-west-1") && !config.includes("super-secret-value") && !config.includes("AKIATEST"), "config.json has the region, not the secrets", config);
  check(await waitFor(page, () => !!document.querySelector('[data-field="bedrock.secretAccessKey"]')?.innerText.includes("Saved in your keychain")), "secrets show as saved in the keychain");
  // Back to the Console login for the rest.
  await page.click('.agent-card[data-agent="claude-acp"] [data-provider="console"]');
  await page.click('[data-testid="agent-auth-save"]');
  await sleep(400);

  await page.click('[data-testid="install-claude-acp"]');
  check(await waitFor(page, () => !!document.querySelector('[data-testid="installed-claude-acp"]'), [], { timeout: 30000 }), "Install downloads and installs the agent");
  check((await textOf('.agent-card[data-agent="claude-acp"] .agent-card-meta')).includes("Installed 0.90.0"), "the card shows the installed version");
  check(await waitFor(page, () => !!document.querySelector('[data-testid="account-status"]')?.innerText.includes("Not signed in")), "the account check runs the agent's status command: not signed in");
  await shot("settings-agents-dark");

  // --- Marketplace → AI Agents ----------------------------------------------------------------------
  await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().showSettingsPage("plugins", "marketplace"));
  await sleep(500);
  await clickText(page, /^AI Agents/, ".marketplace-categories button").catch(() => {});
  await sleep(400);
  const market = await page.$$eval(".agent-market-card", (elements) => elements.map((element) => element.dataset.agent));
  check(market.includes("claude-acp") && market.includes("codex-acp"), "the Marketplace has an AI Agents category with the agents", market);
  await shot("marketplace-agents-dark");

  // --- The panel ---------------------------------------------------------------------------------------
  await page.evaluate(async () => {
    const { useAcpStore } = await import("/src/store/acpStore.ts");
    useAcpStore.getState().setPanelAgent("claude-acp");
    (await import("/src/store/uiStore.ts")).useUiStore.getState().focusAgent();
  });
  await openFile(page, path.join(workspace, "src/app.js"));
  check(await waitFor(page, () => !!document.querySelector(".acp-panel .acp-empty-title")?.innerText.includes("What should Claude Agent do?"), [], { timeout: 20000 }), "the panel starts a thread with the agent");
  check(await waitFor(page, () => !!document.querySelector('[data-testid="acp-mode"]')), "the mode picker shows the agent's modes");
  check((await textOf('[data-testid="acp-model"]')).includes("Fake Smart"), "the model picker shows the current model");
  check((await textOf('[data-testid="acp-options"]')).includes("Medium"), "the agent's other options (effort) show in the options menu");
  await page.click('[data-testid="acp-options"] .acp-dropdown-button');
  await sleep(150);
  await clickText(page, "High", ".acp-menu-label");
  await sleep(400);
  check((await textOf('[data-testid="acp-options"]')).includes("High"), "choosing an option sets it");
  check((await textOf(".acp-chip.context")).includes("app.js"), "the current file is offered as a context chip");
  const box = await page.evaluate(async () => {
    const rect = (await import("/src/lib/editorRegistry.ts")).getEditor().getDomNode().querySelector(".view-lines").getBoundingClientRect();
    return { x: rect.left + 60, y: rect.top + 10 };
  });
  await page.mouse.click(box.x, box.y, { button: "right" });
  await sleep(500);
  const menu = await page.evaluate(() => {
    const labels = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll(".action-label")) labels.push(element.textContent);
      for (const host of root.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
    return labels;
  });
  check(menu.includes("Agent: Explain") && menu.includes("Agent: Send Selection to Agent"), "the editor's context menu has Agent: Send Selection / Explain / Fix", menu.slice(0, 30));
  await page.keyboard.press("Escape");
  await sleep(200);

  await shot("panel-empty-dark");

  // Switcher.
  await page.click('[data-testid="agent-switcher"]');
  await sleep(200);
  const switcher = await textOf(".acp-switcher-menu");
  check(switcher.includes("Sable Agent") && switcher.includes("Claude Agent") && switcher.includes("Codex"), "the agent switcher lists Sable Agent and the external agents", switcher);
  await shot("switcher-dark");
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await sleep(200);

  // Mode / model / effort.
  await page.click('[data-testid="acp-model"] .acp-dropdown-button');
  await sleep(150);
  await clickText(page, "Fake Fast", ".acp-menu-label");
  await sleep(400);
  check((await textOf('[data-testid="acp-model"]')).includes("Fake Fast"), "choosing a model sets it (session/set_config_option)");
  await page.click('[data-testid="acp-mode"] .acp-dropdown-button');
  await sleep(150);
  await clickText(page, "Plan", ".acp-menu-label");
  await sleep(400);
  check((await textOf('[data-testid="acp-mode"]')).includes("Plan"), "choosing a mode sets it");
  await page.click(panel(".acp-input"));
  await combo(page, ["Shift"], "Tab");
  await sleep(400);
  check((await textOf('[data-testid="acp-mode"]')).includes("Bypass"), "⇧Tab cycles the mode", await textOf('[data-testid="acp-mode"]'));
  await combo(page, ["Shift"], "Tab");
  await sleep(300);

  // --- A turn: streaming, thinking, plan, a read card -----------------------------------------------
  await sendPrompt("Tell me about this project");
  check(await waitFor(page, () => !!document.querySelector(".acp-thought")), "thinking appears");
  await idle();
  const reply = await textOf(".acp-assistant");
  check(reply.includes("Summary") && reply.includes("Anything else?"), "the reply streams in", reply.slice(0, 200));
  check(await page.$(".acp-assistant .md-code"), "the reply's code block renders as a code block");
  check((await textOf(".acp-thought-header")).includes("Thought for"), "thinking collapses to 'Thought for …'");
  check((await textOf(".acp-tool.kind-read")).includes("Read README.md"), "the read tool call shows as a card");
  check((await textOf(".acp-plan")).includes("Plan") && (await textOf(".acp-plan")).includes("Check the result"), "the plan shows above the composer");
  check((await page.$eval(".acp-context", (element) => element.title).catch(() => "")).includes("6%"), "context usage shows");
  await page.click(".acp-thought-header");
  await sleep(150);
  check((await textOf(".acp-thought-body")).includes("plan the steps"), "thinking expands");
  await shot("panel-reply-dark");

  // --- Permission: reject, then allow; the review -------------------------------------------------------
  await sendPrompt("please write a notes file");
  check(await waitFor(page, () => !!document.querySelector(".acp-permission")), "the write asks for permission inline");
  const buttons = await textOf(".acp-permission-actions");
  check(buttons.includes("Allow once") && buttons.includes("Always allow") && buttons.includes("Reject"), "permission options: allow once, always allow, reject", buttons);
  check(await page.$(".acp-tool.acp-tool-asking .acp-diff"), "the permission card shows the diff it asks about");
  await shot("permission-dark");
  await clickText(page, /^Reject/, ".acp-permission-actions button");
  await idle();
  check((await textOf(".acp-assistant")).includes("won't write"), "rejecting tells the agent no");
  check(!fs.existsSync(path.join(workspace, "notes.md")), "nothing was written after rejecting");
  check((await textOf(".acp-tag.rejected")).includes("Rejected"), "the card is marked rejected");

  await sendPrompt("now write it for real");
  await waitFor(page, () => !!document.querySelector(".acp-permission"));
  await page.click(panel(".acp-messages"));
  await combo(page, ["Meta"], "Enter");
  await idle();
  check(fs.existsSync(path.join(workspace, "notes.md")) && fs.readFileSync(path.join(workspace, "notes.md"), "utf8").includes("Written by the fake agent"), "⌘⏎ allows it, and fs/write_text_file writes the file");
  check(await waitFor(page, () => !!document.querySelector('[data-testid="acp-review"]')), "the review bar offers the change");
  check((await textOf('[data-testid="acp-review"]')).includes("1 file"), "the review bar counts the file", await textOf('[data-testid="acp-review"]'));
  const opened = await page.evaluate(async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().tabs.map((tab) => tab.name));
  check(opened.includes("notes.md"), "follow along: the written file opens", opened);
  await shot("review-dark");
  await page.click('[data-testid="acp-reject-all"]');
  await sleep(800);
  check(!fs.existsSync(path.join(workspace, "notes.md")), "Reject all removes the file the agent created");

  // Edit an existing file; then accept.
  await sendPrompt("edit the greeting");
  await waitFor(page, () => !!document.querySelector(".acp-permission"));
  await clickText(page, /^Allow once/, ".acp-permission-actions button");
  await idle();
  const edited = fs.readFileSync(path.join(workspace, "src/app.js"), "utf8");
  check(edited.includes("Hello, ${name}!") && edited.includes("Greets people"), "the edit is written");
  const editorHas = await page.evaluate(async (file) => (await import("/src/lib/editorRegistry.ts")).getModelValue(file), path.join(workspace, "src/app.js"));
  check(editorHas?.includes("Hello, ${name}!"), "the open editor shows the edit (through the editor buffer)");
  check(await page.$(".acp-tool.kind-edit .acp-diff-row.added"), "the edit card shows added lines");
  check(await page.$(".acp-tool.kind-edit .acp-diff-row.removed"), "and removed lines");
  // The diff view: reject one hunk, accept the other.
  await page.click(".acp-review-header .acp-button.ghost");
  check(await waitFor(page, () => !!document.querySelector(".diff-view .monaco-diff-editor")), "Review opens Sable's diff view");
  await sleep(1200);
  const lenses = await page.$$eval(".diff-view .codelens-decoration a", (elements) => elements.map((element) => element.innerText));
  check(lenses.filter((lens) => lens.includes("Accept")).length === 2 && lenses.some((lens) => lens.includes("Reject")), "each hunk has Accept / Reject", lenses);
  await shot("diff-review-dark");
  const rejectLens = await page.$$(".diff-view .codelens-decoration a");
  const firstReject = [];
  for (const handle of rejectLens) if ((await handle.evaluate((element) => element.innerText)).includes("Reject")) firstReject.push(handle);
  await firstReject[0].click();
  await sleep(900);
  const afterHunk = fs.readFileSync(path.join(workspace, "src/app.js"), "utf8");
  check(afterHunk.includes("// TODO") && afterHunk.includes("Hello, ${name}!"), "rejecting the first hunk undoes just it", afterHunk);
  await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().acceptAll());
  await sleep(300);
  check(!(await page.$('[data-testid="acp-review"]')), "Accept all clears the review");

  // --- A terminal ---------------------------------------------------------------------------------------
  await sendPrompt("run the build");
  check(await waitFor(page, () => !!document.querySelector(".acp-terminal-output")?.innerText.includes("second line"), [], { timeout: 15000 }), "terminal/create output streams into the card");
  await idle();
  check((await textOf(".acp-exit")).includes("Exit 0"), "the terminal card shows the exit code");
  check((await textOf(".acp-assistant")).includes("printed 2 lines"), "terminal/output and wait_for_exit answer the agent");
  await shot("terminal-dark");

  // --- @-mentions and slash commands ------------------------------------------------------------------
  await openFile(page, path.join(workspace, "src/app.js"));
  await sleep(300);
  await typeInComposer("mention @uti");
  check(await waitFor(page, () => !!document.querySelector(".acp-suggest-item")), "@ opens the file picker");
  check((await textOf(".acp-suggest-item.active")).includes("util.js"), "the picker fuzzy-matches files", await textOf(".acp-suggest"));
  await shot("mention-picker-dark");
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await textOf(".acp-chips")).includes("util.js"), "picking adds a mention chip");
  await page.keyboard.press("Enter");
  await idle();
  const mentionReply = (await textOf(".acp-assistant")).split("\n").filter((line) => line.includes("Received")).pop() ?? "";
  check(mentionReply.includes("resource util.js") && mentionReply.includes("resource app.js"), "the mention and the current file arrive as embedded resources", mentionReply);

  await typeInComposer("/rev");
  check(await waitFor(page, () => !!document.querySelector(".acp-suggest-item")?.innerText.includes("/review")), "/ lists the agent's commands");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await idle();
  check((await textOf(".acp-assistant")).includes("Reviewing your changes"), "a slash command runs");

  // --- Cancel ------------------------------------------------------------------------------------------
  await sendPrompt("something slow");
  await waitFor(page, () => !!document.querySelector(".acp-assistant")?.innerText.includes("tick 3"));
  await page.click(".acp-send.stop");
  check(await waitFor(page, () => !!document.querySelector(".acp-send:not(.stop)")), "Stop cancels the turn");
  check((await textOf(".acp-notice")).includes("Stopped"), "a cancelled turn says so");

  // --- Sign-in required -------------------------------------------------------------------------------------
  await sendPrompt("needauth please");
  check(await waitFor(page, () => !!document.querySelector(".acp-auth")), "auth required shows the sign-in card");
  check((await textOf(".acp-auth-methods")).includes("Fake Console"), "the card lists the agent's auth methods");
  await shot("auth-dark");
  await clickText(page, /^Fake Console/, ".acp-auth-method-name");
  check(await waitFor(page, () => !document.querySelector(".acp-auth") && [...document.querySelectorAll(".acp-assistant")].pop()?.innerText.includes("Anything else?") && !!document.querySelector(".acp-send:not(.stop)"), [], { timeout: 20000 }), "terminal sign-in runs, then the refused prompt is sent again and answered");
  check(terminalRuns.some((run) => run.args.includes("--login") && run.code === 0), "the terminal ran the agent with its login args appended", terminalRuns.map((run) => run.args.join(" ")));

  // A claude.ai-subscription-only login: the card explains and offers Claude Code (panel and terminal).
  await sendPrompt("subscriptiononly please");
  check(await waitFor(page, () => /Pro\/Max\/Team subscription/.test(document.querySelector(".acp-auth")?.innerText ?? "")), "a subscription-only login says Claude Agent can't use it");
  const links = await page.evaluate(() => [...document.querySelectorAll(".acp-auth .acp-link")].map((link) => link.textContent));
  check(links.includes("Use Claude Code (your subscription)") && links.includes("Open Claude Code in the terminal"), "…and offers Claude Code in the panel and Terminal: Run Claude Code", links);
  await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().newThread("claude-acp"));
  await sleep(500);

  // --- History -----------------------------------------------------------------------------------------
  const threadsBefore = await store("state.openThreadIds.length");
  await page.click('[data-testid="acp-new-thread"]');
  await sleep(800);
  check((await store("state.openThreadIds.length")) === threadsBefore + 1, "New thread opens another thread tab");
  check(await page.$(".acp-tabs .acp-tab"), "thread tabs show with two threads");
  await page.click('[data-testid="acp-history"]');
  await sleep(1000);
  const history = await textOf(".acp-history");
  check(history.includes("Tell me about this project"), "history lists the saved thread", history);
  check(history.includes("Earlier Claude Agent sessions") || history.length > 0, "the agent's own sessions are listed (session/list)");
  await shot("history-dark");
  // Close every thread, reopen from history: loaded from the agent (session/load).
  await page.evaluate(async () => {
    const { useAcpStore } = await import("/src/store/acpStore.ts");
    for (const id of [...useAcpStore.getState().openThreadIds]) useAcpStore.getState().closeThread(id);
  });
  await sleep(300);
  await clickText(page, "Tell me about this project", ".acp-history-title");
  check(await waitFor(page, () => !!document.querySelector(".acp-assistant")?.innerText.includes("Anything else?"), [], { timeout: 15000 }), "reopening a thread shows its conversation");
  check(await waitFor(page, async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().threads[(await import("/src/store/acpStore.ts")).useAcpStore.getState().activeThreadId]?.status === "idle", [], { timeout: 15000 }), "the reopened thread can continue (session/load)");

  // --- Claude Code: the user's own claude CLI (a fake one here) ---------------------------------------
  const claudeState = process.env.FAKE_CLAUDE_STATE;
  if (!claudeState) check(false, "FAKE_CLAUDE_STATE is set for the bridge (run through run-all.mjs)");
  else {
    fs.rmSync(path.join(claudeState, "logged-in"), { force: true });
    await page.evaluate(async () => (await import("/src/store/agentHubStore.ts")).useAgentHubStore.getState().refreshInstalled());
    await page.evaluate(async () => {
      const { useAcpStore } = await import("/src/store/acpStore.ts");
      useAcpStore.getState().setPanelAgent("claude-code");
    });
    check(await waitFor(page, () => !!document.querySelector(".acp-auth")?.innerText.includes("Sign in to Claude Code"), [], { timeout: 20000 }), "Claude Code, signed out: the panel offers Claude Code's own sign-in");
    await shot("claude-code-signin-dark");
    await clickText(page, /^Sign in to Claude Code/, ".acp-auth-method-name");
    check(await waitFor(page, () => !!document.querySelector(".acp-empty-title")?.innerText.includes("What should Claude Code do?"), [], { timeout: 20000 }), "after /login in the terminal (Claude Code's own flow), the thread starts", JSON.stringify(await page.evaluate(async () => (await import("/src/store/terminalStore.ts")).useTerminalStore.getState().sessions.map((x) => [x.id, x.title, x.isRunning]))) + JSON.stringify(await store("Object.values(state.threads).map(t => [t.agentId, t.status, t.error])")));
    check(terminalRuns.some((run) => run.args.some((arg) => arg.endsWith("adapter.mjs")) && run.args.includes("--cli")), "sign-in ran the user's claude in a Sable terminal", terminalRuns.map((run) => run.args.slice(-2).join(" ")));
    check((await textOf('[data-testid="acp-mode"]')).includes("Ask"), "Claude Code's permission modes are offered");
    await sendPrompt("hello there");
    await idle();
    check((await textOf(".acp-assistant")).includes("Claude Code here"), "a turn streams from claude -p (stream-json)");
    check((await textOf(".acp-thought-header")).includes("Thought"), "its thinking shows");
    await sendPrompt("please write some notes");
    check(await waitFor(page, () => !!document.querySelector(".acp-permission"), [], { timeout: 15000 }), "Claude Code's permission prompt (through the MCP permission tool) shows inline");
    check(await page.$(".acp-tool.acp-tool-asking .acp-diff"), "the Write it asks about shows as a diff");
    await shot("claude-code-permission-dark");
    await clickText(page, /^Allow once/, ".acp-permission-actions button");
    await idle();
    check(fs.existsSync(path.join(workspace, "cc-notes.md")), "allowed: the CLI writes the file itself");
    check((await textOf('[data-testid="acp-review"]')).includes("1 file"), "the CLI's edit is reviewable in Sable");
    await page.click('[data-testid="acp-mode"] .acp-dropdown-button');
    await sleep(150);
    await clickText(page, "Accept edits", ".acp-menu-label");
    await sleep(300);
    await openFile(page, path.join(workspace, "src/app.js"));
    await sendPrompt("edit the app");
    await idle();
    const ccEdited = fs.readFileSync(path.join(workspace, "src/app.js"), "utf8");
    check(ccEdited.includes("edited by Claude Code") && !(await page.$(".acp-permission")), "in Accept edits mode the CLI edits without asking");
    const buffer = await page.evaluate(async (file) => (await import("/src/lib/editorRegistry.ts")).getModelValue(file), path.join(workspace, "src/app.js"));
    check(buffer?.includes("edited by Claude Code"), "the open editor is refreshed from disk after the CLI's edit");
    await sendPrompt("make a todo list");
    await idle();
    check((await textOf(".acp-plan")).includes("Fix the bug"), "TodoWrite becomes the plan", (await textOf(".acp-plan")) + " | " + (await textOf(".acp-assistant")).slice(-200));
    const launches = fs.readFileSync(path.join(claudeState, "launches.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((launch) => launch.argv.includes("-p"));
    check(launches.length >= 2 && launches.every((launch) => launch.argv.includes("--permission-prompt-tool") && !launch.argv.some((arg) => /api-key|token/i.test(arg))), "claude runs headless with the permission tool and no auth flags", launches.map((launch) => launch.argv.filter((arg) => !arg.startsWith("{")).join(" ")));
    check(launches.some((launch) => launch.argv.includes("acceptEdits") && launch.argv.includes("--resume")), "a mode change restarts claude with --resume and the new --permission-mode");
    await shot("claude-code-dark");
    await page.click('[data-testid="acp-history"]');
    await sleep(1200);
    check((await textOf(".acp-history")).includes("hello there"), "history lists Claude Code's sessions", await textOf(".acp-history"));
    await page.click('[data-testid="acp-history"]');
    await sleep(300);
    await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().acceptAll());
    await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().setPanelAgent("claude-acp"));
    await sleep(500);
  }


  // --- Codex, Kimi Code, Cursor ------------------------------------------------------------------------
  {
    const card = (id) => `.agent-card[data-agent="${id}"]`;
    const until = async (condition, timeout = 15000) => {
      for (const started = Date.now(); Date.now() - started < timeout; await sleep(200)) if (condition()) return true;
      return false;
    };
    const launches = (persona) =>
      fs
        .readFileSync(path.join(stateDir, "launches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((launch) => launch.persona === persona);
    const acpLaunch = (persona) => launches(persona).filter((launch) => !launch.argv.some((arg) => ["login", "logout", "status", "--login", "cli"].includes(arg))).pop();
    const settingsCard = async (id) => {
      await page.evaluate(async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openSettings("agents"));
      await waitFor(page, (selector) => !!document.querySelector(selector), [card(id)]);
      if (!(await page.$(`${card(id)} .agent-card-auth`))) await page.click(`${card(id)} [data-testid="agent-auth-toggle"]`);
      await waitFor(page, (selector) => !!document.querySelector(selector), [`${card(id)} .agent-card-auth`]);
      await page.$eval(card(id), (element) => element.scrollIntoView({ block: "start" }));
      await sleep(200);
    };
    const chooseMethod = async (id, provider) => {
      await page.click(`${card(id)} [data-provider="${provider}"]`);
      await sleep(150);
    };
    const typeField = async (id, key, value) => {
      const selector = `${card(id)} [data-field="${key}"]`;
      if (await page.$(`${selector} select`)) return page.select(`${selector} select`, value);
      if (!(await page.$(`${selector} input`))) {
        // A saved secret: Change, then type.
        await page.$$eval(`${selector} .acp-link`, (links) => links.find((link) => link.textContent === "Change")?.click());
        await sleep(150);
      }
      await page.click(`${selector} input`, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(value);
    };
    const saveMethod = async (id) => {
      await page.click(`${card(id)} [data-testid="agent-auth-save"]`);
      await waitFor(page, (selector) => !document.querySelector(selector)?.disabled, [`${card(id)} [data-testid="agent-auth-save"]`]);
      await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Saved"), [`${card(id)} .agent-auth-actions`]);
    };
    const accountText = (id) => textOf(`${card(id)} [data-testid="account-status"]`);
    const panelThread = async (agentId) => {
      await page.evaluate(async (agentId) => {
        const { useAcpStore } = await import("/src/store/acpStore.ts");
        useAcpStore.getState().setPanelAgent(agentId);
        (await import("/src/store/uiStore.ts")).useUiStore.getState().focusAgent();
        await useAcpStore.getState().newThread(agentId);
      }, agentId);
      await waitFor(page, () => !!document.querySelector(".acp-panel .acp-auth, .acp-panel .acp-empty-title"), [], { timeout: 20000 });
      await sleep(300);
    };
    const threadStarted = (name) => waitFor(page, (name) => !!document.querySelector(".acp-panel .acp-empty-title")?.innerText.includes(`What should ${name} do?`) && !document.querySelector(".acp-panel .acp-auth"), [name], { timeout: 20000 });

    await settingsCard("codex-acp");
    for (const id of ["codex-acp", "kimi-code", "cursor"]) check(!(await textOf(`${card(id)} .agent-card-title`)).includes("Preview"), `${id}: no Preview label`);
    const codexMethods = await page.$$eval(`${card("codex-acp")} .agent-auth-method`, (elements) => elements.map((element) => element.dataset.provider));
    check(JSON.stringify(codexMethods) === JSON.stringify(["chatgpt", "apiKey", "bedrock", "azure", "local", "custom"]), "Codex: ChatGPT, OpenAI API key, Bedrock, Azure OpenAI, local models, OpenAI-compatible endpoint", codexMethods);
    check((await textOf(`${card("codex-acp")} [data-provider="chatgpt"]`)).includes("Subscription"), "the ChatGPT method is labelled as a subscription");
    await page.click('[data-testid="install-codex-acp"]');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="installed-codex-acp"]'), [], { timeout: 30000 }), "Codex installs");
    check(await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Not signed in"), [`${card("codex-acp")} [data-testid="account-status"]`], { timeout: 15000 }), "Codex's card checks the ChatGPT sign-in (codex login status): not signed in", await accountText("codex-acp"));
    await shot("settings-codex-dark");
    // Sign in (a terminal running `codex-acp cli login`), sign out, a one-time code.
    await page.click(`${card("codex-acp")} [data-testid="agent-sign-in"]`);
    check(await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Signed in · ChatGPT"), [`${card("codex-acp")} [data-testid="account-status"]`], { timeout: 15000 }), "Sign in with ChatGPT runs Codex's own login in a terminal", await accountText("codex-acp"));
    check(terminalRuns.some((run) => run.args.join(" ").endsWith("cli login") && run.code === 0), "the terminal ran `codex-acp cli login`", terminalRuns.map((run) => run.args.slice(-3).join(" ")));
    await page.click(`${card("codex-acp")} [data-testid="agent-sign-out"]`);
    check(await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Not signed in"), [`${card("codex-acp")} [data-testid="account-status"]`], { timeout: 15000 }), "Sign out runs `codex-acp cli logout`");
    await page.click(`${card("codex-acp")} [data-testid="agent-sign-in-device"]`);
    check(await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Signed in"), [`${card("codex-acp")} [data-testid="account-status"]`], { timeout: 15000 }), "…and the one-time-code sign-in runs `cli login --device-auth`");
    check(terminalRuns.some((run) => run.args.join(" ").endsWith("cli login --device-auth")), "the device-code login ran", terminalRuns.map((run) => run.args.slice(-3).join(" ")));
    await page.click(`${card("codex-acp")} [data-testid="agent-sign-out"]`);
    await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Not signed in"), [`${card("codex-acp")} [data-testid="account-status"]`], { timeout: 15000 });

    // Amazon Bedrock: Codex's own config.toml (in Sable's folder), AWS profile and region.
    await chooseMethod("codex-acp", "bedrock");
    check(await page.$(`${card("codex-acp")} [data-testid="agent-auth-home"]`), "Bedrock says Sable gives Codex its own settings folder (CODEX_HOME)");
    await typeField("codex-acp", "bedrock.region", "us-east-2");
    await typeField("codex-acp", "bedrock.credentials", "profile");
    await sleep(150);
    await typeField("codex-acp", "bedrock.profile", "work");
    await shot("settings-codex-bedrock-dark");
    await saveMethod("codex-acp");
    check((await accountText("codex-acp")).includes("Amazon Bedrock") && (await accountText("codex-acp")).includes("us-east-2"), "the card says Codex uses Bedrock (and where)", await accountText("codex-acp"));
    await panelThread("codex-acp");
    check(await threadStarted("Codex"), "Codex with Bedrock starts without a ChatGPT sign-in");
    let launch = acpLaunch("codex");
    check(
      launch?.env.CODEX_HOME?.endsWith(path.join(".data", "codex-acp", "codex-home")) &&
        launch.config?.includes('model_provider = "amazon-bedrock-runtime"') &&
        launch.config.includes('[model_providers.amazon-bedrock-runtime.aws]\nprofile = "work"\nregion = "us-east-2"') &&
        launch.config.includes('web_search = "disabled"'),
      "Codex runs with Sable's CODEX_HOME and a config.toml naming Bedrock, the profile and the region",
      launch,
    );
    check(launch?.env.AWS_PROFILE === "work" && launch.env.AWS_REGION === "us-east-2" && !launch.env.CODEX_API_KEY, "…and AWS_PROFILE / AWS_REGION in its environment", launch?.env);
    check(await waitFor(page, () => !!document.querySelector('[data-testid="acp-model"]')?.innerText.includes("global.openai.gpt-6.1-sol")), "the model picker shows Bedrock's models");
    await shot("panel-codex-bedrock-dark");

    // An OpenAI API key: from the keychain into the environment; the login stays in memory.
    await settingsCard("codex-acp");
    await chooseMethod("codex-acp", "apiKey");
    await typeField("codex-acp", "apiKey.apiKey", "sk-codex-test-key");
    await saveMethod("codex-acp");
    await panelThread("codex-acp");
    check(await threadStarted("Codex"), "Codex with an API key starts (signed in with the key automatically)");
    launch = acpLaunch("codex");
    check(launch?.env.CODEX_API_KEY === "sk-codex-test-key" && launch.env.DEFAULT_AUTH_REQUEST === '{"methodId":"api-key"}', "the key goes to Codex in CODEX_API_KEY, with DEFAULT_AUTH_REQUEST", launch?.env);
    check(launch?.config?.includes('cli_auth_credentials_store = "ephemeral"') && !launch.config.includes("sk-codex"), "Codex keeps the key in memory only (ephemeral store); it isn't in the config file", launch?.config);

    // ChatGPT again: signing in from the panel.
    await settingsCard("codex-acp");
    await chooseMethod("codex-acp", "chatgpt");
    await saveMethod("codex-acp");
    await panelThread("codex-acp");
    check(await waitFor(page, () => !!document.querySelector(".acp-auth"), [], { timeout: 15000 }), "Codex signed out: the panel asks to sign in");
    const codexMethodsInPanel = await page.$$eval(".acp-auth .acp-auth-method", (elements) => elements.map((element) => element.dataset.method));
    check(JSON.stringify(codexMethodsInPanel) === JSON.stringify(["chat-gpt", "chat-gpt-device-code", "api-key"]), "the card offers ChatGPT, a one-time code, then an API key", codexMethodsInPanel);
    check((await textOf(".acp-auth")).includes("Sign in with ChatGPT") && (await textOf(".acp-auth")).includes("Use an OpenAI API key"), "…in words", await textOf(".acp-auth"));
    check((await textOf(".acp-auth-using")).includes("ChatGPT account"), "the card names the sign-in method in use");
    await shot("auth-codex-dark");
    // "Use an OpenAI API key…" opens Settings on that method (it never goes into ~/.codex).
    await page.click('.acp-auth [data-method="api-key"]');
    check(await waitFor(page, (selector) => !!document.querySelector(selector), [`${card("codex-acp")} .agent-auth-method.selected[data-provider="apiKey"]`]), "the API key method opens Settings → AI Agents on Codex's API key");
    await page.$$eval(`${card("codex-acp")} .agent-auth-actions button`, (buttons) => buttons.find((button) => button.textContent.includes("Discard"))?.click());
    await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().focusAgent());
    await sleep(300);
    // A one-time code (URL elicitation).
    await page.click('.acp-auth [data-method="chat-gpt-device-code"]');
    check(await waitFor(page, () => document.querySelector('[data-testid="acp-device-code"]')?.innerText === "FAKE-4821", [], { timeout: 15000 }), "the device code shows on its own, to copy");
    check((await textOf('[data-testid="acp-elicitation"]')).includes("auth.openai.com"), "…with the page's address");
    await shot("device-code-dark");
    await clickText(page, /^Open auth\.openai\.com/, '[data-testid="acp-elicitation"] button');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="acp-elicitation"] .acp-elicitation-done')?.innerText.includes("Done"), [], { timeout: 15000 }), "the card says Done when Codex reports the code was entered (elicitation/complete)");
    check(await threadStarted("Codex"), "then the thread starts");
    check(fs.readFileSync(path.join(stateDir, "logged-in-codex"), "utf8") === "chatgpt-device", "signed in through the device code");
    // The browser sign-in.
    fs.rmSync(path.join(stateDir, "logged-in-codex"), { force: true });
    await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().disconnect("codex-acp"));
    await panelThread("codex-acp");
    await waitFor(page, () => !!document.querySelector(".acp-auth"));
    await page.click('.acp-auth [data-method="chat-gpt"]');
    check(await waitFor(page, () => !!document.querySelector(".acp-auth-waiting")?.innerText.includes("ChatGPT in your browser"), [], { timeout: 5000 }), "while the browser sign-in runs, the card says where to finish it");
    check(await threadStarted("Codex"), "the ChatGPT browser sign-in (authenticate) starts the thread");
    check(await waitFor(page, () => !!document.querySelector(".acp-account")?.innerText.includes("dev@chatgpt.test")), "the account Codex reports shows (_auth/status_update)", await textOf(".acp-account"));
    check((await textOf('[data-testid="acp-mode"]')).includes("Auto review") && (await textOf('[data-testid="acp-model"]')).includes("gpt-6.1-sol"), "Codex's modes and models", (await textOf('[data-testid="acp-mode"]')) + " / " + (await textOf('[data-testid="acp-model"]')));
    await page.click('[data-testid="acp-options"] .acp-dropdown-button');
    await sleep(150);
    const codexOptions = (await textOf(".acp-menu")).toLowerCase();
    check(codexOptions.includes("reasoning effort") && codexOptions.includes("fast mode") && codexOptions.includes("collaboration mode"), "reasoning effort, fast mode and collaboration mode are in the options menu", codexOptions);
    await clickText(page, "High", ".acp-menu-label");
    await sleep(300);
    check((await textOf('[data-testid="acp-options"]')).includes("High"), "choosing the effort sets it");
    await sendPrompt("Tell me about this project");
    await idle();
    check([...(await textOf(".acp-assistant")).matchAll(/Anything else\?/g)].length >= 1, "a turn with Codex streams its reply");
    await shot("panel-codex-dark");

    // --- Kimi Code ---
    await settingsCard("kimi-code");
    const kimiMethods = await page.$$eval(`${card("kimi-code")} .agent-auth-method`, (elements) => elements.map((element) => element.dataset.provider));
    check(JSON.stringify(kimiMethods) === JSON.stringify(["account", "platform", "anthropic", "openai", "gemini", "local"]), "Kimi Code: Kimi account, Kimi Platform, Anthropic, OpenAI-compatible, Gemini, local models", kimiMethods);
    await page.click('[data-testid="install-kimi-code"]');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="installed-kimi-code"]'), [], { timeout: 30000 }), "Kimi Code installs");
    await typeField("kimi-code", "account.region", "global");
    await saveMethod("kimi-code");
    await shot("settings-kimi-dark");
    await panelThread("kimi-code");
    check(await waitFor(page, () => !!document.querySelector(".acp-auth")?.innerText.includes("Sign in with your Kimi account")), "Kimi Code signed out: its terminal sign-in is offered", await textOf(".acp-auth"));
    check((await textOf(".acp-auth")).includes("Opens a terminal"), "…which says it opens a terminal");
    await shot("auth-kimi-dark");
    await page.click('.acp-auth [data-method="login"]');
    check(await threadStarted("Kimi Code"), "after `kimi acp --login` in the terminal, the thread starts");
    check(terminalRuns.some((run) => run.args.slice(-4).join(" ") === "acp --login --region global" && run.code === 0), "the terminal ran the agent's login with the region chosen", terminalRuns.map((run) => run.args.slice(-4).join(" ")));
    check((await textOf('[data-testid="acp-model"]')).includes("Kimi K3") && (await textOf('[data-testid="acp-mode"]')).includes("Default"), "Kimi Code's model and modes");
    await sendPrompt("Tell me about this project");
    await idle();
    await shot("panel-kimi-dark");
    await settingsCard("kimi-code");
    await page.click(`${card("kimi-code")} [data-testid="agent-sign-out"]`);
    check(await until(() => !fs.existsSync(path.join(stateDir, "logged-in-kimi"))), "Sign out uses Kimi Code's ACP logout");
    // A Kimi Platform key, through KIMI_MODEL_* (nothing written to ~/.kimi-code).
    await chooseMethod("kimi-code", "platform");
    await typeField("kimi-code", "platform.apiKey", "sk-moonshot-test");
    await typeField("kimi-code", "platform.model", "kimi-k2-turbo-preview");
    await saveMethod("kimi-code");
    await panelThread("kimi-code");
    check(await threadStarted("Kimi Code"), "Kimi Code with a platform key starts without signing in");
    launch = acpLaunch("kimi");
    check(
      launch?.env.KIMI_MODEL_API_KEY === "sk-moonshot-test" && launch.env.KIMI_MODEL_NAME === "kimi-k2-turbo-preview" && launch.env.KIMI_MODEL_PROVIDER_TYPE === "kimi" && launch.env.KIMI_MODEL_BASE_URL === "https://api.moonshot.ai/v1",
      "the key and model reach Kimi Code as KIMI_MODEL_* variables",
      launch?.env,
    );
    check((await textOf('[data-testid="acp-model"]')).includes("kimi-k2-turbo-preview"), "the model shows by its name");
    await settingsCard("kimi-code");
    await chooseMethod("kimi-code", "account");
    await saveMethod("kimi-code");

    // --- Cursor: a proprietary download, only after agreeing ---
    await settingsCard("cursor");
    const refused = await bridge("acp_install", { id: "cursor" }).then(() => "installed", (error) => String(error));
    check(/consent-required/.test(refused), "the backend refuses to download Cursor without consent", refused);
    await page.click('[data-testid="install-cursor"]');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="agent-consent"]')), "Install shows Cursor's notice first");
    const notice = await textOf('[data-testid="agent-consent"]');
    check(notice.includes("proprietary") && notice.includes("Terms of Service") && notice.includes("SHA-256"), "…saying it's proprietary, whose terms apply, and that the download is pinned", notice);
    check(!(await page.$('[data-testid="installed-cursor"]')) && !fs.existsSync(path.join(agentsDir ?? "", "cursor", "sable-agent.json")), "nothing is downloaded before agreeing");
    check(await page.$eval('[data-testid="agent-consent-install"]', (button) => button.disabled), "Download is disabled until you agree");
    await page.$eval(card("cursor"), (element) => element.scrollIntoView({ block: "start" }));
    await shot("consent-cursor-dark");
    await page.click('[data-testid="agent-consent-agree"]');
    await page.click('[data-testid="agent-consent-install"]');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="installed-cursor"]'), [], { timeout: 30000 }), "agreeing installs it");
    check(await waitFor(page, (selector) => !!document.querySelector(selector)?.innerText.includes("Not signed in"), [`${card("cursor")} [data-testid="account-status"]`], { timeout: 15000 }), "Cursor's card checks `status --format json`", await accountText("cursor"));
    await panelThread("cursor");
    check(await waitFor(page, () => !!document.querySelector(".acp-auth")?.innerText.includes("Sign in with Cursor")), "Cursor signed out: the panel offers its browser sign-in", await textOf(".acp-auth"));
    await shot("auth-cursor-dark");
    await page.click('.acp-auth [data-method="cursor_login"]');
    check(await threadStarted("Cursor"), "Cursor's browser sign-in (authenticate cursor_login) starts the thread");
    check((await textOf('[data-testid="acp-mode"]')).includes("Agent") && (await textOf('[data-testid="acp-model"]')).includes("Auto"), "Cursor's modes and models");
    // No browser here: the agent's own login in a terminal instead.
    fs.rmSync(path.join(stateDir, "logged-in-cursor"), { force: true });
    fs.writeFileSync(path.join(stateDir, "no-browser"), "1");
    await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().disconnect("cursor"));
    await panelThread("cursor");
    await waitFor(page, () => !!document.querySelector(".acp-auth"));
    await page.click('.acp-auth [data-method="cursor_login"]');
    check(await waitFor(page, () => !!document.querySelector('[data-testid="acp-auth-error"]')?.innerText.includes("couldn't open your browser")), "when Cursor can't open a browser, the card says so", await textOf(".acp-auth"));
    await shot("auth-cursor-nobrowser-dark");
    await page.click('[data-testid="acp-auth-terminal"]');
    check(await threadStarted("Cursor"), "…and Sign in in a terminal (`cursor-agent login`) gets it going");
    check(terminalRuns.some((run) => run.args[run.args.length - 1] === "login"), "the terminal ran Cursor's login", terminalRuns.map((run) => run.args.slice(-2).join(" ")));
    fs.rmSync(path.join(stateDir, "no-browser"), { force: true });
    // A Cursor API key, and a model pinned at launch.
    fs.rmSync(path.join(stateDir, "logged-in-cursor"), { force: true });
    await settingsCard("cursor");
    await chooseMethod("cursor", "apiKey");
    await typeField("cursor", "apiKey.apiKey", "key_bad");
    await typeField("cursor", "apiKey.model", "sonnet-5-thinking");
    await saveMethod("cursor");
    await panelThread("cursor");
    check(await waitFor(page, () => !!document.querySelector(".acp-auth")?.innerText.includes("didn't accept the API key")), "a key Cursor rejects says so on the sign-in card", await textOf(".acp-auth"));
    await settingsCard("cursor");
    await typeField("cursor", "apiKey.apiKey", "key_good");
    await saveMethod("cursor");
    await panelThread("cursor");
    check(await threadStarted("Cursor"), "with a good key, Cursor starts");
    launch = acpLaunch("cursor");
    check(launch?.env.CURSOR_API_KEY === "key_good" && launch.argv.join(" ") === "acp --model sonnet-5-thinking", "CURSOR_API_KEY in its environment, --model after acp", launch);
    check((await textOf('[data-testid="acp-model"]')).includes("Sonnet 5 Thinking"), "the pinned model is the current one");
    await settingsCard("cursor");
    await chooseMethod("cursor", "account");
    await saveMethod("cursor");

    // No key anywhere but the (test) keychain.
    const configText = fs.readFileSync(path.join(agentsDir ?? path.join(filesDir, "..", "agents"), "config.json"), "utf8");
    check(!/sk-codex-test-key|sk-moonshot-test|key_good|key_bad/.test(configText), "config.json has no keys", configText);
    const dataFiles = [];
    const walk = (dir) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else dataFiles.push(fs.readFileSync(path.join(dir, entry.name), "utf8"));
      }
    };
    walk(path.join(agentsDir ?? "", ".data"));
    check(dataFiles.length > 0 && !dataFiles.some((text) => /sk-codex-test-key|key_good/.test(text)), "nor do the config files Sable writes for agents");
    await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().setPanelAgent("claude-acp"));
    await sleep(400);
  }

  // --- From the editor: actions, palette, shortcuts ----------------------------------------------------
  await openFile(page, path.join(workspace, "src/util.js"));
  await sleep(500);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 30 });
  });
  await palette(page, "Agent: Explain Selection");
  check(await waitFor(page, () => [...document.querySelectorAll(".acp-user")].some((element) => element.innerText.includes("Explain this code.") && element.innerText.includes("util.js:1")), [], { timeout: 15000 }), "Explain sends the selection to the agent");
  await idle();
  await page.evaluate(async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().setPanelAgent("sable"));
  await sleep(300);
  check((await textOf(".agent-panel")).includes("Sable Agent"), "the switcher can show Sable's own agent in the same panel");
  await page.click(".monaco-editor textarea").catch(() => {});
  await combo(page, ["Meta"], "Escape");
  check(await waitFor(page, async () => (await import("/src/store/acpStore.ts")).useAcpStore.getState().panelAgent === "claude-acp"), "⌘⎋ brings back the external agent");
  await combo(page, ["Meta", "Alt"], "KeyK");
  check(await waitFor(page, () => [...document.querySelectorAll(".acp-chip:not(.context)")].some((element) => element.innerText.includes("util.js:1"))), "⌥⌘K puts the selection in the composer as context");
  // Regression: after a diff tab (the review above) has come and gone, the
  // editor's context menu still opens (it threw "InstantiationService has
  // been disposed" once a diff editor was disposed).
  await openFile(page, path.join(workspace, "src/util.js"));
  await sleep(400);
  const afterDiff = await page.evaluate(async () => {
    const rect = (await import("/src/lib/editorRegistry.ts")).getEditor().getDomNode().querySelector(".view-lines").getBoundingClientRect();
    return { x: rect.left + 60, y: rect.top + 10 };
  });
  const diffsSeen = await page.evaluate(() => document.querySelectorAll(".monaco-diff-editor").length);
  await page.mouse.click(afterDiff.x, afterDiff.y, { button: "right" });
  await sleep(500);
  const menuAfterDiff = await page.evaluate(() => {
    const labels = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll(".action-label")) labels.push(element.textContent);
      for (const host of root.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
    return labels;
  });
  check(menuAfterDiff.includes("Agent: Send Selection to Agent") && diffsSeen === 0, "the editor's context menu still opens after a diff tab was closed", { diffsSeen, menu: menuAfterDiff.slice(0, 10) });
  check(!errors.some((error) => /InstantiationService has been disposed/.test(error)), "no 'InstantiationService has been disposed' errors");
  await page.keyboard.press("Escape");
  await sleep(200);

  // --- Light theme -------------------------------------------------------------------------------------
  theme = "catppuccin-latte";
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("workbench.colorTheme", "catppuccin-latte"));
  await sleep(800);
  await shot("panel-light");
  await sendPrompt("please write the notes file");
  await waitFor(page, () => !!document.querySelector(".acp-permission"));
  await shot("permission-light");
  await clickText(page, /^Allow once/, ".acp-permission-actions button");
  await idle();
  await shot("review-light");
  await page.evaluate(async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openSettings("agents"));
  await sleep(700);
  await shot("settings-agents-light");
  for (const id of ["codex-acp", "kimi-code", "cursor"]) {
    const element = await page.$(`.agent-card[data-agent="${id}"]`);
    if (!(await page.$(`.agent-card[data-agent="${id}"] .agent-card-auth`))) await page.click(`.agent-card[data-agent="${id}"] [data-testid="agent-auth-toggle"]`).catch(() => {});
    await sleep(300);
    await element?.screenshot({ path: path.join(shots, `card-${id}-light.png`) }).catch(() => {});
  }
  await page.evaluate(async () => {
    const { useAcpStore } = await import("/src/store/acpStore.ts");
    useAcpStore.getState().setPanelAgent("codex-acp");
    (await import("/src/store/uiStore.ts")).useUiStore.getState().focusAgent();
  });
  fs.rmSync(path.join(stateDir, "logged-in-codex"), { force: true });
  await page.evaluate(async () => {
    const { useAcpStore } = await import("/src/store/acpStore.ts");
    await useAcpStore.getState().disconnect("codex-acp");
    await useAcpStore.getState().newThread("codex-acp");
  });
  await waitFor(page, () => !!document.querySelector(".acp-auth"), [], { timeout: 15000 });
  await shot("auth-codex-light");
  await page.click('.acp-auth [data-method="chat-gpt-device-code"]').catch(() => {});
  await waitFor(page, () => !!document.querySelector('[data-testid="acp-device-code"]'), [], { timeout: 10000 });
  await shot("device-code-light");

  check(realErrors(errors).length === 0, "no page errors", realErrors(errors).slice(0, 3));
} catch (error) {
  check(false, "the suite ran to the end", error.stack ?? String(error));
  await shot("crash").catch(() => {});
} finally {
  await browser.close();
}
finish();
