import type * as MonacoTypes from "monaco-editor";
import { getEditor, pathFromUri } from "../editorRegistry";
import { useRefactoringStore } from "../../store/refactoringStore";
import { useUiStore } from "../../store/uiStore";
import { useNavigationStore } from "../../store/navigationStore";
import { applyAndReport, applyPlan, currentText, undoLastRefactoring } from "./apply";
import {
  pythonChangeSignaturePlan,
  pythonModuleUsages,
  pythonMoveModulePlan,
  pythonMovePlan,
  pythonSafeDeletePlan,
  pythonSignature,
  pythonUsages,
} from "./python";
import { isScript, openTsProject, tsPlan } from "./typescript";
import { tsChangeSignature, tsFileRename, tsImporters, tsMove, tsSafeDelete, tsSignature, tsUsages, topLevelStatement } from "./tsEngine";
import { TEXT_ENGINE, genericChangeSignature, genericSignature, genericUsages, importersByText, lspFileRenamePlan } from "./generic";
import { findUsages, serverSupports } from "../lsp/navigation";
import { languageOf } from "./signature";
import type { RefactoringPlan, Signature, UsageItem } from "./types";

/**
 * JetBrains' deeper refactorings: Safe Delete (⌘⌫ / Alt+Delete), Change
 * Signature (⌘F6 / Ctrl+F6) and Move (F6), plus import updates when the
 * Explorer renames or moves a file.
 *
 *   - Python: Rope (python.ts).
 *   - TypeScript/JavaScript: the TypeScript language service (tsEngine.ts),
 *     with the language server's references added to Safe Delete's usages.
 *   - Others: the language server's references and careful text rewriting
 *     (generic.ts), labeled as best effort.
 *
 * Every refactoring is previewed (Safe Delete with no usages just
 * deletes), applied as one step, and can be undone in every file at once.
 */

export { undoLastRefactoring } from "./apply";
export type { RefactoringPlan } from "./types";

type Position = { lineNumber: number; column: number };

interface Cursor {
  path: string;
  position: Position;
  offset: number;
  word: string;
  model: MonacoTypes.editor.ITextModel;
}

function cursor(): Cursor | null {
  const editor = getEditor();
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!editor || !model || !position || model.uri.scheme !== "file") return null;
  return {
    path: pathFromUri(model.uri),
    position: { lineNumber: position.lineNumber, column: position.column },
    offset: model.getOffsetAt(position),
    word: model.getWordAtPosition(position)?.word ?? "",
    model,
  };
}

type Engine = "python" | "typescript" | "generic";

function engineFor(path: string): Engine {
  if (languageOf(path) === "python") return "python";
  if (isScript(path)) return "typescript";
  return "generic";
}

function report(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const store = useRefactoringStore.getState();
  if (store.dialog) store.setError(message);
  else useUiStore.getState().setLastError(message);
}

/** Show the Refactoring Preview; "Do Refactor" applies it. */
export function preview(plan: RefactoringPlan, options: { applyLabel?: string; alternative?: { label: string; run: () => Promise<void> } } = {}) {
  const store = useRefactoringStore.getState();
  if (plan.files.length === 0 && plan.moves.length === 0) {
    store.close();
    useUiStore.getState().showStatus(`${plan.title}: nothing to change`);
    return;
  }
  store.open({
    kind: "preview",
    plan,
    applyLabel: options.applyLabel,
    alternative: options.alternative,
    apply: async () => {
      await applyAndReport(plan);
      useRefactoringStore.getState().close();
    },
  });
}

// --- Safe Delete -----------------------------------------------------------------------------

