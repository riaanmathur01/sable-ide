import type * as MonacoTypes from "monaco-editor";
import { pathFromUri } from "../editorRegistry";
import { emitPluginEvent } from "./events";

/** Problems changing anywhere (any source), debounced: once Monaco loads. */
let markersWatched = false;
export function watchDiagnosticsForPlugins(monaco: typeof MonacoTypes): void {
  if (markersWatched) return;
  markersWatched = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paths = new Set<string>();
  monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) if (uri.scheme === "file") paths.add(pathFromUri(uri));
    clearTimeout(timer);
    timer = setTimeout(() => {
      emitPluginEvent("didChangeDiagnostics", { path: null, paths: [...paths] });
      paths = new Set();
    }, 150);
  });
}

/** Typing and cursor moves reach plugins at most this often. */
const SELECTION_DELAY_MS = 120;
const CHANGE_DELAY_MS = 300;

/**
 * Raise plugin events for an editor (one per editor group): which file is
 * in front, selection changes and text changes — the latter two debounced
 * so plugins see a settled state, not every keystroke. Only the focused
 * group's editor reports. Returns the cleanup.
 */
export function installPluginEditorEvents(
  editor: MonacoTypes.editor.IStandaloneCodeEditor,
  focused: () => boolean,
): () => void {
  const path = () => {
    const model = editor.getModel();
    return model && model.uri.scheme === "file" ? pathFromUri(model.uri) : null;
  };
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const selection = () => {
    const current = editor.getSelection();
    const model = editor.getModel();
    if (!current || !model) return null;
    return {
      start: { line: current.startLineNumber, column: current.startColumn },
      end: { line: current.endLineNumber, column: current.endColumn },
      text: model.getValueInRange(current),
    };
  };
  const disposables = [
    editor.onDidChangeModel(() => {
      if (focused()) emitPluginEvent("didChangeActiveEditor", { path: path() });
    }),
    editor.onDidFocusEditorText(() => emitPluginEvent("didChangeActiveEditor", { path: path() })),
    editor.onDidChangeCursorSelection(() => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (focused() && path()) emitPluginEvent("didChangeSelection", { path: path(), selection: selection() });
      }, SELECTION_DELAY_MS);
    }),
    editor.onDidChangeModelContent(() => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (path()) emitPluginEvent("didChange", { path: path() });
      }, CHANGE_DELAY_MS);
    }),
  ];
  // The editor's first file (set at creation, so no model-change event).
  const initial = setTimeout(() => {
    if (focused() && path()) emitPluginEvent("didChangeActiveEditor", { path: path() });
  }, 0);
  return () => {
    clearTimeout(initial);
    clearTimeout(selectionTimer);
    clearTimeout(changeTimer);
    for (const disposable of disposables) disposable.dispose();
  };
}
