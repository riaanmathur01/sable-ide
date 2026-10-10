import type * as MonacoTypes from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listWorkspaceFiles, runShell } from "../ipc";
import { getEditor, pathFromUri, whenMonaco } from "../editorRegistry";
import { readCurrentText, writeFileContents } from "../fileContents";
import { confinedPath, ensureParentDirectories } from "../ai/tools";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onPluginEvent, type PluginEventName } from "./events";
import { WORKER_SOURCE } from "./workerBootstrap";
import type { HostMessage, PluginInfo, PluginLogLine, PluginPermission, PluginState, WorkerMessage } from "./types";

/**
 * Runs one plugin: its Web Worker, and the host side of the `sable` API
 * (lib/plugins/workerBootstrap.ts is the other side). Every call from the
 * plugin arrives here, is checked against the plugin's permissions, and
 * is carried out with the editor's own plumbing — so a plugin's edits are
 * undoable, its file writes respect unsaved buffers, and everything it
 * registered is removed when it stops.
 */

type Monaco = typeof MonacoTypes;

export interface PluginCommand {
  /** The plugin's handler for it. */
  handler: number;
  id: string;
  title: string;
}

export interface PluginStatusItem {
  text: string;
  tooltip?: string;
  /** A command id of the plugin's, run on click. */
  command?: string;
}

/** What a runtime tells its owner (the plugin store). */
export interface RuntimeListener {
  state(state: PluginState, error?: string): void;
  log(line: PluginLogLine): void;
  commandsChanged(): void;
  statusChanged(item: PluginStatusItem | null): void;
}

export interface PluginDiagnostic {
  /** 1-based, like the editor. */
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity?: "error" | "warning" | "info" | "hint";
  source?: string;
}

interface CompletionResult {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: string;
  kind?: string;
  /** insertText uses snippet syntax ($1, ${2:name}, $0). */
  snippet?: boolean;
}

const ACTIVATE_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS: Record<string, number> = { formatter: 10_000, completions: 3_000, command: 120_000, event: 10_000 };

let sableVersion: Promise<string> | null = null;

function resolvePath(path: string): string {
  const root = useWorkspaceStore.getState().rootPath;
  if (/^([/\\]|[A-Za-z]:)/.test(path) || !root) return path;
  return `${root}/${path.replace(/^\.\//, "")}`;
}

export class PluginRuntime {
  readonly commands = new Map<number, PluginCommand>();
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private activation: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private deactivation: (() => void) | null = null;
  /** Monaco registrations (formatters, completions), by handler. */
  private registrations = new Map<number, MonacoTypes.IDisposable>();
  /** Handlers whose registration was disposed before Monaco loaded. */
  private cancelled = new Set<number>();
  private subscriptions = new Map<number, PluginEventName>();
  private diagnostics = new Map<string, PluginDiagnostic[]>();
  private cleanups: (() => void)[] = [];

  constructor(
    readonly info: PluginInfo,
    private listener: RuntimeListener,
  ) {}

  get id(): string {
    return this.info.manifest.id;
  }

  private get name(): string {
    return this.info.manifest.name;
  }

  private markerOwner(): string {
    return `plugin:${this.id}`;
  }

  /** Load the plugin and run its activate(). Rejects if it fails. */
  async start(): Promise<void> {
    this.listener.state("starting");
    try {
      const source = await invoke<string>("plugin_read_main", { id: this.id });
      const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const worker = new Worker(workerUrl, { type: "module", name: `plugin:${this.id}` });
      URL.revokeObjectURL(workerUrl);
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => void this.receive(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.log("error", event.message || "The plugin crashed");
      };
      this.cleanups.push(onPluginEvent((name, payload) => this.dispatchEvent(name, payload)));
      this.cleanups.push(
        useWorkspaceStore.subscribe((state, previous) => {
          if (state.rootPath !== previous.rootPath) this.post({ type: "root", root: state.rootPath });
        }),
      );
      sableVersion ??= getVersion().catch(() => "");
      const activated = new Promise<void>((resolve, reject) => {
        this.activation = { resolve, reject };
        setTimeout(() => reject(new Error("activate() didn't finish within 15 seconds")), ACTIVATE_TIMEOUT_MS);
      });
      this.post({
        type: "init",
        source,
        manifest: this.info.manifest,
        root: useWorkspaceStore.getState().rootPath,
        sableVersion: await sableVersion,
      });
      await activated;
      this.listener.state("running");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", message);
      await this.stop();
      this.listener.state("error", message);
      throw error;
    } finally {
      this.activation = null;
    }
  }

