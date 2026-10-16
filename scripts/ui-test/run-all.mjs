// Runs every UI test suite in this folder and prints one PASS/FAIL/SKIP line
// per suite (with the names of its failing checks). It starts Vite once,
// and for each suite that needs the backend a fresh bridge
// (src-tauri/src/ui_bridge.rs) with fresh plugins and history folders, so
// suites can't see each other's plugins, settings or Node plugin hosts.
//
//   node scripts/ui-test/run-all.mjs [--only a,b] [--skip a,b] [--list] [--verbose] [--keep-going-on-crash]
//
// Ports: SABLE_RUN_VITE_PORT (default 1550) and SABLE_RUN_BRIDGE_PORT
// (default 1551). Each suite's output goes to a log in the run folder
// (printed at the end; SABLE_RUN_DIR to choose it), with its screenshots.
// --verbose also streams it.
//
// Suites whose prerequisites are missing are skipped, saying why:
//   notebook       SABLE_TEST_JUPYTER_PYTHON=/venv/bin/python (with ipykernel)
//   refactorings   SABLE_TEST_ROPE_PYTHON=/venv/bin/python (with rope)
//   launch-json    SABLE_TEST_PYTHON (default python3) with debugpy
//   database       python3 (its sqlite3 module)
//   popular-plugins, vscode-real   the network (npm registry / Open VSX)
// A suite may also skip itself by exiting with code 3 after printing
// "skipped: <why>".
//
// Exit code: 0 when nothing failed (skips are fine), 1 otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const VITE_PORT = process.env.SABLE_RUN_VITE_PORT ?? "1550";
const BRIDGE_PORT = process.env.SABLE_RUN_BRIDGE_PORT ?? "1551";
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "").split(",").filter(Boolean) : null;
};
const verbose = args.includes("--verbose");

// --- Prerequisites ------------------------------------------------------------------------
const canRun = (program, programArgs) => spawnSync(program, programArgs, { stdio: "ignore", timeout: 30000 }).status === 0;
const pythonWith = (python, module) => (python && canRun(python, ["-c", `import ${module}`]) ? null : `${python ?? "python"} can't import ${module}`);
const reachable = async (url) => {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
};
const needs = {
  jupyter: () =>
    process.env.SABLE_TEST_JUPYTER_PYTHON
      ? pythonWith(process.env.SABLE_TEST_JUPYTER_PYTHON, "ipykernel")
      : "set SABLE_TEST_JUPYTER_PYTHON to a Python with ipykernel",
  rope: () => (process.env.SABLE_TEST_ROPE_PYTHON ? pythonWith(process.env.SABLE_TEST_ROPE_PYTHON, "rope") : "set SABLE_TEST_ROPE_PYTHON to a virtualenv's Python with rope"),
  debugpy: () => {
    const python = process.env.SABLE_TEST_PYTHON ?? "python3";
    return pythonWith(python, "debugpy") && `${python} lacks debugpy (set SABLE_TEST_PYTHON to a Python with it)`;
  },
  sqlite: () => pythonWith(process.env.SABLE_TEST_PYTHON ?? "python3", "sqlite3"),
  git: () => (canRun("git", ["--version"]) ? null : "git isn't installed"),
  npm: async () => (!canRun("npm", ["--version"]) ? "npm isn't installed" : (await reachable("https://registry.npmjs.org/eslint")) ? null : "no network (the npm registry is unreachable)"),
  openVsx: async () => ((await reachable("https://open-vsx.org/api/aaron-bond/better-comments")) ? null : "no network (Open VSX is unreachable)"),
};

// --- The suites ---------------------------------------------------------------------------
// browser: needs Vite and a bridge. requires: prerequisite checks (each
// returns null or why it's missing). timeout in minutes.
const SUITES = [
  // No browser: plugins in a fake host, the refactoring engines.
  { name: "plugin-units", browser: false },
  { name: "plugin-smoke", browser: false },
  { name: "refactorings-engines", browser: false },
  // The restored suites.
  { name: "view-switcher" },
  { name: "agents" },
  { name: "marketplace" },
  { name: "plugin-details" },
  { name: "rename" },
  { name: "plugin-api" },
  { name: "keybindings-vim" },
  { name: "plugins" },
  { name: "update" },
  { name: "remote" },
  { name: "multi-root", requires: [needs.git] },
  { name: "color-picker" },
  { name: "theme-disable" },
  { name: "pets" },
  { name: "vscode-convert" },
  { name: "vscode-real", requires: [needs.openVsx], timeout: 15 },
  // The suites that were already in the repository.
  { name: "editor-extras" },
  { name: "claude-code-cli" },
  { name: "github", requires: [needs.git] },
  { name: "database", requires: [needs.sqlite], timeout: 15 },
  { name: "launch-json", requires: [needs.debugpy], timeout: 15 },
  { name: "notebook", requires: [needs.jupyter], timeout: 15 },
  { name: "refactorings", requires: [needs.rope], timeout: 15 },
  { name: "popular-plugins", requires: [needs.npm], timeout: 20 },
];

