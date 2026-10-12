import { create } from "zustand";
import type * as MonacoTypes from "monaco-editor";
import { monaco } from "../monacoSetup";
import { readFile, writeFile } from "../ipc";
import { useTabsStore } from "../../store/tabsStore";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useUiStore } from "../../store/uiStore";
import { notebookHooks, notebookTabKey, type NotebookCommand } from "./hooks";
import { KernelConnection, installIpykernel, type KernelMessage } from "./kernel";
import { stripAnsi } from "./ansi";
import {
  hasCellIds,
  joinBundle,
  makeCell,
  parseNotebook,
  serializeNotebook,
  type CellType,
  type NbCell,
  type NbOutput,
  type Notebook,
} from "./nbformat";

/**
 * Open notebooks: their cells and outputs, selection and mode, and their
 * kernel. Keyed by file path, independent of the views — so a notebook
 * keeps its state while its tab is in the background, and two editor
 * groups showing the same notebook share it (and its kernel).
 *
 * Cell text lives in Monaco models (one per cell, created when its editor
 * first shows) — so undo/redo works per cell — and `cell.source` until then.
 */

export type KernelState = "unstarted" | "starting" | "idle" | "busy" | "restarting" | "dead" | "missing";

export interface CellRun {
  req: string | null;
  state: "queued" | "running";
  started: number | null;
}

export interface CellTiming {
  ms: number;
  status: "ok" | "error";
}

export interface NotebookDoc {
  path: string;
  notebook: Notebook | null;
  /** Couldn't read or parse the file. */
  error: string | null;
  dirty: boolean;
  /** The selected cell's key. */
  selected: string | null;
  /** Command mode (keys act on cells) or edit mode (typing in a cell). */
  mode: "command" | "edit";
  /** Markdown cells showing their source instead of the rendering. */
  editingMarkdown: Record<string, boolean>;
  runs: Record<string, CellRun>;
  timings: Record<string, CellTiming>;
  kernelState: KernelState;
  kernelName: string;
  kernelDisplayName: string;
  /** Something to tell the user about the kernel (failed to start, …). */
  kernelMessage: string | null;
  /** Packages the interpreter lacks to run kernels. */
  missingPackages: string[] | null;
  installing: boolean;
  /** The interpreter the kernel runs with. */
  python: string | null;
  /** The kernel waits for input() in this cell. */
  input: { cellKey: string; prompt: string; password: boolean } | null;
  /** Deleted cells, most recent last (Z / Undo Delete). */
  deleted: { cell: NbCell; index: number }[];
  collapsedOutputs: Record<string, boolean>;
  /** Long outputs shown in full instead of a scroll box. */
  expandedOutputs: Record<string, boolean>;
  lineNumbers: boolean;
}

interface NotebookStoreState {
  docs: Record<string, NotebookDoc>;
}

export const useNotebookStore = create<NotebookStoreState>(() => ({ docs: {} }));

const getDoc = (path: string): NotebookDoc | undefined => useNotebookStore.getState().docs[path];

function patch(path: string, update: (doc: NotebookDoc) => Partial<NotebookDoc> | null) {
  useNotebookStore.setState((state) => {
    const doc = state.docs[path];
    if (!doc) return state;
    const changes = update(doc);
    if (!changes) return state;
    return { docs: { ...state.docs, [path]: { ...doc, ...changes } } };
  });
}

function updateCells(path: string, update: (cells: NbCell[], doc: NotebookDoc) => NbCell[] | null, extra?: Partial<NotebookDoc>) {
  patch(path, (doc) => {
    if (!doc.notebook) return null;
    const cells = update(doc.notebook.cells, doc);
    if (!cells) return extra ?? null;
    return { notebook: { ...doc.notebook, cells }, ...extra };
  });
}

const mapCell = (cells: NbCell[], key: string, update: (cell: NbCell) => NbCell) =>
  cells.map((cell) => (cell.key === key ? update(cell) : cell));

// --- Runtime state (not rendered) ------------------------------------------------------------

