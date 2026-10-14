// Shared helpers for the UI test suites in this folder (the ones that drive
// the frontend through driver.mjs): check() reporting, temp fixtures, the
// bridge, a local HTTP file server (a stand-in marketplace), plugin
// archives, Tauri plugin stand-ins (dialogs, app version…) and keyboard
// helpers. Nothing here starts Vite or the bridge — see run-all.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sleep } from "./driver.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGINS = path.join(REPO, "plugins");
export const BRIDGE_PORT = process.env.SABLE_UI_BRIDGE_PORT ?? "1531";

/**
 * check(name, condition, detail?) prints "  ok  name" or "  FAIL name — detail".
 * known(name, condition, bug, detail?) is a check that fails because of a
 * known app bug: printed as "  KNOWN name" (not counted as a failure) while
 * it fails, and "  FIXED? name" once it passes.
 * finish() prints the summary and exits (1 on a failure).
 */
export function checker() {
  const failures = [];
  const knownFailures = [];
  const short = (detail) => (detail === undefined || detail === "" ? "" : `  — ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
  const check = (name, condition, detail) => {
    if (condition) console.log(`  ok  ${name}`);
    else {
      console.log(`  FAIL ${name}${short(detail)}`);
      failures.push(name);
    }
    return Boolean(condition);
  };
  const known = (name, condition, bug, detail) => {
    if (condition) console.log(`  FIXED? ${name} (was a known app bug: ${bug})`);
    else {
      console.log(`  KNOWN ${name} — app bug: ${bug}${short(detail)}`);
      knownFailures.push(name);
    }
  };
  const finish = () => {
    if (knownFailures.length) console.log(`\n${knownFailures.length} known failure(s) (app bugs): ${knownFailures.join("; ")}`);
    if (failures.length) {
      console.log(`\n${failures.length} failed`);
      process.exit(1);
    }
    console.log("\nall passed");
    process.exit(0);
  };
  return { check, known, finish, failures, knownFailures };
}

/** A fresh temp folder (its real path: macOS's /var is /private/var). */
export function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sable-${prefix}-`)));
}

/** Write files under root: { "relative/path": "contents" }. */
export function writeTree(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

/** Screenshots folder (SHOTS, or a temp one per suite). */
export function shotsDir(name) {
  const dir = process.env.SHOTS ?? path.join(os.tmpdir(), `sable-${name}-shots`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Call a backend command on the bridge directly (not through the page). */
export async function bridge(cmd, args = {}) {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/invoke`, { method: "POST", body: JSON.stringify({ cmd, args }) });
  const result = await response.json();
  if (result.unknown) throw new Error(`the bridge doesn't serve ${cmd}`);
  if ("err" in result) throw new Error(`${cmd}: ${result.err}`);
  return result.ok;
}

/** Uninstall every plugin the bridge has installed (a clean plugins folder). */
export async function uninstallAllPlugins() {
  for (const plugin of await bridge("plugin_list")) {
    await bridge("plugin_node_stop", { id: plugin.manifest.id }).catch(() => {});
    await bridge("plugin_uninstall", { id: plugin.manifest.id }).catch(() => {});
  }
}

/**
 * Serve a folder over HTTP on a free local port. `routes` may add
 * handlers: { "/path": (req, res) => … }. Returns { port, url, close }.
 */
export async function serveFolder(root, routes = {}) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (routes[pathname]) return routes[pathname](req, res);
    const file = path.join(root, pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const type = file.endsWith(".json") ? "application/json" : file.endsWith(".md") ? "text/markdown" : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Copy a folder (a plugin from plugins/, say) to `to`. */
export function copyFolder(from, to) {
  fs.cpSync(from, to, { recursive: true });
  return to;
}

/** Pack a plugin folder into a .tar.gz (its files at the archive's top). */
export function tarGz(folder, out) {
  execFileSync("tar", ["-czf", out, "-C", folder, "."]);
  return out;
}

/**
 * An init script (for openSable's `init`) answering Tauri plugin calls the
 * driver doesn't: { "plugin:dialog|message": "Yes", … }. Values are
 * returned as they are; runs in every page load (so it survives reloads).
 */
export function tauriStandins(answers) {
  return `(() => {
    if (window !== window.top) return;
    const answers = ${JSON.stringify(answers)};
    const internals = window.__TAURI_INTERNALS__;
    const original = internals.invoke;
    window.__tauriCalls = [];
    internals.invoke = async (cmd, args) => {
      if (cmd.startsWith("plugin:")) window.__tauriCalls.push({ cmd, args });
      if (cmd in answers) return answers[cmd];
      return original(cmd, args);
    };
  })()`;
}

/** Press a key with modifiers held: combo(page, ["Meta", "Shift"], "KeyP"). */
export async function combo(page, mods, key, settle = 300) {
  for (const mod of mods) await page.keyboard.down(mod);
  await page.keyboard.press(key);
  for (const mod of [...mods].reverse()) await page.keyboard.up(mod);
  await sleep(settle);
}

/** Open the command palette (⇧⌘P). */
export async function openPalette(page) {
  await combo(page, ["Meta", "Shift"], "KeyP");
}

/** Run a palette command by typing its title and pressing Enter. Returns the first item offered. */
export async function palette(page, text, settle = 800) {
  await openPalette(page);
  await page.keyboard.type(text);
  await sleep(400);
  const first = await page.$$eval("[data-index]", (items) => items[0]?.innerText.trim() ?? null).catch(() => null);
  await page.keyboard.press("Enter");
  await sleep(settle);
  return first;
}

/** Poll fn in the page until it returns something truthy (or time out with null). */
export async function waitFor(page, fn, args = [], { timeout = 15000, interval = 200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await page.evaluate(fn, ...args).catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

/** Open a file in the editor through the app's tabs store. */
export function openFile(page, file) {
  return page.evaluate(async (file) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(file);
  }, file);
}

/** The active editor's text. */
export function editorText(page) {
  return page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.getValue() ?? null);
}

/** Focus the active editor and put the cursor at a 1-based line/column. */
export function setCursor(page, lineNumber, column) {
  return page.evaluate(
    async (lineNumber, column) => {
      const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
      editor.focus();
      editor.setPosition({ lineNumber, column });
    },
    lineNumber,
    column,
  );
}

/** Errors worth failing on (resources that 404 are expected: no favicon, no README…). */
export function realErrors(errors) {
  return errors.filter((error) => !/404|Failed to load resource/.test(error));
}

/** The plugin store's state, summarised (ids, states, errors). */
export function pluginSummary(page) {
  return page.evaluate(async () => {
    const state = (await import("/src/store/pluginStore.ts")).usePluginStore.getState();
    return { ids: state.plugins.map((p) => p.manifest.id), states: state.states, errors: state.errors };
  });
}
