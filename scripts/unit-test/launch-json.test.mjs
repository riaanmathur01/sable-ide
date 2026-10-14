// Unit tests for launch.json support (src/lib/debug/launch*.ts): parsing,
// variable substitution, inputs, compounds, tasks, the launch request
// produced for each debug type, and launch.json editing. The TypeScript is
// bundled with esbuild into a temp dir first.
//
//   node --test scripts/unit-test/launch-json.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sable-launch-unit-"));
const entry = path.join(temp, "entry.ts");
fs.writeFileSync(
  entry,
  ["launchJson", "launchVariables", "launchRequest", "launchTemplates"]
    .map((name) => `export * from ${JSON.stringify(path.join(root, "src/lib/debug", `${name}.ts`))};`)
    .join("\n"),
);
const bundle = path.join(temp, "bundle.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`, "--log-level=warning"]);
const L = await import(pathToFileURL(bundle).href);
process.on("exit", () => fs.rmSync(temp, { recursive: true, force: true }));

// --- Parsing --------------------------------------------------------------------

const LAUNCH = `{
  // Comments and trailing commas, as VS Code allows.
  "version": "0.2.0",
  "configurations": [
    { "name": "Run app", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/app.py", "preLaunchTask": "build", },
    { "name": "Hidden", "type": "node", "request": "launch", "program": "x.js", "presentation": { "hidden": true } },
    { "type": "node", "request": "launch" },
    { "name": "Server", "type": "node", "request": "launch", "program": "server.js" },
  ],
  "compounds": [
    { "name": "Both", "configurations": ["Run app", "Server"], "stopAll": true },
  ],
  "inputs": [
    { "id": "who", "type": "promptString", "description": "Name?", "default": "world" },
    { "id": "mode", "type": "pickString", "description": "Mode", "options": ["fast", { "label": "Slow", "value": "slow" }] },
  ],
}`;

test("parses configurations, compounds and inputs from JSONC", () => {
  const file = L.parseLaunchJson(LAUNCH);
  assert.deepEqual(file.configurations.map((config) => config.name), ["Run app", "Hidden", "Server"]);
  assert.equal(file.compounds[0].name, "Both");
  assert.equal(file.compounds[0].stopAll, true);
  assert.deepEqual(file.inputs.map((input) => input.id), ["who", "mode"]);
  assert.equal(file.errors.length, 1, "the unnamed configuration is reported");
  assert.match(file.errors[0], /configuration 3 has no "name"/);
});

test("reports a broken file instead of throwing", () => {
  const file = L.parseLaunchJson(`{ "configurations": [ { "name": `);
  assert.equal(file.configurations.length, 0);
  assert.equal(file.errors.length, 1);
});

test("reads a .code-workspace file's launch section", () => {
  const file = L.parseWorkspaceLaunch(`{ "folders": [{ "path": "a" }], "launch": { "configurations": [{ "name": "W", "type": "go", "request": "launch", "program": "." }] } }`);
  assert.equal(file.configurations[0].name, "W");
  assert.equal(L.parseWorkspaceLaunch(`{ "folders": [] }`).configurations.length, 0);
});

test("lists entries, labeled by folder in multi-root workspaces", () => {
  const api = { folder: "/w/api", path: "/w/api/.vscode/launch.json", file: L.parseLaunchJson(LAUNCH) };
  const web = { folder: "/w/web", path: "/w/web/.vscode/launch.json", file: L.parseLaunchJson(`{"configurations":[{"name":"Server","type":"chrome","request":"launch","url":"http://x"}]}`) };
  const single = L.launchEntries([api], false);
  assert.deepEqual(single.map((entry) => entry.label), ["Run app", "Server", "Both"]);
  const multi = L.launchEntries([api, web], true);
  assert.deepEqual(multi.map((entry) => entry.label), ["Run app (api)", "Server (api)", "Both (api)", "Server (web)"]);
  assert.notEqual(multi[1].key, multi[3].key, "same name in two folders: different keys");
  const workspace = { folder: null, path: "/w/x.code-workspace", file: L.parseLaunchJson(`{"configurations":[{"name":"All","type":"go","request":"launch","program":"."}]}`) };
  assert.deepEqual(L.launchEntries([workspace], false).map((entry) => entry.label), ["All (workspace)"]);
});

test("resolves compound members, across folders too", () => {
  const api = { folder: "/w/api", path: "", file: L.parseLaunchJson(LAUNCH) };
  const web = { folder: "/w/web", path: "", file: L.parseLaunchJson(`{"configurations":[{"name":"Client","type":"chrome","request":"launch","url":"http://x"}]}`) };
  const both = api.file.compounds[0];
  assert.deepEqual(L.compoundMembers(both, api, [api, web]).map(({ config }) => config.name), ["Run app", "Server"]);
  const cross = { name: "Full", configurations: ["Server", { name: "Client", folder: "web" }] };
  const members = L.compoundMembers(cross, api, [api, web]);
  assert.equal(members[1].source, web);
  assert.throws(() => L.compoundMembers({ name: "Bad", configurations: ["Nope"] }, api, [api]), /no configuration named “Nope”/);
});

test("merges platform-specific properties", () => {
  const merged = L.withPlatform({ name: "x", env: { A: "1" }, osx: { env: { B: "2" }, program: "mac" }, windows: { program: "win" } }, "osx");
  assert.deepEqual(merged, { name: "x", env: { A: "1", B: "2" }, program: "mac" });
});

// --- Variables ----------------------------------------------------------------

function context(overrides = {}) {
  const prompts = [];
  const ctx = {
    workspaceFolder: "/w/api",
    folders: ["/w/api", "/w/web"],
    file: "/w/api/src/pkg/main.test.py",
    lineNumber: 12,
    selectedText: "picked",
    env: { HOME: "/home/me", TOKEN: "abc" },
    userHome: "/home/me",
    pathSeparator: "/",
    config: (key) => ({ "editor.fontSize": 14, "python.defaultInterpreterPath": "/usr/bin/python3" })[key],
    inputs: L.parseLaunchJson(LAUNCH).inputs,
    promptInput: async (input) => {
      prompts.push(input.id);
      return input.id === "who" ? "Ada" : "slow";
    },
    pickProcess: async (mine) => (mine ? "4242" : "1234"),
    pickArgs: async () => "--a 'b c'",
    pythonInterpreter: () => "/venv/bin/python",
    defaultBuildTask: () => "build",
    ...overrides,
  };
  return { ctx, prompts };
}

test("substitutes the predefined variables", async () => {
  const { ctx } = context();
  const cases = {
    "${workspaceFolder}": "/w/api",
    "${workspaceFolderBasename}": "api",
    "${workspaceFolder:web}/x": "/w/web/x",
    "${file}": "/w/api/src/pkg/main.test.py",
    "${fileBasename}": "main.test.py",
    "${fileBasenameNoExtension}": "main.test",
    "${fileDirname}": "/w/api/src/pkg",
    "${fileExtname}": ".py",
    "${relativeFile}": "src/pkg/main.test.py",
    "${relativeFileDirname}": "src/pkg",
    "${lineNumber}": "12",
    "${selectedText}": "picked",
    "${cwd}": "/w/api",
    "${env:TOKEN}-${env:MISSING}": "abc-",
    "a${pathSeparator}b": "a/b",
    "${userHome}/.config": "/home/me/.config",
    "${config:editor.fontSize}": "14",
    "${defaultBuildTask}": "build",
    "${command:python.interpreterPath}": "/venv/bin/python",
    "${fileWorkspaceFolder}": "/w/api",
    "no variables": "no variables",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(await L.substituteString(input, ctx), expected, input);
  }
});

test("substitutes deep inside objects and arrays", async () => {
  const { ctx } = context();
  const result = await L.substitute({ args: ["${fileBasename}", 3], env: { HOME_DIR: "${userHome}" }, nested: { flag: true } }, ctx);
  assert.deepEqual(result, { args: ["main.test.py", 3], env: { HOME_DIR: "/home/me" }, nested: { flag: true } });
});

test("asks for each input once, and picks processes", async () => {
  const { ctx, prompts } = context();
  const result = await L.substitute({ a: "${input:who}", b: "hello ${input:who} (${input:mode})", pid: "${command:pickProcess}", mine: "${command:pickMyProcess}" }, ctx);
  assert.deepEqual(result, { a: "Ada", b: "hello Ada (slow)", pid: "1234", mine: "4242" });
  assert.deepEqual(prompts, ["who", "mode"]);
  assert.deepEqual(L.interactiveVariables({ x: ["${input:who}", "${command:pickProcess}", "${file}"] }), ["input:who", "command:pickProcess"]);
});

test("a cancelled prompt cancels the launch", async () => {
  const { ctx } = context({ promptInput: async () => null });
  await assert.rejects(L.substituteString("${input:who}", ctx), L.LaunchCancelled);
});

test("unknown variables and missing context are errors with clear messages", async () => {
  const { ctx } = context();
  await assert.rejects(L.substituteString("${nope}", ctx), (error) => error instanceof L.VariableError && /Unknown variable \$\{nope\}/.test(error.message));
  await assert.rejects(L.substituteString("${input:missing}", ctx), /no input with id “missing”/);
  await assert.rejects(L.substituteString("${command:foo.bar}", ctx), /isn't supported/);
  await assert.rejects(L.substituteString("${workspaceFolder:other}", ctx), /no workspace folder named “other”/);
  await assert.rejects(L.substituteString("${config:no.such}", ctx), /no such setting/);
  const { ctx: noFile } = context({ file: null, lineNumber: null });
  await assert.rejects(L.substituteString("${file}", noFile), /needs an open file/);
});

test("relativeFileDirname at the top of the folder is '.'", async () => {
  const { ctx } = context({ file: "/w/api/main.py" });
  assert.equal(await L.substituteString("${relativeFileDirname}", ctx), ".");
  assert.equal(await L.substituteString("${relativeFile}", ctx), "main.py");
});

// --- Launch requests per type -------------------------------------------------------

const options = { workspaceFolder: "/w", python: "/venv/bin/python", envFile: null };

test("python launch: program, args, env, envFile, cwd, console, justMyCode", () => {
  const { adapter, request, requiredPaths } = L.toLaunchRequest(
    {
      name: "Py",
      type: "debugpy",
      request: "launch",
      program: "app.py",
      args: "--name 'Ada Lovelace'",
      env: { A: "1", N: 2 },
      preLaunchTask: "build",
      stopOnEntry: true,
      purpose: ["debug-test"],
    },
    { ...options, envFile: { A: "from-file", B: "file" } },
  );
  assert.deepEqual(adapter, { kind: "debugpy", python: "/venv/bin/python" });
  assert.equal(request.type, "python");
  assert.deepEqual(request.args, ["--name", "Ada Lovelace"]);
  assert.deepEqual(request.env, { A: "1", B: "file", N: "2" });
  assert.equal(request.cwd, "/w");
  assert.equal(request.console, "integratedTerminal");
  assert.equal(request.justMyCode, true);
  assert.equal(request.stopOnEntry, true);
  assert.equal(request.python, "/venv/bin/python");
  assert.deepEqual(request.purpose, ["debug-test"], "unknown fields pass through");
  assert.equal(request.preLaunchTask, undefined, "client-only fields are dropped");
  assert.deepEqual(requiredPaths, [{ path: "/w/app.py", what: "program" }]);
});

test("python module launch, internal console, explicit interpreter", () => {
  const { adapter, request, requiredPaths } = L.toLaunchRequest(
    { name: "M", type: "python", request: "launch", module: "pkg.cli", console: "internalConsole", python: "/opt/py", justMyCode: false },
    options,
  );
  assert.equal(adapter.python, "/opt/py");
  assert.equal(request.module, "pkg.cli");
  assert.equal(request.redirectOutput, true);
  assert.equal(request.justMyCode, false);
  assert.deepEqual(requiredPaths, []);
});

test("python attach: connect, legacy host/port, processId", () => {
  assert.deepEqual(L.toLaunchRequest({ name: "A", type: "debugpy", request: "attach", connect: { port: "5678" } }, options).request.connect, { host: "127.0.0.1", port: 5678 });
  const legacy = L.toLaunchRequest({ name: "A", type: "python", request: "attach", host: "remote", port: 3000 }, options).request;
  assert.deepEqual(legacy.connect, { host: "remote", port: 3000 });
  assert.equal(legacy.host, undefined);
  assert.equal(L.toLaunchRequest({ name: "A", type: "debugpy", request: "attach", processId: "123" }, options).request.processId, 123);
  assert.throws(() => L.toLaunchRequest({ name: "A", type: "debugpy", request: "attach" }, options), /connect/);
  assert.throws(() => L.toLaunchRequest({ name: "P", type: "debugpy", request: "launch" }, options), /set "program"/);
});

test("node launch: program, npm runtime, runtimeArgs, skipFiles, outFiles, sourceMaps", () => {
  const { adapter, request, requiredPaths } = L.toLaunchRequest(
    { name: "N", type: "node", request: "launch", program: "${workspaceFolder}/index.js".replace("${workspaceFolder}", "/w"), args: ["a"], outFiles: ["/w/dist/**/*.js"], sourceMaps: true },
    options,
  );
  assert.deepEqual(adapter, { kind: "js-debug" });
  assert.equal(request.type, "pwa-node");
  assert.equal(request.console, "internalConsole");
  assert.deepEqual(request.skipFiles, ["<node_internals>/**"]);
  assert.deepEqual(request.outFiles, ["/w/dist/**/*.js"]);
  assert.equal(request.cwd, "/w");
  assert.deepEqual(requiredPaths, [{ path: "/w/index.js", what: "program" }]);
  const npm = L.toLaunchRequest({ name: "npm", type: "node", request: "launch", runtimeExecutable: "npm", runtimeArgs: "run-script debug", console: "integratedTerminal" }, options).request;
  assert.equal(npm.runtimeExecutable, "npm");
  assert.deepEqual(npm.runtimeArgs, ["run-script", "debug"]);
  assert.equal(npm.console, "integratedTerminal");
  assert.throws(() => L.toLaunchRequest({ name: "x", type: "node", request: "launch" }, options), /set "program"/);
});

test("node attach: port (default 9229) or processId", () => {
  const byPort = L.toLaunchRequest({ name: "a", type: "pwa-node", request: "attach" }, options).request;
  assert.equal(byPort.port, 9229);
  assert.equal(byPort.address, "localhost");
  const byPid = L.toLaunchRequest({ name: "a", type: "node", request: "attach", processId: 77 }, options).request;
  assert.equal(byPid.processId, "77");
  assert.equal(byPid.port, undefined);
});

test("chrome maps onto js-debug's pwa-chrome", () => {
  const { adapter, request } = L.toLaunchRequest({ name: "c", type: "chrome", request: "launch", url: "http://localhost:3000" }, options);
  assert.equal(adapter.kind, "js-debug");
  assert.equal(request.type, "pwa-chrome");
  assert.equal(request.webRoot, "/w");
  assert.equal(L.toLaunchRequest({ name: "e", type: "msedge", request: "attach" }, options).request.port, 9222);
  assert.throws(() => L.toLaunchRequest({ name: "c", type: "chrome", request: "launch" }, options), /"url"/);
});

test("go: modes, relative program, buildFlags, env, console", () => {
  const debug = L.toLaunchRequest({ name: "g", type: "go", request: "launch", mode: "auto", program: "cmd/app", args: "-v x", env: { G: "1" }, buildFlags: ["-tags", "dev"] }, options);
  assert.deepEqual(debug.adapter, { kind: "go", terminal: false });
  assert.equal(debug.request.program, "/w/cmd/app");
  assert.equal(debug.request.mode, "debug");
  assert.deepEqual(debug.request.args, ["-v", "x"]);
  assert.equal(debug.request.buildFlags, "-tags dev");
  assert.deepEqual(debug.request.env, { G: "1" });
  const test = L.toLaunchRequest({ name: "t", type: "go", request: "launch", mode: "auto", program: "/w/pkg/a_test.go" }, options);
  assert.equal(test.request.mode, "test");
  const exec = L.toLaunchRequest({ name: "e", type: "go", request: "launch", mode: "exec", program: "/w/bin/app", console: "integratedTerminal" }, options);
  assert.equal(exec.request.mode, "exec");
  assert.equal(exec.adapter.terminal, true);
  assert.equal(exec.request.console, undefined);
  assert.equal(L.toLaunchRequest({ name: "a", type: "go", request: "attach", processId: "99" }, options).request.processId, 99);
  assert.throws(() => L.toLaunchRequest({ name: "r", type: "go", request: "attach", mode: "remote" }, options), /isn't supported/);
});

test("lldb / cppdbg / codelldb map onto lldb-dap", () => {
  const cpp = L.toLaunchRequest(
    {
      name: "cpp",
      type: "cppdbg",
      request: "launch",
      program: "/w/build/app",
      stopAtEntry: true,
      environment: [{ name: "X", value: "1" }],
      externalConsole: false,
      MIMode: "lldb",
      setupCommands: [{ text: "-enable-pretty-printing" }],
    },
    options,
  );
  assert.deepEqual(cpp.adapter, { kind: "lldb" });
  assert.equal(cpp.request.type, "lldb-dap");
  assert.equal(cpp.request.stopOnEntry, true);
  assert.deepEqual(cpp.request.env, { X: "1" });
  assert.equal(cpp.request.MIMode, undefined);
  assert.equal(cpp.request.setupCommands, undefined);
  assert.equal(cpp.request.runInTerminal, undefined);
  const cargo = L.toLaunchRequest(
    { name: "rs", type: "lldb", request: "launch", cargo: { args: ["build", "--bin=app"], filter: { name: "app", kind: "bin" } }, terminal: "integrated", sourceMap: { "/rustc": "/src" } },
    options,
  );
  assert.deepEqual(cargo.adapter.cargo, ["build", "--bin=app"]);
  assert.deepEqual(cargo.adapter.cargoFilter, { name: "app", kind: "bin" });
  assert.equal(cargo.adapter.cwd, "/w");
  assert.equal(cargo.request.runInTerminal, true);
  assert.deepEqual(cargo.request.sourceMap, [["/rustc", "/src"]]);
  assert.equal(cargo.request.cargo, undefined);
  assert.equal(L.toLaunchRequest({ name: "at", type: "codelldb", request: "attach", pid: "321" }, options).request.pid, 321);
  assert.throws(() => L.toLaunchRequest({ name: "w", type: "cppvsdbg", request: "launch" }, options), /cppvsdbg/);
});

test("java: launch needs jdtls; attach host/port", () => {
  const launch = L.toLaunchRequest({ name: "j", type: "java", request: "launch", mainClass: "com.x.Main", projectName: "x", args: "a b", vmArgs: "-Xmx1g", env: { J: "1" } }, options);
  assert.equal(launch.adapter.kind, "java");
  assert.equal(launch.needsJdtls, true);
  assert.equal(launch.request.args, "a b", "java-debug takes args as a string");
  assert.equal(launch.request.vmArgs, "-Xmx1g");
  assert.equal(launch.request.console, "integratedTerminal");
  const attach = L.toLaunchRequest({ name: "j", type: "java", request: "attach", port: "5005" }, options);
  assert.equal(attach.request.hostName, "localhost");
  assert.equal(attach.request.port, 5005);
  assert.throws(() => L.toLaunchRequest({ name: "j", type: "java", request: "launch" }, options), /mainClass/);
});

test("unsupported types and bad requests say so", () => {
  assert.throws(() => L.toLaunchRequest({ name: "php", type: "php", request: "launch" }, options), /debug type “php” isn't supported by Sable/);
  assert.throws(() => L.toLaunchRequest({ name: "x", type: "", request: "launch" }, options), /has no "type"/);
  assert.throws(() => L.toLaunchRequest({ name: "x", type: "node", request: "run" }, options), /"request" must be/);
});

// --- Tasks --------------------------------------------------------------------------

const TASKS = `{
  "version": "2.0.0",
  "tasks": [
    { "label": "build", "type": "shell", "command": "make", "args": ["all", "with space"], "group": { "kind": "build", "isDefault": true }, "dependsOn": ["gen", "lint"], "dependsOrder": "sequence" },
    { "label": "gen", "type": "process", "command": "python3", "args": ["gen.py"], "options": { "cwd": "tools", "env": { "G": "1" } } },
    { "label": "lint", "command": "eslint ." },
    { "type": "npm", "script": "test" },
    { "label": "loop", "dependsOn": "loop" },
  ],
}`;

test("parses tasks.json and finds the default build task", () => {
  const file = L.parseTasksJson(TASKS);
  assert.deepEqual(file.tasks.map((task) => task.label), ["build", "gen", "lint", "npm: test", "loop"]);
  assert.equal(L.defaultBuildTask(file.tasks), "build");
});

test("builds task command lines", () => {
  const [build, gen, lint, npm] = L.parseTasksJson(TASKS).tasks;
  assert.equal(L.taskCommandLine(build), "make all 'with space'");
  assert.equal(L.taskCommandLine(gen), "python3 gen.py");
  assert.equal(L.taskCommandLine(lint), "eslint .");
  assert.equal(L.taskCommandLine(npm), "npm run test");
});

test("plans dependsOn (sequence / parallel), detects cycles and unknown tasks", async () => {
  const tasks = L.parseTasksJson(TASKS).tasks;
  const plan = L.planTask("build", tasks);
  assert.equal(plan.sequence, true);
  assert.deepEqual(plan.dependencies.map((dependency) => dependency.task.label), ["gen", "lint"]);
  assert.throws(() => L.planTask("loop", tasks), /depends on itself/);
  assert.throws(() => L.planTask("nope", tasks), /Could not find the task “nope”/);
  assert.equal(L.planTask("npm: dev", tasks, (label) => ({ label, type: "shell", command: "npm run dev" })).task.command, "npm run dev");

  const ran = [];
  await L.runTaskPlan(plan, async (task) => (ran.push(task.label), 0));
  assert.deepEqual(ran, ["gen", "lint", "build"]);
  const failing = [];
  await assert.rejects(
    L.runTaskPlan(plan, async (task) => (failing.push(task.label), task.label === "gen" ? 2 : 0)),
    (error) => error instanceof L.TaskFailed && error.exitCode === 2 && /“gen” failed \(exit code 2\)/.test(error.message),
  );
  assert.deepEqual(failing, ["gen"], "nothing runs after a failed dependency");
});

test("the exit-status wrapper reports the real exit code through a shell", () => {
  for (const [command, code] of [["echo hi", 0], ["exit 3", 3], ["false", 1], ["echo a; (exit 7)", 7]]) {
    const result = spawnSync("/bin/sh", ["-c", L.withExitReport(command)], { encoding: "utf8" });
    assert.equal(result.status, code, command);
    assert.equal(L.exitStatusIn(result.stdout), code, command);
  }
  assert.equal(L.exitStatusIn("no marker"), null);
});

// --- Templates and editing launch.json ------------------------------------------------

test("new launch.json files parse back", () => {
  const text = L.newLaunchJson([L.DEBUGGER_TEMPLATES[0].snippets[0].config]);
  const file = L.parseLaunchJson(text);
  assert.equal(file.configurations[0].type, "debugpy");
  assert.equal(file.errors.length, 0);
});

test("ranks debuggers by the folder's files and the open file", () => {
  assert.equal(L.rankDebuggers(["go.mod"], null)[0].id, "go");
  assert.equal(L.rankDebuggers(["package.json"], "/w/a.py")[0].id, "python");
  assert.equal(L.rankDebuggers([], null)[0].id, "python");
});

test("adds a configuration, keeping comments and formatting", () => {
  const snippet = { name: "Added", type: "node", request: "launch", program: "a.js" };
  for (const original of [
    LAUNCH,
    `{\n  "version": "0.2.0",\n  "configurations": []\n}`,
    `{\n  // c\n  "configurations": [\n    { "name": "One", "type": "go", "request": "launch", "program": "." }\n  ]\n}`,
    `{ "version": "0.2.0" }`,
    "",
  ]) {
    const { text, line } = L.insertConfiguration(original, snippet);
    const file = L.parseLaunchJson(text);
    assert.equal(file.configurations.at(-1).name, "Added", original);
    assert.ok(text.split("\n")[line - 1].includes("{") || text.split("\n")[line - 1].includes('"name"'), `line ${line} points at the new configuration:\n${text}`);
    if (original.includes("// c")) assert.ok(text.includes("// c"), "comments kept");
  }
});

test("the JSON schemas list every debugger type", async () => {
  // launchSchemas imports Monaco's registry; check the snippets feed it instead.
  const types = new Set(L.DEBUGGER_TEMPLATES.flatMap((template) => template.snippets.map((snippet) => snippet.config.type)));
  for (const type of types) assert.doesNotThrow(() => L.toLaunchRequest({ ...L.DEBUGGER_TEMPLATES.flatMap((t) => t.snippets).find((s) => s.config.type === type).config, processId: 1, pid: 1, url: "http://x" }, options), type);
});
