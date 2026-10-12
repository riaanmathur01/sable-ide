import { memo, useEffect, useRef } from "react";
import type * as MonacoTypes from "monaco-editor";
import { editorOptionsFromSettings, monaco } from "../../lib/monacoSetup";
import { useSettingsStore } from "../../store/settingsStore";
import {
  cellModel,
  moveSelection,
  runSelected,
  selectCell,
  setMarkdownEditing,
  setMode,
  useNotebookStore,
} from "../../lib/notebook/notebookStore";

/** Lines of padding above and below a cell's code. */
const PADDING = 8;

function cellOptions(
  settings: ReturnType<typeof useSettingsStore.getState>["values"],
  lineNumbers: boolean,
): MonacoTypes.editor.IEditorOptions {
  return {
    ...editorOptionsFromSettings(settings),
    minimap: { enabled: false },
    lineNumbers: lineNumbers ? "on" : "off",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: lineNumbers ? 8 : 12,
    scrollBeyondLastLine: false,
    stickyScroll: { enabled: false },
    rulers: [],
    padding: { top: PADDING, bottom: PADDING },
    automaticLayout: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "none",
    // The notebook scrolls, not the cell.
    scrollbar: {
      vertical: "hidden",
      horizontal: "auto",
      verticalScrollbarSize: 0,
      horizontalScrollbarSize: 8,
      alwaysConsumeMouseWheel: false,
      handleMouseWheel: true,
    },
    // Suggestions and hovers can reach outside the cell.
    fixedOverflowWidgets: true,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
  };
}

/** Is one of Monaco's popups (suggestions, find, rename…) open? Esc closes it, not edit mode. */
function popupOpen(editor: MonacoTypes.editor.IStandaloneCodeEditor): boolean {
  const node = editor.getDomNode();
  if (!node) return false;
  return !!node.querySelector(".find-widget.visible, .rename-box") || !!document.querySelector(".suggest-widget.visible, .parameter-hints-widget.visible");
}

/**
 * One cell's code: a Monaco editor on the cell's model, as tall as its
 * text. Jupyter's keys while typing: Shift+Enter (run, next), ⌘/Ctrl+Enter
 * (run), Alt+Enter (run, insert below), Esc (command mode), and ↑/↓ at
 * the first/last line move to the neighboring cell.
 */
export const CellEditor = memo(function CellEditor({
  path,
  cellKey,
  language,
  focused,
  lineNumbers,
  markdown,
}: {
  path: string;
  cellKey: string;
  language: string;
  /** Edit mode on this cell: take the keyboard. */
  focused: boolean;
  lineNumbers: boolean;
  markdown: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const settings = useSettingsStore((state) => state.values);

  useEffect(() => {
    const element = container.current;
    const model = cellModel(path, cellKey);
    if (!element || !model) return;
    const editor = monaco.editor.create(element, {
      ...cellOptions(useSettingsStore.getState().values, lineNumbers),
      model,
    });
    editorRef.current = editor;
    let width = element.clientWidth;
    const layout = () => {
      const height = Math.max(editor.getContentHeight(), 20);
      element.style.height = `${height}px`;
      editor.layout({ width: element.clientWidth, height });
    };
    layout();
    const sizing = editor.onDidContentSizeChange(layout);
    const resize = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        layout();
      }
    });
    resize.observe(element);

    editor.onDidFocusEditorText(() => selectCell(path, cellKey, "edit"));
    editor.onKeyDown((event) => {
      const { keyCode, shiftKey, altKey, ctrlKey, metaKey } = event;
      const { KeyCode } = monaco;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (keyCode === KeyCode.Enter && (shiftKey || altKey || ctrlKey || metaKey) && !(shiftKey && (ctrlKey || metaKey))) {
        if (document.querySelector(".suggest-widget.visible") && !shiftKey && !altKey) return;
        handled();
        selectCell(path, cellKey);
        runSelected(path, shiftKey ? "next" : altKey ? "insert" : "stay");
        return;
      }
      if (keyCode === KeyCode.Escape && !popupOpen(editor)) {
        handled();
        setMode(path, "command");
        if (markdown) setMarkdownEditing(path, cellKey, false);
        return;
      }
      if ((keyCode === KeyCode.UpArrow || keyCode === KeyCode.DownArrow) && !shiftKey && !altKey && !ctrlKey && !metaKey && !popupOpen(editor)) {
        const position = editor.getPosition();
        const lastLine = model.getLineCount();
        const atTop = position?.lineNumber === 1 && keyCode === KeyCode.UpArrow;
        const atBottom = position?.lineNumber === lastLine && keyCode === KeyCode.DownArrow;
        if (!atTop && !atBottom) return;
        const doc = useNotebookStore.getState().docs[path];
        const cells = doc?.notebook?.cells ?? [];
        const index = cells.findIndex((cell) => cell.key === cellKey);
        const neighbor = cells[index + (atTop ? -1 : 1)];
        if (!neighbor) return;
        handled();
        moveSelection(path, atTop ? -1 : 1);
        // The neighbor's editor takes focus (at its near end).
        pendingCursor = atTop ? "end" : "start";
        setMode(path, "edit");
      }
    });

    return () => {
      sizing.dispose();
      resize.disconnect();
      editorRef.current = null;
      editor.dispose();
    };
    // The editor is created once per cell; options follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cellKey]);

  useEffect(() => {
    editorRef.current?.updateOptions(cellOptions(settings, lineNumbers));
  }, [settings, lineNumbers]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!focused || !editor) return;
    if (!editor.hasTextFocus()) {
      editor.focus();
      const model = editor.getModel();
      if (pendingCursor && model) {
        const line = pendingCursor === "end" ? model.getLineCount() : 1;
        editor.setPosition({ lineNumber: line, column: pendingCursor === "end" ? model.getLineMaxColumn(line) : 1 });
      }
    }
    pendingCursor = null;
    editor.updateOptions({ renderLineHighlight: "line" });
    return () => editor.updateOptions({ renderLineHighlight: "none" });
  }, [focused]);

  return <div ref={container} className="nb-cell-editor" />;
});

/** Where the cursor goes in the next cell entered with ↑/↓. */
let pendingCursor: "start" | "end" | null = null;

// Cell editors come and go with their cells; Monaco's word highlighter
// rejects its pending request with a CancellationError when its editor is
// disposed mid-request, and nothing catches it. It's not an error.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "Canceled" || (reason?.name === "CancellationError" && reason.message?.startsWith("Canceled"))) {
    event.preventDefault();
  }
});
