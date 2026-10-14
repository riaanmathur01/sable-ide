// End-to-end test of launch.json debugging against real debuggers:
// a project with .vscode/launch.json and tasks.json; the Run and Debug
// view lists its configurations; a Python configuration runs its
// preLaunchTask first, asks for an ${input:…}, and stops at a breakpoint
// with its args/env/envFile/cwd visible in Variables; a Node
// configuration stops at a breakpoint (js-debug); broken configurations
// (unsupported type, missing program, failing task) say why; a compound
// starts two sessions; the selection is remembered; and in a project
// without one, the gear creates launch.json from a template.
//
//   [SABLE_TEST_PYTHON=/path/to/python with debugpy (default: python3)]
//   [SHOTS=/dir for screenshots] SABLE_UI_VITE_PORT=1582 SABLE_UI_BRIDGE_PORT=1583
//   node scripts/ui-test/launch-json.mjs
//
// with Vite and the bridge running (README → Testing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { openSable, extraStandins, sleep, clickText, gutterPoint, unknownCommands } from "./driver.mjs";

const python = process.env.SABLE_TEST_PYTHON ?? "python3";
if (spawnSync(python, ["-c", "import debugpy"]).status !== 0) {
  throw new Error(`${python} lacks debugpy — set SABLE_TEST_PYTHON to an interpreter with it (python3 -m venv /tmp/v && /tmp/v/bin/pip install debugpy)`);
}
const jsDebug = path.join(os.homedir(), "Library/Application Support/com.riaanmathur.sable/tools/js-debug/src/dapDebugServer.js");
const hasJsDebug = fs.existsSync(jsDebug) && spawnSync("node", ["--version"]).status === 0;
const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-launch-shots");
fs.mkdirSync(shots, { recursive: true });

// --- The project ------------------------------------------------------------------------
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-launch-")));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(workspace, file), text);
};
write(
  "app.py",
  `import os
import sys


def main():
    who = os.environ.get("GREETING_NAME", "?")
    from_env_file = os.environ.get("FROM_ENV_FILE", "no")
    args = sys.argv[1:]
    cwd = os.path.basename(os.getcwd())
    marker = open("built.txt").read().strip() if os.path.exists("built.txt") else "missing"
    message = f"hello {who}"
    print(message, args, cwd, marker, from_env_file)


main()
`,
);
const PY_BREAKPOINT = 12; // the print
write(
  "script.js",
  `const numbers = [1, 2, 3];
const total = numbers.reduce((sum, n) => sum + n, 0);
const label = "total:" + total;
console.log(label, process.env.NODE_GREETING);
`,
);
const JS_BREAKPOINT = 4;
write(".env", "# loaded through envFile\nFROM_ENV_FILE=yes\n");
write("sub/.keep", "");
write(
  ".vscode/launch.json",
  `{
    // A typical VS Code launch.json: comments, trailing commas, variables.
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Python: App",
            "type": "debugpy",
            "request": "launch",
            "program": "\${workspaceFolder}/app.py",
            "args": ["--who", "\${input:who}", "\${workspaceFolderBasename}"],
            "cwd": "\${workspaceFolder}/sub",
            "env": { "GREETING_NAME": "\${input:who}" },
            "envFile": "\${workspaceFolder}/.env",
            "console": "integratedTerminal",
            "python": "${python}",
            "preLaunchTask": "make marker",
        },
        {
            "name": "Node: Script",
            "type": "node",
            "request": "launch",
            "program": "\${workspaceFolder}/script.js",
            "env": { "NODE_GREETING": "hi from launch.json" },
        },
        { "name": "PHP: Unsupported", "type": "php", "request": "launch", "program": "index.php" },
        { "name": "Python: Missing Program", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/nope.py" },
        { "name": "Python: Failing Task", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/app.py", "preLaunchTask": "fail" },
        { "name": "Python: Unknown Variable", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/\${nope}" },
    ],
    "compounds": [
        { "name": "Python + Node", "configurations": ["Node: Script", "Python: App"] },
    ],
    "inputs": [
        { "id": "who", "type": "promptString", "description": "Who to greet?", "default": "world" },
    ],
}
`,
);
write(
  ".vscode/tasks.json",
  `{
    "version": "2.0.0",
    "tasks": [
        { "label": "make marker", "type": "shell", "command": "echo built > sub/built.txt && echo marker-written", "dependsOn": "prepare" },
        { "label": "prepare", "type": "shell", "command": "rm -f sub/built.txt" },
        { "label": "fail", "type": "shell", "command": "echo failing; exit 4" },
    ],
}
`,
);
// A second project, without launch.json (the gear creates one).
const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-launch-empty-")));
fs.writeFileSync(path.join(empty, "main.py"), "print('hi')\n");

