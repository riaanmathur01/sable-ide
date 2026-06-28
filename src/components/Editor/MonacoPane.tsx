import { useEffect, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useBreakpointsStore } from "../../store/breakpointsStore";
import { useDebugStore } from "../../store/debugStore";
import { registerEditor, getEditor } from "../../lib/editorRegistry";
import { changeDocument } from "../../lib/lsp/lspClient";
import { fetchBlame } from "../../lib/blame";
import { BlameGutter } from "./BlameGutter";
import { monaco } from "../../lib/monacoSetup";
import type * as MonacoTypes from "monaco-editor";
import type { BlameLine } from "../../lib/ipc";
import "../../lib/monacoSetup";
import "./MonacoPane.css";

const NO_BREAKPOINTS: number[] = [];

/**
 * The Monaco surface. One editor instance for all tabs: the `path` prop
 * keys a model per file, and @monaco-editor/react swaps models (and
 * preserves scroll/cursor per tab) when the active path changes.
 * Language is inferred from the file extension via the model URI.
 *
 * This component is lazy-loaded (React.lazy in EditorArea) so Monaco's
 * bundle is only fetched when the first file opens.
 */
export default function MonacoPane() {
  // The editor follows the last active *file* tab; diff tabs render in a
  // separate DiffView, so MonacoPane keeps its model when one is active.
  const activePath = useTabsStore((state) => state.lastFilePath);
  const initialContentByPath = useTabsStore(
    (state) => state.initialContentByPath,
  );
  const syncDirtyState = useTabsStore((state) => state.syncDirtyState);
  const scheduleAutoSave = useTabsStore((state) => state.scheduleAutoSave);
  const setCursorPosition = useUiStore((state) => state.setCursorPosition);
  const blameEnabled = useUiStore((state) => state.blameEnabled);
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [editorReady, setEditorReady] = useState(false);

  // Breakpoints for this file, and the line where the debugger is paused
  // (only when it's paused in *this* file).
  const breakpointLines = useBreakpointsStore(
    (state) =>
      (activePath && state.breakpointsByFile[activePath]) || NO_BREAKPOINTS,
  );
  const stoppedLine = useDebugStore((state) =>
    state.stoppedFile === activePath ? state.stoppedLine : null,
  );

  // Render breakpoint glyphs + the paused-line highlight as decorations
  // (className/glyph-based decorations render reliably in this build).
  useEffect(() => {
    if (!editorReady) return;
    const editor = getEditor();
    if (!editor) return;

    const decorations: MonacoTypes.editor.IModelDeltaDecoration[] =
      breakpointLines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "debug-breakpoint",
          glyphMarginHoverMessage: { value: "Breakpoint" },
        },
      }));
    if (stoppedLine != null) {
      decorations.push({
        range: new monaco.Range(stoppedLine, 1, stoppedLine, 1),
        options: {
          isWholeLine: true,
          className: "debug-stopped-line",
          glyphMarginClassName: "debug-stopped-arrow",
        },
      });
      editor.revealLineInCenter(stoppedLine);
    }
    const collection = editor.createDecorationsCollection(decorations);
    return () => collection.clear();
  }, [breakpointLines, stoppedLine, activePath, editorReady]);

  // Fetch git blame for the active file when blame is on.
  useEffect(() => {
    if (!blameEnabled || !activePath) {
      setBlameLines([]);
      return;
    }
    let cancelled = false;
    void fetchBlame(activePath).then((lines) => {
      if (!cancelled) setBlameLines(lines);
    });
    return () => {
      cancelled = true;
    };
  }, [blameEnabled, activePath]);

  if (!activePath) return null;

  const showBlame = blameEnabled && blameLines.length > 0;

  const handleMount: OnMount = (editor, monaco) => {
    registerEditor(editor, monaco);
    setEditorReady(true);

    // Click the gutter (glyph margin OR line-number area) to toggle a
    // breakpoint on that line — the glyph margin alone is easy to miss.
    editor.onMouseDown((event) => {
      const targetType = event.target.type;
      const inGutter =
        targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        targetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
      if (inGutter && event.target.position) {
        const path = useTabsStore.getState().lastFilePath;
        if (path) {
          useBreakpointsStore
            .getState()
            .toggle(path, event.target.position.lineNumber);
        }
      }
    });

    // Cmd/Ctrl+S inside the editor. (A window-level listener in
    // EditorArea covers saves while focus is elsewhere.)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const currentPath = useTabsStore.getState().activePath;
      if (currentPath) useTabsStore.getState().saveTab(currentPath);
    });

    editor.onDidChangeCursorPosition((event) =>
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      }),
    );
  };

  return (
    <div className="monaco-pane">
      {showBlame && <BlameGutter lines={blameLines} filePath={activePath} />}
      <div className="monaco-pane-editor">
        <Editor
          theme="sable-dark"
          path={activePath}
          defaultValue={initialContentByPath[activePath] ?? ""}
          onMount={handleMount}
          onChange={(value) => {
            syncDirtyState(activePath);
            // Auto-save: content hits the disk shortly after typing stops.
            scheduleAutoSave(activePath);
            // Keep the language server's buffer current so diagnostics and
            // completions reflect what's on screen.
            void changeDocument(activePath, value ?? "");
          }}
          saveViewState
          options={{
            minimap: { enabled: false },
            glyphMargin: true, // breakpoint dots live here
            fontFamily:
              '"JetBrains Mono", "SF Mono", "Cascadia Code", monospace',
            fontSize: 13,
            fontLigatures: true,
            lineHeight: 1.6,
            padding: { top: 12 },
            scrollBeyondLastLine: false,
            renderLineHighlight: "line",
            cursorBlinking: "smooth",
            smoothScrolling: true,
            automaticLayout: true,
            tabSize: 2,
            guides: { indentation: true },
            stickyScroll: { enabled: false },
          }}
        />
      </div>
    </div>
  );
}
