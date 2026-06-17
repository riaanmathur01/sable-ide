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
export function revealPosition(path: string, lineNumber: number) {
  let attemptsLeft = 60; // ~1s of frames, covers Monaco's first load
  const tryReveal = () => {
    const editor = editorInstance;
    const model = editor?.getModel();
    const targetUri = monacoInstance?.Uri.parse(path).toString();
    if (editor && model && targetUri && model.uri.toString() === targetUri) {
      editor.setPosition({ lineNumber, column: 1 });
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
}

/**
 * Render a file's diagnostics as Monaco markers (the red/yellow
 * squiggles). LSP positions are 0-based; Monaco's are 1-based, so every
 * line and column is shifted by one. Called whenever the server pushes
 * `publishDiagnostics` for a document.
 */
export function applyDiagnostics(path: string, diagnostics: LspDiagnostic[]) {
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
    source: diagnostic.source ?? "pyright",
    code: diagnostic.code != null ? String(diagnostic.code) : undefined,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  }));

  monacoInstance.editor.setModelMarkers(model, "pyright", markers);
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

export function getScrollMetrics(): EditorScrollMetrics | null {
  if (!monacoInstance || !editorInstance) return null;
  return {
    scrollTop: editorInstance.getScrollTop(),
    lineHeight: editorInstance.getOption(
      monacoInstance.editor.EditorOption.lineHeight,
    ),
    paddingTop: editorInstance.getTopForLineNumber(1),
    viewportHeight: editorInstance.getLayoutInfo().height,
  };
}

/** Subscribe to editor scroll/layout changes; returns an unsubscribe fn. */
export function onEditorViewChange(callback: () => void): () => void {
  if (!editorInstance) return () => {};
  const scroll = editorInstance.onDidScrollChange(callback);
  const layout = editorInstance.onDidLayoutChange(callback);
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
