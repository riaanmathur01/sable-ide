/**
 * The script each plugin's Web Worker starts with. It builds the `sable`
 * API object — every method a message to the host, which checks the
 * plugin's permissions and does the work — then loads the plugin's module
 * and calls its `activate(sable)`.
 *
 * Workers can't reach Tauri's IPC (it lives in the main window, keyed
 * with a secret the worker never sees), so the host's API is all a
 * plugin can do. Without the "network" permission the worker's network
 * APIs are removed too.
 *
 * `bootstrap` is stringified into the worker, so it must be
 * self-contained: no imports, no references outside its own body.
 */
function bootstrap() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = self as any;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const handlers = new Map<number, (...args: unknown[]) => unknown>();
  let plugin: { activate?: (api: unknown) => unknown; deactivate?: () => unknown } | null = null;

  const post = (message: unknown) => scope.postMessage(message);
  const call = (method: string, ...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ type: "call", id, method, args });
    });
  /** Keep a function the host can call back (command, formatter, …). */
  const handler = (fn: unknown) => {
    if (typeof fn !== "function") throw new TypeError("Expected a function");
    const id = nextId++;
    handlers.set(id, fn as (...args: unknown[]) => unknown);
    return id;
  };
  const disposable = (method: string, id: number) => ({
    dispose: () => {
      handlers.delete(id);
      return call(method, id);
    },
  });

  // console.* goes to the plugin's log in the Plugins view.
  const format = (args: unknown[]) =>
    args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack || String(arg);
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  for (const level of ["log", "info", "debug", "warn", "error"]) {
    scope.console[level] = (...args: unknown[]) =>
      post({ type: "log", level: level === "warn" ? "warn" : level === "error" ? "error" : "log", text: format(args) });
  }

  scope.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "reply") {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (!waiting) return;
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.value);
    } else if (message.type === "invoke") {
      const fn = handlers.get(message.handler);
      try {
        if (!fn) throw new Error("That handler was disposed");
        post({ type: "return", id: message.id, value: await fn(...message.args) });
      } catch (error) {
        post({ type: "return", id: message.id, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (message.type === "root") {
      if (api) api.workspace.root = message.root;
    } else if (message.type === "deactivate") {
      try {
        await plugin?.deactivate?.();
      } catch (error) {
        console.error("deactivate failed:", error);
      }
      post({ type: "deactivated" });
    } else if (message.type === "init") {
      await init(message);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function init(message: any) {
    const { manifest, source, root, sableVersion } = message;
    if (!manifest.permissions.includes("network")) {
      for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"]) {
        try {
          delete scope[name];
          if (name in scope) Object.defineProperty(scope, name, { value: undefined, configurable: false });
        } catch {
          /* not present */
        }
      }
    }
    api = Object.freeze({
      manifest,
      version: sableVersion,
      commands: {
        register(id: string, title: string, run: () => unknown) {
          const handlerId = handler(run);
          void call("commands.register", handlerId, String(id), String(title));
          return disposable("commands.unregister", handlerId);
        },
        execute: (id: string) => call("commands.execute", String(id)),
      },
      window: {
        showMessage: (text: string) => call("window.showMessage", String(text)),
        showError: (text: string) => call("window.showError", String(text)),
      },
      statusBar: {
        set: (text: string, options: { tooltip?: string; command?: string } = {}) =>
          call("statusBar.set", String(text), options),
        clear: () => call("statusBar.clear"),
      },
      editor: {
        active: () => call("editor.active"),
        replaceSelection: (text: string) => call("editor.replaceSelection", String(text)),
        setText: (text: string) => call("editor.setText", String(text)),
      },
      workspace: {
        root,
        readFile: (path: string) => call("workspace.readFile", String(path)),
        writeFile: (path: string, text: string) => call("workspace.writeFile", String(path), String(text)),
        listFiles: () => call("workspace.listFiles"),
      },
      events: {
        onDidSave: (listener: (event: { path: string }) => unknown) => {
          const id = handler(listener);
          void call("events.subscribe", id, "didSave");
          return disposable("events.unsubscribe", id);
        },
        onDidOpen: (listener: (event: { path: string }) => unknown) => {
          const id = handler(listener);
          void call("events.subscribe", id, "didOpen");
          return disposable("events.unsubscribe", id);
        },
      },
      languages: {
        registerFormatter(language: string, format: (document: unknown) => unknown) {
          const id = handler(format);
          void call("languages.registerFormatter", id, String(language));
          return disposable("languages.unregister", id);
        },
        registerCompletions(
          language: string,
          provide: (request: unknown) => unknown,
          options: { triggerCharacters?: string[] } = {},
        ) {
          const id = handler(provide);
          void call("languages.registerCompletions", id, String(language), options.triggerCharacters ?? []);
          return disposable("languages.unregister", id);
        },
        setDiagnostics: (path: string, diagnostics: unknown[]) => call("languages.setDiagnostics", String(path), diagnostics),
        clearDiagnostics: (path?: string) => call("languages.clearDiagnostics", path ?? null),
      },
      shell: {
        run: (command: string, options: { timeoutSeconds?: number } = {}) =>
          call("shell.run", String(command), options.timeoutSeconds ?? 60),
      },
    });
    try {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      plugin = await scope.__sableImport(url);
      URL.revokeObjectURL(url);
      if (typeof plugin?.activate !== "function") throw new Error(`${manifest.main} doesn't export an activate(sable) function`);
      await plugin.activate(api);
      post({ type: "activated" });
    } catch (error) {
      post({ type: "failed", error: error instanceof Error ? error.stack || error.message : String(error) });
    }
  }
}

/**
 * The worker's source. The dynamic import lives in this string, not in
 * `bootstrap`: bundlers rewrite `import()` in code (Vite's dev server
 * wraps it in a helper that doesn't exist inside the worker).
 */
export const WORKER_SOURCE = `self.__sableImport = (url) => import(url);\n(${bootstrap.toString()})();`;