/** Safe Delete (⌘⌫ / Alt+Delete) the symbol at the cursor. */
export async function safeDelete(): Promise<void> {
  const at = cursor();
  if (!at) return;
  if (!at.word) {
    useUiStore.getState().showStatus("Put the cursor on the name of what to delete");
    return;
  }
  useUiStore.getState().showStatus(`Looking for usages of ${at.word}…`);
  try {
    let what: string;
    let usages: UsageItem[];
    let plan: () => Promise<RefactoringPlan>;
    const engine = engineFor(at.path);
    if (engine === "python") {
      const found = await pythonUsages(at.path, at.position);
      what = `${found.symbol.kind} ${found.symbol.name}`;
      usages = found.usages;
      plan = () => pythonSafeDeletePlan(at.path, at.position, what);
    } else if (engine === "typescript") {
      const project = await openTsProject([at.path]);
      const found = tsUsages(project, at.path, at.offset);
      what = found.what;
      usages = await withServerUsages(at, found.usages, found.declaration);
      plan = async () => {
        const fresh = await openTsProject([at.path]);
        return tsPlan(fresh, `Safe Delete ${what}`, tsSafeDelete(fresh, at.path, at.offset));
      };
    } else {
      const found = await genericUsages(at.path, at.position);
      what = found.what;
      usages = found.usages;
      plan = found.plan;
    }
    useUiStore.getState().showStatus("");
    const run = async () => {
      const ready = await plan();
      await applyAndReport(ready);
      useRefactoringStore.getState().close();
    };
    if (usages.length === 0) {
      await run();
      return;
    }
    useRefactoringStore.getState().open({ kind: "safeDelete", what, usages, deleteAnyway: run });
  } catch (error) {
    report(error);
  }
}

/** The language server's references too (it may see files the TS project doesn't). */
async function withServerUsages(at: Cursor, usages: UsageItem[], declaration: { path: string; startLine: number; endLine: number }) {
  if (!serverSupports(at.path, "referencesProvider")) return usages;
  try {
    const known = new Set(usages.map((usage) => `${usage.path}:${usage.line}:${usage.column}`));
    const extra: UsageItem[] = [];
    for (const location of await findUsages(at.path, at.position)) {
      const key = `${location.path}:${location.line}:${location.column}`;
      const own = location.path === declaration.path && location.line >= declaration.startLine && location.line <= declaration.endLine;
      if (known.has(key) || own) continue;
      known.add(key);
      const text = (await currentText(location.path)) ?? "";
      extra.push({
        path: location.path,
        line: location.line,
        column: location.column,
        endColumn: location.endLine === location.line ? location.endColumn : location.column,
        preview: text.split("\n")[location.line - 1] ?? "",
      });
    }
    return [...usages, ...extra];
  } catch {
    return usages;
  }
}

/** Safe Delete a file (Explorer): its importers first. */
export async function safeDeleteFile(path: string): Promise<void> {
  const name = path.split(/[/\\]/).pop() ?? path;
  useUiStore.getState().showStatus(`Looking for imports of ${name}…`);
  try {
    let usages: UsageItem[];
    const engine = engineFor(path);
    if (engine === "python") usages = await pythonModuleUsages(path);
    else if (engine === "typescript") usages = tsImporters(await openTsProject([path]), path);
    else usages = await importersByText(path);
    useUiStore.getState().showStatus("");
    const contents = await currentText(path);
    const plan: RefactoringPlan = {
      title: `Delete ${name}`,
      files: [{ path, before: contents ?? "", after: null }],
      moves: [],
      conflicts: [],
      engine: engine === "generic" ? "import search" : engine === "python" ? "Rope" : "TypeScript",
    };
    useRefactoringStore.getState().open({
      kind: "safeDelete",
      what: `file ${name}`,
      usages,
      confirmOnly: usages.length === 0,
      deleteAnyway: async () => {
        await applyAndReport(plan);
        useRefactoringStore.getState().close();
      },
    });
  } catch (error) {
    report(error);
  }
}

/** "View Usages": the Safe Delete dialog's usages in the Usages panel. */
export function showUsagesInPanel(what: string, usages: UsageItem[]) {
  useNavigationStore.setState({
    usages: { symbol: what, usages: usages.map((usage) => ({ ...usage })) },
    usagesLoading: false,
  });
  useUiStore.getState().setBottomPanel("usages");
}

// --- Change Signature ---------------------------------------------------------------------------