interface Runtime {
  kernel: KernelConnection | null;
  starting: Promise<void> | null;
  startDone: { resolve: () => void; reject: (error: Error) => void } | null;
  restartDone: (() => void)[];
  /** Execute request → cell key. */
  reqToCell: Map<string, string>;
  /** display_id → cells showing it (update_display_data). */
  displays: Map<string, Set<string>>;
  /** Cells whose outputs clear with the next output (clear_output wait=True). */
  clearOnNext: Set<string>;
  models: Map<string, MonacoTypes.editor.ITextModel>;
  /** Kernel messages waiting for the next frame. */
  queue: { message: KernelMessage; at: number }[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const runtimes = new Map<string, Runtime>();
/** Model URI → its notebook and cell (completions, hover). */
const modelOwners = new Map<string, { path: string; key: string }>();

function runtime(path: string): Runtime {
  let found = runtimes.get(path);
  if (!found) {
    found = {
      kernel: null,
      starting: null,
      startDone: null,
      restartDone: [],
      reqToCell: new Map(),
      displays: new Map(),
      clearOnNext: new Set(),
      models: new Map(),
      queue: [],
      flushTimer: null,
    };
    runtimes.set(path, found);
  }
  return found;
}

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || null;

// --- Loading, saving, closing ----------------------------------------------------------------

function kernelOf(notebook: Notebook): { name: string; displayName: string } {
  const spec = notebook.metadata.kernelspec as { name?: string; display_name?: string } | undefined;
  return { name: spec?.name || "python3", displayName: spec?.display_name || spec?.name || "Python 3" };
}

/** Load a notebook (once; later views share it). */
export function ensureDoc(path: string): void {
  if (getDoc(path)) return;
  const doc: NotebookDoc = {
    path,
    notebook: null,
    error: null,
    dirty: false,
    selected: null,
    mode: "command",
    editingMarkdown: {},
    runs: {},
    timings: {},
    kernelState: "unstarted",
    kernelName: "python3",
    kernelDisplayName: "Python 3",
    kernelMessage: null,
    missingPackages: null,
    installing: false,
    python: null,
    input: null,
    deleted: [],
    collapsedOutputs: {},
    expandedOutputs: {},
    lineNumbers: false,
  };
  useNotebookStore.setState((state) => ({ docs: { ...state.docs, [path]: doc } }));
  void readFile(path).then(
    (text) => {
      try {
        const notebook = parseNotebook(text);
        const kernel = kernelOf(notebook);
        patch(path, () => ({
          notebook,
          selected: notebook.cells[0]?.key ?? null,
          kernelName: kernel.name,
          kernelDisplayName: kernel.displayName,
        }));
      } catch (error) {
        patch(path, () => ({ error: `Couldn't read this notebook: ${error instanceof Error ? error.message : String(error)}` }));
      }
    },
    (error) => patch(path, () => ({ error: String(error) })),
  );
}

/** The cell's current text (its editor's, when it has one). */
export function cellSource(path: string, cell: NbCell): string {
  const model = runtimes.get(path)?.models.get(cell.key);
  return model && !model.isDisposed() ? model.getValue() : cell.source;
}

/** Monaco's language for the notebook's code cells. */
export function codeLanguage(notebook: Notebook | null): string {
  const info = notebook?.metadata.language_info as { name?: string } | undefined;
  const spec = notebook?.metadata.kernelspec as { language?: string } | undefined;
  const wanted = (info?.name || spec?.language || "python").toLowerCase();
  const language = monaco.languages
    .getLanguages()
    .find((candidate) => candidate.id === wanted || candidate.aliases?.some((alias) => alias.toLowerCase() === wanted));
  return language?.id ?? "plaintext";
}

const languageFor = (doc: NotebookDoc, type: CellType) =>
  type === "code" ? codeLanguage(doc.notebook) : type === "markdown" ? "markdown" : "plaintext";

let modelCounter = 0;

/** The cell's Monaco model (created on first use). */
export function cellModel(path: string, key: string): MonacoTypes.editor.ITextModel | null {
  const doc = getDoc(path);
  const cell = doc?.notebook?.cells.find((candidate) => candidate.key === key);
  if (!doc || !cell) return null;
  const run = runtime(path);
  const existing = run.models.get(key);
  if (existing && !existing.isDisposed()) return existing;
  modelCounter += 1;
  const uri = monaco.Uri.from({ scheme: "sable-cell", path: `/${modelCounter}/${key}` });
  const model = monaco.editor.createModel(cell.source, languageFor(doc, cell.cell_type), uri);
  modelOwners.set(uri.toString(), { path, key });
  model.onDidChangeContent(() => markDirty(path));
  model.onWillDispose(() => modelOwners.delete(uri.toString()));
  run.models.set(key, model);
  return model;
}

function disposeModel(path: string, key: string) {
  const run = runtimes.get(path);
  const model = run?.models.get(key);
  if (!run || !model) return;
  run.models.delete(key);
  model.dispose();
}

export function markDirty(path: string): void {
  const doc = getDoc(path);
  if (!doc) return;
  if (!doc.dirty) {
    patch(path, () => ({ dirty: true }));
    useTabsStore.getState().setTabDirty(notebookTabKey(path), true);
  }
  useTabsStore.getState().scheduleAutoSave(notebookTabKey(path));
}

/** Write the notebook to disk (nbformat 4, as Jupyter writes it). */
export async function saveNotebook(path: string): Promise<void> {
  const doc = getDoc(path);
  if (!doc?.notebook) return;
  // Bring sources up to date first, so what's saved is what's in the cells;
  // cells of 4.5+ notebooks need ids (kept from now on).
  const withIds = hasCellIds(doc.notebook);
  const cells = doc.notebook.cells.map((cell) => {
    const source = cellSource(path, cell);
    const needsId = withIds && typeof cell.raw.id !== "string";
    if (source === cell.source && !needsId) return cell;
    return { ...cell, source, raw: needsId ? { ...cell.raw, id: makeCell("code").raw.id } : cell.raw };
  });
  const notebook = { ...doc.notebook, cells };
  const text = serializeNotebook(notebook);
  await writeFile(path, text);
  const now = getDoc(path);
  // Edits made while writing keep the notebook dirty.
  const unchanged = now?.notebook?.cells.every((cell, index) => cellSource(path, cell) === cells[index]?.source) && now.notebook.cells.length === cells.length;
  patch(path, (current) => ({
    notebook: current.notebook ? { ...current.notebook, cells: current.notebook.cells.map((cell) => cells.find((saved) => saved.key === cell.key) ?? cell) } : current.notebook,
    dirty: unchanged ? false : current.dirty,
  }));
  if (unchanged) useTabsStore.getState().setTabDirty(notebookTabKey(path), false);
}

/** The last tab closed: shut the kernel down, forget the notebook. */
export function closeNotebook(path: string): void {
  const run = runtimes.get(path);
  if (run) {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    void run.kernel?.stop().catch(() => {});
    for (const model of run.models.values()) model.dispose();
    runtimes.delete(path);
  }
  useNotebookStore.setState((state) => {
    const docs = { ...state.docs };
    delete docs[path];
    return { docs };
  });
}

/** The file moved: carry the notebook (and its kernel) along. */
export function renameNotebook(oldPath: string, newPath: string): void {
  const doc = getDoc(oldPath);
  if (!doc) return;
  const run = runtimes.get(oldPath);
  if (run) {
    runtimes.delete(oldPath);
    runtimes.set(newPath, run);
    for (const [uri, owner] of modelOwners) if (owner.path === oldPath) modelOwners.set(uri, { ...owner, path: newPath });
  }
  useNotebookStore.setState((state) => {
    const docs = { ...state.docs };
    delete docs[oldPath];
    docs[newPath] = { ...doc, path: newPath };
    return { docs };
  });
}

// --- Selection, mode, structure --------------------------------------------------------------

export function selectCell(path: string, key: string, mode?: "command" | "edit"): void {
  patch(path, (doc) => (doc.selected === key && (!mode || doc.mode === mode) ? null : { selected: key, mode: mode ?? doc.mode }));
}

export function setMode(path: string, mode: "command" | "edit"): void {
  patch(path, (doc) => {
    if (doc.mode === mode) return null;
    const editingMarkdown = { ...doc.editingMarkdown };
    const cell = doc.notebook?.cells.find((candidate) => candidate.key === doc.selected);
    // Entering edit mode on a Markdown cell shows its source.
    if (mode === "edit" && cell?.cell_type === "markdown") editingMarkdown[cell.key] = true;
    return { mode, editingMarkdown };
  });
}

/** Select the cell `delta` away from the selected one. */
export function moveSelection(path: string, delta: number): void {
  patch(path, (doc) => {
    const cells = doc.notebook?.cells ?? [];
    const index = cells.findIndex((cell) => cell.key === doc.selected);
    const next = cells[Math.max(0, Math.min(cells.length - 1, index + delta))];
    return next ? { selected: next.key } : null;
  });
}

export function setMarkdownEditing(path: string, key: string, editing: boolean): void {
  patch(path, (doc) => (!!doc.editingMarkdown[key] === editing ? null : { editingMarkdown: { ...doc.editingMarkdown, [key]: editing } }));
}

/** Add a cell above or below `key` (default: the selected one) and select it. */
export function insertCell(path: string, where: "above" | "below", options: { type?: CellType; key?: string; source?: string; edit?: boolean } = {}): string | null {
  const doc = getDoc(path);
  if (!doc?.notebook) return null;
  const cell = makeCell(options.type ?? "code", options.source ?? "", hasCellIds(doc.notebook));
  const anchor = options.key ?? doc.selected;
  updateCells(
    path,
    (cells) => {
      const index = cells.findIndex((candidate) => candidate.key === anchor);
      const at = index === -1 ? (where === "above" ? 0 : cells.length) : where === "above" ? index : index + 1;
      return [...cells.slice(0, at), cell, ...cells.slice(at)];
    },
    {
      selected: cell.key,
      mode: options.edit ? "edit" : "command",
      editingMarkdown: cell.cell_type === "markdown" ? { ...doc.editingMarkdown, [cell.key]: true } : doc.editingMarkdown,
    },
  );
  markDirty(path);
  return cell.key;
}

export function deleteCell(path: string, key?: string): void {
  const doc = getDoc(path);
  const cells = doc?.notebook?.cells;
  const target = key ?? doc?.selected;
  if (!doc || !cells || !target) return;
  const index = cells.findIndex((cell) => cell.key === target);
  if (index === -1) return;
  const cell = cells[index];
  const source = cellSource(path, cell);
  if (doc.runs[target]) void interruptKernel(path);
  const remaining = cells.filter((candidate) => candidate.key !== target);
  // Never leave a notebook without cells.
  const nextCells = remaining.length > 0 ? remaining : [makeCell("code", "", hasCellIds(doc.notebook!))];
  const selected = nextCells[Math.min(index, nextCells.length - 1)].key;
  updateCells(path, () => nextCells, {
    selected,
    mode: "command",
    deleted: [...doc.deleted, { cell: { ...cell, source }, index }].slice(-20),
  });
  disposeModel(path, target);
  markDirty(path);
}

/** Bring back the last deleted cell. */
export function undoDelete(path: string): void {
  const doc = getDoc(path);
  const last = doc?.deleted[doc.deleted.length - 1];
  if (!doc || !last) return;
  updateCells(
    path,
    (cells) => {
      // The notebook's placeholder cell (left after deleting the last one) goes again.
      const base = cells.length === 1 && !cellSource(path, cells[0]) && cells[0].outputs.length === 0 && doc.deleted.length > 0 && last.index === 0 ? [] : cells;
      const at = Math.min(last.index, base.length);
      return [...base.slice(0, at), last.cell, ...base.slice(at)];
    },
    { deleted: doc.deleted.slice(0, -1), selected: last.cell.key, mode: "command" },
  );
  markDirty(path);
}

export function moveCell(path: string, delta: -1 | 1, key?: string): void {
  const doc = getDoc(path);
  const target = key ?? doc?.selected;
  if (!target) return;
  let moved = false;
  updateCells(path, (cells) => {
    const index = cells.findIndex((cell) => cell.key === target);
    const to = index + delta;
    if (index === -1 || to < 0 || to >= cells.length) return null;
    const next = [...cells];
    [next[index], next[to]] = [next[to], next[index]];
    moved = true;
    return next;
  });
  if (moved) markDirty(path);
}

export function setCellType(path: string, type: CellType, key?: string): void {
  const doc = getDoc(path);
  const target = key ?? doc?.selected;
  const cell = doc?.notebook?.cells.find((candidate) => candidate.key === target);
  if (!doc || !cell || !target || cell.cell_type === type) return;
  const source = cellSource(path, cell);
  updateCells(
    path,
    (cells) =>
      mapCell(cells, target, (current) => ({
        ...current,
        cell_type: type,
        source,
        outputs: type === "code" ? current.outputs : [],
        execution_count: type === "code" ? current.execution_count : null,
      })),
    { editingMarkdown: { ...doc.editingMarkdown, [target]: type === "markdown" && doc.mode === "edit" } },
  );
  const model = runtimes.get(path)?.models.get(target);
  if (model) monaco.editor.setModelLanguage(model, languageFor(doc, type));
  markDirty(path);
}

export function clearOutputs(path: string, key?: string): void {
  const doc = getDoc(path);
  const target = key ?? doc?.selected;
  if (!target) return;
  updateCells(path, (cells) => mapCell(cells, target, (cell) => ({ ...cell, outputs: [], execution_count: cell.execution_count })));
  patch(path, (current) => {
    const timings = { ...current.timings };
    delete timings[target];
    return { timings };
  });
  markDirty(path);
}

export function clearAllOutputs(path: string): void {
  updateCells(path, (cells) =>
    cells.map((cell) => (cell.cell_type === "code" && (cell.outputs.length > 0 || cell.execution_count !== null) ? { ...cell, outputs: [], execution_count: null } : cell)),
    { timings: {} },
  );
  markDirty(path);
}

export function toggleOutputCollapsed(path: string, key: string): void {
  patch(path, (doc) => ({ collapsedOutputs: { ...doc.collapsedOutputs, [key]: !doc.collapsedOutputs[key] } }));
}

export function toggleOutputExpanded(path: string, key: string): void {
  patch(path, (doc) => ({ expandedOutputs: { ...doc.expandedOutputs, [key]: !doc.expandedOutputs[key] } }));
}

export function toggleLineNumbers(path: string): void {
  patch(path, (doc) => ({ lineNumbers: !doc.lineNumbers }));
}

// --- The kernel --------------------------------------------------------------------------

async function selectedPython(): Promise<string | null> {
  const interpreters = useInterpreterStore.getState();
  if (!interpreters.selectedPath && interpreters.interpreters.length === 0) {
    await interpreters.discover().catch(() => {});
  }
  return useInterpreterStore.getState().selectedPath;
}

/** Start the kernel unless it's running. Rejects if it can't start. */
export function ensureKernel(path: string): Promise<void> {
  const doc = getDoc(path);
  const run = runtime(path);
  if (!doc) return Promise.reject(new Error("closed"));
  if (run.kernel && ["idle", "busy", "restarting"].includes(doc.kernelState)) return Promise.resolve();
  if (run.starting) return run.starting;
  const starting = new Promise<void>((resolve, reject) => {
    run.startDone = { resolve, reject };
  });
  run.starting = starting;
  void starting.then(
    () => {
      run.starting = null;
    },
    () => {
      run.starting = null;
    },
  );
  patch(path, () => ({ kernelState: "starting", kernelMessage: null, missingPackages: null }));
  void (async () => {
    const previous = run.kernel;
    run.kernel = null;
    if (previous) await previous.stop().catch(() => {});
    const python = await selectedPython();
    patch(path, () => ({ python }));
    const kernel = new KernelConnection((message) => receive(path, kernel, message));
    run.kernel = kernel;
    try {
      await kernel.start(python, getDoc(path)?.kernelName ?? "python3", dirOf(path));
    } catch (error) {
      failStart(path, String(error));
    }
  })();
  return starting;
}

function failStart(path: string, message: string, state: KernelState = "dead") {
  const run = runtimes.get(path);
  patch(path, (doc) => ({
    kernelState: state,
    kernelMessage: state === "missing" ? null : message,
    runs: {},
    input: null,
    timings: doc.timings,
  }));
  run?.startDone?.reject(new Error(message));
  if (run) run.startDone = null;
}

/** Messages arrive in bursts (a loop printing): apply them once per frame. */
function receive(path: string, kernel: KernelConnection, message: KernelMessage) {
  const run = runtimes.get(path);
  if (!run || run.kernel !== kernel) return;
  run.queue.push({ message, at: Date.now() });
  run.flushTimer ??= setTimeout(() => {
    run.flushTimer = null;
    const messages = run.queue.splice(0);
    for (const queued of messages) handle(path, run, queued.message, queued.at);
  }, 16);
}

/** A cell's run ended (its reply, or the kernel going idle after it). */
function finishRun(path: string, key: string, at: number, aborted = false) {
  if (!getDoc(path)?.runs[key]) return;
  patch(path, (doc) => {
    const current = doc.runs[key];
    if (!current) return null;
    const runs = { ...doc.runs };
    delete runs[key];
    const timings = { ...doc.timings };
    const cell = doc.notebook?.cells.find((candidate) => candidate.key === key);
    const failed = cell?.outputs.some((output) => output.output_type === "error");
    if (aborted || current.started === null) delete timings[key];
    else timings[key] = { ms: Math.max(0, at - current.started), status: failed ? "error" : "ok" };
    return { runs, timings, input: doc.input?.cellKey === key ? null : doc.input };
  });
  // New outputs are a change to save (auto-save picks them up).
  markDirty(path);
}

/** Add an output to a cell, merging consecutive stream text. */
function appendOutput(path: string, run: Runtime, key: string, output: NbOutput) {
  const clearFirst = run.clearOnNext.delete(key);
  updateCells(path, (cells) =>
    mapCell(cells, key, (cell) => {
      const outputs = clearFirst ? [] : [...cell.outputs];
      const last = outputs[outputs.length - 1];
      if (output.output_type === "stream" && last?.output_type === "stream" && last.name === output.name) {
        outputs[outputs.length - 1] = { ...last, text: String(last.text) + String(output.text) };
      } else {
        outputs.push(output);
      }
      return { ...cell, outputs };
    }),
  );
  const displayId = (output as { transient?: { display_id?: string } }).transient?.display_id;
  if (displayId) {
    const cellsShowing = run.displays.get(displayId) ?? new Set<string>();
    cellsShowing.add(key);
    run.displays.set(displayId, cellsShowing);
  }
}

/** Apply one kernel message (`at`: when it arrived). */
function handle(path: string, run: Runtime, message: KernelMessage, at: number) {
  const key = message.req ? run.reqToCell.get(message.req) : undefined;
  switch (message.type) {
    case "status": {
      const state = message.state;
      if (state === "busy" && key) {
        patch(path, (doc) => (doc.runs[key] ? { runs: { ...doc.runs, [key]: { ...doc.runs[key], state: "running", started: at } } } : null));
      }
      if (state === "idle" && key) {
        finishRun(path, key, at);
        // Outputs can trail the reply; the idle status is the last word.
        run.reqToCell.delete(message.req!);
      }
      if (state === "dead") {
        const wasStarting = getDoc(path)?.kernelState === "starting";
        if (wasStarting) failStart(path, "The kernel died while starting");
        else patch(path, () => ({ kernelState: "dead", runs: {}, input: null, kernelMessage: "The kernel died. Run a cell to start a new one." }));
        run.restartDone.splice(0).forEach((done) => done());
        return;
      }
      if (state === "busy" || state === "idle" || state === "starting" || state === "restarting") {
        patch(path, (doc) => (doc.kernelState === "starting" && state !== "starting" ? null : doc.kernelState === state ? null : { kernelState: state }));
      }
      return;
    }
    case "started": {
      const info = message.info?.language_info;
      patch(path, (doc) => {
        const notebook = doc.notebook;
        // Note the kernel's language for highlighting (not a user edit).
        const metadata = notebook && info && !notebook.metadata.language_info ? { ...notebook.metadata, language_info: info } : notebook?.metadata;
        return {
          kernelState: "idle",
          kernelMessage: null,
          notebook: notebook && metadata ? { ...notebook, metadata } : notebook,
        };
      });
      run.startDone?.resolve();
      run.startDone = null;
      return;
    }
    case "restarted":
      run.reqToCell.clear();
      run.clearOnNext.clear();
      patch(path, () => ({ runs: {}, input: null, kernelState: "idle" }));
      run.restartDone.splice(0).forEach((done) => done());
      return;
    case "missing":
      // Nothing to run with: the helper can go (Install starts a new one).
      if (run.kernel) {
        void run.kernel.stop().catch(() => {});
        run.kernel = null;
      }
      failStart(path, "missing", "missing");
      patch(path, () => ({ missingPackages: message.packages ?? ["ipykernel"], python: message.python ?? null }));
      return;
    case "error":
      if (getDoc(path)?.kernelState === "starting") failStart(path, message.message ?? "The kernel didn't start");
      else patch(path, () => ({ kernelMessage: message.message ?? null }));
      return;
    case "exited": {
      const doc = getDoc(path);
      run.kernel = null;
      run.reqToCell.clear();
      if (doc?.kernelState === "starting") {
        const detail = message.stderr?.trim().split("\n").pop();
        failStart(path, detail ? `The kernel helper stopped: ${detail}` : "The kernel helper stopped");
      } else if (doc && doc.kernelState !== "missing") {
        patch(path, () => ({ kernelState: "dead", runs: {}, input: null }));
      }
      run.restartDone.splice(0).forEach((done) => done());
      return;
    }
    case "input_request":
      if (key) patch(path, () => ({ input: { cellKey: key, prompt: message.prompt ?? "", password: !!message.password } }));
      return;
    case "reply": {
      if (!key || message.msg_type !== "execute_reply") return;
      const content = message.content ?? {};
      if (content.status === "aborted") {
        finishRun(path, key, at, true);
        return;
      }
      if (typeof content.execution_count === "number") {
        updateCells(path, (cells) => mapCell(cells, key, (cell) => ({ ...cell, execution_count: content.execution_count })));
      }
      // help(), obj? and %magics page their text: show it under the cell.
      for (const payload of content.payload ?? []) {
        if (payload?.source === "page" && payload.data) {
          appendOutput(path, run, key, { output_type: "display_data", data: joinBundle(payload.data), metadata: {} });
        }
      }
      finishRun(path, key, at);
      return;
    }
    case "iopub": {
      const content = message.content ?? {};
      if (message.msg_type === "update_display_data") {
        const id = content.transient?.display_id;
        const showing = id ? run.displays.get(id) : undefined;
        if (!showing) return;
        updateCells(path, (cells) =>
          cells.map((cell) =>
            !showing.has(cell.key)
              ? cell
              : {
                  ...cell,
                  outputs: cell.outputs.map((output) =>
                    (output.output_type === "display_data" || output.output_type === "execute_result") && output.transient?.display_id === id
                      ? { ...output, data: joinBundle(content.data ?? {}), metadata: content.metadata ?? {} }
                      : output,
                  ),
                },
          ),
        );
        return;
      }
      if (!key) return;
      switch (message.msg_type) {
        case "execute_input":
          if (typeof content.execution_count === "number") {
            updateCells(path, (cells) => mapCell(cells, key, (cell) => ({ ...cell, execution_count: content.execution_count })));
          }
          return;
        case "stream":
          appendOutput(path, run, key, { output_type: "stream", name: content.name === "stderr" ? "stderr" : "stdout", text: String(content.text ?? "") });
          return;
        case "display_data":
          appendOutput(path, run, key, {
            output_type: "display_data",
            data: joinBundle(content.data ?? {}),
            metadata: content.metadata ?? {},
            ...(content.transient?.display_id ? { transient: { display_id: content.transient.display_id } } : {}),
          });
          return;
        case "execute_result":
          appendOutput(path, run, key, {
            output_type: "execute_result",
            data: joinBundle(content.data ?? {}),
            metadata: content.metadata ?? {},
            execution_count: content.execution_count ?? null,
            ...(content.transient?.display_id ? { transient: { display_id: content.transient.display_id } } : {}),
          });
          return;
        case "error":
          appendOutput(path, run, key, {
            output_type: "error",
            ename: String(content.ename ?? "Error"),
            evalue: String(content.evalue ?? ""),
            traceback: Array.isArray(content.traceback) ? content.traceback.map(String) : [],
          });
          return;
        case "clear_output":
          if (content.wait) run.clearOnNext.add(key);
          else {
            run.clearOnNext.delete(key);
            updateCells(path, (cells) => mapCell(cells, key, (cell) => ({ ...cell, outputs: [] })));
          }
          return;
      }
      return;
    }
  }
}

// --- Running cells -----------------------------------------------------------------------

/**
 * Run cells in order: Markdown cells render, code cells queue on the
 * kernel (started first if needed). A failing cell stops the rest (the
 * kernel aborts them), like Jupyter.
 */
export async function runCells(path: string, keys: string[]): Promise<void> {
  const doc = getDoc(path);
  if (!doc?.notebook) return;
  const code: { key: string; source: string }[] = [];
  const editingMarkdown = { ...doc.editingMarkdown };
  for (const key of keys) {
    const cell = doc.notebook.cells.find((candidate) => candidate.key === key);
    if (!cell) continue;
    if (cell.cell_type === "markdown") editingMarkdown[key] = false;
    if (cell.cell_type !== "code") continue;
    const source = cellSource(path, cell);
    if (!source.trim()) {
      // Nothing to run: just clear it (like JupyterLab).
      updateCells(path, (cells) => mapCell(cells, key, (current) => ({ ...current, outputs: [], execution_count: null })));
      continue;
    }
    code.push({ key, source });
  }
  const queued: Record<string, CellRun> = {};
  for (const { key } of code) queued[key] = { req: null, state: "queued", started: null };
  patch(path, (current) => {
    const timings = { ...current.timings };
    for (const { key } of code) delete timings[key];
    return { editingMarkdown, runs: { ...current.runs, ...queued }, timings };
  });
  if (code.length === 0) return;
  const run = runtime(path);
  for (const { key } of code) run.clearOnNext.delete(key);
  updateCells(path, (cells) => cells.map((cell) => (queued[cell.key] ? { ...cell, outputs: [] } : cell)));
  markDirty(path);
  try {
    await ensureKernel(path);
  } catch {
    patch(path, (current) => {
      const runs = { ...current.runs };
      for (const { key } of code) delete runs[key];
      return { runs };
    });
    return;
  }
  const kernel = run.kernel;
  if (!kernel) return;
  for (const { key, source } of code) {
    // Interrupted or restarted while the kernel started: not anymore.
    if (!getDoc(path)?.runs[key]) continue;
    const req = kernel.execute(source);
    run.reqToCell.set(req, key);
    patch(path, (current) => (current.runs[key] ? { runs: { ...current.runs, [key]: { ...current.runs[key], req } } } : null));
  }
}

/** Run the selected cell; then stay, select the next (adding one at the end), or insert one below. */
export function runSelected(path: string, then: "stay" | "next" | "insert"): void {
  const doc = getDoc(path);
  const cells = doc?.notebook?.cells;
  const key = doc?.selected;
  if (!doc || !cells || !key) return;
  void runCells(path, [key]);
  const index = cells.findIndex((cell) => cell.key === key);
  if (then === "stay") {
    patch(path, () => ({ mode: "command" }));
  } else if (then === "insert" || index === cells.length - 1) {
    insertCell(path, "below", { key, edit: true });
  } else {
    patch(path, () => ({ selected: cells[index + 1].key, mode: "command" }));
  }
}

export function runAll(path: string): void {
  const keys = getDoc(path)?.notebook?.cells.map((cell) => cell.key) ?? [];
  void runCells(path, keys);
}

/** Run the cells above the selected one (not it). */
export function runAbove(path: string, key?: string): void {
  const doc = getDoc(path);
  const cells = doc?.notebook?.cells ?? [];
  const index = cells.findIndex((cell) => cell.key === (key ?? doc?.selected));
  if (index > 0) void runCells(path, cells.slice(0, index).map((cell) => cell.key));
}

/** Run the selected cell and everything below it. */
export function runBelow(path: string, key?: string): void {
  const doc = getDoc(path);
  const cells = doc?.notebook?.cells ?? [];
  const index = cells.findIndex((cell) => cell.key === (key ?? doc?.selected));
  if (index !== -1) void runCells(path, cells.slice(index).map((cell) => cell.key));
}

export async function interruptKernel(path: string): Promise<void> {
  const run = runtimes.get(path);
  // Cells still waiting for the kernel to start: drop them.
  patch(path, (doc) => {
    const runs: Record<string, CellRun> = {};
    for (const [key, value] of Object.entries(doc.runs)) if (value.req) runs[key] = value;
    return { runs };
  });
  await run?.kernel?.interrupt().catch((error) => useUiStore.getState().setLastError(String(error)));
}

/** Restart the kernel (variables are lost); resolves once it's back. */
export async function restartKernel(path: string): Promise<void> {
  const run = runtimes.get(path);
  const doc = getDoc(path);
  if (!run?.kernel || !doc || doc.kernelState === "dead" || doc.kernelState === "starting") {
    // Nothing (alive) to restart: a fresh start does the same.
    patch(path, () => ({ runs: {}, input: null }));
    await ensureKernel(path).catch(() => {});
    return;
  }
  patch(path, () => ({ kernelState: "restarting", runs: {}, input: null }));
  const done = new Promise<void>((resolve) => run.restartDone.push(resolve));
  await run.kernel.restart().catch((error) => useUiStore.getState().setLastError(String(error)));
  await done;
}

export async function restartAndRunAll(path: string): Promise<void> {
  await restartKernel(path);
  if (getDoc(path)?.kernelState === "idle") runAll(path);
}

/** Answer the kernel's input() prompt. */
export function submitInput(path: string, value: string): void {
  const doc = getDoc(path);
  const run = runtimes.get(path);
  if (!doc?.input || !run?.kernel) return;
  const { cellKey, prompt, password } = doc.input;
  // Echo what was typed into the output, like Jupyter.
  appendOutput(path, run, cellKey, { output_type: "stream", name: "stdout", text: `${prompt}${password ? "········" : value}\n` });
  patch(path, () => ({ input: null }));
  void run.kernel.inputReply(value).catch((error) => useUiStore.getState().setLastError(String(error)));
}

/** Switch kernels (saved in the notebook's metadata); restarts a running one. */
export async function selectKernel(path: string, name: string, displayName: string, language: string): Promise<void> {
  const doc = getDoc(path);
  if (!doc?.notebook) return;
  const changed = doc.kernelName !== name;
  patch(path, (current) => ({
    kernelName: name,
    kernelDisplayName: displayName,
    notebook: current.notebook
      ? {
          ...current.notebook,
          metadata: { ...current.notebook.metadata, kernelspec: { display_name: displayName, language, name } },
        }
      : current.notebook,
  }));
  if (changed) markDirty(path);
  const run = runtimes.get(path);
  if (changed && run?.kernel) {
    patch(path, () => ({ kernelState: "unstarted", runs: {}, input: null }));
    const kernel = run.kernel;
    run.kernel = null;
    await kernel.stop().catch(() => {});
  }
  await ensureKernel(path).catch(() => {});
}

/** `pip install ipykernel` for the interpreter, then start the kernel. */
export async function installKernelPackages(path: string): Promise<void> {
  const doc = getDoc(path);
  if (!doc) return;
  patch(path, () => ({ installing: true, kernelMessage: null }));
  try {
    await installIpykernel(doc.python ?? (await selectedPython()));
    patch(path, () => ({ installing: false, missingPackages: null, kernelState: "unstarted" }));
    await ensureKernel(path).catch(() => {});
  } catch (error) {
    patch(path, () => ({ installing: false, kernelMessage: String(error) }));
  }
}

// --- Completions and hover from the kernel ---------------------------------------------------------

/** UTF-16 offset in `text` → code points (Jupyter's cursor positions). */
const toCodePoints = (text: string, offset: number) => [...text.slice(0, offset)].length;

/** Code points → UTF-16 offset. */
function fromCodePoints(text: string, points: number): number {
  let offset = 0;
  let count = 0;
  for (const char of text) {
    if (count >= points) break;
    offset += char.length;
    count += 1;
  }
  return offset;
}

const COMPLETION_KINDS: Record<string, MonacoTypes.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  module: monaco.languages.CompletionItemKind.Module,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  instance: monaco.languages.CompletionItemKind.Variable,
  statement: monaco.languages.CompletionItemKind.Variable,
  param: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Property,
  path: monaco.languages.CompletionItemKind.File,
  magic: monaco.languages.CompletionItemKind.Keyword,
};

/** The kernel serving a cell model, if it can answer right now. */
function idleKernelFor(model: MonacoTypes.editor.ITextModel): KernelConnection | null {
  const owner = modelOwners.get(model.uri.toString());
  if (!owner) return null;
  const doc = getDoc(owner.path);
  const kernel = runtimes.get(owner.path)?.kernel;
  // A busy kernel answers only after the running cell: don't wait for it.
  return kernel && doc?.kernelState === "idle" ? kernel : null;
}

let providersRegistered = false;

function registerKernelProviders() {
  if (providersRegistered) return;
  providersRegistered = true;
  const selector = { scheme: "sable-cell" };
  monaco.languages.registerCompletionItemProvider(selector, {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const kernel = idleKernelFor(model);
      if (!kernel) return { suggestions: [] };
      const code = model.getValue();
      const offset = model.getOffsetAt(position);
      const reply = await kernel.request("complete", { code, cursor_pos: toCodePoints(code, offset) });
      if (!reply || !Array.isArray(reply.matches)) return { suggestions: [] };
      const start = model.getPositionAt(fromCodePoints(code, reply.cursor_start ?? 0));
      const end = model.getPositionAt(fromCodePoints(code, reply.cursor_end ?? 0));
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      const types: { text: string; type?: string; signature?: string }[] = reply.metadata?._jupyter_types_experimental ?? [];
      const typeOf = new Map(types.map((entry) => [entry.text, entry]));
      return {
        suggestions: (reply.matches as string[]).slice(0, 500).map((match, index) => {
          const info = typeOf.get(match);
          return {
            label: match,
            insertText: match,
            range,
            kind: COMPLETION_KINDS[info?.type ?? ""] ?? monaco.languages.CompletionItemKind.Text,
            detail: info?.signature || info?.type || "kernel",
            sortText: String(index).padStart(5, "0"),
          };
        }),
      };
    },
  });
  monaco.languages.registerHoverProvider(selector, {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      const kernel = word ? idleKernelFor(model) : null;
      if (!kernel || !word) return null;
      const code = model.getValue();
      // Inspect at the end of the word (where Jupyter's Shift+Tab looks).
      const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.endColumn });
      const reply = await kernel.request("inspect", { code, cursor_pos: toCodePoints(code, offset), detail_level: 0 }, 1500);
      const text = reply?.found ? stripAnsi(String(reply.data?.["text/plain"] ?? "")).trim() : "";
      if (!text) return null;
      const lines = text.split("\n");
      const shown = lines.length > 40 ? [...lines.slice(0, 40), "…"].join("\n") : text;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: "```text\n" + shown.replace(/```/g, "ˋˋˋ") + "\n```" }],
      };
    },
  });
}

// --- Wiring --------------------------------------------------------------------------------

function runCommand(path: string, command: NotebookCommand) {
  switch (command) {
    case "runAll":
      return runAll(path);
    case "runCell":
      return runSelected(path, "stay");
    case "interrupt":
      return void interruptKernel(path);
    case "restart":
      return void restartKernel(path);
    case "restartRunAll":
      return void restartAndRunAll(path);
    case "clearOutputs":
      return clearAllOutputs(path);
    case "selectKernel":
      return openKernelPicker(path);
  }
}

/** Views listen for this to open their kernel picker. */
export const kernelPickerRequests = new EventTarget();
function openKernelPicker(path: string) {
  kernelPickerRequests.dispatchEvent(new CustomEvent("open", { detail: path }));
}

/** Connect the tabs store and Monaco (once, when the notebook editor loads). */
export function installNotebookSupport(): void {
  registerKernelProviders();
  notebookHooks.save = saveNotebook;
  notebookHooks.close = closeNotebook;
  notebookHooks.rename = renameNotebook;
  notebookHooks.command = runCommand;
}