  /** Run deactivate() (briefly), stop the worker, undo its registrations. */
  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await new Promise<void>((resolve) => {
        this.deactivation = resolve;
        worker.postMessage({ type: "deactivate" } satisfies HostMessage);
        setTimeout(resolve, 1000);
      });
      this.deactivation = null;
      worker.terminate();
    }
    for (const waiting of this.pending.values()) waiting.reject(new Error("The plugin stopped"));
    this.pending.clear();
    for (const registration of this.registrations.values()) registration.dispose();
    this.registrations.clear();
    this.subscriptions.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.commands.clear();
    this.listener.commandsChanged();
    this.listener.statusChanged(null);
    if (this.diagnostics.size > 0) {
      void whenMonaco().then((monaco) => {
        for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, this.markerOwner(), []);
      });
    }
    this.diagnostics.clear();
    this.listener.state("stopped");
  }

  /** Run one of the plugin's commands. */
  async runCommand(handler: number): Promise<void> {
    try {
      await this.callback(handler, [], "command");
    } catch (error) {
      useUiStore.getState().setLastError(`${this.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private post(message: HostMessage) {
    this.worker?.postMessage(message);
  }

  private log(level: PluginLogLine["level"], text: string) {
    this.listener.log({ level, text, time: Date.now() });
  }

  /** Call one of the plugin's functions (a command, formatter, …). */
  private callback(handler: number, args: unknown[], kind: keyof typeof CALLBACK_TIMEOUT_MS): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error(`${this.name} isn't running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} didn't answer in time`));
      }, CALLBACK_TIMEOUT_MS[kind]);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.post({ type: "invoke", id, handler, args });
    });
  }

  private async receive(message: WorkerMessage) {
    switch (message.type) {
      case "activated":
        this.activation?.resolve();
        return;
      case "failed":
        this.activation?.reject(new Error(message.error));
        return;
      case "deactivated":
        this.deactivation?.();
        return;
      case "log":
        this.log(message.level, message.text);
        return;
      case "return": {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) waiting?.reject(new Error(message.error));
        else waiting?.resolve(message.value);
        return;
      }
      case "call":
        try {
          const value = await this.handle(message.method, message.args);
          this.post({ type: "reply", id: message.id, value });
        } catch (error) {
          this.post({ type: "reply", id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
  }

  private require(permission: PluginPermission) {
    if (!this.info.manifest.permissions.includes(permission)) {
      throw new Error(`${this.name} doesn't have the "${permission}" permission (add it to sable-plugin.json's "permissions")`);
    }
  }

  private root(): string {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) throw new Error("No folder is open");
    return root;
  }

  /** One API call from the plugin. */
  private async handle(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      // --- Commands, messages, status bar ------------------------------------
      case "commands.register": {
        const [handler, id, title] = args as [number, string, string];
        this.commands.set(handler, { handler, id, title });
        this.listener.commandsChanged();
        return null;
      }
      case "commands.unregister":
        this.commands.delete(args[0] as number);
        this.listener.commandsChanged();
        return null;
      case "commands.execute": {
        const command = [...this.commands.values()].find((candidate) => candidate.id === args[0]);
        if (!command) throw new Error(`No command ${String(args[0])}`);
        void this.runCommand(command.handler);
        return null;
      }
      case "window.showMessage":
        useUiStore.getState().showStatus(`${this.name}: ${String(args[0])}`);
        return null;
      case "window.showError":
        useUiStore.getState().setLastError(`${this.name}: ${String(args[0])}`);
        return null;
      case "statusBar.set": {
        const [text, options] = args as [string, { tooltip?: string; command?: string } | undefined];
        this.listener.statusChanged({ text, tooltip: options?.tooltip, command: options?.command });
        return null;
      }
      case "statusBar.clear":
        this.listener.statusChanged(null);
        return null;

      // --- Editor --------------------------------------------------------------
      case "editor.active": {
        this.require("editor");
        const editor = getEditor();
        const model = editor?.getModel();
        if (!editor || !model || model.uri.scheme !== "file") return null;
        const selection = editor.getSelection();
        return {
          path: pathFromUri(model.uri),
          language: model.getLanguageId(),
          text: model.getValue(),
          selection: selection && {
            start: { line: selection.startLineNumber, column: selection.startColumn },
            end: { line: selection.endLineNumber, column: selection.endColumn },
            text: model.getValueInRange(selection),
          },
        };
      }
      case "editor.replaceSelection": {
        this.require("editor");
        const editor = getEditor();
        const selection = editor?.getSelection();
        if (!editor || !selection) throw new Error("No file is open");
        editor.pushUndoStop();
        editor.executeEdits(this.markerOwner(), [{ range: selection, text: String(args[0]), forceMoveMarkers: true }]);
        editor.pushUndoStop();
        return null;
      }
      case "editor.setText": {
        this.require("editor");
        const model = getEditor()?.getModel();
        if (!model) throw new Error("No file is open");
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: String(args[0]) }], () => null);
        model.pushStackElement();
        return null;
      }

      // --- Workspace files -------------------------------------------------------
      case "workspace.readFile": {
        this.require("workspace:read");
        const path = await confinedPath(this.root(), String(args[0]));
        const text = await readCurrentText(path);
        if (text === null) throw new Error(`File not found: ${String(args[0])}`);
        return text;
      }
      case "workspace.writeFile": {
        this.require("workspace:write");
        const root = this.root();
        const path = await confinedPath(root, String(args[0]));
        await ensureParentDirectories(root, path);
        await writeFileContents(path, String(args[1]));
        return null;
      }
      case "workspace.listFiles": {
        this.require("workspace:read");
        const root = this.root();
        return (await listWorkspaceFiles(root)).map((file) => file.slice(root.length).replace(/^[/\\]/, ""));
      }

      // --- Events -------------------------------------------------------------------
      case "events.subscribe":
        this.subscriptions.set(args[0] as number, args[1] as PluginEventName);
        return null;
      case "events.unsubscribe":
        this.subscriptions.delete(args[0] as number);
        return null;

      // --- Languages -------------------------------------------------------------------
      case "languages.registerFormatter": {
        this.require("editor");
        const [handler, language] = args as [number, string];
        await this.register(handler, (monaco) =>
          monaco.languages.registerDocumentFormattingEditProvider(language, {
            displayName: this.name,
            provideDocumentFormattingEdits: async (model) => {
              if (model.uri.scheme !== "file") return [];
              const text = model.getValue();
              try {
                const result = await this.callback(
                  handler,
                  [{ path: pathFromUri(model.uri), language: model.getLanguageId(), text }],
                  "formatter",
                );
                if (typeof result !== "string" || result === text || model.isDisposed()) return [];
                return [{ range: model.getFullModelRange(), text: result }];
              } catch (error) {
                useUiStore.getState().showStatus(`${this.name} couldn't format: ${error instanceof Error ? error.message : String(error)}`);
                return [];
              }
            },
          }),
        );
        return null;
      }
      case "languages.registerCompletions": {
        this.require("editor");
        const [handler, language, triggerCharacters] = args as [number, string, string[]];
        await this.register(handler, (monaco) =>
          monaco.languages.registerCompletionItemProvider(language, {
            triggerCharacters,
            provideCompletionItems: async (model, position) => {
              if (model.uri.scheme !== "file") return { suggestions: [] };
              const word = model.getWordUntilPosition(position);
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
              try {
                const items = (await this.callback(
                  handler,
                  [
                    {
                      path: pathFromUri(model.uri),
                      language: model.getLanguageId(),
                      text: model.getValue(),
                      line: position.lineNumber,
                      column: position.column,
                      linePrefix: model.getLineContent(position.lineNumber).slice(0, position.column - 1),
                      word: word.word,
                    },
                  ],
                  "completions",
                )) as CompletionResult[] | null;
                return {
                  suggestions: (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
                    label: String(item.label),
                    insertText: String(item.insertText ?? item.label),
                    insertTextRules: item.snippet
                      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                      : undefined,
                    detail: item.detail ?? this.name,
                    documentation: item.documentation,
                    kind: completionKind(monaco, item.kind),
                    range,
                  })),
                };
              } catch {
                return { suggestions: [] };
              }
            },
          }),
        );
        return null;
      }
      case "languages.unregister": {
        const handler = args[0] as number;
        const registration = this.registrations.get(handler);
        if (registration) registration.dispose();
        else this.cancelled.add(handler);
        this.registrations.delete(handler);
        this.subscriptions.delete(handler);
        return null;
      }
      case "languages.setDiagnostics": {
        this.require("editor");
        const path = resolvePath(String(args[0]));
        const list = Array.isArray(args[1]) ? (args[1] as PluginDiagnostic[]) : [];
        this.diagnostics.set(path, list);
        this.applyDiagnostics(path);
        return null;
      }
      case "languages.clearDiagnostics": {
        this.require("editor");
        const paths = args[0] == null ? [...this.diagnostics.keys()] : [resolvePath(String(args[0]))];
        for (const path of paths) {
          this.diagnostics.set(path, []);
          this.applyDiagnostics(path);
          this.diagnostics.delete(path);
        }
        return null;
      }

      // --- Shell ------------------------------------------------------------------------
      case "shell.run": {
        this.require("shell");
        const [command, timeout] = args as [string, number];
        const output = await runShell(command, this.root(), Math.min(Math.max(1, Number(timeout) || 60), 1800));
        return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode, timedOut: output.timedOut };
      }
    }
    throw new Error(`Unknown API call ${method}`);
  }

  /** Register with Monaco once it's loaded (unless disposed meanwhile). */
  private async register(handler: number, make: (monaco: Monaco) => MonacoTypes.IDisposable) {
    const monaco = await whenMonaco();
    if (this.cancelled.delete(handler) || !this.worker) return;
    this.registrations.set(handler, make(monaco));
  }

  private watchingModels = false;

  private applyDiagnostics(path: string) {
    void whenMonaco().then((monaco) => {
      if (!this.worker) return;
      // Files opened later get the plugin's diagnostics too.
      if (!this.watchingModels) {
        this.watchingModels = true;
        const listener = monaco.editor.onDidCreateModel((model) => {
          if (model.uri.scheme === "file" && this.diagnostics.has(pathFromUri(model.uri))) {
            this.applyDiagnostics(pathFromUri(model.uri));
          }
        });
        this.cleanups.push(() => {
          listener.dispose();
          this.watchingModels = false;
        });
      }
      const model = monaco.editor.getModels().find((candidate) => candidate.uri.scheme === "file" && pathFromUri(candidate.uri) === path);
      if (!model) return;
      const severity = {
        error: monaco.MarkerSeverity.Error,
        warning: monaco.MarkerSeverity.Warning,
        info: monaco.MarkerSeverity.Info,
        hint: monaco.MarkerSeverity.Hint,
      };
      const markers = (this.diagnostics.get(path) ?? []).map((item) => {
        const line = Math.max(1, Math.floor(Number(item.line) || 1));
        const column = Math.max(1, Math.floor(Number(item.column) || 1));
        const endLine = Math.max(line, Math.floor(Number(item.endLine) || line));
        return {
          severity: severity[item.severity ?? "error"] ?? monaco.MarkerSeverity.Error,
          message: String(item.message),
          source: item.source ?? this.name,
          startLineNumber: line,
          startColumn: column,
          endLineNumber: endLine,
          endColumn: item.endColumn ? Math.floor(Number(item.endColumn)) : model.getLineMaxColumn(Math.min(endLine, model.getLineCount())),
        };
      });
      monaco.editor.setModelMarkers(model, this.markerOwner(), markers);
    });
  }

  private dispatchEvent(name: PluginEventName, payload: { path: string }) {
    for (const [handler, event] of this.subscriptions) {
      if (event !== name) continue;
      this.callback(handler, [payload], "event").catch((error) =>
        this.log("error", `${name} listener failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
}

function completionKind(monaco: Monaco, kind: string | undefined): MonacoTypes.languages.CompletionItemKind {
  const Kind = monaco.languages.CompletionItemKind;
  const kinds: Record<string, MonacoTypes.languages.CompletionItemKind> = {
    function: Kind.Function,
    method: Kind.Method,
    variable: Kind.Variable,
    field: Kind.Field,
    class: Kind.Class,
    interface: Kind.Interface,
    module: Kind.Module,
    property: Kind.Property,
    keyword: Kind.Keyword,
    snippet: Kind.Snippet,
    constant: Kind.Constant,
    value: Kind.Value,
    file: Kind.File,
    color: Kind.Color,
  };
  return (kind ? kinds[kind] : undefined) ?? Kind.Text;
}
