import { useEffect, useRef, useState } from "react";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronUp, Check } from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { gitConflictVersions, type ConflictVersions } from "../../lib/ipc";
import { monaco } from "../../lib/monacoSetup";
import { ensureModel } from "../../lib/lsp/monacoLsp";
import { parseConflicts, resolveAll, type Resolution } from "../../lib/git/conflicts";
import { diffLines } from "../../lib/git/hunks";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useGitStore } from "../../store/gitStore";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { cachedThemeId } from "../../lib/themes";
import "./DiffView.css";
import "./MergeView.css";

type Editor = MonacoTypes.editor.IStandaloneCodeEditor;

/** Above this many lines the side panes skip their change highlighting. */
const HIGHLIGHT_LIMIT = 4000;

function languageForPath(path: string): string {
  const extension = "." + (path.split(".").pop()?.toLowerCase() ?? "");
  return monaco.languages.getLanguages().find((lang) => lang.extensions?.includes(extension))?.id ?? "plaintext";
}

function editorOptions(readOnly: boolean): MonacoTypes.editor.IStandaloneEditorConstructionOptions {
  return {
    theme: useSettingsStore.getState().loaded ? getSetting("workbench.colorTheme") : cachedThemeId(),
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: getSetting("editor.fontFamily"),
    fontSize: getSetting("editor.fontSize"),
    fontWeight: getSetting("editor.fontWeight"),
    lineHeight: getSetting("editor.lineHeight"),
    fontLigatures: getSetting("editor.fontLigatures"),
    scrollBeyondLastLine: false,
    glyphMargin: false,
    folding: false,
    lineNumbersMinChars: 3,
  };
}

/** Tint what one side changed relative to the common ancestor. */
function highlightChanges(editor: Editor, base: string, side: string, className: string) {
  const baseLines = base.split("\n");
  const sideLines = side.split("\n");
  if (baseLines.length > HIGHLIGHT_LIMIT || sideLines.length > HIGHLIGHT_LIMIT) return;
  const decorations = diffLines(baseLines, sideLines)
    .filter((change) => change.modifiedEndLineNumber !== 0)
    .map((change) => ({
      range: {
        startLineNumber: change.modifiedStartLineNumber,
        startColumn: 1,
        endLineNumber: change.modifiedEndLineNumber,
        endColumn: 1,
      },
      options: { isWholeLine: true, className },
    }));
  editor.createDecorationsCollection(decorations);
}

/**
 * The three-way merge tool: the current branch's version (left), the
 * file being resolved (middle, editable — the real file, conflict
 * markers and all, with Accept buttons above each conflict), and the
 * incoming version (right). "Mark as Resolved" saves and stages it.
 */
