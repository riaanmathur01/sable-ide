import { memo, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, ChevronsDown, Play, Square, Trash2 } from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { readFileBase64 } from "../../lib/ipc";
import type { NbCell } from "../../lib/notebook/nbformat";
import {
  cellSource,
  deleteCell,
  interruptKernel,
  moveCell,
  runBelow,
  runCells,
  selectCell,
  setCellType,
  setMarkdownEditing,
  setMode,
  type CellRun,
  type CellTiming,
} from "../../lib/notebook/notebookStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { CellEditor } from "./CellEditor";
import { CellOutputs } from "./CellOutputs";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const isExternal = (href: string) => /^(https?:|mailto:|data:)/i.test(href);

function resolve(base: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (/^([/\\]|[A-Za-z]:)/.test(clean)) return clean;
  const separator = base.includes("\\") ? "\\" : "/";
  const resolved: string[] = [];
  for (const part of `${base}${separator}${clean}`.split(/[/\\]/)) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join(separator);
}

function languageOf(label: string): string | null {
  const wanted = label.toLowerCase();
  if (!wanted) return null;
  return (
    monaco.languages
      .getLanguages()
      .find((candidate) => candidate.id === wanted || candidate.aliases?.some((alias) => alias.toLowerCase() === wanted))?.id ?? null
  );
}

