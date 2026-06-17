import { useEffect, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { registerEditor } from "../../lib/editorRegistry";
import { changeDocument } from "../../lib/lsp/lspClient";
import { fetchBlame } from "../../lib/blame";
import { BlameGutter } from "./BlameGutter";
import type { BlameLine } from "../../lib/ipc";
import "../../lib/monacoSetup";
import "./MonacoPane.css";

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
