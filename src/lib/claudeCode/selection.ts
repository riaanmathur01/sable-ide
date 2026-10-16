import type * as MonacoTypes from "monaco-editor";
import { getEditor, pathFromUri } from "../editorRegistry";
import { notify } from "./backend";
import { useClaudeCodeStore } from "./store";

/**
 * The editor selection, shared with Claude Code as the VS Code extension
 * does: `selection_changed` (debounced) as you select, the latest one for
 * getLatestSelection, and `at_mentioned` when you send a selection
 * explicitly (⌥⌘K / the editor's context menu).
 */

type Editor = MonacoTypes.editor.ICodeEditor;

export interface SelectionPayload {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

/** A file path as a file:// URL. */
export function fileUrl(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/** An editor's selection (0-based, as the CLI expects); null if it isn't a file. */
export function selectionOf(editor: Editor | null): SelectionPayload | null {
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!editor || !model || !selection || model.uri.scheme !== "file") return null;
  const filePath = pathFromUri(model.uri);
  return {
    text: model.getValueInRange(selection),
    filePath,
    fileUrl: fileUrl(filePath),
    selection: {
      start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
      end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
      isEmpty: selection.isEmpty(),
    },
  };
}

let latest: SelectionPayload | null = null;
let lastSent = "";
let timer: ReturnType<typeof setTimeout> | undefined;

/** The most recent selection in any file editor. */
export function latestSelection(): SelectionPayload | null {
  return latest;
}

function publish(editor: Editor) {
  const payload = selectionOf(editor);
  if (!payload) return;
  latest = payload;
  if (useClaudeCodeStore.getState().clients === 0) return;
  const key = JSON.stringify(payload);
  if (key === lastSent) return;
  lastSent = key;
  void notify("selection_changed", payload).catch(() => {});
}

function schedule(editor: Editor) {
  clearTimeout(timer);
  timer = setTimeout(() => publish(editor), 150);
}

/** A CLI just connected: tell it where the cursor is. */
export function resendSelection() {
  lastSent = "";
  const editor = getEditor();
  if (editor) publish(editor);
}

/** Follow selections in every file editor (now and future). */
export function trackSelections(monaco: typeof MonacoTypes) {
  const tracked = new WeakSet<Editor>();
  const attach = (editor: Editor) => {
    if (tracked.has(editor)) return;
    tracked.add(editor);
    editor.onDidChangeCursorSelection(() => schedule(editor));
    editor.onDidFocusEditorText(() => schedule(editor));
    editor.onDidChangeModel(() => schedule(editor));
  };
  monaco.editor.getEditors().forEach(attach);
  monaco.editor.onDidCreateEditor(attach);
}

/** at_mentioned's parameters for an editor's selection (0-based lines). */
export function atMentionOf(editor: Editor | null): { filePath: string; lineStart?: number; lineEnd?: number } | null {
  const payload = selectionOf(editor);
  if (!payload) return null;
  const { start, end, isEmpty } = payload.selection;
  if (isEmpty) return { filePath: payload.filePath };
  // A selection ending at the start of a line doesn't include that line.
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { filePath: payload.filePath, lineStart: start.line, lineEnd: lastLine };
}
