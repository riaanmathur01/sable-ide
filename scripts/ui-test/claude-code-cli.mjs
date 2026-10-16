// End-to-end test of the Claude Code (Anthropic's CLI) IDE integration:
// Sable is the IDE the `claude` CLI connects to. A fake CLI
// (fixtures/fake-claude-ide-cli.mjs) does what the real one does on the IDE
// side of the protocol — it never talks to Anthropic:
//
//   - the window's IDE server starts with the folder: a lock file in
//     $CLAUDE_CONFIG_DIR/ide/<port>.lock (0600 in a 0700 folder) with the
//     pid, folders, "Sable", "ws" and a random token; a wrong or missing
//     token is refused (401);
//   - Terminal: Run Claude Code starts the CLI found (a stand-in path) in a
//     terminal tab titled "claude", in the workspace folder, with exactly
//     CLAUDE_CODE_SSE_PORT and ENABLE_IDE_INTEGRATION — nothing about
//     signing in;
//   - the fake CLI connects (the status bar says "Claude Code connected"),
//     initializes MCP, lists the tools, and calls getWorkspaceFolders,
//     getOpenEditors, getCurrentSelection, getLatestSelection,
//     getDiagnostics (TypeScript errors), openFile (with a text range),
//     checkDocumentDirty and saveDocument;
//   - it gets selection_changed as you select, and at_mentioned from ⌥⌘K;
//   - openDiff opens Sable's diff view with Accept / Reject: accepting (after
//     touching up the proposal) returns FILE_SAVED with the final text and
//     puts it in the open editor (undoable); rejecting returns
//     DIFF_REJECTED; closing the tab rejects; the CLI cancelling closes it;
//     closeAllDiffTabs closes them all; with diff review off, openDiff is
//     an error (the CLI then asks in its terminal);
//   - open files follow Claude Code's writes on disk; a second folder
//     updates the lock file; a remote window runs `claude` on the remote;
//     no CLI installed → Anthropic's install help (the install command runs
//     only after the click); stopping removes the lock file.
//
// Optionally (SABLE_TEST_REAL_CLAUDE=1), the real installed `claude` is
// started against the test's temp config to check that it discovers Sable
// and connects — no prompt is typed, nothing reaches the model.
//
//   CLAUDE_CONFIG_DIR=<temp> [SHOTS=/dir] [SABLE_TEST_REAL_CLAUDE=1] SABLE_UI_VITE_PORT=… SABLE_UI_BRIDGE_PORT=…
//   node scripts/ui-test/claude-code-cli.mjs
//
// with Vite and a bridge started with the SAME CLAUDE_CONFIG_DIR (run-all.mjs
// does this); never your real ~/.claude.
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { openSable, sleep, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, bridge, combo, openFile, palette, realErrors, waitFor } from "./helpers.mjs";
import { connectFakeCli, readLocks, tryToken } from "./fixtures/fake-claude-ide-cli.mjs";

const { check, finish } = checker();
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir || path.resolve(configDir) === path.join(os.homedir(), ".claude")) {
  console.log("Set CLAUDE_CONFIG_DIR to a temp folder (the bridge's too) — never your real ~/.claude");
  process.exit(2);
}
const shots = shotsDir("claude-code-cli");
const workspace = tempDir("claude-ws");
const second = tempDir("claude-ws2");
writeTree(workspace, {
  "src/app.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const answer = add(40, 2);\n",
  "src/broken.ts": 'export const count: number = "three";\n',
  "notes.md": "# Notes\n\nThe start marker is here.\nAnd the end marker there.\n",
});
const appPath = path.join(workspace, "src/app.ts");

