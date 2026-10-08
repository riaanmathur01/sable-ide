import { useEffect, useRef, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { historyDeletedFiles, historyList, historyRead, readFile, writeFile, type HistorySnapshot } from "../../lib/ipc";
import { monaco } from "../../lib/monacoSetup";
import { getModelValue } from "../../lib/editorRegistry";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { cachedThemeId } from "../../lib/themes";
import "./DiffView.css";
import "./LocalHistoryView.css";

function languageForPath(path: string): string {
  const extension = "." + (path.split(".").pop()?.toLowerCase() ?? "");
  return monaco.languages.getLanguages().find((lang) => lang.extensions?.includes(extension))?.id ?? "plaintext";
}

function when(timestamp: number): string {
  const date = new Date(timestamp);
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  const relative =
    seconds < 60
      ? "just now"
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min ago`
        : seconds < 86400
          ? `${Math.round(seconds / 3600)} h ago`
          : `${Math.round(seconds / 86400)} d ago`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ${relative}`;
}

const name = (path: string) => path.split(/[/\\]/).pop() ?? path;

/**
 * Local history: every version Sable saved of a file, newest first, each
 * compared with the file as it is now — and Revert. With no file, the
 * files Sable deleted (Recover Deleted File).
 */
export default function LocalHistoryView({ filePath: initialFile }: { filePath: string | null }) {
  const [filePath, setFilePath] = useState(initialFile);
  const [deleted, setDeleted] = useState<{ path: string; deletedAt: number }[] | null>(null);
  const [snapshots, setSnapshots] = useState<HistorySnapshot[]>([]);
  const [selected, setSelected] = useState<HistorySnapshot | null>(null);
  const [exists, setExists] = useState(true);
  const [message, setMessage] = useState<string | null>("Loading…");
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoTypes.editor.IStandaloneDiffEditor | null>(null);
  const snapshotText = useRef("");

  // Deleted-files mode: the list of what can be recovered.
  useEffect(() => {
    if (filePath) return;
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    void historyDeletedFiles(root).then((files) => {
      setDeleted(files);
      setMessage(files.length ? "Choose a file to see its versions" : "No deleted files in local history");
    });
  }, [filePath]);

  // A file: its snapshots.
  useEffect(() => {
    if (!filePath) return;
    void historyList(filePath).then((list) => {
      setSnapshots(list);
      setSelected(list[0] ?? null);
      if (!list.length) setMessage("No local history yet — versions are kept each time the file is saved");
    });
    void readFile(filePath).then(
      () => setExists(true),
      () => setExists(false),
    );
  }, [filePath]);

  // The selected version against the current file.
  useEffect(() => {
    const container = containerRef.current;
    if (!filePath || !selected || !container) return;
    let disposed = false;
    const models: MonacoTypes.editor.ITextModel[] = [];
    void (async () => {
      const old = await historyRead(filePath, selected.id);
      const current = getModelValue(filePath) ?? (await readFile(filePath).catch(() => ""));
      if (disposed) return;
      snapshotText.current = old;
      setMessage(null);
      const language = languageForPath(filePath);
      models.push(monaco.editor.createModel(old, language), monaco.editor.createModel(current, language));
      if (!editorRef.current) {
        editorRef.current = monaco.editor.createDiffEditor(container, {
          theme: useSettingsStore.getState().loaded ? getSetting("workbench.colorTheme") : cachedThemeId(),
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: getSetting("editor.fontFamily"),
          fontSize: getSetting("editor.fontSize"),
          lineHeight: getSetting("editor.lineHeight"),
          scrollBeyondLastLine: false,
        });
      }
      editorRef.current.setModel({ original: models[0], modified: models[1] });
    })();
    return () => {
      disposed = true;
      editorRef.current?.setModel(null);
      models.forEach((model) => model.dispose());
    };
  }, [filePath, selected]);

  useEffect(() => () => editorRef.current?.dispose(), []);

  const revert = async () => {
    if (!filePath || !selected) return;
    const text = snapshotText.current;
    const tabs = useTabsStore.getState();
    const model = monaco.editor.getModel(monaco.Uri.file(filePath));
    try {
      if (model) {
        // Undoable, like any edit.
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        model.pushStackElement();
        await tabs.saveTab(filePath, "auto");
      } else {
        await writeFile(filePath, text);
      }
      useUiStore.getState().showStatus(`${name(filePath)} reverted to the version from ${when(selected.timestamp)}`);
      setExists(true);
      const list = await historyList(filePath);
      setSnapshots(list);
      setSelected(list[0] ?? null);
      if (!model) await tabs.openFile(filePath);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  };

  return (
    <div className="local-history">
      <div className="local-history-list">
        <div className="local-history-heading">
          <History size={13} strokeWidth={1.5} />
          {filePath ? name(filePath) : "Deleted files"}
          {filePath && initialFile === null && (
            <button className="local-history-back" onClick={() => setFilePath(null)}>
              ← All
            </button>
          )}
        </div>
        {!filePath &&
          deleted?.map((file) => (
            <button key={file.path} className="local-history-item" onClick={() => setFilePath(file.path)} title={file.path}>
              <span className="local-history-label">{name(file.path)}</span>
              <span className="local-history-time">deleted {when(file.deletedAt)}</span>
            </button>
          ))}
        {filePath &&
          snapshots.map((snapshot) => (
            <button
              key={snapshot.id}
              className={snapshot.id === selected?.id ? "local-history-item selected" : "local-history-item"}
              onClick={() => setSelected(snapshot)}
            >
              <span className="local-history-label">{snapshot.label}</span>
              <span className="local-history-time">{when(snapshot.timestamp)}</span>
            </button>
          ))}
      </div>
      <div className="local-history-main">
        <div className="diff-toolbar">
          <span className="local-history-caption">
            {selected && filePath ? `${selected.label} · ${when(selected.timestamp)}  →  ${exists ? "current" : "(file deleted)"}` : ""}
          </span>
          <button
            className="diff-toggle local-history-revert"
            disabled={!selected || !filePath}
            onClick={() => void revert()}
            title={exists ? "Replace the file's contents with this version (undoable)" : "Restore the file with this version"}
          >
            <RotateCcw size={13} strokeWidth={1.5} />
            <span>{exists ? "Revert to This Version" : "Restore File"}</span>
          </button>
        </div>
        <div className="diff-body">
          <div ref={containerRef} className="diff-surface" />
          {message && <div className="diff-message">{message}</div>}
        </div>
      </div>
    </div>
  );
}
