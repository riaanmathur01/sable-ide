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
/** One editor per editor group (split view); getEditor() is the
 *  focused group's. */
const editorsByGroup = new Map<string, Editor>();
let activeGroupId: string | null = null;

/**
 * Version id of each model at its last save, keyed by the model's URI
 * string (see modelUriFor).
 */
const savedVersionIds = new Map<string, number>();

/** Called by monacoSetup as soon as Monaco loads. */
export function setMonacoInstance(monaco: Monaco) {
  monacoInstance = monaco;
}

export function registerEditor(editor: Editor, monaco: Monaco, groupId: string) {
  editorsByGroup.set(groupId, editor);
  monacoInstance = monaco;
}

export function unregisterEditor(groupId: string, editor: Editor) {
  if (editorsByGroup.get(groupId) === editor) editorsByGroup.delete(groupId);
}

/** Called by the tabs store whenever the focused group changes. */
export function setActiveEditorGroup(groupId: string) {
  activeGroupId = groupId;
}

// --- File paths ↔ model URIs ---------------------------------------------------
//
// Every model is keyed by `Uri.file(path)`. (Not `Uri.parse(path)`: that
// treats a path as a URI string, so `#` and `?` in names start a
// fragment/query — every file under a "C#" folder collapsed into one
// model — and Windows drive letters parse as URI schemes.)

/** Original path for each model URI we've handed out, so a URI maps
 *  back to the exact path string tabs use (case, separators). */
const pathByModelUri = new Map<string, string>();

/** The model URI string for a file path. */
export function modelUriFor(path: string): string {
  if (!monacoInstance) return path;
  const uri = monacoInstance.Uri.file(path).toString();
  pathByModelUri.set(uri, path);
  return uri;
}

/** The file path a model URI refers to. */
export function pathFromUri(uri: { toString(): string; fsPath: string }): string {
  return pathByModelUri.get(uri.toString()) ?? uri.fsPath;
}

/** The focused group's editor (or any editor, if it has none yet). */
export function getEditor(): Editor | null {
  return (
    (activeGroupId ? editorsByGroup.get(activeGroupId) : undefined) ??
    editorsByGroup.values().next().value ??
    null
  );
}

function modelForPath(path: string) {
  if (!monacoInstance) return null;
  return monacoInstance.editor.getModel(monacoInstance.Uri.file(path));
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
  const key = model.uri.toString();
  const baseline = savedVersionIds.get(key);
  if (baseline === undefined) {
    // No recorded save-point yet (e.g. a model created during session
    // restore before its baseline was set). Adopt the current state as
    // clean rather than reporting a phantom "dirty" — a file you haven't
    // edited must not block its own tab from closing.
    savedVersionIds.set(key, model.getAlternativeVersionId());
    return false;
  }
  return model.getAlternativeVersionId() !== baseline;
}

/**
 * Move the cursor to a line and center it — used by search results.
 * The model switch after openFile() is asynchronous (and Monaco itself
 * may still be lazy-loading), so this retries across animation frames
 * until the right model is active.
 */
export function revealPosition(path: string, lineNumber: number, column = 1) {
  let attemptsLeft = 60; // ~1s of frames, covers Monaco's first load
  const tryReveal = () => {
    const editor = getEditor();
    const model = editor?.getModel();
    const targetUri = monacoInstance?.Uri.file(path).toString();
    if (editor && model && targetUri && model.uri.toString() === targetUri) {
      editor.setPosition({ lineNumber, column });
      editor.revealLineInCenter(lineNumber);
      editor.focus();
      return;
    }
    if (attemptsLeft-- > 0) requestAnimationFrame(tryReveal);
  };
  tryReveal();
}

/** One diagnostic as it arrives from the language server (LSP shape). */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1 Error, 2 Warning, 3 Info, 4 Hint
  message: string;
  source?: string;
  code?: string | number;
  /** 1 = unnecessary (faded), 2 = deprecated (struck through). */
  tags?: number[];
  codeDescription?: { href: string };
}

/**
 * Render a file's diagnostics as Monaco markers (the red/yellow
 * squiggles). LSP positions are 0-based; Monaco's are 1-based, so every
 * line and column is shifted by one. Called whenever the server pushes
 * `publishDiagnostics` for a document.
 */
