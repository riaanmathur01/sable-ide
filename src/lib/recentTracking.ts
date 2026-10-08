import type * as MonacoTypes from "monaco-editor";
import { pathFromUri } from "./editorRegistry";
import { useNavigationStore } from "../store/navigationStore";

/** How long the cursor must rest somewhere to count as a visited place. */
const SETTLE_MS = 1000;

/**
 * Feed Recent Files (⌘E), Recent Locations (⇧⌘E) and Back/Forward
 * (⌘[ / ⌘]) from one editor: every file shown in it, and every place the
 * cursor goes while you work in it.
 */
export function installRecentTracking(editor: MonacoTypes.editor.IStandaloneCodeEditor): () => void {
  /** Back/Forward: every cursor position (jumps become new entries). */
  const recordPosition = () => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position || model.uri.scheme !== "file") return;
    useNavigationStore.getState().recordPosition({
      path: pathFromUri(model.uri),
      line: position.lineNumber,
      column: position.column,
    });
  };
  const recordFile = () => {
    const model = editor.getModel();
    if (model?.uri.scheme === "file") useNavigationStore.getState().recordFile(pathFromUri(model.uri));
    recordPosition();
  };
  recordFile();
  const modelListener = editor.onDidChangeModel(recordFile);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cursorListener = editor.onDidChangeCursorPosition(() => {
    // Every move, focused or not: jumps from the Usages panel or a symbol
    // popup move the cursor before the editor takes focus.
    recordPosition();
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