// The terminal and the CLI's location are stand-ins: no real `claude` runs.
const terminalStarts = [];
extraStandins.create_command_terminal = (args) => {
  terminalStarts.push(args);
  return 4242;
};
extraStandins.kill_terminal = null;
// What's typed into terminals (locally, or on the remote through remote_call).
const typed = [];
extraStandins.create_terminal = null;
extraStandins.write_terminal = (args) => {
  typed.push({ remote: false, data: args.data });
  return null;
};
extraStandins.remote_call = (args) => {
  if (args.cmd === "write_terminal") typed.push({ remote: true, data: args.args.data });
  return null;
};
let cliFound = { path: "/opt/fake/bin/claude", version: "9.9.9 (stand-in)", shell: "/bin/zsh" };
extraStandins.claude_code_find_cli = () => cliFound;

const text = (result) => result?.content?.[0]?.text;
const parse = (result) => JSON.parse(text(result));
const store = (page, expression) =>
  page.evaluate(async (expression) => {
    const modules = {
      tabs: (await import("/src/store/tabsStore.ts")).useTabsStore.getState(),
      terminals: (await import("/src/store/terminalStore.ts")).useTerminalStore.getState(),
      claude: (await import("/src/lib/claudeCode/store.ts")).useClaudeCodeStore.getState(),
      editor: (await import("/src/lib/editorRegistry.ts")).getEditor(),
    };
    return new Function("m", `return (${expression})`)(modules);
  }, expression);