// --- Terminals: the test runs their programs (the bridge has no PTYs) -----------------------
let page;
const terminals = new Map();
const terminalOutput = new Map();
const emit = (event, payload) => page?.evaluate((event, payload) => window.__sableEmit(event, payload), event, payload).catch(() => {});
extraStandins.create_command_terminal = ({ id, args, cwd, env }) => {
  const childEnv = { ...process.env };
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === null) delete childEnv[name];
    else childEnv[name] = value;
  }
  const child = spawn(args[0], args.slice(1), { cwd: cwd ?? workspace, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  terminals.set(id, child);
  terminalOutput.set(id, "");
  const forward = (data) => {
    const text = data.toString();
    terminalOutput.set(id, terminalOutput.get(id) + text);
    void emit("terminal:output", { id, data: text });
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("close", () => setTimeout(() => void emit("terminal:exit", id), 50));
  return child.pid;
};
extraStandins.create_terminal = null;
extraStandins.write_terminal = ({ id, data }) => void terminals.get(id)?.stdin.write(data);
extraStandins.resize_terminal = null;
extraStandins.kill_terminal = ({ id }) => void terminals.get(id)?.kill();
const allTerminalOutput = () => [...terminalOutput.values()].join("\n");

// --- Helpers ----------------------------------------------------------------------------------
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};
async function waitFor(fn, args = [], timeout = 20000, what = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const mod = process.platform === "darwin" ? "Meta" : "Control";
async function chord(key, modifiers = [mod]) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}
async function paletteCommand(label) {
  await chord("p", [mod, "Shift"]);
  await page.waitForSelector(".palette-input");
  await page.type(".palette-input", label);
  await sleep(150);
  await page.keyboard.press("Enter");
  await sleep(150);
}
const consoleText = async () => {
  await page.evaluate(() => [...document.querySelectorAll(".terminal-panel button[role=tab]")].find((tab) => tab.textContent.includes("Debug Console"))?.click());
  await sleep(100);
  return page.evaluate(() => [...document.querySelectorAll(".debug-console-line")].map((line) => line.innerText).join("\n"));
};
const statusText = () => page.evaluate(() => document.querySelector(".status-bar")?.innerText ?? "");
const optionLabels = () => page.$$eval(".launch-select option", (options) => options.map((option) => option.textContent));
async function selectConfiguration(label) {
  const value = await page.$$eval(".launch-select option", (options, label) => options.find((option) => option.textContent === label)?.value, label);
  if (!value) throw new Error(`no configuration ${label}`);
  await page.select(".launch-select", value);
  await sleep(100);
}
const variables = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".debug-variable")].map((row) => [row.querySelector(".debug-variable-name")?.innerText, row.querySelector(".debug-variable-value")?.innerText]),
    ),
  );
async function openFile(name) {
  await chord("p");
  await page.waitForSelector(".palette-input");
  await page.type(".palette-input", name);
  await sleep(400);
  await page.keyboard.press("Enter");
  await waitFor((name) => document.querySelector(".editor-tab.active")?.innerText.includes(name), [name], 10000, `${name} to open`);
  await sleep(600);
}
async function addBreakpoint(line) {
  const point = await gutterPoint(page, line);
  await page.mouse.click(point.x, point.y);
  await sleep(200);
}
async function answerPrompt(text) {
  await page.waitForSelector(".palette-input", { timeout: 15000 });
  const placeholder = await page.$eval(".palette-input", (input) => input.placeholder);
  await page.focus(".palette-input");
  // Clear the default value.
  for (let index = 0; index < 30; index++) await page.keyboard.press("Backspace");
  await page.type(".palette-input", text);
  await sleep(150);
  await page.keyboard.press("Enter");
  return placeholder;
}
const waitStopped = (what) => waitFor(() => /Paused on/.test(document.querySelector(".debug-state")?.innerText ?? ""), [], 45000, what);
const waitIdle = (what) => waitFor(() => !!document.querySelector(".launch-bar"), [], 30000, what);