export function applyDiagnostics(
  path: string,
  diagnostics: LspDiagnostic[],
  serverLabel: string,
) {
  if (!monacoInstance) return;
  const model = modelForPath(path);
  if (!model) return; // file isn't open in the editor

  const severityMap = monacoInstance.MarkerSeverity;
  const lspSeverityToMonaco = (severity?: number) => {
    switch (severity) {
      case 1:
        return severityMap.Error;
      case 2:
        return severityMap.Warning;
      case 3:
        return severityMap.Info;
      case 4:
        return severityMap.Hint;
      default:
        return severityMap.Error;
    }
  };

  const markers = diagnostics.map((diagnostic) => ({
    severity: lspSeverityToMonaco(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? serverLabel,
    code:
      diagnostic.code == null
        ? undefined
        : diagnostic.codeDescription?.href
          ? {
              value: String(diagnostic.code),
              target: monacoInstance!.Uri.parse(diagnostic.codeDescription.href),
            }
          : String(diagnostic.code),
    // LSP DiagnosticTag and Monaco MarkerTag share values (1, 2).
    tags: diagnostic.tags,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  }));

  // One marker owner for all language servers (a file only ever belongs
  // to one), so markers replace cleanly on every publish.
  monacoInstance.editor.setModelMarkers(model, "lsp", markers);
}

/**
 * Editor scroll metrics, for the DOM blame gutter to position itself.
 * (Monaco's injected-text decorations don't render in this build, so the
 * gutter is drawn as our own scroll-synced DOM column instead.)
 */
export interface EditorScrollMetrics {
  scrollTop: number;
  lineHeight: number;
  paddingTop: number;
  viewportHeight: number;
}

export function getScrollMetrics(editor: Editor | null): EditorScrollMetrics | null {
  if (!monacoInstance || !editor) return null;
  return {
    scrollTop: editor.getScrollTop(),
    lineHeight: editor.getOption(monacoInstance.editor.EditorOption.lineHeight),
    paddingTop: editor.getTopForLineNumber(1),
    viewportHeight: editor.getLayoutInfo().height,
  };
}

/** Subscribe to an editor's scroll/layout changes; returns an unsubscribe fn. */
export function onEditorViewChange(editor: Editor | null, callback: () => void): () => void {
  if (!editor) return () => {};
  const scroll = editor.onDidScrollChange(callback);
  const layout = editor.onDidLayoutChange(callback);
  return () => {
    scroll.dispose();
    layout.dispose();
  };
}

/** Dispose the model on tab close so reopening reloads from disk. */
export function disposeModel(path: string) {
  const model = modelForPath(path);
  if (model) {
    savedVersionIds.delete(model.uri.toString());
    model.dispose();
  }
}

/** True if the file currently has a Monaco model (i.e. is open). */
export function hasModel(path: string): boolean {
  return modelForPath(path) !== null;
}

/**
 * Replace a model's whole content as one undoable edit — used when the
 * AI agent writes a file that's open, so the user can ⌘Z the change and
 * the editor never shows stale text.
 */
export function replaceModelContent(path: string, content: string): boolean {
  const model = modelForPath(path);
  if (!model) return false;
  if (model.getValue() === content) return true;
  model.pushStackElement();
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: content }],
    () => null,
  );
  model.pushStackElement();
  return true;
}

export interface SaveOptions {
  format: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

/**
 * Save-time transforms (format, trim trailing whitespace, final newline),
 * applied to the model as undoable edits before its value is written.
 * Formatting needs a live editor, so it only runs when some editor group
 * is showing the file.
 */
export async function applySaveTransforms(
  path: string,
  options: SaveOptions,
): Promise<void> {
  const model = modelForPath(path);
  if (!model || !monacoInstance) return;

  const editor = [...editorsByGroup.values()].find((candidate) => candidate.getModel() === model);
  if (options.format && editor) {
    const action = editor.getAction("editor.action.formatDocument");
    if (action?.isSupported()) {
      try {
        await action.run();
      } catch {
        /* a formatter error must never block the save */
      }
    }
  }

  if (options.trimTrailingWhitespace) {
    const edits: MonacoTypes.editor.IIdentifiedSingleEditOperation[] = [];
    for (let line = 1; line <= model.getLineCount(); line++) {
      const content = model.getLineContent(line);
      const trimmedLength = content.trimEnd().length;
      if (trimmedLength < content.length) {
        edits.push({
          range: new monacoInstance.Range(
            line,
            trimmedLength + 1,
            line,
            content.length + 1,
          ),
          text: "",
        });
      }
    }
    if (edits.length > 0) model.pushEditOperations([], edits, () => null);
  }
  // Applied after trimming (as its own edit) so the two never overlap.
  if (options.insertFinalNewline) {
    const lastLine = model.getLineCount();
    const lastContent = model.getLineContent(lastLine);
    if (lastContent !== "") {
      const column = lastContent.length + 1;
      model.pushEditOperations(
        [],
        [
          {
            range: new monacoInstance.Range(lastLine, column, lastLine, column),
            text: model.getEOL(),
          },
        ],
        () => null,
      );
    }
  }
}

/** A text edit in Monaco coordinates (1-based lines and columns). */
export interface ModelEdit {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  text: string;
}

/** Apply edits to an open model as one undoable step. False if not open. */
export function pushModelEdits(path: string, edits: ModelEdit[]): boolean {
  const model = modelForPath(path);
  if (!model || !monacoInstance) return false;
  model.pushStackElement();
  model.pushEditOperations(
    [],
    edits.map((edit) => ({
      range: new monacoInstance!.Range(
        edit.startLineNumber,
        edit.startColumn,
        edit.endLineNumber,
        edit.endColumn,
      ),
      text: edit.text,
    })),
    () => null,
  );
  model.pushStackElement();
  return true;
}