if (args.includes("--list")) {
  for (const suite of SUITES) console.log(suite.name);
  process.exit(0);
}
const only = option("--only");
const skipped = option("--skip") ?? [];
for (const name of [...(only ?? []), ...skipped]) {
  if (!SUITES.some((suite) => suite.name === name)) {
    console.error(`No suite named ${name} (--list lists them)`);
    process.exit(2);
  }
}
const selected = SUITES.filter((suite) => (!only || only.includes(suite.name)) && !skipped.includes(suite.name));
for (const suite of selected) {
  if (!fs.existsSync(path.join(here, `${suite.name}.mjs`))) {
    console.error(`Missing ${suite.name}.mjs`);
    process.exit(2);
  }
}

const runDir = process.env.SABLE_RUN_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "sable-ui-run-"));
fs.mkdirSync(runDir, { recursive: true });

// --- Processes ------------------------------------------------------------------------------
const children = new Set();
/** Start a process in its own process group (so it and its children can be killed together). */
function start(command, commandArgs, options) {
  const child = spawn(command, commandArgs, { ...options, detached: true });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
const cleanup = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
};
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
async function waitUntil(test, what, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The bridge: build the backend's test binary once, then run it directly.
let bridgeBinary = null;
function buildBridge() {
  console.log("building the bridge (cargo test --lib --no-run)…");
  const output = execFileSync("cargo", ["test", "--lib", "--no-run", "--message-format=json"], {
    cwd: path.join(repo, "src-tauri"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.profile?.test && message.target?.name === "sable_lib" && message.executable) bridgeBinary = message.executable;
  }
  if (!bridgeBinary) throw new Error("couldn't find the backend's test binary");
}
async function startBridge(suiteDir) {
  const plugins = path.join(suiteDir, "plugins");
  const history = path.join(suiteDir, "history");
  const agents = path.join(suiteDir, "agents");
  const files = path.join(suiteDir, "files");
  for (const dir of [plugins, history, agents, files]) fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(suiteDir, "bridge.log"), "w");
  const child = start(bridgeBinary, ["ui_bridge::ui_bridge", "--exact", "--ignored", "--nocapture"], {
    cwd: path.join(repo, "src-tauri"),
    // Agents (ACP): their own folder, and a stand-in registry the suite can
    // put in files/ (served by the bridge at /files/).
    env: {
      ...process.env,
      SABLE_UI_BRIDGE_PORT: BRIDGE_PORT,
      SABLE_UI_PLUGINS_DIR: plugins,
      SABLE_UI_HISTORY_DIR: history,
      SABLE_UI_AGENTS_DIR: agents,
      SABLE_UI_FILES_DIR: files,
      SABLE_ACP_REGISTRY_URL: `http://127.0.0.1:${BRIDGE_PORT}/files/registry.json`,
      FAKE_ACP_STATE: path.join(suiteDir, "fake-acp-state"),
      // Claude Code: a fake claude CLI (never the real one in tests).
      SABLE_CLAUDE_PATH: path.join(here, "fixtures", "fake-claude-cli.mjs"),
      FAKE_CLAUDE_STATE: path.join(suiteDir, "fake-claude-state"),
      // CLAUDE_CONFIG_DIR: the Claude Code IDE server's lock files go to the
      // suite's folder, never the real ~/.claude/ide.
      CLAUDE_CONFIG_DIR: path.join(suiteDir, "claude-config"),
    },
    stdio: ["ignore", log, log],
  });
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`the bridge exited (see ${suiteDir}/bridge.log)`);
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/invoke`, { method: "POST", body: JSON.stringify({ cmd: "plugin_list", args: {} }) });
      return response.ok;
    } catch {
      return false;
    }
  }, "the bridge");
  return child;
}

let vite = null;
async function startVite() {
  const log = fs.openSync(path.join(runDir, "vite.log"), "a");
  vite = start("npx", ["vite", "--port", VITE_PORT, "--strictPort"], { cwd: repo, stdio: ["ignore", log, log] });
  await waitUntil(async () => {
    if (vite.exitCode !== null) throw new Error(`Vite exited (see ${runDir}/vite.log)`);
    try {
      return (await fetch(`http://localhost:${VITE_PORT}/`)).ok;
    } catch {
      return false;
    }
  }, "Vite");
  // Warm up: the first page load makes Vite optimize the app's
  // dependencies (and then reload the page), which shouldn't happen in
  // the middle of a suite.
  const warm = fs.mkdtempSync(path.join(runDir, "warm-"));
  const bridge = await startBridge(warm);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sable-warm-"));
  try {
    const script = `import { openSable, sleep } from ${JSON.stringify(path.join(here, "driver.mjs"))};
      const { browser } = await openSable(${JSON.stringify(workspace)});
      await sleep(4000);
      await browser.close();`;
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, SABLE_UI_VITE_PORT: VITE_PORT, SABLE_UI_BRIDGE_PORT: BRIDGE_PORT },
      stdio: "ignore",
      timeout: 120000,
    });
  } finally {
    await stop(bridge);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// --- Run --------------------------------------------------------------------------------------
function runSuite(suite, suiteDir, env) {
  return new Promise((resolve) => {
    const logFile = path.join(suiteDir, "output.log");
    const log = fs.createWriteStream(logFile);
    const child = start(process.execPath, [path.join(here, `${suite.name}.mjs`)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk) => {
      output += chunk;
      log.write(chunk);
      if (verbose) process.stdout.write(chunk.toString().replace(/^/gm, `  [${suite.name}] `));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const minutes = suite.timeout ?? 10;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stop(child);
    }, minutes * 60000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ code: timedOut ? null : code, output, timedOut, logFile, minutes });
    });
  });
}

