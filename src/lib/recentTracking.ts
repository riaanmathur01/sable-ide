import type * as MonacoTypes from "monaco-editor";
import { pathFromUri } from "./editorRegistry";
import { useNavigationStore } from "../store/navigationStore";

/** How long the cursor must rest somewhere to count as a visited place. */
const SETTLE_MS = 1000;

/**
 * Feed Recent Files (⌘E) and Recent Locations (⇧⌘E) from one editor:
 * every file shown in it, and every place the cursor settles while you
 * work in it.
 */
export function installRecentTracking(editor: MonacoTypes.editor.IStandaloneCodeEditor): () => void {
  const recordFile = () => {
    const model = editor.getModel();
    if (model?.uri.scheme === "file") useNavigationStore.getState().recordFile(pathFromUri(model.uri));
  };
  recordFile();
  const modelListener = editor.onDidChangeModel(recordFile);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cursorListener = editor.onDidChangeCursorPosition(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position || model.uri.scheme !== "file" || !editor.hasTextFocus()) return;
      useNavigationStore.getState().recordLocation({
        path: pathFromUri(model.uri),
        line: position.lineNumber,
        column: position.column,
        preview: model.getLineContent(position.lineNumber),
      });
    }, SETTLE_MS);
  });

  return () => {
    clearTimeout(timer);
    modelListener.dispose();
    cursorListener.dispose();
  };
}
