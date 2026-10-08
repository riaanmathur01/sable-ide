import type * as MonacoTypes from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { getEditor, getModelValue, pathFromUri } from "./editorRegistry";
import { changeDocument, extensionOf, pathToUri, sendRequest } from "./lsp/lspClient";
import { applyLspCodeAction, type LspCodeAction, type LspCommand } from "./lsp/monacoLsp";
import { applyWorkspaceEdit } from "./lsp/workspaceEdit";
import { readFile } from "./ipc";
import { useInterpreterStore } from "../store/interpreterStore";
import { useTabsStore } from "../store/tabsStore";
import { useUiStore } from "../store/uiStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useRefactorPickerStore } from "../store/refactorPickerStore";

/**
 * JetBrains-style refactorings: Extract Variable / Method / Constant and
 * Inline (⌥⌘V / ⌥⌘M / ⌥⌘C / ⌥⌘N), and Refactor This (⌃T).
 *
 *   - Go, Rust, C/C++, Java and TypeScript/JavaScript: the language
 *     server's refactoring code actions.
 *   - Python: Rope (Pyright has no refactorings).
 *
 * An extraction then starts a rename of the new name, so you name it in
 * place — as JetBrains does.
 */

export type Refactoring = "extractVariable" | "extractMethod" | "extractConstant" | "inline";

const LABELS: Record<Refactoring, string> = {
  extractVariable: "Extract Variable",
  extractMethod: "Extract Method",
  extractConstant: "Extract Constant",
  inline: "Inline",
};

type Editor = MonacoTypes.editor.ICodeEditor;
type Model = MonacoTypes.editor.ITextModel;

/** Which of a server's refactoring actions is which (servers name them
 *  differently; rust-analyzer's kinds don't say). */
export function matches(refactoring: Refactoring, action: { title: string; kind?: string }): boolean {
  const kind = action.kind ?? "";
  const title = action.title;
  switch (refactoring) {
    case "extractVariable":
      return (
        kind.startsWith("refactor.extract.variable") ||
        /extract (into|to) (local )?variable|extract subexpression|extract to constant in enclosing scope/i.test(title)
      );
    case "extractMethod":
      return kind.startsWith("refactor.extract.function") || /extract (in)?to (inner )?(function|method)/i.test(title);
    case "extractConstant":
      // TypeScript's "constant in enclosing scope" is a local: that's
      // Extract Variable.
      if (/enclosing scope/i.test(title)) return false;
      return kind.startsWith("refactor.extract.constant") || /extract (in)?to (constant|static|const)/i.test(title);
    case "inline":
      return kind.startsWith("refactor.inline") || /^inline/i.test(title);
  }
}

/** The identifiers in `text`. */
function identifiers(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/** Resolves when the model next changes (or after `ms`). */
function nextChange(model: Model, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(false);
    }, ms);
    const listener = model.onDidChangeContent(() => {
      clearTimeout(timer);
      listener.dispose();
      // Let a multi-edit apply finish.
      setTimeout(() => resolve(true), 50);
    });
  });
}

/**
 * After an extraction: put the cursor on the name the refactoring made up
 * (an identifier that wasn't in the file before) and start renaming it.
 */
function renameNewName(editor: Editor, model: Model, before: string, near: number) {
  const known = identifiers(before);
  const text = model.getValue();
  let best: { offset: number; distance: number } | null = null;
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (known.has(match[0])) continue;
    const offset = match.index ?? 0;
    const distance = Math.abs(offset - near);
    if (!best || distance < best.distance) best = { offset, distance };
  }
  if (!best) return;
  const position = model.getPositionAt(best.offset);
  editor.setPosition(position);
  editor.revealPositionInCenterIfOutsideViewport(position);
  editor.focus();
  void editor.getAction("editor.action.rename")?.run();
}

/** Apply an action, then (for extractions) rename what it created. */
async function applyAndRename(editor: Editor, model: Model, apply: () => Promise<void>, rename: boolean) {
  const before = model.getValue();
  const near = model.getOffsetAt(editor.getSelection()?.getStartPosition() ?? { lineNumber: 1, column: 1 });
  const changed = nextChange(model, 5000);
  await apply();
  if ((await changed) && rename) renameNewName(editor, model, before, near);
}

// --- Language servers ---------------------------------------------------------

async function serverRefactorings(model: Model, selection: MonacoTypes.Selection) {
  const path = pathFromUri(model.uri);
  await changeDocument(path, model.getValue());
  const result = (await sendRequest(extensionOf(path), "textDocument/codeAction", {
    textDocument: { uri: pathToUri(path) },
    range: {
      start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
      end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
    },
    context: { diagnostics: [], only: ["refactor"], triggerKind: 1 },
  })) as (LspCodeAction | LspCommand)[] | null;
  return (result ?? []).filter((action) => !("disabled" in action && action.disabled));
}

// --- Python (Rope) ----------------------------------------------------------------

interface RopeChange {
  path: string;
  contents: string;
}

const ROPE_KIND: Record<Refactoring, string> = {
  extractVariable: "extract_variable",
  extractMethod: "extract_method",
  extractConstant: "extract_constant",
  inline: "inline",
};