// --- The test ---------------------------------------------------------------------------------
let browser;
try {
  ({ browser, page } = await openSable(workspace, { width: 1400, height: 900, pollEvents: true }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // Debug traffic, for the failure report.
  await page.evaluate(() => {
    const emit = window.__sableEmit;
    window.__debugEvents = [];
    window.__sableEmit = (event, payload) => {
      if (event.startsWith("debug:")) window.__debugEvents.push(JSON.stringify({ event, payload }).slice(0, 400));
      emit(event, payload);
    };
  });
  await sleep(1200);
  await chord("d", [mod, "Shift"]);
  await waitFor(() => !!document.querySelector(".launch-select"), [], 10000, "the configuration dropdown");

  // The dropdown: launch.json configurations, the compound, then Sable's own.
  const labels = await optionLabels();
  console.log("  dropdown:", labels.join(" | "));
  check(labels[0] === "Python: App", "the first launch.json configuration is selected by default");
  check(labels.includes("Python + Node"), "compounds are listed");
  check(labels.some((label) => label.startsWith("Current File")), "Sable's automatic Current File configuration is listed");
  check(labels.at(-1) === "Add Configuration…", "Add Configuration… ends the list");
  check(!(await page.$(".debug-start-button:not(.secondary)")), "the old Run and Debug button gives way to the dropdown");
  await openFile("app.py");
  await addBreakpoint(PY_BREAKPOINT);
  await page.screenshot({ path: path.join(shots, "1-run-and-debug.png") });
  const panel = await page.$(".sidebar");
  if (panel) await panel.screenshot({ path: path.join(shots, "1b-panel.png") });

  // --- Python: preLaunchTask, input, env/envFile/args/cwd, breakpoint ------------------------
  await page.click(".launch-start");
  const prompt = await answerPrompt("Ada");
  check(prompt === "Who to greet?", `the \${input:who} prompt shows its description (${prompt})`);
  await waitStopped("the Python breakpoint");
  check(allTerminalOutput().includes("marker-written"), "the preLaunchTask ran (its output is in a terminal)");
  check(fs.readFileSync(path.join(workspace, "sub/built.txt"), "utf8").trim() === "built", "the preLaunchTask (and its dependsOn) ran before the program");
  await waitFor(() => document.querySelectorAll(".debug-variable").length > 3, [], 10000, "variables");
  const pyVars = await variables();
  console.log("  variables:", JSON.stringify(pyVars));
  check(pyVars.who === "'Ada'", "env from launch.json, with the input's answer");
  check(pyVars.from_env_file === "'yes'", "envFile loaded");
  check(/\['--who', 'Ada', 'sable-launch-\w+'\]/.test(pyVars.args ?? ""), "args substituted (input and ${workspaceFolderBasename})");
  check(pyVars.cwd === "'sub'", "cwd honored");
  check(pyVars.marker === "'built'", "the program sees what the preLaunchTask made");
  check(pyVars.message === "'hello Ada'", "the breakpoint's locals are visible");
  await page.screenshot({ path: path.join(shots, "2-python-paused.png") });
  await page.click(".debug-session-bar button[title^='Continue']");
  await waitIdle("the Python session to end");
  await sleep(500);
  check(/hello Ada \['--who', 'Ada', 'sable-launch-\w+'\] sub built yes/.test(allTerminalOutput()), "the program ran to the end in a terminal (console: integratedTerminal)");

  // --- Node --------------------------------------------------------------------------------------
  if (hasJsDebug) {
    await selectConfiguration("Node: Script");
    await openFile("script.js");
    await addBreakpoint(JS_BREAKPOINT);
    await page.keyboard.press("F5"); // F5 starts the selected configuration
    await waitStopped("the Node breakpoint");
    await waitFor(() => [...document.querySelectorAll(".debug-variable-name")].some((name) => name.innerText === "total"), [], 15000, "Node variables");
    const jsVars = await variables();
    check(jsVars.total === "6" && /total:6/.test(jsVars.label ?? ""), `Node stopped with its locals (total=${jsVars.total}, label=${jsVars.label})`);
    await page.click(".debug-session-bar button[title^='Continue']");
    await waitIdle("the Node session to end");
    await sleep(400);
    check((await consoleText()).includes("total:6 hi from launch.json"), "Node's output (with env) reaches the debug console");
  } else {
    console.log("  skip: js-debug isn't installed (Node configuration)");
  }

  // --- Errors are never silent -----------------------------------------------------------------
  for (const [label, pattern, what] of [
    ["PHP: Unsupported", /debug type “php” isn't supported by Sable/, "an unsupported type"],
    ["Python: Missing Program", /the program “.*nope\.py” doesn't exist/, "a missing program"],
    ["Python: Failing Task", /The task “fail” failed \(exit code 4\)/, "a failing preLaunchTask"],
    ["Python: Unknown Variable", /Unknown variable \$\{nope\}/, "an unknown variable"],
  ]) {
    await selectConfiguration(label);
    await page.click(".launch-start");
    await waitFor((source) => new RegExp(source).test(document.querySelector(".status-bar")?.innerText ?? ""), [pattern.source], 20000, `${what}'s message`);
    const text = await consoleText();
    check(pattern.test(text) && pattern.test(await statusText()), `${what} is reported in the debug console and the status bar`);
    check(!(await page.$(".debug-session-bar")), `${what} doesn't start a session`);
  }
  await page.screenshot({ path: path.join(shots, "3-error.png") });

  // --- A compound: two sessions --------------------------------------------------------------
  if (hasJsDebug) {
    await selectConfiguration("Python + Node");
    await page.click(".launch-start");
    await answerPrompt("Grace");
    await waitStopped("a compound session to stop");
    await waitFor(() => document.querySelectorAll(".launch-session").length === 2, [], 20000, "two sessions");
    const sessions = await page.$$eval(".launch-session-name", (names) => names.map((name) => name.innerText));
    check(sessions.includes("Node: Script") && sessions.includes("Python: App"), `the compound runs both sessions (${sessions.join(", ")})`);
    await page.screenshot({ path: path.join(shots, "4-compound.png") });
    // Continue each stop until both have ended.
    for (let round = 0; round < 6 && (await page.$(".debug-session-bar")); round++) {
      if (/Paused on/.test(await page.$eval(".debug-state", (state) => state.innerText).catch(() => ""))) await page.click(".debug-session-bar button[title^='Continue']");
      await sleep(1500);
    }
    await waitIdle("the compound to end");
    check(allTerminalOutput().includes("hello Grace"), "the compound's Python session ran to the end");
  }

  // --- Remembered selection -------------------------------------------------------------------
  await selectConfiguration("Node: Script");
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1200);
  await chord("d", [mod, "Shift"]);
  await waitFor(() => !!document.querySelector(".launch-select"), [], 10000, "the dropdown after reloading");
  const remembered = await page.$eval(".launch-select", (select) => select.selectedOptions[0]?.textContent);
  check(remembered === "Node: Script", `the selection is remembered per workspace (${remembered})`);

  // --- Reloads when launch.json changes on save ------------------------------------------------
  await paletteCommand("Debug: Open launch.json");
  await waitFor(() => document.querySelector(".editor-tab.active")?.innerText.includes("launch.json"), [], 10000, "launch.json to open");
  await paletteCommand("Debug: Add Configuration…");
  await waitFor(() => document.querySelector(".palette-input")?.placeholder === "Add a configuration", [], 5000, "the snippet list");
  await page.type(".palette-input", "Go: Launch Package");
  await sleep(150);
  await page.keyboard.press("Enter");
  await sleep(400);
  await chord("s");
  await waitFor(() => [...document.querySelectorAll(".launch-select option")].some((option) => option.textContent === "Launch Package"), [], 10000, "the added configuration in the dropdown");
  check(/"name": "Launch Package"/.test(fs.readFileSync(path.join(workspace, ".vscode/launch.json"), "utf8")), "Add Configuration… inserted the snippet and the save reloaded the list");
  check(fs.readFileSync(path.join(workspace, ".vscode/launch.json"), "utf8").includes("// A typical VS Code launch.json"), "comments in launch.json are kept");

  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
  await browser.close();

  // --- No launch.json: the gear creates one --------------------------------------------------
  ({ browser, page } = await openSable(empty, { width: 1400, height: 900, pollEvents: true }));
  await sleep(1200);
  await chord("d", [mod, "Shift"]);
  await waitFor(() => !!document.querySelector(".launch-create"), [], 10000, "the create-launch.json link");
  check(!!(await page.$(".debug-start-button:not(.secondary)")), "without launch.json, Run and Debug (current file) stays");
  const sidebar = await page.$(".sidebar");
  if (sidebar) await sidebar.screenshot({ path: path.join(shots, "5-no-launch-json.png") });
  await clickText(page, "Create a launch.json file");
  await waitFor(() => document.querySelector(".palette-input")?.placeholder === "Select debugger", [], 5000, "the debugger pick");
  const firstDebugger = await page.$eval(".palette-item-label", (label) => label.innerText);
  check(firstDebugger === "Python Debugger", `the likeliest debugger is offered first (${firstDebugger})`);
  await page.keyboard.press("Enter");
  await waitFor(() => !!document.querySelector(".launch-select"), [], 10000, "the new configuration in the dropdown");
  const created = JSON.parse(fs.readFileSync(path.join(empty, ".vscode/launch.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  check(created.configurations[0].type === "debugpy" && created.configurations[0].program === "${file}", "launch.json was created from the Python template");
  const createdSelection = await page.$eval(".launch-select", (select) => select.selectedOptions[0]?.textContent);
  check(createdSelection === "Python Debugger: Current File", `the new configuration is selected (${createdSelection})`);
  await page.screenshot({ path: path.join(shots, "6-created.png") });
  await browser.close();
  browser = null;
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
  if (page) await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
  if (page) console.log("  console:\n" + (await consoleText().catch(() => "")));
  console.log("  terminals:\n" + allTerminalOutput());
  if (page) console.log("  debug events:\n" + (await page.evaluate(() => (window.__debugEvents ?? []).slice(-40).join("\n")).catch(() => "")));
} finally {
  for (const child of terminals.values()) child.kill();
  await browser?.close().catch(() => {});
}

if (unknownCommands.size) console.log(`  (commands the bridge didn't serve: ${[...unknownCommands].join(", ")})`);
console.log(`\nscreenshots: ${shots}`);
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("all passed");
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
