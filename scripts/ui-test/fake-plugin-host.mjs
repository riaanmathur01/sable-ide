// A fake Sable plugin host for Node: the `sable` object a plugin's
// activate(sable) gets in the real app (src/lib/plugins/workerBootstrap.ts
// builds it; host.ts / hostExtras.ts answer its calls), with an in-memory
// editor, workspace, storage and clipboard instead of Monaco and the
// backend. Every call is recorded. Used by plugin-smoke.mjs and
// plugin-units.mjs; no browser, Vite or bridge needed.
//
// As in the real host:
//  - main.js is loaded as a single ES module (from source, so it can't
//    import other files) and must export activate(sable);
//  - every API method returns a Promise, except register*/on* which return
//    a Disposable at once;
//  - calls needing a permission the manifest lacks fail with the host's
//    message (recorded in state.permissionErrors);
//  - editor.active() gives a selection even when nothing is selected (an
//    empty one at the cursor), with 1-based UTF-16 line/columns;
//  - showQuickPick resolves to the item passed in (or null), showInputBox
//    to a string (or null);
//  - workspace.readFile of a missing file fails with "File not found: …".
import fs from "node:fs";
import path from "node:path";

let loads = 0;

/** A plugin folder's manifest and module (a fresh module instance each time). */
export async function loadPlugin(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "sable-plugin.json"), "utf8"));
  const source = fs.readFileSync(path.join(dir, manifest.main ?? "main.js"), "utf8");
  // A data: URL, as the worker imports a blob: URL: no relative imports, and
  // a unique comment so module-level state isn't shared between loads.
  const url = `data:text/javascript;base64,${Buffer.from(`${source}\n//# load ${++loads}`).toString("base64")}`;
  const module = await import(url);
  return { manifest, module };
}

/** Text with markers → { text, selection: [start, end] } (offsets). "⟦…⟧" marks a selection, "‸" a cursor. */
export function marked(input) {
  const cursor = input.indexOf("‸");
  if (cursor >= 0) return { text: input.replace("‸", ""), selection: [cursor, cursor] };
  const open = input.indexOf("⟦");
  const close = input.indexOf("⟧");
  if (open >= 0 && close > open) return { text: input.replace("⟦", "").replace("⟧", ""), selection: [open, close - 1] };
  return { text: input, selection: [0, 0] };
}

/** 0-based offset ↔ 1-based { line, column }. */
export function positionAt(text, offset) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
}
export function offsetAt(text, position, invalid) {
  const lines = text.split("\n");
  const line = Math.trunc(position?.line);
  const column = Math.trunc(position?.column);
  if (!(line >= 1 && line <= lines.length && column >= 1 && column <= lines[line - 1].length + 1)) {
    invalid?.(position);
  }
  // Monaco clamps out-of-range positions.
  const l = Math.min(Math.max(1, line || 1), lines.length);
  const c = Math.min(Math.max(1, column || 1), lines[l - 1].length + 1);
  let offset = 0;
  for (let i = 0; i < l - 1; i++) offset += lines[i].length + 1;
  return offset + c - 1;
}

const PERMISSIONS = {
  "editor.active": "editor",
  "editor.replaceSelection": "editor",
  "editor.setText": "editor",
  "editor.applyEdits": "editor",
  "editor.setSelection": "editor",
  "editor.executeAction": "editor",
  "editor.open": "workspace:read",
  "editor.createDecorationType": "editor",
  "editor.setDecorations": "editor",
  "languages.registerFormatter": "editor",
  "languages.registerCompletions": "editor",
  "languages.registerHover": "editor",
  "languages.registerRenameSuggestions": "editor",
  "languages.setDiagnostics": "editor",
  "languages.clearDiagnostics": "editor",
  "workspace.readFile": "workspace:read",
  "workspace.listFiles": "workspace:read",
  "workspace.listDirectory": "workspace:read",
  "workspace.writeFile": "workspace:write",
  "workspace.createDirectory": "workspace:write",
  "workspace.delete": "workspace:write",
  "workspace.rename": "workspace:write",
  "terminal.create": "shell",
  "terminal.sendText": "shell",
  "terminal.show": "shell",
  "terminal.dispose": "shell",
  "shell.run": "shell",
};

const EVENT_NAMES = {
  onDidSave: "didSave",
  onDidOpen: "didOpen",
  onDidChange: "didChange",
  onDidChangeContent: "didChangeContent",
  onDidChangeActiveEditor: "didChangeActiveEditor",
  onDidChangeSelection: "didChangeSelection",
  onDidChangeDiagnostics: "didChangeDiagnostics",
};

