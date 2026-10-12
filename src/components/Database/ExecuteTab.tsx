import { useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoTypes from "monaco-editor";
import { FileDown, FolderOpen, History, Play, Plus, Square, StepForward, X } from "lucide-react";
import { editorOptionsFromSettings, monaco } from "../../lib/monacoSetup";
import { useSettingsStore } from "../../store/settingsStore";
import { db, type SortSpec, type StatementResult } from "../../lib/database/api";
import {
  addHistory,
  edited,
  newSqlTab,
  onDatabaseClosed,
  openSqlFile,
  refreshSchema,
  saveSqlFile,
  sqlHistory,
  update,
  useDatabaseStore,
  type SqlRun,
} from "../../lib/database/databaseStore";
import { statementAt } from "../../lib/database/sql";
import { formatCount } from "../../lib/database/values";
import { DataGrid, type GridColumn, type Selection } from "./DataGrid";
import { staticSource, useRowCache, type RowSource } from "./rowCache";

const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";

/** Monaco models for SQL tabs, by tab id (with their database). */
const models = new Map<string, MonacoTypes.editor.ITextModel>();
const modelPaths = new Map<string, string>();
function modelFor(path: string, id: string, text: string) {
  let model = models.get(id);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(text, "sql", monaco.Uri.parse(`sable-sql://db/${encodeURIComponent(path)}/${id}.sql`));
    models.set(id, model);
    modelPaths.set(id, path);
  }
  return model;
}
// A closed database's SQL tabs (their text is saved with the store).
onDatabaseClosed((path) => {
  for (const [id, owner] of modelPaths) {
    if (owner !== path) continue;
    models.get(id)?.dispose();
    models.delete(id);
    modelPaths.delete(id);
  }
});

let runCounter = 0;

/** The statement the results come from: the last one, if it returned rows. */
function resultStatement(run: SqlRun | null): StatementResult | null {
  const statements = run?.result?.statements ?? [];
  const last = statements[statements.length - 1];
  if (!last || last.kind !== "rows" || statements.length < (run?.result?.total ?? 0)) return null;
  return last;
}

/** The text of the messages pane, like DB4S's. */
function messages(run: SqlRun, rows: number | null, ms: number | null): { text: string; error: boolean } {
  if (run.running) return { text: "Executing…", error: false };
  if (run.error) return { text: `Execution aborted.\n${run.error}`, error: true };
  const result = run.result;
  if (!result) return { text: "", error: false };
  const statements = result.statements;
  const failed = statements.find((statement) => statement.kind === "error");
  const last = failed ?? statements[statements.length - 1];
  if (!last) return { text: "Nothing to execute.", error: false };
  const line = (last.errorLine ?? last.line) + run.lineOffset;
  const head = `At line ${line}:\n${last.sql}`;
  if (failed) {
    const done = statements.length - 1;
    return {
      text: `Execution finished with errors.\nResult: ${failed.error}\n${head}${done > 0 ? `\n(${done} statement${done === 1 ? "" : "s"} before it ran)` : ""}`,
      error: true,
    };
  }
  const took = Math.max(0, Math.round(ms ?? statements.reduce((sum, statement) => sum + statement.ms, 0)));
  let summary: string;
  if (last.kind === "rows") {
    const count = rows ?? last.rowCount ?? last.rows?.length ?? 0;
    summary = `${formatCount(count)} row${count === 1 ? "" : "s"} returned in ${took} ms`;
  } else {
    summary = `query executed successfully. Took ${took} ms, ${formatCount(last.changes ?? 0)} row${last.changes === 1 ? "" : "s"} affected`;
  }
  const extra = statements.length > 1 ? `\n(${statements.length} statements executed)` : "";
  return { text: `Execution finished without errors.\nResult: ${summary}\n${head}${extra}`, error: false };
}

/**
 * Execute SQL: a SQL editor (several tabs), Run All (⌘↵) / Run Current
 * Statement (⇧⌘↵), the last statement's rows in a grid, messages with
 * timing or the error and its line, and a history of what ran.
 */