/** A Markdown cell, rendered (as in Sable's Markdown preview). */
function RenderedMarkdown({ path, cell, source }: { path: string; cell: NbCell; source: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = element.current;
    if (!root) return;
    root.innerHTML = DOMPurify.sanitize(marked.parse(source, { gfm: true, async: false }) as string);
    let cancelled = false;
    for (const code of root.querySelectorAll("pre > code")) {
      const language = languageOf(/language-([\w+#-]+)/.exec(code.className)?.[1] ?? "");
      if (!language) continue;
      void monaco.editor.colorize(code.textContent ?? "", language, { tabSize: 4 }).then((colored) => {
        if (!cancelled) code.innerHTML = colored.replace(/(<br\s*\/?>\s*)+$/, "");
      });
    }
    const attachments = (cell.raw.attachments ?? {}) as Record<string, Record<string, string>>;
    for (const image of root.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (src.startsWith("attachment:")) {
        const bundle = attachments[decodeURIComponent(src.slice("attachment:".length))];
        const mime = bundle && Object.keys(bundle).find((type) => type.startsWith("image/"));
        if (mime) {
          const data = Array.isArray(bundle[mime]) ? (bundle[mime] as unknown as string[]).join("") : bundle[mime];
          image.src = mime === "image/svg+xml" ? `data:${mime};charset=utf-8,${encodeURIComponent(data)}` : `data:${mime};base64,${data.replace(/\s/g, "")}`;
        }
        continue;
      }
      if (!src || isExternal(src)) continue;
      const file = resolve(dirOf(path), src);
      const type = IMAGE_TYPES[file.split(".").pop()?.toLowerCase() ?? ""];
      if (!type) continue;
      void readFileBase64(file).then(
        (data) => {
          if (!cancelled) image.src = `data:${type};base64,${data}`;
        },
        () => image.classList.add("missing"),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [source, path, cell.raw.attachments]);

  const onClick = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href).catch((error) => useUiStore.getState().setLastError(String(error)));
    else if (!href.startsWith("#")) void useTabsStore.getState().openFile(resolve(dirOf(path), href));
  };

  if (!source.trim()) {
    return <div className="nb-markdown-empty">Empty Markdown cell — double-click or press Enter to edit</div>;
  }
  return <div ref={element} className="nb-markdown markdown-body" onClick={onClick} />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "Running 3.2 s" while it runs, then how long it took. */
function RunStatus({ run, timing }: { run: CellRun | undefined; timing: CellTiming | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run?.state !== "running") return;
    const timer = setInterval(() => tick((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [run?.state]);
  if (run) {
    return (
      <div className="nb-cell-status running">
        {run.state === "running" && run.started !== null ? formatDuration(Date.now() - run.started) : "Queued"}
      </div>
    );
  }
  if (!timing) return null;
  return (
    <div className={`nb-cell-status ${timing.status}`}>
      <span className="nb-cell-status-mark">{timing.status === "ok" ? "✓" : "✗"}</span>
      {formatDuration(timing.ms)}
    </div>
  );
}

export interface NotebookCellProps {
  path: string;
  cell: NbCell;
  index: number;
  count: number;
  language: string;
  selected: boolean;
  editing: boolean;
  markdownEditing: boolean;
  run: CellRun | undefined;
  timing: CellTiming | undefined;
  collapsed: boolean;
  expanded: boolean;
  input: { prompt: string; password: boolean } | null;
  lineNumbers: boolean;
}

export const NotebookCell = memo(function NotebookCell({
  path,
  cell,
  index,
  count,
  language,
  selected,
  editing,
  markdownEditing,
  run,
  timing,
  collapsed,
  expanded,
  input,
  lineNumbers,
}: NotebookCellProps) {
  const isCode = cell.cell_type === "code";
  const isMarkdown = cell.cell_type === "markdown";
  const showEditor = !isMarkdown || markdownEditing;
  const editorLanguage = isCode ? language : isMarkdown ? "markdown" : "plaintext";
  const prompt = run ? "*" : cell.execution_count ?? " ";

  const classes = ["nb-cell", `nb-cell-${cell.cell_type}`];
  if (selected) classes.push("selected");
  if (editing) classes.push("editing");
  if (run) classes.push(run.state === "running" ? "running" : "queued");

  return (
    <div
      className={classes.join(" ")}
      data-cell-key={cell.key}
      data-cell-index={index}
      onMouseDown={(event) => {
        // Clicks in the editor select through its focus handler.
        if ((event.target as Element).closest(".monaco-editor, .nb-stdin, .nb-cell-toolbar, .nb-output-frame")) return;
        selectCell(path, cell.key, "command");
      }}
    >
      <div className="nb-cell-gutter">
        {isCode ? (
          <>
            <button
              className={run ? "nb-run-button active" : "nb-run-button"}
              title={run ? "Interrupt (I I)" : "Run cell (⌘/Ctrl+Enter)"}
              onClick={(event) => {
                event.stopPropagation();
                if (run) void interruptKernel(path);
                else {
                  selectCell(path, cell.key, "command");
                  void runCells(path, [cell.key]);
                }
              }}
            >
              {run?.state === "running" ? (
                <>
                  <span className="nb-run-ring" />
                  <Square size={8} strokeWidth={0} fill="currentColor" />
                </>
              ) : run ? (
                <Square size={9} strokeWidth={0} fill="currentColor" />
              ) : (
                <Play size={12} strokeWidth={0} fill="currentColor" />
              )}
            </button>
            <div className="nb-exec-count" title={cell.execution_count ? `Execution ${cell.execution_count}` : undefined}>
              [{prompt}]
            </div>
          </>
        ) : null}
      </div>
      <div className="nb-cell-main">
        <div
          className="nb-cell-input"
          onDoubleClick={() => {
            if (!isMarkdown || markdownEditing) return;
            setMarkdownEditing(path, cell.key, true);
            selectCell(path, cell.key, "edit");
          }}
        >
          {showEditor ? (
            <CellEditor
              path={path}
              cellKey={cell.key}
              language={editorLanguage}
              focused={editing}
              lineNumbers={lineNumbers}
              markdown={isMarkdown}
            />
          ) : (
            <RenderedMarkdown path={path} cell={cell} source={cellSource(path, cell)} />
          )}
          {cell.cell_type === "raw" && <span className="nb-cell-kind">Raw</span>}
          {isMarkdown && markdownEditing && <span className="nb-cell-kind">Markdown</span>}
        </div>
        {isCode && <RunStatus run={run} timing={timing} />}
        {isCode && <CellOutputs path={path} cellKey={cell.key} outputs={cell.outputs} collapsed={collapsed} expanded={expanded} input={input} />}
      </div>
      {selected && (
        <div className="nb-cell-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          {isCode && (
            <button title="Run this cell and below" onClick={() => runBelow(path, cell.key)}>
              <ChevronsDown size={13} strokeWidth={1.6} />
            </button>
          )}
          <button
            className="nb-type-toggle"
            title={isCode ? "Change to Markdown (M)" : "Change to Code (Y)"}
            onClick={() => {
              setCellType(path, isCode ? "markdown" : "code", cell.key);
              setMode(path, "command");
            }}
          >
            {isCode ? "M↓" : "{ }"}
          </button>
          <button title="Move up (⌥↑)" disabled={index === 0} onClick={() => moveCell(path, -1, cell.key)}>
            <ArrowUp size={13} strokeWidth={1.6} />
          </button>
          <button title="Move down (⌥↓)" disabled={index === count - 1} onClick={() => moveCell(path, 1, cell.key)}>
            <ArrowDown size={13} strokeWidth={1.6} />
          </button>
          <button title="Delete cell (D D)" className="danger" onClick={() => deleteCell(path, cell.key)}>
            <Trash2 size={13} strokeWidth={1.6} />
          </button>
        </div>
      )}
    </div>
  );
});
