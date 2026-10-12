import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Braces,
  Check,
  ChevronDown,
  Eraser,
  FastForward,
  ListOrdered,
  Play,
  Plus,
  RotateCw,
  Square,
  Undo2,
} from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { themeById } from "../../lib/themes";
import { useColorTheme } from "../../store/settingsStore";
import { useTabsStore } from "../../store/tabsStore";
import { useInterpreterStore } from "../../store/interpreterStore";
import { listKernelSpecs, type KernelSpecs } from "../../lib/notebook/kernel";
import {
  clearAllOutputs,
  codeLanguage,
  deleteCell,
  ensureDoc,
  ensureKernel,
  insertCell,
  installKernelPackages,
  installNotebookSupport,
  interruptKernel,
  kernelPickerRequests,
  moveCell,
  moveSelection,
  restartAndRunAll,
  restartKernel,
  runAbove,
  runAll,
  runBelow,
  runSelected,
  selectKernel,
  setCellType,
  setMarkdownEditing,
  setMode,
  toggleLineNumbers,
  toggleOutputCollapsed,
  undoDelete,
  useNotebookStore,
  type KernelState,
  type NotebookDoc,
} from "../../lib/notebook/notebookStore";
import { NotebookCell } from "./NotebookCell";
import "../Editor/MarkdownPreview.css";
import "./Notebook.css";

installNotebookSupport();

const STATE_LABEL: Record<KernelState, string> = {
  unstarted: "Not started",
  starting: "Starting…",
  idle: "Idle",
  busy: "Busy",
  restarting: "Restarting…",
  dead: "Dead",
  missing: "Needs ipykernel",
};

const isMac = navigator.platform.toLowerCase().includes("mac");