/** Change Signature (⌘F6 / Ctrl+F6) of the function at the cursor. */
export async function changeSignature(): Promise<void> {
  const at = cursor();
  if (!at) return;
  try {
    const engine = engineFor(at.path);
    const store = useRefactoringStore.getState();
    if (engine === "python") {
      const signature = await pythonSignature(at.path, at.position);
      store.open({
        kind: "changeSignature",
        signature,
        engine: "Rope",
        bestEffort: false,
        submit: async (changed) => preview(await pythonChangeSignaturePlan(at.path, at.position, signature, changed)),
      });
    } else if (engine === "typescript") {
      const project = await openTsProject([at.path]);
      useUiStore.getState().showStatus("");
      const signature = tsSignature(project, at.path, at.offset);
      store.open({
        kind: "changeSignature",
        signature,
        engine: "TypeScript",
        bestEffort: false,
        submit: async (changed: Signature) => {
          const fresh = await openTsProject([at.path]);
          preview(tsPlan(fresh, `Change Signature of ${signature.name}`, tsChangeSignature(fresh, at.path, at.offset, changed)));
        },
      });
    } else {
      const declaration = await genericSignature(at.path, at.position);
      store.open({
        kind: "changeSignature",
        signature: declaration.signature,
        engine: TEXT_ENGINE,
        bestEffort: true,
        submit: async (changed) => preview(await genericChangeSignature(declaration, changed)),
      });
    }
  } catch (error) {
    report(error);
  }
}

// --- Move -----------------------------------------------------------------------------------------

/** Move (F6) the top-level declaration at the cursor to another file. */
export async function move(): Promise<void> {
  const at = cursor();
  if (!at) return;
  const engine = engineFor(at.path);
  if (engine === "generic") {
    useUiStore.getState().showStatus("Move is available for Python, TypeScript and JavaScript");
    return;
  }
  try {
    let what = at.word;
    let extensions = [".py"];
    if (engine === "typescript") {
      const project = await openTsProject([at.path]);
      useUiStore.getState().showStatus("");
      what = topLevelStatement(project, at.path, at.offset).name;
      extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
    }
    if (!what) {
      useUiStore.getState().showStatus("Put the cursor on the name of a class, function or variable");
      return;
    }
    useRefactoringStore.getState().open({
      kind: "move",
      what,
      sourcePath: at.path,
      extensions,
      submit: async (target) => {
        if (engine === "python") {
          preview(await pythonMovePlan(at.path, at.position, what, target));
          return;
        }
        const fresh = await openTsProject([at.path]);
        const result = tsMove(fresh, at.path, at.offset, target);
        const moved = result.changes.get(fresh.toFileName(target));
        const line = moved ? Math.max(1, moved.split("\n").findIndex((text) => text.includes(what)) + 1) : 1;
        preview(tsPlan(fresh, `Move ${what} to ${target.split(/[/\\]/).pop()}`, result, { reveal: { path: target, line } }));
      },
    });
  } catch (error) {
    report(error);
  }
}

// --- Explorer: moving and renaming files ------------------------------------------------------------

/** `name` inside `directory`, with the directory's separator. */
export function pathIn(directory: string, name: string): string {
  const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return directory.endsWith(separator) ? directory + name : directory + separator + name;
}

/**
 * The Explorer is about to move or rename a file: offer to update the
 * imports (a preview, "Move Only" to skip). True if this took over the
 * move; false to let the Explorer move it as usual (nothing to update).
 */
export async function moveFileWithImports(from: string, to: string): Promise<boolean> {
  const engine = engineFor(from);
  const name = from.split(/[/\\]/).pop() ?? from;
  const renaming = from.slice(0, from.length - name.length) === to.slice(0, to.length - (to.split(/[/\\]/).pop() ?? "").length);
  let plan: RefactoringPlan | null = null;
  try {
    if (engine === "python") {
      if (!/\.pyw?$/.test(to)) return false;
      useUiStore.getState().showStatus(`Looking for imports of ${name}…`);
      plan = await pythonMoveModulePlan(from, to);
    } else if (engine === "typescript") {
      useUiStore.getState().showStatus(`Looking for imports of ${name}…`);
      const project = await openTsProject([from]);
      plan = tsPlan(project, `${renaming ? "Rename" : "Move"} ${name}`, tsFileRename(project, from, to), { moves: [{ from, to }] });
    } else {
      plan = await lspFileRenamePlan(from, to);
    }
  } catch (error) {
    useUiStore.getState().showStatus(`Imports weren't updated: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    useUiStore.getState().showStatus("");
  }
  if (!plan || plan.files.length === 0) return false;
  if (plan.moves.length === 0) plan.moves = [{ from, to }];
  const plain: RefactoringPlan = { ...plan, files: [], conflicts: [] };
  preview(plan, {
    applyLabel: renaming ? "Rename and Update Imports" : "Move and Update Imports",
    alternative: {
      label: renaming ? "Rename Only" : "Move Only",
      run: async () => {
        await applyPlan(plain);
        useRefactoringStore.getState().close();
      },
    },
  });
  return true;
}

// --- ⌃T, the light bulb ---------------------------------------------------------------------------

const COMMAND = "sable.refactor.deep";

/** Whether the line declares `word` (a cheap check for the light bulb). */
function declaresOnLine(language: string, line: string, word: string): "function" | "other" | null {
  const name = word.replace(/[$]/g, "\\$");
  if (language === "python") {
    if (new RegExp(`^\\s*(async\\s+)?def\\s+${name}\\b`).test(line)) return "function";
    if (new RegExp(`^\\s*class\\s+${name}\\b|^${name}\\s*(:[^=]*)?=`).test(line)) return "other";
    return null;
  }
  if (new RegExp(`\\b(function\\*?|fn|func|fun|def)\\s+${name}\\b`).test(line)) return "function";
  if (new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${name}\\s*=\\s*(async\\s*)?(\\([^)]*\\)|\\w+)\\s*=>`).test(line)) return "function";
  if (new RegExp(`^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?(class|interface|type|enum|struct|trait|const|let|var|static)\\s+${name}\\b`).test(line)) {
    return "other";
  }
  if (new RegExp(`^\\s*((public|private|protected|static|async|override|final|abstract|readonly|virtual|internal)\\s+)*([\\w<>\\[\\],.?]+\\s+)?${name}\\s*\\([^)]*\\)?\\s*[:{]?`).test(line) && /[{:]\s*$|\)\s*$/.test(line)) {
    return "function";
  }
  return null;
}

