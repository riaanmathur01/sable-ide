/**
 * Non-reactive bridge to the live Monaco instance. The zustand stores
 * keep lightweight tab metadata; the actual text lives in Monaco models.
 * Pulling the value out of the model only at save time means typing
 * never copies the whole document through React state.
 *
 * Dirty tracking uses Monaco's alternative version id: it goes *back*
 * to the saved value after undo, so undoing every change clears the
 * dirty dot — same behavior as VS Code.
 *
 * Only type imports from monaco here: this module is reachable from the
 * main bundle (via tabsStore), and Monaco's runtime must stay inside the
 * lazy-loaded editor chunk.
 */
import type * as MonacoTypes from "monaco-editor";

type Monaco = typeof MonacoTypes;
type Editor = MonacoTypes.editor.IStandaloneCodeEditor;

let monacoInstance: Monaco | null = null;
let editorInstance: Editor | null = null;

/**
 * Version id of each model at its last save, keyed by the model's URI
 * string. Tab paths are converted with the same `Uri.parse` the
 * @monaco-editor/react library uses, so keys always agree.
 */
const savedVersionIds = new Map<string, number>();

export function registerEditor(editor: Editor, monaco: Monaco) {
  editorInstance = editor;
  monacoInstance = monaco;
}

export function getEditor(): Editor | null {
  return editorInstance;
}

function modelForPath(path: string) {
  if (!monacoInstance) return null;
  return monacoInstance.editor.getModel(monacoInstance.Uri.parse(path));
}

export function getModelValue(path: string): string | null {
  return modelForPath(path)?.getValue() ?? null;
}

/** Called by monacoSetup whenever a model is created: it starts clean. */
export function markSavedByUri(uriString: string, versionId: number) {
  savedVersionIds.set(uriString, versionId);
}

/** Call after writing to disk: the current state is "clean". */
export function markSaved(path: string) {
  const model = modelForPath(path);
  if (model) {
    savedVersionIds.set(
      model.uri.toString(),
      model.getAlternativeVersionId(),
    );
  }
}

export function isModelDirty(path: string): boolean {
  const model = modelForPath(path);
  if (!model) return false;
  return (
    model.getAlternativeVersionId() !==
    savedVersionIds.get(model.uri.toString())
  );
}

/** Dispose the model on tab close so reopening reloads from disk. */
export function disposeModel(path: string) {
  const model = modelForPath(path);
  if (model) {
    savedVersionIds.delete(model.uri.toString());
    model.dispose();
  }
}