const for_ = (ms) => `${(ms / 1000).toFixed(0)}s`;
const results = [];
const started = Date.now();
let checkedPorts = false;
for (const suite of selected) {
  const t0 = Date.now();
  const report = (status, detail = "", extra = []) => {
    const line = `${status.padEnd(4)} ${suite.name.padEnd(22)} ${for_(Date.now() - t0).padStart(5)}${detail ? `  ${detail}` : ""}`;
    console.log(line);
    for (const item of extra) console.log(`       ${item}`);
    results.push({ name: suite.name, status, detail, extra });
  };
  // Prerequisites.
  let missing = null;
  for (const requirement of suite.requires ?? []) {
    missing = await requirement();
    if (missing) break;
  }
  if (missing) {
    report("SKIP", `skipped: ${missing}`);
    continue;
  }
  const suiteDir = path.join(runDir, suite.name);
  fs.rmSync(suiteDir, { recursive: true, force: true });
  fs.mkdirSync(suiteDir, { recursive: true });
  const env = { ...process.env, SHOTS: path.join(suiteDir, "shots") };
  let bridge = null;
  try {
    if (suite.browser !== false) {
      if (!checkedPorts) {
        for (const port of [VITE_PORT, BRIDGE_PORT]) {
          if (await portInUse(port)) throw new Error(`port ${port} is in use (set SABLE_RUN_VITE_PORT / SABLE_RUN_BRIDGE_PORT)`);
        }
        checkedPorts = true;
      }
      if (!bridgeBinary) buildBridge();
      if (!vite || vite.exitCode !== null) {
        console.log(`starting Vite on ${VITE_PORT}…`);
        await startVite();
      }
      bridge = await startBridge(suiteDir);
      Object.assign(env, {
        SABLE_UI_VITE_PORT: VITE_PORT,
        SABLE_UI_BRIDGE_PORT: BRIDGE_PORT,
        SABLE_UI_PLUGINS_DIR: path.join(suiteDir, "plugins"),
        SABLE_UI_AGENTS_DIR: path.join(suiteDir, "agents"),
        SABLE_UI_FILES_DIR: path.join(suiteDir, "files"),
        FAKE_ACP_STATE: path.join(suiteDir, "fake-acp-state"),
        FAKE_CLAUDE_STATE: path.join(suiteDir, "fake-claude-state"),
        // Claude Code IDE integration: lock files go to the suite's folder,
        // never the real ~/.claude/ide.
        CLAUDE_CONFIG_DIR: path.join(suiteDir, "claude-config"),
      });
    }
    const result = await runSuite(suite, suiteDir, env);
    const lines = result.output.split("\n");
    const failing = lines.filter((line) => /^\s*FAIL\b/.test(line)).map((line) => `FAIL ${line.replace(/^\s*FAIL\s+/, "")}`);
    const known = lines.filter((line) => /^\s*KNOWN\b/.test(line)).map((line) => `KNOWN ${line.replace(/^\s*KNOWN\s+/, "")}`);
    const skipLine = lines.find((line) => /^\s*skipped:/i.test(line));
    if (result.timedOut) report("FAIL", `timed out after ${result.minutes} min (log: ${result.logFile})`, failing);
    else if (result.code === 3) report("SKIP", skipLine?.trim() ?? "skipped (exit code 3)");
    else if (result.code === 0) report("PASS", known.length ? `${known.length} known failure(s) (app bugs)` : "", known);
    else {
      // A crash (an uncaught error) rather than failed checks: show its message.
      const crash = failing.length ? [] : [lines.filter((line) => /Error|error:/.test(line)).slice(0, 2).join(" / ").slice(0, 300) || `exit code ${result.code}`];
      report("FAIL", `(log: ${result.logFile})`, [...failing, ...crash.map((line) => `crashed: ${line}`), ...known]);
    }
  } catch (error) {
    report("FAIL", `couldn't run: ${error.message}`);
  } finally {
    await stop(bridge);
  }
}
await stop(vite);

const count = (status) => results.filter((result) => result.status === status).length;
console.log(
  `\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped — ${for_(Date.now() - started)} in all. Logs and screenshots: ${runDir}`,
);
process.exit(count("FAIL") ? 1 : 0);