/** Whether the cursor is on a declaration's name (⌘⌫ only means Safe Delete there). */
export function cursorOnDeclaration(): boolean {
  const at = cursor();
  if (!at || !at.word) return false;
  return declaresOnLine(at.model.getLanguageId(), at.model.getLineContent(at.position.lineNumber), at.word) !== null;
}

export function registerDeepRefactorings(monaco: typeof MonacoTypes) {
  monaco.editor.registerCommand(COMMAND, (_accessor, which: "safeDelete" | "changeSignature" | "move") => {
    if (which === "safeDelete") void safeDelete();
    else if (which === "changeSignature") void changeSignature();
    else void move();
  });
  monaco.languages.registerCodeActionProvider(
    "*",
    {
      provideCodeActions: (model, range, context) => {
        const none = { actions: [], dispose() {} };
        if (model.uri.scheme !== "file" || !range.isEmpty()) return none;
        const word = model.getWordAtPosition(range.getStartPosition());
        if (!word) return none;
        const language = model.getLanguageId();
        if (["plaintext", "markdown", "json", "jsonc", "css", "scss", "less", "html", "yaml", "ini", "xml"].includes(language)) return none;
        const declared = declaresOnLine(language, model.getLineContent(range.startLineNumber), word.word);
        const invoked = context.trigger === monaco.languages.CodeActionTriggerType.Invoke;
        // The light bulb offers them on declarations; ⌃T / ⌘. anywhere on a name.
        if (!invoked && !declared) return none;
        const path = pathFromUri(model.uri);
        const movable =
          (language === "python" || isScript(path)) &&
          (invoked || /^(export\s+)?(default\s+)?(async\s+)?(def|class|function|const|let|var|interface|type|enum|abstract)\b|^[A-Za-z_]\w*\s*[:=]/.test(model.getLineContent(range.startLineNumber)));
        const entries: [string, string, "safeDelete" | "changeSignature" | "move", boolean][] = [
          // Kinds Monaco's menu groups: "Rewrite", "Move".
          ["Change Signature…", "refactor.rewrite.changeSignature", "changeSignature", invoked || declared === "function"],
          ["Safe Delete…", "refactor.rewrite.safeDelete", "safeDelete", true],
          ["Move…", "refactor.move.sable", "move", movable],
        ];
        return {
          actions: entries
            .filter(([, , , available]) => available)
            .map(([title, kind, which]) => ({ title, kind, command: { id: COMMAND, title, arguments: [which] } })),
          dispose() {},
        };
      },
    },
    { providedCodeActionKinds: ["refactor.rewrite.changeSignature", "refactor.rewrite.safeDelete", "refactor.move.sable"] },
  );
}

/** For the bridge-driven UI test: run without a key press. */
export const deepRefactorings = { safeDelete, safeDeleteFile, changeSignature, move, moveFileWithImports, undoLastRefactoring };