/** Let pending promise callbacks (and un-awaited plugin calls) run. */
export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A fake host. Options:
 *  manifest     the plugin's manifest (permissions are enforced)
 *  doc          { path, language, text, selection: [start, end] offsets } or null (no file open);
 *               `text` may use marked()'s markers instead of `selection`
 *  root         the open folder (default "/work"; null for none)
 *  files        { "relative/path": "text" } in the folder
 *  storage      initial storage values
 *  pick         (items, placeholder) → index or null (default: 0, the first item)
 *  input        (options) → string or null (default: options.value || "sable")
 *  clipboard    initial clipboard text
 */
export function createHost(options = {}) {
  const manifest = options.manifest ?? { id: "test", name: "Test", version: "1.0.0", permissions: [] };
  const root = options.root === undefined ? "/work" : options.root;
  const state = {
    calls: [],
    commands: new Map(),
    providers: [],
    listeners: new Map(),
    diagnostics: new Map(),
    status: null,
    messages: [],
    errors: [],
    warnings: [],
    picks: [],
    inputs: [],
    clipboard: options.clipboard ?? "",
    external: [],
    opened: [],
    storage: new Map(Object.entries(structuredClone(options.storage ?? {}))),
    files: new Map(Object.entries(options.files ?? {})),
    edits: [],
    decorations: new Map(),
    webviews: new Map(),
    views: [],
    terminals: [],
    shell: [],
    actions: [],
    permissionErrors: [],
    invalidRanges: [],
    doc: null,
  };
  const setDoc = (doc) => {
    if (!doc) return (state.doc = null);
    const m = doc.selection ? { text: doc.text, selection: doc.selection } : marked(doc.text ?? "");
    state.doc = { path: doc.path ?? "/work/file.txt", language: doc.language ?? "plaintext", text: m.text, selection: [...m.selection] };
  };
  setDoc(options.doc === undefined ? { text: "" } : options.doc);

  /** What editor.active() answers: the document, its selection as positions. */
  const snapshot = () => {
    const doc = state.doc;
    if (!doc) return null;
    const [a, b] = doc.selection;
    return {
      path: doc.path,
      language: doc.language,
      text: doc.text,
      selection: { start: positionAt(doc.text, a), end: positionAt(doc.text, b), text: doc.text.slice(a, b) },
    };
  };
  const pick = options.pick ?? (() => 0);
  const input = options.input ?? ((o) => (typeof o?.value === "string" && o.value ? o.value : "sable"));

  const record = (method, args) => state.calls.push({ method, args });
  const require = (method) => {
    const permission = PERMISSIONS[method];
    if (!permission || manifest.permissions.includes("node") || manifest.permissions.includes(permission)) return null;
    const error = new Error(`${manifest.name} doesn't have the "${permission}" permission (add it to sable-plugin.json's "permissions")`);
    state.permissionErrors.push({ method, permission });
    return error;
  };
  /** An async API call: recorded, permission-checked, answered by `fn`. */
  const call = (method, fn) =>
    async (...args) => {
      record(method, args);
      const denied = require(method);
      if (denied) throw denied;
      return fn(...args);
    };
  const disposable = (onDispose) => ({ dispose: async () => void onDispose() });
  const invalid = (position) => state.invalidRanges.push(position);
  const docOrThrow = () => {
    if (!state.doc) throw new Error("No file is open");
    return state.doc;
  };
  /** Paths relative to the folder, or absolute inside it. */
  const relative = (p) => {
    if (!root) throw new Error("No folder is open");
    const text = String(p);
    if (text.startsWith(root + "/")) return text.slice(root.length + 1);
    if (path.isAbsolute(text)) throw new Error(`${text} is outside the open folder`);
    return path.posix.normalize(text);
  };
  const register = (method, entry) => {
    record(method, Object.values(entry));
    const denied = require(method);
    // The real register call is fire-and-forget: a denied one just doesn't register.
    if (denied) return disposable(() => {});
    state.providers.push(entry);
    return disposable(() => (state.providers = state.providers.filter((p) => p !== entry)));
  };

  const sable = Object.freeze({
    manifest,
    version: "0.4.0",
    commands: {
      register(id, title, run, opts = {}) {
        record("commands.register", [id, title, opts]);
        if (typeof run !== "function") throw new TypeError("Expected a function");
        const entry = { id: String(id), title: String(title), run, hidden: Boolean(opts.hidden) };
        state.commands.set(entry.id, entry);
        return disposable(() => state.commands.get(entry.id) === entry && state.commands.delete(entry.id));
      },
      execute: call("commands.execute", async (id) => {
        const command = state.commands.get(String(id));
        if (!command) throw new Error(`No command ${String(id)}`);
        await command.run();
        return null;
      }),
    },
    window: {
      showMessage: call("window.showMessage", (text) => void state.messages.push(String(text))),
      showError: call("window.showError", (text) => void state.errors.push(String(text))),
      showWarning: call("window.showWarning", (text) => void state.warnings.push(String(text))),
      showInputBox: call("window.showInputBox", async (opts = {}) => {
        state.inputs.push(opts);
        const answer = await input(opts);
        return typeof answer === "string" ? answer : null;
      }),
      showQuickPick: call("window.showQuickPick", async (items, opts = {}) => {
        const list = Array.isArray(items) ? items : [];
        state.picks.push({ items: list, placeholder: opts.placeholder ?? "" });
        if (!list.length) return null;
        // The real host shows labels: an item without one would be blank.
        const index = await pick(list, opts.placeholder ?? "");
        return typeof index === "number" ? (list[index] ?? null) : null;
      }),
    },
    statusBar: {
      set: call("statusBar.set", (text, opts = {}) => void (state.status = { text: String(text), ...opts })),
      clear: call("statusBar.clear", () => void (state.status = null)),
    },
    editor: {
      active: call("editor.active", () => snapshot()),
      replaceSelection: call("editor.replaceSelection", (text) => {
        const doc = docOrThrow();
        const [a, b] = doc.selection;
        state.edits.push({ kind: "replaceSelection", text: String(text) });
        doc.text = doc.text.slice(0, a) + String(text) + doc.text.slice(b);
        const end = a + String(text).length;
        doc.selection = [end, end];
      }),
      setText: call("editor.setText", (text) => {
        const doc = docOrThrow();
        state.edits.push({ kind: "setText", text: String(text) });
        doc.text = String(text);
        doc.selection = doc.selection.map((o) => Math.min(o, doc.text.length));
      }),
      applyEdits: call("editor.applyEdits", (edits) => {
        const doc = docOrThrow();
        const list = (Array.isArray(edits) ? edits : []).map((edit) => ({
          start: offsetAt(doc.text, edit.range?.start, invalid),
          end: offsetAt(doc.text, edit.range?.end, invalid),
          text: String(edit.text ?? ""),
        }));
        state.edits.push({ kind: "applyEdits", edits });
        // Ranges refer to the text before any of the edits.
        let text = doc.text;
        for (const edit of [...list].sort((x, y) => y.start - x.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        doc.text = text;
        doc.selection = doc.selection.map((o) => Math.min(o, text.length));
      }),
      setSelection: call("editor.setSelection", (range) => {
        const doc = docOrThrow();
        doc.selection = [offsetAt(doc.text, range?.start, invalid), offsetAt(doc.text, range?.end, invalid)];
      }),
      executeAction: call("editor.executeAction", (id) => void state.actions.push(String(id))),
      open: call("editor.open", (p, opts = {}) => {
        const rel = relative(p);
        state.opened.push({ path: rel, line: opts.line ?? 0 });
        if (state.files.has(rel)) setDoc({ path: `${root}/${rel}`, text: state.files.get(rel) });
      }),
      createDecorationType: call("editor.createDecorationType", (key, opts) => void state.decorations.set(String(key), { options: opts, items: [] })),
      setDecorations: call("editor.setDecorations", (p, key, items) => {
        const entry = state.decorations.get(String(key)) ?? { options: null, items: [] };
        entry.items = items ?? [];
        entry.path = p;
        state.decorations.set(String(key), entry);
      }),
      disposeDecorationType: call("editor.disposeDecorationType", (key) => void state.decorations.delete(String(key))),
    },
    terminal: {
      create: call("terminal.create", (opts = {}) => {
        state.terminals.push({ options: opts, text: [] });
        return `terminal-${state.terminals.length}`;
      }),
      sendText: call("terminal.sendText", (id, text) => void state.terminals[Number(String(id).split("-")[1]) - 1]?.text.push(String(text))),
      show: call("terminal.show", () => null),
      dispose: call("terminal.dispose", () => null),
    },
    webview: {
      create: call("webview.create", (id, opts, listener) => {
        if (typeof listener !== "function") throw new TypeError("Expected a function");
        state.webviews.set(String(id), { options: opts ?? {}, listener, html: "", title: opts?.title ?? "", messages: [] });
      }),
      setHtml: call("webview.setHtml", (id, html) => {
        const view = state.webviews.get(String(id));
        if (!view) throw new Error(`No webview ${id}`);
        view.html = String(html);
      }),
      setTitle: call("webview.setTitle", (id, title) => {
        const view = state.webviews.get(String(id));
        if (view) view.title = String(title);
      }),
      postMessage: call("webview.postMessage", (id, message) => {
        const view = state.webviews.get(String(id));
        if (!view) return false;
        view.messages.push(structuredClone(message));
        return true;
      }),
      reveal: call("webview.reveal", () => null),
      dispose: call("webview.dispose", async (id) => {
        const view = state.webviews.get(String(id));
        state.webviews.delete(String(id));
        await view?.listener({ type: "dispose" });
      }),
    },
    views: {
      declare: call("views.declare", (views, handler) => {
        if (typeof handler !== "function") throw new TypeError("Expected a function");
        state.views.push({ views, handler });
      }),
      refresh: call("views.refresh", () => null),
      reveal: call("views.reveal", () => null),
    },
    env: {
      clipboard: {
        readText: call("env.readClipboard", () => state.clipboard),
        writeText: call("env.writeClipboard", (text) => void (state.clipboard = String(text))),
      },
      openExternal: call("env.openExternal", (url) => {
        if (!/^(https?:|mailto:)/i.test(String(url))) throw new Error("Only http(s) and mailto links can be opened");
        state.external.push(String(url));
      }),
    },
    storage: {
      get: call("storage.get", (key) => structuredClone(state.storage.get(String(key)) ?? null)),
      set: call("storage.set", (key, value) => {
        if (value === undefined || value === null) state.storage.delete(String(key));
        else state.storage.set(String(key), JSON.parse(JSON.stringify(value)));
      }),
      keys: call("storage.keys", () => [...state.storage.keys()]),
    },
    workspace: {
      root,
      folders: root ? [root] : [],
      readFile: call("workspace.readFile", (p) => {
        const rel = relative(p);
        if (state.doc && state.doc.path === `${root}/${rel}`) return state.doc.text;
        if (!state.files.has(rel)) throw new Error(`File not found: ${String(p)}`);
        return state.files.get(rel);
      }),
      writeFile: call("workspace.writeFile", (p, text) => void state.files.set(relative(p), String(text))),
      listFiles: call("workspace.listFiles", () => [...state.files.keys()].sort()),
      listDirectory: call("workspace.listDirectory", (p) => {
        const rel = relative(p);
        const prefix = rel === "." ? "" : `${rel}/`;
        const names = new Map();
        for (const file of state.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const [name, ...rest] = file.slice(prefix.length).split("/");
          names.set(name, names.get(name) || rest.length > 0);
        }
        return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
      }),
      createDirectory: call("workspace.createDirectory", () => null),
      delete: call("workspace.delete", (p) => void state.files.delete(relative(p))),
      rename: call("workspace.rename", (from, to) => {
        const text = state.files.get(relative(from));
        if (text === undefined) throw new Error(`File not found: ${from}`);
        state.files.delete(relative(from));
        state.files.set(relative(to), text);
      }),
      onDidChangeRoot: (listener) => {
        record("workspace.onDidChangeRoot", []);
        return subscribe("root", listener);
      },
    },
    events: Object.fromEntries(
      Object.entries(EVENT_NAMES).map(([method, event]) => [
        method,
        (listener) => {
          record(`events.${method}`, []);
          return subscribe(event, listener);
        },
      ]),
    ),
    languages: {
      registerFormatter: (language, format) => register("languages.registerFormatter", { kind: "formatter", language: String(language), fn: format }),
      registerCompletions: (language, provide, opts = {}) =>
        register("languages.registerCompletions", { kind: "completions", language: String(language), fn: provide, triggerCharacters: opts.triggerCharacters ?? [] }),
      registerHover: (language, provide) => register("languages.registerHover", { kind: "hover", language: String(language), fn: provide }),
      registerRenameSuggestions: (language, provide) => register("languages.registerRenameSuggestions", { kind: "rename", language: String(language), fn: provide }),
      registerProvider: (kind, language, provide) => register("languages.registerProvider", { kind: `provider:${kind}`, language: String(language), fn: provide }),
      refreshCodeLenses: call("languages.refreshCodeLenses", () => null),
      contribute: call("languages.contribute", () => null),
      getDiagnostics: call("languages.getDiagnostics", () => []),
      setDiagnostics: call("languages.setDiagnostics", (p, list) => void state.diagnostics.set(String(p), structuredClone(list ?? []))),
      clearDiagnostics: call("languages.clearDiagnostics", (p) => (p ? void state.diagnostics.delete(String(p)) : state.diagnostics.clear())),
    },
    shell: {
      run: call("shell.run", (command) => {
        state.shell.push(String(command));
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }),
    },
  });

  function subscribe(event, listener) {
    if (typeof listener !== "function") throw new TypeError("Expected a function");
    if (!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event).add(listener);
    return disposable(() => state.listeners.get(event)?.delete(listener));
  }

  /** Providers of `kind` for a language ("*" matches all). */
  const providersFor = (kind, language) => state.providers.filter((p) => p.kind === kind && (p.language === "*" || p.language === language));
  /** Monaco's default word around a 0-based index of a line. */
  const wordAround = (lineText, index) => {
    for (const match of lineText.matchAll(/(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g)) {
      if (match.index <= index && index <= match.index + match[0].length) return { word: match[0], start: match.index };
    }
    return null;
  };

  const host = {
    sable,
    state,
    manifest,
    /** The document's text and selection (as offsets). */
    get text() {
      return state.doc?.text ?? null;
    },
    get selection() {
      return state.doc ? state.doc.text.slice(...state.doc.selection) : null;
    },
    setDoc,
    /** editor.active()'s answer, without recording a call. */
    snapshot,
    /** Run a command; resolves to { ok, error }. */
    async run(id) {
      const command = state.commands.get(id);
      if (!command) return { ok: false, error: new Error(`No command ${id}`) };
      try {
        await command.run();
        await flush(2);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
    /** Fire an event to every listener; resolves to the errors thrown. */
    async fire(event, payload) {
      const errors = [];
      for (const listener of state.listeners.get(event) ?? []) {
        try {
          await listener(payload);
        } catch (error) {
          errors.push(error);
        }
      }
      await flush(2);
      return errors;
    },
    /** Completions at the cursor (or a given linePrefix), from every matching provider, concatenated. */
    async complete(overrides = {}) {
      const doc = state.doc ?? { path: "/work/file.txt", language: "plaintext", text: "", selection: [0, 0] };
      const position = positionAt(doc.text, doc.selection[1]);
      const lineText = doc.text.split("\n")[position.line - 1];
      const linePrefix = overrides.linePrefix ?? lineText.slice(0, position.column - 1);
      const word = /[\w$]*$/.exec(linePrefix)[0];
      const request = { path: doc.path, language: doc.language, text: doc.text, line: position.line, column: linePrefix.length + 1, linePrefix, word, ...overrides };
      const items = [];
      for (const p of providersFor("completions", request.language)) items.push(...((await p.fn(request)) ?? []));
      return items;
    },
    /** The hover at a 1-based line/column of the document: the first provider's non-null answer. */
    async hover(line, column, overrides = {}) {
      const doc = state.doc;
      const lineText = doc.text.split("\n")[line - 1] ?? "";
      const request = { path: doc.path, language: doc.language, text: doc.text, line, column, lineText, word: wordAround(lineText, column - 1)?.word ?? "", ...overrides };
      for (const p of providersFor("hover", request.language)) {
        const result = await p.fn(request);
        if (result) return result;
      }
      return null;
    },
    /** Rename suggestions for a name. */
    async renameSuggestions(name, language = state.doc?.language ?? "plaintext") {
      const out = [];
      for (const p of providersFor("rename", language)) out.push(...((await p.fn({ path: state.doc?.path ?? "/work/x", language, name, line: 1 })) ?? []));
      return out;
    },
    /** Format the document with the first formatter for its language. */
    async format(doc = state.doc) {
      const p = providersFor("formatter", doc.language)[0];
      if (!p) return null;
      return p.fn({ path: doc.path, language: doc.language, text: doc.text });
    },
    /** The diagnostics set for the document's path. */
    diagnostics(p = state.doc?.path) {
      return state.diagnostics.get(p) ?? null;
    },
  };
  return host;
}

/** Load a plugin, make a host for it and activate it. Returns { host, module, manifest, activateError }. */
export async function activatePlugin(dir, options = {}) {
  const { manifest, module } = await loadPlugin(dir);
  const host = createHost({ manifest, ...options });
  let activateError = null;
  try {
    if (typeof module.activate !== "function") throw new Error(`${manifest.main ?? "main.js"} doesn't export an activate(sable) function`);
    await module.activate(host.sable);
    await flush();
  } catch (error) {
    activateError = error;
  }
  return { host, module, manifest, activateError };
}

/**
 * Replace Date with one frozen at `ms` (Date.now(), new Date()). Returns
 * restore(), with restore.set(ms) to move the frozen time.
 */
export function freezeDate(ms) {
  const RealDate = Date;
  let now = ms;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FrozenDate;
  const restore = () => (globalThis.Date = RealDate);
  restore.set = (value) => (now = value);
  return restore;
}