export default function MergeView({ filePath }: { filePath: string }) {
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultEditor = useRef<Editor | null>(null);
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [message, setMessage] = useState<string | null>("Loading…");
  const [remaining, setRemaining] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    let disposed = false;
    const disposables: { dispose(): void }[] = [];

    void (async () => {
      try {
        const loaded = await gitConflictVersions(root, filePath);
        const uri = await ensureModel(monaco, filePath);
        const model = monaco.editor.getModel(uri);
        if (disposed) return;
        if (!model) throw new Error(`Couldn't open ${filePath}`);
        setVersions(loaded);
        setMessage(null);

        const language = languageForPath(filePath);
        const oursModel = monaco.editor.createModel(loaded.ours, language);
        const theirsModel = monaco.editor.createModel(loaded.theirs, language);
        const ours = monaco.editor.create(oursRef.current!, { ...editorOptions(true), model: oursModel });
        const theirs = monaco.editor.create(theirsRef.current!, { ...editorOptions(true), model: theirsModel });
        const result = monaco.editor.create(resultRef.current!, { ...editorOptions(false), model });
        resultEditor.current = result;
        highlightChanges(ours, loaded.base, loaded.ours, "merge-changed-ours");
        highlightChanges(theirs, loaded.base, loaded.theirs, "merge-changed-theirs");

        const count = () => setRemaining(parseConflicts(model.getLinesContent()).length);
        count();
        const first = parseConflicts(model.getLinesContent())[0];
        if (first) result.revealLineInCenter(first.startLine);
        disposables.push(
          ours,
          theirs,
          result,
          oursModel,
          theirsModel,
          model.onDidChangeContent(() => {
            count();
            useTabsStore.getState().syncDirtyState(filePath);
          }),
        );
      } catch (error) {
        if (!disposed) setMessage(String(error));
      }
    })();

    return () => {
      disposed = true;
      resultEditor.current = null;
      // The file's own model stays: a tab may be showing it.
      disposables.forEach((disposable) => disposable.dispose());
    };
  }, [filePath]);

  const go = (step: number) => {
    const editor = resultEditor.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const conflicts = parseConflicts(model.getLinesContent());
    if (!conflicts.length) return;
    const line = editor.getPosition()?.lineNumber ?? 1;
    const index =
      step > 0
        ? Math.max(0, conflicts.findIndex((conflict) => conflict.startLine > line))
        : (conflicts.map((conflict) => conflict.startLine < line).lastIndexOf(true) + conflicts.length) % conflicts.length;
    const target = conflicts[index];
    setCurrent(index + 1);
    editor.setPosition({ lineNumber: target.startLine, column: 1 });
    editor.revealLineInCenter(target.startLine);
    editor.focus();
  };

  const acceptAll = (resolution: Resolution) => {
    const model = resultEditor.current?.getModel();
    if (!model) return;
    const resolved = resolveAll(model.getLinesContent(), resolution).join(model.getEOL());
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: resolved }], () => null);
    model.pushStackElement();
  };

  const markResolved = async () => {
    if (
      remaining > 0 &&
      !(await confirmNative(
        `${remaining} conflict${remaining === 1 ? "" : "s"} still ha${remaining === 1 ? "s" : "ve"} markers. Mark as resolved anyway?`,
        { title: "Unresolved Conflicts", kind: "warning" },
      ))
    ) {
      return;
    }
    const tabs = useTabsStore.getState();
    await tabs.saveTab(filePath, "auto");
    await useGitStore.getState().stage(filePath);
    await tabs.closeTab(`merge:${filePath}`);
  };

  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  return (
    <div className="merge-view">
      <div className="merge-toolbar">
        <span className={remaining ? "merge-count" : "merge-count done"}>
          {message ? "" : remaining ? `${remaining} conflict${remaining === 1 ? "" : "s"} left` : "No conflicts left"}
          {remaining > 0 && current > 0 && current <= remaining ? ` · ${current}/${remaining}` : ""}
        </span>
        <button className="merge-icon-button" title="Previous conflict" disabled={!remaining} onClick={() => go(-1)}>
          <ChevronUp size={14} strokeWidth={1.5} />
        </button>
        <button className="merge-icon-button" title="Next conflict" disabled={!remaining} onClick={() => go(1)}>
          <ChevronDown size={14} strokeWidth={1.5} />
        </button>
        <span className="merge-spacer" />
        <button className="merge-button" disabled={!remaining} onClick={() => acceptAll("ours")}>
          Accept All Current
        </button>
        <button className="merge-button" disabled={!remaining} onClick={() => acceptAll("theirs")}>
          Accept All Incoming
        </button>
        <button className="merge-button primary" disabled={!!message} onClick={() => void markResolved()}>
          <Check size={13} strokeWidth={1.75} /> Mark as Resolved
        </button>
      </div>
      <div className="merge-columns">
        <div className="merge-column">
          <div className="merge-heading ours">Current{versions ? ` — ${versions.oursLabel}` : ""}</div>
          <div ref={oursRef} className="merge-surface" />
        </div>
        <div className="merge-column result">
          <div className="merge-heading">Result — {name}</div>
          <div ref={resultRef} className="merge-surface" />
        </div>
        <div className="merge-column">
          <div className="merge-heading theirs">Incoming{versions ? ` — ${versions.theirsLabel}` : ""}</div>
          <div ref={theirsRef} className="merge-surface" />
        </div>
        {message && <div className="diff-message">{message}</div>}
      </div>
    </div>
  );
}