/** The kernel's name and state; opens the list of kernels. */
function KernelPicker({ doc }: { doc: NotebookDoc }) {
  const [open, setOpen] = useState(false);
  const [specs, setSpecs] = useState<KernelSpecs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const python = useInterpreterStore((state) => state.selectedPath);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onRequest = (event: Event) => {
      if ((event as CustomEvent).detail === doc.path) setOpen(true);
    };
    kernelPickerRequests.addEventListener("open", onRequest);
    return () => kernelPickerRequests.removeEventListener("open", onRequest);
  }, [doc.path]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void listKernelSpecs(python).then(
      (result) => !cancelled && setSpecs(result),
      (failure) => !cancelled && setError(String(failure)),
    );
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => {
      cancelled = true;
      window.removeEventListener("mousedown", close);
    };
  }, [open, python]);

  const entries = Object.entries(specs?.specs ?? {});
  return (
    <div className="nb-kernel" ref={root}>
      <button className="nb-kernel-button" title="Select kernel" onClick={() => setOpen((value) => !value)}>
        <span className={`nb-kernel-dot ${doc.kernelState}`} />
        <span className="nb-kernel-name">{doc.kernelDisplayName}</span>
        <span className="nb-kernel-state">{STATE_LABEL[doc.kernelState]}</span>
        <ChevronDown size={12} strokeWidth={1.6} />
      </button>
      {open && (
        <div className="nb-kernel-menu" onKeyDown={(event) => event.stopPropagation()}>
          <div className="nb-kernel-menu-title">Kernels</div>
          {!specs && !error && <div className="nb-kernel-menu-note">Looking for kernels…</div>}
          {error && <div className="nb-kernel-menu-note error">{error}</div>}
          {specs && entries.length === 0 && (
            <div className="nb-kernel-menu-note">
              {specs.missing.length > 0 ? `${specs.missing.join(" and ")} not installed for this interpreter.` : "No kernels found."}
            </div>
          )}
          {entries.map(([name, spec]) => (
            <button
              key={name}
              className="nb-kernel-option"
              onClick={() => {
                setOpen(false);
                void selectKernel(doc.path, name, spec.display_name, spec.language);
              }}
            >
              <span className="nb-kernel-check">{name === doc.kernelName ? <Check size={13} strokeWidth={1.8} /> : null}</span>
              <span className="nb-kernel-option-name">{spec.display_name}</span>
              <span className="nb-kernel-option-detail">{spec.language || name}</span>
            </button>
          ))}
          {specs && specs.missing.includes("ipykernel") && (
            <button className="nb-kernel-option" onClick={() => void installKernelPackages(doc.path)}>
              <span className="nb-kernel-check" />
              <span className="nb-kernel-option-name">Install ipykernel…</span>
            </button>
          )}
          <div className="nb-kernel-menu-footer" title={specs?.python ?? python ?? "python3"}>
            <span className="nb-kernel-menu-path">&lrm;{specs?.python ?? python ?? "python3"}&lrm;</span>
            <span>Change the interpreter in the status bar.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({ title, onClick, children, disabled, optional }: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; optional?: boolean }) {
  return (
    <button className="nb-tool" title={title} onClick={onClick} disabled={disabled} data-optional={optional || undefined}>
      {children}
    </button>
  );
}

/** Between cells (and after the last): add a code or Markdown cell there. */
function InsertBar({ path, afterKey }: { path: string; afterKey: string | null }) {
  const add = (type: "code" | "markdown") => {
    if (afterKey) insertCell(path, "below", { key: afterKey, type, edit: true });
    else insertCell(path, "above", { key: useNotebookStore.getState().docs[path]?.notebook?.cells[0]?.key, type, edit: true });
  };
  return (
    <div className="nb-insert">
      <div className="nb-insert-line" />
      <button onClick={() => add("code")}>
        <Plus size={12} strokeWidth={1.8} /> Code
      </button>
      <button onClick={() => add("markdown")}>
        <Plus size={12} strokeWidth={1.8} /> Markdown
      </button>
      <div className="nb-insert-line" />
    </div>
  );
}

/**
 * A Jupyter notebook: cells (code and Markdown), their outputs, and the
 * kernel that runs them, with JupyterLab's keys. Command mode (Esc): keys
 * act on cells — A/B add, D D delete, Z undo delete, M/Y Markdown/code,
 * ↑/↓ or J/K select, Enter edits. Shift+Enter runs and moves on,
 * ⌘/Ctrl+Enter runs in place, Alt+Enter runs and inserts below.
 */
export default function NotebookView({ path, active }: { path: string; active: boolean }) {
  useEffect(() => ensureDoc(path), [path]);
  const doc = useNotebookStore((state) => state.docs[path]);
  const colorTheme = useColorTheme();
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastKey = useRef<{ key: string; at: number } | null>(null);

  // Cell editors share Monaco's (global) theme; ANSI colors follow the terminal palette.
  useEffect(() => monaco.editor.setTheme(colorTheme), [colorTheme]);
  const ansiVariables = useMemo(() => {
    const palette = themeById(colorTheme).terminal;
    if (!palette) return {};
    const order = [
      palette.black, palette.red, palette.green, palette.yellow, palette.blue, palette.magenta, palette.cyan, palette.white,
      palette.brightBlack, palette.brightRed, palette.brightGreen, palette.brightYellow, palette.brightBlue, palette.brightMagenta, palette.brightCyan, palette.brightWhite,
    ];
    return Object.fromEntries(order.map((color, index) => [`--nb-ansi-${index}`, color])) as React.CSSProperties;
  }, [colorTheme]);

  const language = codeLanguage(doc?.notebook ?? null);
  const selected = doc?.selected ?? null;
  const mode = doc?.mode ?? "command";

  // Command mode keeps the keyboard on the notebook (not a cell's editor).
  useEffect(() => {
    if (!active || mode !== "command") return;
    const element = root.current;
    const focusedInside = element?.contains(document.activeElement);
    const inEditor = document.activeElement?.closest(".monaco-editor");
    if (element && (!focusedInside || inEditor)) element.focus({ preventScroll: true });
  }, [active, mode, selected]);

  // Keep the selected cell in view.
  useEffect(() => {
    if (!selected) return;
    const element = scroller.current?.querySelector<HTMLElement>(`[data-cell-key="${CSS.escape(selected)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!doc || (!doc.notebook && !doc.error)) {
    return <div className="nb-root nb-message">Loading notebook…</div>;
  }
  if (doc.error || !doc.notebook) {
    return (
      <div className="nb-root nb-message">
        <p>{doc.error}</p>
        <button className="nb-button" onClick={() => void useTabsStore.getState().openFile(path, { asText: true })}>
          Open as Text
        </button>
      </div>
    );
  }

  const cells = doc.notebook.cells;
  const busy = Object.keys(doc.runs).length > 0;
  const kernelUp = doc.kernelState === "idle" || doc.kernelState === "busy";

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".monaco-editor, input, textarea, select, .nb-kernel-menu")) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const twice = (name: string) => {
      const now = Date.now();
      const previous = lastKey.current;
      lastKey.current = { key: name, at: now };
      if (previous?.key === name && now - previous.at < 600) {
        lastKey.current = null;
        return true;
      }
      return false;
    };
    if (key === "Enter") {
      handled();
      if (event.shiftKey) runSelected(path, "next");
      else if (mod || event.ctrlKey) runSelected(path, "stay");
      else if (event.altKey) runSelected(path, "insert");
      else setMode(path, "edit");
      return;
    }
    if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      handled();
      moveCell(path, key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (!plain && !(event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)) return;
    switch (key) {
      case "ArrowUp":
      case "k":
        handled();
        moveSelection(path, -1);
        return;
      case "ArrowDown":
      case "j":
        handled();
        moveSelection(path, 1);
        return;
      case "a":
        handled();
        insertCell(path, "above");
        return;
      case "b":
        handled();
        insertCell(path, "below");
        return;
      case "d":
        handled();
        if (twice("d")) deleteCell(path);
        return;
      case "z":
        handled();
        undoDelete(path);
        return;
      case "m":
        handled();
        setCellType(path, "markdown");
        return;
      case "y":
        handled();
        setCellType(path, "code");
        if (selected) setMarkdownEditing(path, selected, false);
        return;
      case "r":
        handled();
        setCellType(path, "raw");
        return;
      case "i":
        handled();
        if (twice("i")) void interruptKernel(path);
        return;
      case "0":
        handled();
        if (twice("0")) void restartKernel(path);
        return;
      case "l":
        handled();
        toggleLineNumbers(path);
        return;
      case "o":
        handled();
        if (selected) toggleOutputCollapsed(path, selected);
        return;
      case "Home":
        handled();
        moveSelection(path, -cells.length);
        return;
      case "End":
        handled();
        moveSelection(path, cells.length);
        return;
    }
  };

  return (
    <div
      ref={root}
      className={`nb-root ${mode === "edit" ? "edit-mode" : "command-mode"}`}
      style={ansiVariables}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="nb-toolbar">
        <div className="nb-toolbar-group">
          <ToolbarButton title="Add a code cell below (B)" onClick={() => insertCell(path, "below", { edit: true })}>
            <Plus size={14} strokeWidth={1.6} /> <span>Code</span>
          </ToolbarButton>
          <ToolbarButton title="Add a Markdown cell below" onClick={() => insertCell(path, "below", { type: "markdown", edit: true })}>
            <Plus size={14} strokeWidth={1.6} /> <span>Markdown</span>
          </ToolbarButton>
        </div>
        <div className="nb-toolbar-separator" />
        <div className="nb-toolbar-group">
          <ToolbarButton title="Run All" onClick={() => runAll(path)}>
            <Play size={13} strokeWidth={1.6} /> <span>Run All</span>
          </ToolbarButton>
          <ToolbarButton optional title="Run the cells above the selected one" onClick={() => runAbove(path)}>
            <ArrowUpToLine size={14} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton optional title="Run the selected cell and those below it" onClick={() => runBelow(path)}>
            <ArrowDownToLine size={14} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton title="Interrupt the kernel (I I)" onClick={() => void interruptKernel(path)} disabled={!busy}>
            <Square size={12} strokeWidth={1.8} />
          </ToolbarButton>
          <ToolbarButton title="Restart the kernel (0 0)" onClick={() => void restartKernel(path)} disabled={!kernelUp && doc.kernelState !== "dead"}>
            <RotateCw size={13} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton title="Restart the kernel and run all cells" onClick={() => void restartAndRunAll(path)}>
            <FastForward size={14} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton title="Clear all outputs" onClick={() => clearAllOutputs(path)}>
            <Eraser size={14} strokeWidth={1.6} />
          </ToolbarButton>
        </div>
        <div className="nb-toolbar-separator" />
        <div className="nb-toolbar-group">
          <ToolbarButton optional title={doc.deleted.length > 0 ? "Undo cell deletion (Z)" : "No deleted cells"} onClick={() => undoDelete(path)} disabled={doc.deleted.length === 0}>
            <Undo2 size={14} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton optional title="Toggle line numbers (L)" onClick={() => toggleLineNumbers(path)}>
            <ListOrdered size={14} strokeWidth={1.6} />
          </ToolbarButton>
          <ToolbarButton title="Open as Text (the notebook's JSON)" onClick={() => void useTabsStore.getState().openFile(path, { asText: true })}>
            <Braces size={14} strokeWidth={1.6} />
          </ToolbarButton>
        </div>
        <div className="nb-toolbar-spacer" />
        <KernelPicker doc={doc} />
      </div>
      {doc.missingPackages && (
        <div className="nb-banner">
          <span>
            Running this notebook needs Jupyter's kernel packages ({doc.missingPackages.join(", ")}) in{" "}
            <code>{doc.python ?? "python3"}</code>.
          </span>
          <button className="nb-button primary" disabled={doc.installing} onClick={() => void installKernelPackages(path)}>
            {doc.installing ? "Installing…" : "Install ipykernel"}
          </button>
        </div>
      )}
      {doc.kernelMessage && (
        <div className="nb-banner error">
          <span>{doc.kernelMessage}</span>
          {doc.kernelState === "dead" && (
            <button className="nb-button" onClick={() => void ensureKernel(path).catch(() => {})}>
              Start Kernel
            </button>
          )}
        </div>
      )}
      <div className="nb-scroll" ref={scroller}>
        <div className="nb-cells">
          <InsertBar path={path} afterKey={null} />
          {cells.map((cell, index) => (
            <div key={cell.key} className="nb-cell-slot">
              <NotebookCell
                path={path}
                cell={cell}
                index={index}
                count={cells.length}
                language={language}
                selected={cell.key === selected}
                editing={active && cell.key === selected && mode === "edit"}
                markdownEditing={!!doc.editingMarkdown[cell.key]}
                run={doc.runs[cell.key]}
                timing={doc.timings[cell.key]}
                collapsed={!!doc.collapsedOutputs[cell.key]}
                expanded={!!doc.expandedOutputs[cell.key]}
                input={doc.input?.cellKey === cell.key ? doc.input : null}
                lineNumbers={doc.lineNumbers}
              />
              <InsertBar path={path} afterKey={cell.key} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