export function ExecuteTab({ path, active }: { path: string; active: boolean }) {
  const sqlTabs = useDatabaseStore((state) => state.docs[path]?.sqlTabs ?? []);
  const activeSql = useDatabaseStore((state) => state.docs[path]?.activeSql ?? "");
  const settings = useSettingsStore((state) => state.values);
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const [editorHeight, setEditorHeight] = useState(240);
  const [showHistory, setShowHistory] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const tab = sqlTabs.find((candidate) => candidate.id === activeSql) ?? sqlTabs[0];
  const run = tab?.run ?? null;
  const runRef = useRef<(current: boolean) => void>(() => {});
  const decorations = useRef<MonacoTypes.editor.IEditorDecorationsCollection | null>(null);

  // The editor: one Monaco editor, a model per SQL tab.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const editor = monaco.editor.create(element, {
      ...editorOptionsFromSettings(useSettingsStore.getState().values),
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      padding: { top: 6, bottom: 6 },
      fixedOverflowWidgets: true,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
    });
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current(false));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runRef.current(true));
    editor.addCommand(monaco.KeyCode.F5, () => runRef.current(false));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changes = editor.onDidChangeModelContent(() => {
      decorations.current?.clear();
      const model = editor.getModel();
      if (!model) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const id = [...models.entries()].find(([, candidate]) => candidate === model)?.[0];
        if (!id) return;
        const text = model.getValue();
        update(path, (doc) => ({ sqlTabs: doc.sqlTabs.map((candidate) => (candidate.id === id ? { ...candidate, text } : candidate)) }));
      }, 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      changes.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ...editorOptionsFromSettings(settings), minimap: { enabled: false } });
  }, [settings]);

  // Show the active tab's model.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !tab) return;
    const model = modelFor(path, tab.id, tab.text);
    if (editor.getModel() !== model) editor.setModel(model);
    setSort(null);
    setSelection(null);
  }, [path, tab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) setTimeout(() => editorRef.current?.layout(), 0);
  }, [active, editorHeight]);

  const setRun = (id: string, change: Partial<SqlRun> | null) =>
    update(path, (doc) => ({
      sqlTabs: doc.sqlTabs.map((candidate) =>
        candidate.id === id ? { ...candidate, run: change === null ? null : { ...(candidate.run as SqlRun), ...change } } : candidate,
      ),
    }));

  const execute = async (current: boolean) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !tab || run?.running) return;
    const text = model.getValue();
    let sql = text;
    let start = 0;
    const selectionRange = editor.getSelection();
    if (current) {
      const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
      const range = statementAt(text, offset);
      if (!range) return;
      start = range.start;
      sql = text.slice(range.start, range.end);
    } else if (selectionRange && !selectionRange.isEmpty()) {
      // Run All with a selection runs the selection (as DB4S does).
      start = model.getOffsetAt(selectionRange.getStartPosition());
      sql = model.getValueInRange(selectionRange);
    }
    if (!sql.trim()) return;
    const lineOffset = model.getPositionAt(start).lineNumber - 1;
    runCounter += 1;
    const id = runCounter;
    const tabId = tab.id;
    decorations.current?.clear();
    update(path, (doc) => ({
      sqlTabs: doc.sqlTabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, text, run: { id, sql, lineOffset, running: true, result: null, error: null, ms: 0 } } : candidate,
      ),
    }));
    setSort(null);
    setSelection(null);
    const started = performance.now();
    try {
      const result = await db.execute(path, sql);
      setRun(tabId, { running: false, result, ms: performance.now() - started });
      addHistory(path, sql);
      setHistoryTick((value) => value + 1);
      const wrote = result.statements.some((statement) => statement.kind === "changes" || (statement.changes ?? 0) > 0);
      edited(path, result.dirty, wrote);
      if (result.schemaChanged) await refreshSchema(path, true);
      const failed = result.statements.find((statement) => statement.kind === "error");
      if (failed) {
        const line = (failed.errorLine ?? failed.line) + lineOffset;
        decorations.current?.set([
          { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "db-error-line", linesDecorationsClassName: "db-error-gutter" } },
        ]);
        editor.revealLineInCenterIfOutsideViewport(line);
      }
    } catch (error) {
      setRun(tabId, { running: false, error: String(error), ms: performance.now() - started });
    }
  };
  runRef.current = (current) => void execute(current);

  const stop = () => void db.interrupt(path);

  // Results: the last statement's rows (paged through `query` for a SELECT).
  const statement = resultStatement(run);
  const source = useMemo<RowSource | null>(() => {
    if (!run || !statement) return null;
    if (statement.pageable && statement.query) {
      const query = statement.query;
      return {
        id: `run-${run.id}-${JSON.stringify(sort)}`,
        fetch: async (offset, limit, count) => {
          const page = await db.query(path, { sql: query, offset, limit, count, sort: sort ? [sort] : undefined });
          return { rows: page.rows.map((cells) => ({ cells, key: null })), total: page.total };
        },
      };
    }
    return staticSource(`run-${run.id}`, (statement.rows ?? []).map((cells) => ({ cells, key: null })));
  }, [run?.id, statement, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const cache = useRowCache(source);
  const columns: GridColumn[] = useMemo(() => (statement?.columns ?? []).map((name) => ({ name, readOnly: true })), [statement]);
  const fetching = !!statement?.pageable && source !== null && cache.readyId !== source.id;
  const message = run
    ? fetching
      ? { text: "Executing…", error: false }
      : messages(run, statement?.pageable ? cache.total : null, statement?.pageable && cache.firstMs !== null ? statement.ms + cache.firstMs : null)
    : null;

  const addTab = () => {
    const created = newSqlTab("");
    update(path, (doc) => ({ sqlTabs: [...doc.sqlTabs, created], activeSql: created.id }));
  };
  const closeTab = (id: string) => {
    update(path, (doc) => {
      const remaining = doc.sqlTabs.filter((candidate) => candidate.id !== id);
      const tabs = remaining.length > 0 ? remaining : [newSqlTab("")];
      const index = doc.sqlTabs.findIndex((candidate) => candidate.id === id);
      return { sqlTabs: tabs, activeSql: doc.activeSql === id ? tabs[Math.min(index, tabs.length - 1)].id : doc.activeSql };
    });
    models.get(id)?.dispose();
    models.delete(id);
    modelPaths.delete(id);
  };

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const start = editorHeight;
    const move = (moveEvent: MouseEvent) => setEditorHeight(Math.max(80, Math.min(window.innerHeight - 200, start + moveEvent.clientY - startY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const history = useMemo(() => (showHistory ? sqlHistory() : []), [showHistory, historyTick]);

  return (
    <div className="db-execute">
      <div className="db-sqltabs">
        {sqlTabs.map((candidate) => (
          <div
            key={candidate.id}
            className={candidate.id === tab?.id ? "db-sqltab active" : "db-sqltab"}
            onClick={() => update(path, { activeSql: candidate.id })}
            onAuxClick={(event) => event.button === 1 && closeTab(candidate.id)}
            title={candidate.file ?? candidate.title}
          >
            <span>{candidate.title}</span>
            {candidate.run?.running && <span className="db-spinner" />}
            <button
              className="db-sqltab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(candidate.id);
              }}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button className="db-sqltab-add" title="New SQL tab" onClick={addTab}>
          <Plus size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className="db-subbar">
        <button className="db-tool" title={`Execute all, or the selection (${MOD}↵ / F5)`} disabled={!!run?.running} onClick={() => void execute(false)}>
          <Play size={13} strokeWidth={1.8} /> <span>Run All</span>
        </button>
        <button className="db-tool" title={`Execute the statement at the cursor (${SHIFT}${MOD}↵)`} disabled={!!run?.running} onClick={() => void execute(true)}>
          <StepForward size={13} strokeWidth={1.8} /> <span>Run Current</span>
        </button>
        <button className="db-tool" title="Stop the running statement" disabled={!run?.running} onClick={stop}>
          <Square size={11} strokeWidth={2} />
        </button>
        <div className="db-toolbar-separator" />
        <button className="db-tool" title="Open a SQL file in a new tab" onClick={() => void openSqlFile(path)}>
          <FolderOpen size={13} strokeWidth={1.6} /> <span>Open SQL</span>
        </button>
        <button className="db-tool" title="Save this tab's SQL to a file" onClick={() => void saveSqlFile(path)}>
          <FileDown size={13} strokeWidth={1.6} /> <span>Save SQL</span>
        </button>
        <div className="db-toolbar-spacer" />
        <button className={showHistory ? "db-tool on" : "db-tool"} title="SQL history" onClick={() => setShowHistory((value) => !value)}>
          <History size={13} strokeWidth={1.6} /> <span>History</span>
        </button>
      </div>
      <div className="db-execute-main">
        <div className="db-execute-column">
          <div className="db-sql-editor" style={{ height: editorHeight }} ref={container} />
          <div className="db-hsplit" onMouseDown={startDrag} onDoubleClick={() => setEditorHeight(240)} />
          <div className="db-results">
            {statement ? (
              <DataGrid
                columns={columns}
                cache={cache}
                sort={statement.pageable ? sort : null}
                onSort={
                  statement.pageable
                    ? (column) => setSort((current) => (current?.column !== column ? { column, desc: false } : current.desc ? null : { column, desc: true }))
                    : undefined
                }
                widths={widths}
                onWidths={setWidths}
                editable={false}
                selection={selection}
                onSelection={setSelection}
                emptyMessage="No rows returned"
              />
            ) : (
              <div className="db-results-empty">{run?.running ? "Executing…" : run ? "No rows to show" : `Results appear here. ${MOD}↵ runs all, ${SHIFT}${MOD}↵ the current statement.`}</div>
            )}
          </div>
          <div className={`db-messages${message?.error ? " error" : ""}`}>
            {message ? <pre>{message.text}</pre> : <span className="db-dim">Messages</span>}
            {statement?.truncated && <div className="db-dim">Only the first {formatCount(statement.rows?.length ?? 0)} rows are shown.</div>}
          </div>
        </div>
        {showHistory && (
          <div className="db-history">
            <div className="db-history-head">History</div>
            <div className="db-history-list">
              {history.length === 0 && <div className="db-dim db-history-empty">Nothing executed yet.</div>}
              {history.map((entry) => (
                <button
                  key={`${entry.at}-${entry.sql.slice(0, 20)}`}
                  className="db-history-item"
                  title={`${entry.sql}\n\n${new Date(entry.at).toLocaleString()} — ${entry.path.split(/[/\\]/).pop()}\nClick to insert`}
                  onClick={() => {
                    const editor = editorRef.current;
                    if (!editor) return;
                    const position = editor.getSelection();
                    if (position) editor.executeEdits("history", [{ range: position, text: entry.sql }]);
                    editor.focus();
                  }}
                >
                  <code>{entry.sql}</code>
                  <span>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