/** A name Rope gives the new variable/function (renamed right after). */
function placeholderName(refactoring: Refactoring, text: string): string {
  const base = refactoring === "extractMethod" ? "extracted" : refactoring === "extractConstant" ? "EXTRACTED" : "value";
  const taken = identifiers(text);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

/** Turn whole-file results into minimal edits (keeps undo and the cursor sane). */
async function applyFileContents(changes: RopeChange[]) {
  const edits: Record<string, { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]> = {};
  for (const change of changes) {
    // An open file's buffer, else the file on disk.
    const old = getModelValue(change.path) ?? (await readFile(change.path));
    let start = 0;
    while (start < old.length && start < change.contents.length && old[start] === change.contents[start]) start++;
    let oldEnd = old.length;
    let newEnd = change.contents.length;
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === change.contents[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const position = (offset: number) => {
      const lines = old.slice(0, offset).split("\n");
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    };
    edits[pathToUri(change.path)] = [{ range: { start: position(start), end: position(oldEnd) }, newText: change.contents.slice(start, newEnd) }];
  }
  await applyWorkspaceEdit({ changes: edits });
}

async function ropeRefactor(editor: Editor, model: Model, refactoring: Refactoring): Promise<void> {
  const path = pathFromUri(model.uri);
  const root = useWorkspaceStore.getState().rootPath ?? path.slice(0, path.lastIndexOf("/"));
  const python = useInterpreterStore.getState().selectedPath ?? null;
  const selection = editor.getSelection()!;
  if (refactoring !== "inline" && selection.isEmpty()) {
    useUiStore.getState().showStatus(`Select the code to ${LABELS[refactoring].toLowerCase()} first`);
    return;
  }
  // Rope works on the file on disk.
  await useTabsStore.getState().saveTab(path, "auto");
  const request = () =>
    invoke<RopeChange[]>("python_refactor", {
      python,
      root,
      file: path,
      kind: ROPE_KIND[refactoring],
      start: [selection.startLineNumber, selection.startColumn],
      end: [selection.endLineNumber, selection.endColumn],
      name: refactoring === "inline" ? null : placeholderName(refactoring, model.getValue()),
    });
  let changes: RopeChange[];
  try {
    changes = await request();
  } catch (error) {
    if (String(error) !== "rope-missing") throw error;
    const install = await confirmNative(
      "Python refactoring uses Rope, a small Python library. Install it into Sable's tools folder now?",
      { title: "Install Rope", kind: "info" },
    );
    if (!install) return;
    useUiStore.getState().showStatus("Installing Rope…");
    await invoke("install_rope", { python });
    changes = await request();
  }
  await applyAndRename(editor, model, () => applyFileContents(changes), refactoring !== "inline");
}

// --- Entry points -------------------------------------------------------------------

/** Run one refactoring at the cursor/selection of the active editor. */
export async function refactor(refactoring: Refactoring): Promise<void> {
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model || model.uri.scheme !== "file") return;
  const ui = useUiStore.getState();
  try {
    if (model.getLanguageId() === "python") {
      await ropeRefactor(editor, model, refactoring);
      return;
    }
    const selection = editor.getSelection();
    if (!selection) return;
    const path = pathFromUri(model.uri);
    const extension = extensionOf(path);
    const candidates = (await serverRefactorings(model, selection)).filter((action) => matches(refactoring, action));
    if (candidates.length === 0) {
      ui.showStatus(
        selection.isEmpty() && refactoring !== "inline"
          ? `Select the code to ${LABELS[refactoring].toLowerCase()} first`
          : `${LABELS[refactoring]} isn't available here`,
      );
      return;
    }
    const run = (action: LspCodeAction | LspCommand) =>
      applyAndRename(editor, model, () => applyLspCodeAction(extension, action), refactoring !== "inline");
    if (candidates.length === 1) {
      await run(candidates[0]);
      return;
    }
    // Several (e.g. TypeScript's "inner function" / "module scope"): pick.
    const position = editor.getScrolledVisiblePosition(selection.getStartPosition());
    const box = editor.getDomNode()?.getBoundingClientRect();
    useRefactorPickerStore.getState().open(
      (box?.left ?? 0) + (position?.left ?? 0),
      (box?.top ?? 0) + (position?.top ?? 0) + (position?.height ?? 18),
      candidates.map((action) => ({ label: action.title, onSelect: () => void run(action).catch(report) })),
    );
  } catch (error) {
    report(error);
  }
}

function report(error: unknown) {
  useUiStore.getState().setLastError(`Refactoring failed: ${String(error)}`);
}

/** Refactor This (⌃T): every refactoring available here, as a menu. */
export function refactorThis(): void {
  const editor = getEditor();
  if (!editor) return;
  editor.focus();
  void editor.getAction("editor.action.refactor")?.run();
}

/** Python's refactorings in the ⌘. / ⌃T menus (other languages' come
 *  from their servers). */
export function registerPythonRefactorings(monaco: typeof MonacoTypes) {
  monaco.editor.registerCommand("sable.refactor", (_accessor, refactoring: Refactoring) => void refactor(refactoring));
  monaco.languages.registerCodeActionProvider(
    "python",
    {
      provideCodeActions: (model, range) => {
        const word = model.getWordAtPosition(range.getStartPosition());
        const selected = !range.isEmpty();
        const entries: [Refactoring, string, boolean][] = [
          ["extractMethod", "refactor.extract.function", selected],
          ["extractVariable", "refactor.extract.variable", selected],
          ["extractConstant", "refactor.extract.constant", selected],
          ["inline", "refactor.inline", !selected && !!word],
        ];
        return {
          actions: entries
            .filter(([, , available]) => available)
            .map(([refactoring, kind]) => ({
              title: LABELS[refactoring],
              kind,
              command: { id: "sable.refactor", title: LABELS[refactoring], arguments: [refactoring] },
            })),
          dispose() {},
        };
      },
    },
    { providedCodeActionKinds: ["refactor.extract", "refactor.inline"] },
  );
}