const { browser, page, errors } = await openSable(workspace, { width: 1440, height: 900, pollEvents: true });
let cli = null;
try {
  await sleep(1500);
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("files.autoSave", false));

  // --- The IDE server and its lock file ---------------------------------------------------
  const status = await waitFor(page, async () => {
    const port = (await import("/src/lib/claudeCode/store.ts")).useClaudeCodeStore.getState().port;
    return port ?? null;
  });
  check("the window's IDE server starts with the folder", Boolean(status), status);
  const serverStatus = await bridge("claude_code_status");
  const lock = readLocks(configDir).find((candidate) => candidate.port === serverStatus.port);
  check("it writes a lock file in $CLAUDE_CONFIG_DIR/ide", Boolean(lock) && serverStatus.lockFile === path.join(configDir, "ide", `${serverStatus.port}.lock`), JSON.stringify(serverStatus));
  check("…naming Sable, the folder and a WebSocket", lock?.ideName === "Sable" && lock?.transport === "ws" && JSON.stringify(lock?.workspaceFolders) === JSON.stringify([workspace]) && Number.isInteger(lock?.pid), JSON.stringify({ ...lock, authToken: "…" }));
  check("…with a random 128-bit token", /^[0-9a-f]{32}$/.test(lock?.authToken ?? ""));
  check("…readable by you only (0600 in a 0700 folder)", lock?.mode === 0o600 && (fs.statSync(path.join(configDir, "ide")).mode & 0o777) === 0o700, `${lock?.mode?.toString(8)}`);
  check("the port is in 10000–65535", serverStatus.port >= 10000 && serverStatus.port <= 65535, serverStatus.port);
  check("no token: refused", (await tryToken(lock.port)) === 401);
  check("a wrong token: refused", (await tryToken(lock.port, "0".repeat(32))) === 401);

  // --- Terminal: Run Claude Code --------------------------------------------------------
  const offered = await palette(page, "Run Claude Code", 1500);
  check("the palette offers Terminal: Run Claude Code", /Terminal: Run Claude Code/.test(offered ?? ""), offered);
  const started = terminalStarts[0];
  check("it starts the CLI in a terminal", Boolean(started), JSON.stringify(terminalStarts));
  check("…the CLI found, through your login shell", JSON.stringify(started?.args) === JSON.stringify(["/bin/zsh", "-l", "-c", 'exec "$0"', "/opt/fake/bin/claude"]), JSON.stringify(started?.args));
  check("…in the workspace folder", started?.cwd === workspace, started?.cwd);
  check(
    "…with only the IDE integration's environment (nothing about signing in)",
    JSON.stringify(started?.env) === JSON.stringify({ CLAUDE_CODE_SSE_PORT: String(lock.port), ENABLE_IDE_INTEGRATION: "true" }),
    JSON.stringify(started?.env),
  );
  const session = await store(page, "m.terminals.sessions.find((s) => s.reuseKey === 'claude-code')");
  check("…in a terminal tab titled “claude”", session?.title === "claude" && session?.fixedTitle === true, JSON.stringify(session));
  await page.evaluate(async (id) => (await import("/src/store/terminalStore.ts")).useTerminalStore.getState().setTitle(id, "✳ Something else"), session.id);
  check("…which keeps its name when the CLI sets a title", (await store(page, "m.terminals.sessions.find((s) => s.reuseKey === 'claude-code').title")) === "claude");
  await palette(page, "Run Claude Code", 800);
  check("running it again shows the same terminal", terminalStarts.length === 1, terminalStarts.length);

  // --- The (fake) CLI connects ---------------------------------------------------------------
  cli = await connectFakeCli({ configDir, port: started.env.CLAUDE_CODE_SSE_PORT });
  check("the CLI connects with the token (mcp subprotocol)", cli.protocol === "mcp" && cli.acceptOk);
  check("MCP initialize answers with Sable's server info", cli.initialized?.serverInfo?.name === "sable" && Boolean(cli.initialized?.capabilities?.tools), JSON.stringify(cli.initialized));
  const connected = await waitFor(page, () => document.querySelector(".claude-code-status")?.textContent ?? null);
  check("the status bar says Claude Code is connected", /Claude Code connected/.test(connected ?? ""), connected);
  const toolNames = (await cli.call("tools/list")).result.tools.map((tool) => tool.name);
  check(
    "tools/list offers the IDE tools",
    ["openFile", "openDiff", "getCurrentSelection", "getLatestSelection", "getOpenEditors", "getWorkspaceFolders", "getDiagnostics", "checkDocumentDirty", "saveDocument", "close_tab", "closeAllDiffTabs"].every((name) => toolNames.includes(name)),
    toolNames.join(","),
  );

  const folders = parse(await cli.tool("getWorkspaceFolders"));
  check("getWorkspaceFolders", folders.success && folders.rootPath === workspace && folders.folders[0]?.path === workspace && folders.folders[0]?.name === path.basename(workspace), JSON.stringify(folders));

  // Selection: selection_changed as you select; getCurrentSelection.
  await openFile(page, appPath);
  await sleep(1200);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 15 });
  });
  const selectionChanged = await cli.waitForNotification("selection_changed", (params) => params.filePath === appPath && !params.selection.isEmpty).catch((error) => error);
  check(
    "selection_changed reaches the CLI as you select",
    selectionChanged?.text === "export function add(a: number, b: number) {\n  return a + b" && selectionChanged.selection.start.line === 0 && selectionChanged.selection.end.line === 1 && selectionChanged.fileUrl === `file://${appPath}`,
    JSON.stringify(selectionChanged),
  );
  const current = parse(await cli.tool("getCurrentSelection"));
  check("getCurrentSelection", current.success && current.filePath === appPath && current.text.startsWith("export function add") && current.selection.end.character === 14, JSON.stringify(current));
  const latest = parse(await cli.tool("getLatestSelection"));
  check("getLatestSelection", latest.success && latest.filePath === appPath, JSON.stringify(latest));
  const editors = parse(await cli.tool("getOpenEditors"));
  check("getOpenEditors", editors.tabs?.length === 1 && editors.tabs[0].uri === `file://${appPath}` && editors.tabs[0].isActive && editors.tabs[0].label === "app.ts" && editors.tabs[0].languageId === "typescript", JSON.stringify(editors));

  // At-mention: ⌥⌘K in the editor.
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 });
  });
  await combo(page, ["Meta", "Alt"], "KeyK", 500);
  const mention = await cli.waitForNotification("at_mentioned").catch((error) => error);
  check("⌥⌘K sends at_mentioned (0-based lines; a selection ending at a line start leaves that line out)", mention?.filePath === appPath && mention.lineStart === 1 && mention.lineEnd === 2, JSON.stringify(mention));
  // ⌘⎋ belongs to the agent panel (Terminal: Run Claude Code has no default keys).
  await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.setState({ agentVisible: false }));
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().focus());
  await combo(page, ["Meta"], "Escape", 600);
  check(
    "⌘⎋ opens the agent panel, not another Claude Code",
    terminalStarts.length === 1 && (await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().agentVisible)) === true,
    `${terminalStarts.length} starts`,
  );
  // The editor's context menu offers it too.
  const box = await page.evaluate(() => {
    const lines = document.querySelector(".monaco-editor .view-lines").getBoundingClientRect();
    return { x: lines.left + 60, y: lines.top + 30 };
  });
  await page.mouse.click(box.x, box.y, { button: "right" });
  await sleep(600);
  const menuItems = await page.evaluate(() => {
    const roots = [document, ...[...document.querySelectorAll("*")].map((element) => element.shadowRoot).filter(Boolean)];
    return roots.flatMap((root) => [...root.querySelectorAll(".action-label")].map((label) => label.textContent.trim())).filter(Boolean);
  });
  check("the editor's context menu has Send Selection to Claude Code", menuItems.includes("Send Selection to Claude Code"), menuItems.join(" | "));
  await page.screenshot({ path: `${shots}/context-menu.png` });
  await page.keyboard.press("Escape");
  await sleep(200);

  // Diagnostics: TypeScript's error in broken.ts.
  const brokenPath = path.join(workspace, "src/broken.ts");
  await openFile(page, brokenPath);
  let brokenDiagnostics = null;
  for (let attempt = 0; attempt < 40 && !brokenDiagnostics; attempt++) {
    const all = parse(await cli.tool("getDiagnostics"));
    brokenDiagnostics = all.find((entry) => entry.uri === `file://${brokenPath}` && entry.diagnostics.some((diagnostic) => diagnostic.severity === "Error")) ?? null;
    if (!brokenDiagnostics) await sleep(500);
  }
  check("getDiagnostics reports the editor's errors", Boolean(brokenDiagnostics) && brokenDiagnostics.diagnostics[0].range.start.line === 0 && typeof brokenDiagnostics.diagnostics[0].message === "string", JSON.stringify(brokenDiagnostics));
  const oneFile = parse(await cli.tool("getDiagnostics", { uri: `file://${brokenPath}` }));
  check("…for one file by URI", oneFile.length === 1 && oneFile[0].uri === `file://${brokenPath}` && oneFile[0].diagnostics.length > 0, JSON.stringify(oneFile));
  const cleanFile = parse(await cli.tool("getDiagnostics", { uri: `file://${appPath}` }));
  check("…and none for a clean file", cleanFile.length === 1 && cleanFile[0].diagnostics.length === 0, JSON.stringify(cleanFile));

  // openFile, with a text range; in the background.
  const notesPath = path.join(workspace, "notes.md");
  const opened = text(await cli.tool("openFile", { filePath: notesPath, startText: "start marker", endText: "end marker", makeFrontmost: true }));
  await sleep(400);
  const notesSelection = await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    return editor.getModel().getValueInRange(editor.getSelection());
  });
  check("openFile opens and selects from startText to endText", opened === `Opened file: ${notesPath}` && notesSelection === "start marker is here.\nAnd the end marker", `${opened} / ${JSON.stringify(notesSelection)}`);
  const background = parse(await cli.tool("openFile", { filePath: appPath, makeFrontmost: false }));
  check("openFile without makeFrontmost describes the file", background.success && background.lineCount === 6 && background.languageId === "typescript" && (await store(page, "m.tabs.activePath")) === notesPath, JSON.stringify(background));

  // Dirty check and save.
  await openFile(page, appPath);
  await sleep(500);
  check("checkDocumentDirty: clean", parse(await cli.tool("checkDocumentDirty", { filePath: appPath })).isDirty === false);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.executeEdits("test", [{ range: { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 }, text: "// edited\n" }]);
  });
  check("checkDocumentDirty: unsaved changes", parse(await cli.tool("checkDocumentDirty", { filePath: appPath })).isDirty === true);
  const saved = parse(await cli.tool("saveDocument", { filePath: appPath }));
  check("saveDocument saves it", saved.success && saved.saved && fs.readFileSync(appPath, "utf8").endsWith("// edited\n"), JSON.stringify(saved));
  check("…files that aren't open: Document not open", parse(await cli.tool("checkDocumentDirty", { filePath: path.join(workspace, "nope.ts") })).success === false);

  // --- openDiff: Accept ------------------------------------------------------------------------
  const before = fs.readFileSync(appPath, "utf8");
  const proposed = before.replace("return a + b;", "// Adds two numbers.\n  return a + b;");
  const acceptCall = cli.tool("openDiff", { old_file_path: appPath, new_file_path: appPath, new_file_contents: proposed, tab_name: "✻ [Claude Code] app.ts (a1b2c3) ⧉" }, { timeout: 0 });
  const toolbar = await waitFor(page, () => document.querySelector(".claude-proposal-bar")?.innerText ?? null);
  check("openDiff opens Sable's diff view with Accept / Reject", /Proposed change from Claude Code/.test(toolbar ?? "") && /Accept/.test(toolbar) && /Reject/.test(toolbar), toolbar);
  const tabName = await store(page, "m.tabs.tabs.find((tab) => tab.diff?.kind === 'claude')?.name");
  check("…in a tab named after the file", tabName === "app.ts (Proposed)", tabName);
  await sleep(1200);
  // Touch up the proposal before accepting (the right side is editable).
  const touched = await page.evaluate(async () => {
    const { monaco } = await import("/src/lib/monacoSetup.ts");
    const model = monaco.editor.getModels().find((candidate) => candidate.uri.scheme === "sable-diff" && candidate.uri.path.endsWith("/modified"));
    model.pushEditOperations([], [{ range: model.getFullModelRange().collapseToEnd(), text: "// reviewed\n" }], () => null);
    return model.getValue();
  });
  await page.screenshot({ path: `${shots}/diff-review.png` });
  await page.click(".claude-proposal-button.accept");
  const accepted = await acceptCall;
  check("Accept returns FILE_SAVED with the final text", accepted.content[0].text === "FILE_SAVED" && accepted.content[1].text === touched && touched.endsWith("// reviewed\n"), JSON.stringify(accepted).slice(0, 200));
  const editorAfter = await page.evaluate(async (appPath) => (await import("/src/lib/editorRegistry.ts")).getModelValue(appPath), appPath);
  check("…and puts it in the open editor", editorAfter === touched);
  check("…the diff tab closes", !(await store(page, "m.tabs.tabs.some((tab) => tab.diff?.kind === 'claude')")));
  // The CLI writes the file; the editor is then clean.
  fs.writeFileSync(appPath, touched);
  const clean = await waitFor(page, async (appPath) => !(await import("/src/lib/editorRegistry.ts")).isModelDirty(appPath), [appPath]);
  check("…and clean once the CLI has written it", Boolean(clean));
  const undone = await page.evaluate(async (appPath) => {
    const { getEditor, getModelValue } = await import("/src/lib/editorRegistry.ts");
    getEditor().getModel().undo();
    const value = getModelValue(appPath);
    getEditor().getModel().redo();
    return value;
  }, appPath);
  check("…and ⌘Z in the editor undoes it", undone === before, JSON.stringify(undone));
  check("close_tab answers TAB_CLOSED", text(await cli.tool("close_tab", { tab_name: "✻ [Claude Code] app.ts (a1b2c3) ⧉" })) === "TAB_CLOSED");

  // --- openDiff: Reject (a new file) ----------------------------------------------------------
  const newPath = path.join(workspace, "src/new.ts");
  const rejectCall = cli.tool("openDiff", { old_file_path: newPath, new_file_path: newPath, new_file_contents: "export const fresh = true;\n", tab_name: "new-file-tab" }, { timeout: 0 });
  const newToolbar = await waitFor(page, () => document.querySelector(".claude-proposal-bar")?.innerText ?? null);
  check("a new file's proposal says so", /new file/.test(newToolbar ?? ""), newToolbar);
  await sleep(800);
  await page.click(".claude-proposal-button.reject");
  const rejected = await rejectCall;
  check("Reject returns DIFF_REJECTED (and the tab name)", rejected.content[0].text === "DIFF_REJECTED" && rejected.content[1].text === "new-file-tab", JSON.stringify(rejected));
  check("…and writes nothing", !fs.existsSync(newPath));

  // Closing the tab rejects.
  const closedCall = cli.tool("openDiff", { old_file_path: appPath, new_file_path: appPath, new_file_contents: "x\n", tab_name: "closed-tab" }, { timeout: 0 });
  await waitFor(page, () => document.querySelector(".claude-proposal-bar") !== null);
  await page.evaluate(async () => {
    const tabs = (await import("/src/store/tabsStore.ts")).useTabsStore.getState();
    await tabs.closeTab(tabs.tabs.find((tab) => tab.diff?.kind === "claude").path);
  });
  check("closing the diff tab rejects", text(await closedCall) === "DIFF_REJECTED");

  // The CLI cancels (answered in its terminal): the tab goes away.
  const cancelId = cli.peekId();
  void cli.tool("openDiff", { old_file_path: appPath, new_file_path: appPath, new_file_contents: "y\n", tab_name: "cancelled-tab" }, { timeout: 0 }).catch(() => {});
  await waitFor(page, () => document.querySelector(".claude-proposal-bar") !== null);
  cli.notify("notifications/cancelled", { requestId: cancelId, reason: "answered in the terminal" });
  const gone = await waitFor(page, async () => !(await import("/src/store/tabsStore.ts")).useTabsStore.getState().groups.some((group) => group.tabs.some((tab) => tab.diff?.kind === "claude")));
  check("the CLI cancelling closes the diff", Boolean(gone));

  // closeAllDiffTabs.
  const first = cli.tool("openDiff", { old_file_path: appPath, new_file_path: appPath, new_file_contents: "1\n", tab_name: "one" }, { timeout: 0 });
  const secondDiff = cli.tool("openDiff", { old_file_path: notesPath, new_file_path: notesPath, new_file_contents: "2\n", tab_name: "two" }, { timeout: 0 });
  await waitFor(page, async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().tabs.filter((tab) => tab.diff?.kind === "claude").length === 2);
  check("closeAllDiffTabs closes Claude Code's diffs", text(await cli.tool("closeAllDiffTabs")) === "CLOSED_2_DIFF_TABS");
  check("…answering their requests", text(await first) === "TAB_CLOSED" && text(await secondDiff) === "TAB_CLOSED");

  // Diff review off: the CLI asks in its terminal instead.
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("claudeCode.reviewDiffs", false));
  const off = await cli.tool("openDiff", { old_file_path: appPath, new_file_path: appPath, new_file_contents: "z\n", tab_name: "off" });
  check("with diff review off, openDiff is an error (no diff opens)", off.isError === true && /Diff review is turned off/.test(text(off)) && !(await store(page, "m.tabs.tabs.some((tab) => tab.diff?.kind === 'claude')")), JSON.stringify(off));
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("claudeCode.reviewDiffs", true));

  // Open files follow Claude Code's writes.
  await openFile(page, appPath);
  fs.writeFileSync(appPath, "export const rewritten = 1;\n");
  await page.evaluate((dir) => window.__sableEmit("fs:changed", [dir]), path.dirname(appPath));
  const followed = await waitFor(page, async (appPath) => (await import("/src/lib/editorRegistry.ts")).getModelValue(appPath) === "export const rewritten = 1;\n", [appPath]);
  check("an open file follows the CLI's write on disk", Boolean(followed));

  // Status bar + terminal screenshot.
  await page.evaluate(async (id) => {
    const terminals = (await import("/src/store/terminalStore.ts")).useTerminalStore.getState();
    terminals.setActive(id);
    (await import("/src/store/uiStore.ts")).useUiStore.getState().setBottomPanel("terminal");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // What the terminal shows (no real CLI runs here).
    window.__sableEmit("terminal:output", { id, data: "\x1b[2m[test stand-in for the claude CLI: connected to Sable over the IDE integration]\x1b[0m\r\n> " });
  }, session.id);
  await sleep(800);
  await page.screenshot({ path: `${shots}/terminal-status.png` });

  // A second folder: the lock file lists both.
  await page.evaluate(async (second) => (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState().addFolder(second), second);
  const updated = await waitFor(page, () => true).then(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const lockNow = readLocks(configDir).find((candidate) => candidate.port === lock.port);
      if (lockNow?.workspaceFolders?.length === 2) return lockNow;
      await sleep(200);
    }
    return null;
  });
  check("adding a folder updates the lock file (multi-root)", JSON.stringify(updated?.workspaceFolders) === JSON.stringify([workspace, second]), JSON.stringify(updated?.workspaceFolders));
  const twoFolders = parse(await cli.tool("getWorkspaceFolders"));
  check("…and getWorkspaceFolders", twoFolders.folders.length === 2 && twoFolders.folders[1].path === second);

  // The CLI quits.
  await cli.close();
  cli = null;
  const disconnected = await waitFor(page, () => document.querySelector(".claude-code-status") === null);
  check("the status bar item goes when the CLI disconnects", Boolean(disconnected));
  // No CLI connected: ⌥⌘K goes to the agent panel instead.
  await openFile(page, appPath);
  await sleep(400);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 });
    (await import("/src/store/uiStore.ts")).useUiStore.setState({ agentVisible: false });
  });
  await combo(page, ["Meta", "Alt"], "KeyK", 800);
  check(
    "with no CLI connected, ⌥⌘K sends the selection to the agent panel (not Claude Code)",
    (await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().agentVisible)) === true && terminalStarts.length === 1,
    `${terminalStarts.length} starts`,
  );
  // Put things back: the agent panel closed, the editor focused.
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    (await import("/src/store/uiStore.ts")).useUiStore.setState({ agentVisible: false });
    (await import("/src/lib/editorRegistry.ts")).getEditor()?.focus();
  });
  await sleep(300);

  // --- Optional: the REAL `claude` finds Sable's lock file and connects ---------------------
  // SABLE_TEST_REAL_CLAUDE=1. Only discovery and connection: it starts in a
  // pseudo-terminal with this test's temp config (no credentials: "not
  // logged in"), no prompt is ever typed, and it's quit after a few seconds.
  if (process.env.SABLE_TEST_REAL_CLAUDE === "1") {
    const real = await bridge("claude_code_find_cli", { path: process.env.SABLE_TEST_CLAUDE_PATH ?? null }).catch(() => null);
    if (!real) console.log("  (claude isn't installed: skipping the real CLI check)");
    else {
      const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/real-claude-connect.py");
      let output = "";
      const realStarted = Date.now() - 1000;
      const child = spawn("python3", ["-I", fixture, real.path, configDir, workspace, String(lock.port), "20"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.on("exit", resolve));
      let realPids = [];
      for (let attempt = 0; attempt < 60 && realPids.length === 0; attempt++) {
        await sleep(250);
        realPids = (await bridge("claude_code_status")).clientPids;
      }
      const cliPid = Number(/cli pid (\d+)/.exec(output)?.[1]);
      check(`the real claude (${real.version}) finds Sable's lock file and connects`, realPids.includes(cliPid), `${JSON.stringify(realPids)} ${output.slice(-400)}`);
      const shown = await waitFor(page, () => document.querySelector(".claude-code-status")?.textContent ?? null);
      check("…and the status bar says so", /Claude Code connected/.test(shown ?? ""), shown);
      await exited;
      const debugDir = path.join(configDir, "debug");
      // This run's log (the config folder may hold earlier runs').
      const logs = fs.existsSync(debugDir)
        ? fs
            .readdirSync(debugDir)
            .map((name) => path.join(debugDir, name))
            .filter((file) => fs.statSync(file).mtimeMs >= realStarted)
            .map((file) => fs.readFileSync(file, "utf8"))
            .join("\n")
        : "";
      check("…over the WebSocket IDE transport (its --debug log)", /MCP server "ide": Successfully connected \(transport: ws-ide\)/.test(logs), logs.split("\n").filter((line) => /"ide"/.test(line)).slice(0, 3).join(" / "));
      check("…signed out in the temp config (Sable passed nothing about signing in)", /Not ?logged ?in/i.test(output), output.slice(-300));
    }
  }

  // --- Remote window: the CLI runs on the remote ----------------------------------------------
  await page.evaluate(async () => {
    const terminals = (await import("/src/store/terminalStore.ts")).useTerminalStore.getState();
    const claude = terminals.sessions.find((s) => s.reuseKey === "claude-code");
    if (claude) await terminals.closeTerminal(claude.id);
    (await import("/src/lib/backend.ts")).setRemoteActive(true);
  });
  const startsBefore = terminalStarts.length;
  await palette(page, "Run Claude Code", 1500);
  const remoteStatus = await page.evaluate(() => document.querySelector(".status-bar")?.innerText ?? "");
  check(
    "a remote window runs `claude` in a remote terminal, and says IDE features aren't there",
    typed.some((entry) => entry.remote && entry.data === "claude\r") && terminalStarts.length === startsBefore && /isn't available for remote workspaces/.test(remoteStatus),
    `${JSON.stringify(typed)} ${remoteStatus}`,
  );
  await page.evaluate(async () => (await import("/src/lib/backend.ts")).setRemoteActive(false));

  // --- Not installed: Anthropic's install help -----------------------------------------------
  cliFound = null;
  await palette(page, "Run Claude Code", 1200);
  const help = await page.evaluate(() => document.querySelector(".claude-install")?.innerText ?? null);
  check("no CLI: a panel says what Claude Code is and how to install it", /Claude Code isn't installed/.test(help ?? "") && /Anthropic's command-line coding agent/.test(help) && help.includes("curl -fsSL https://claude.ai/install.sh | bash") && /\/login/.test(help), help);
  const typedBefore = typed.length;
  await sleep(500);
  check("…without running anything yet", typed.length === typedBefore && !typed.some((entry) => /install\.sh/.test(entry.data)) && terminalStarts.length === startsBefore);
  await page.screenshot({ path: `${shots}/install-help.png` });
  await page.evaluate(() => [...document.querySelectorAll(".claude-install-actions button")].find((button) => /Install in a terminal/.test(button.textContent)).click());
  await sleep(1500);
  const installing = typed.find((entry) => /install\.sh/.test(entry.data));
  check(
    "…the install command runs in a visible terminal after the click",
    installing?.data === "curl -fsSL https://claude.ai/install.sh | bash\r" && !installing.remote && (await page.evaluate(() => document.querySelector(".claude-install") === null)) && (await store(page, "m.terminals.sessions.length")) >= 1,
    JSON.stringify(installing),
  );

  // Settings: the section and its three settings.
  await page.evaluate(async () => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openSettings());
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll("button, a, li")].find((element) => element.textContent.trim() === "Claude Code (Anthropic's CLI)")?.click());
  await sleep(600);
  const settingsText = await page.evaluate(() => document.getElementById("settings-section-Claude Code (Anthropic's CLI)")?.innerText ?? "");
  check("Settings has a Claude Code (Anthropic's CLI) section", ["CLI Path", "Connect Automatically", "Review Edits in a Diff"].every((label) => settingsText.includes(label)), settingsText.slice(0, 200));
  await page.screenshot({ path: `${shots}/settings.png` });

  // Stopping removes the lock file.
  await bridge("claude_code_stop");
  check("stopping the server removes the lock file", !fs.existsSync(path.join(configDir, "ide", `${lock.port}.lock`)));
  check("no lock file was written outside the test's config folder", serverStatus.lockFile.startsWith(configDir));
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  if (cli) await cli.close().catch(() => {});
  await browser.close();
  await bridge("claude_code_stop").catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
}
finish();
