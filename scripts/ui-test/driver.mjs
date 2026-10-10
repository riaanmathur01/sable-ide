// Drives Sable's real frontend in Chrome for UI tests, against the real
// backend: Vite serves the frontend (`npx vite --port 1530`), and
// invoke() goes to the backend bridge (src-tauri/src/ui_bridge.rs, port
// 1531). Commands the bridge can't serve (they need the app window) get
// stand-ins here. See README → Testing.
import puppeteer from "puppeteer-core";

const CHROME = process.env.SABLE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const STANDINS = {
  load_settings: {},
  settings_path: "/tmp/sable-ui-settings.json",
  save_settings: null,
  list_monospace_fonts: ["JetBrains Mono"],
  discover_python_interpreters: [],
  watch_workspace: null,
  load_chats: [],
  ai_key_status: {},
  python_formatter: null,
  java_debug_installed: false,
};

/** Commands neither the bridge nor a stand-in handled. */
export const unknownCommands = new Set();
/** Extra stand-ins for one scenario: command → result, or (args) => result. */
export const extraStandins = {};
/** Every command the page invoked, in order. */
export const calls = [];

export async function openSable(workspace, { width = 1500, height = 950 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width, height },
    args: ["--no-first-run"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.exposeFunction("__sableBridge", async (cmd, args) => {
    calls.push(cmd);
    if (cmd in extraStandins) {
      const value = extraStandins[cmd];
      return { ok: typeof value === "function" ? await value(args) : value };
    }
    if (cmd in STANDINS) return { ok: STANDINS[cmd] };
    // No language servers here: fail fast, as the app does without one.
    if (cmd === "lsp_request" || cmd === "start_language_server") return { err: "No language server running" };
    const response = await fetch("http://127.0.0.1:1531/invoke", { method: "POST", body: JSON.stringify({ cmd, args }) });
    const result = await response.json();
    if (result.unknown) {
      unknownCommands.add(cmd);
      return { ok: null };
    }
    return result;
  });
  await page.evaluateOnNewDocument((workspace) => {
    localStorage.setItem("sable.lastFolder", workspace);
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    window.__sableEmit = (event, payload) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id: 0, payload });
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      convertFileSrc: (path) => path,
      async invoke(cmd, args = {}) {
        if (cmd === "plugin:event|listen") {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          return args.handler;
        }
        if (cmd === "plugin:path|resolve_directory") return "/tmp";
        if (cmd === "plugin:path|join") return args.paths.join("/").replace(/\/+/g, "/");
        if (cmd.startsWith("plugin:")) return null;
        const result = await window.__sableBridge(cmd, args ?? {});
        if ("err" in result) throw result.err;
        return result.ok;
      },
    };
  }, workspace);
  await page.goto("http://localhost:1530/", { waitUntil: "networkidle0" });
  return { browser, page, errors };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Click the innermost visible element whose text matches (string or RegExp). */
export async function clickText(page, text, selector = "*") {
  const handle = await page.evaluateHandle(
    (text, selector) => {
      const matches = (value) => (text.startsWith("/") ? new RegExp(text.slice(1, -1)).test(value) : value === text);
      const all = [...document.querySelectorAll(selector)].filter(
        (element) => element.offsetParent !== null && matches((element.innerText ?? element.textContent ?? "").trim()),
      );
      return all.find((element) => !all.some((other) => other !== element && element.contains(other))) ?? null;
    },
    text instanceof RegExp ? `/${text.source}/` : text,
    selector,
  );
  const element = handle.asElement();
  if (!element) throw new Error(`No element with text ${text}`);
  await element.click();
  return element;
}

export async function texts(page, selector) {
  return page.$$eval(selector, (elements) => elements.map((element) => element.innerText.trim()));
}

/** Screen point of a 1-based editor line's gutter. */
export async function gutterPoint(page, line) {
  return page.evaluate((line) => {
    const lines = [...document.querySelectorAll(".monaco-editor .margin-view-overlays > div")].sort(
      (a, b) => parseFloat(a.style.top) - parseFloat(b.style.top),
    );
    const box = lines[line - 1].getBoundingClientRect();
    return { x: box.left + 8, y: box.top + box.height / 2 };
  }, line);
}
