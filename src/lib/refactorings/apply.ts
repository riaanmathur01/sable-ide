import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { createDirectory, parentDirectoryOf, pathExists, readFile } from "../ipc";
import { getModelValue } from "../editorRegistry";
import { pathToUri } from "../lsp/lspClient";
import { applyWorkspaceEdit, type LspWorkspaceEdit } from "../lsp/workspaceEdit";
import { goTo } from "../../store/navigationStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useRefactoringStore } from "../../store/refactoringStore";
import { useUiStore } from "../../store/uiStore";
import { minimalEdits } from "./diff";
import type { RefactoringPlan } from "./types";

/**
 * Apply a refactoring's plan as one step — every file's edit, created,
 * deleted and moved files — and keep it for Undo (which puts every file
 * back, wherever the refactoring touched them). Open files are edited
 * through their editors, so ⌘Z there undoes that file's part too.
 */

/** Current text of a file: its open editor's, else the disk's. */
export async function currentText(path: string): Promise<string | null> {
  const open = getModelValue(path);
  if (open !== null) return open;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

const undoStack: RefactoringPlan[] = [];
const MAX_UNDO = 20;

export function lastRefactoring(): RefactoringPlan | null {
  return undoStack[undoStack.length - 1] ?? null;
}

async function ensureDirectory(path: string) {
  const missing: string[] = [];
  let directory = parentDirectoryOf(path);
  while (directory && !(await pathExists(directory))) {
    missing.push(directory);
    const parent = parentDirectoryOf(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const folder of missing.reverse()) await createDirectory(folder);
}

/** Refresh the Explorer's listings of the folders a plan touched. */
async function refreshExplorer(paths: string[]) {
  const { childrenByPath, refreshDirectory } = useWorkspaceStore.getState();
  const directories = new Set<string>();
  for (const path of paths) {
    let directory = parentDirectoryOf(path);
    // The nearest folder the Explorer has listed (new folders appear in it).
    while (directory && !childrenByPath[directory] && parentDirectoryOf(directory) !== directory) {
      directory = parentDirectoryOf(directory);
    }
    if (directory && childrenByPath[directory]) directories.add(directory);
  }
  for (const directory of directories) await refreshDirectory(directory);
}

/**
 * Apply `plan`. Every file must still read as the plan's `before` (it was
 * worked out from that); otherwise nothing is changed.
 */
export async function applyPlan(plan: RefactoringPlan, { record = true } = {}): Promise<void> {
  for (const file of plan.files) {
    if (file.before === null) {
      const existing = (await pathExists(file.path)) ? await currentText(file.path) : null;
      if (existing) throw new Error(`${file.path.split(/[/\\]/).pop()} already exists`);
      continue;
    }
    const now = await currentText(file.path);
    if (now !== file.before) {
      throw new Error(`${file.path.split(/[/\\]/).pop()} changed since the refactoring was worked out — try again`);
    }
  }
  const documentChanges: NonNullable<LspWorkspaceEdit["documentChanges"]> = [];
  for (const file of plan.files) {
    if (file.before === null && file.after !== null) {
      await ensureDirectory(file.path);
      documentChanges.push({ kind: "create", uri: pathToUri(file.path), options: { ignoreIfExists: true } });
      if (file.after) {
        documentChanges.push({
          textDocument: { uri: pathToUri(file.path) },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: file.after }],
        });
      }
    }
  }
  for (const file of plan.files) {
    if (file.before !== null && file.after !== null && file.before !== file.after) {
      documentChanges.push({ textDocument: { uri: pathToUri(file.path) }, edits: minimalEdits(file.before, file.after) });
    }
  }
  for (const move of plan.moves) {
    await ensureDirectory(move.to);
    documentChanges.push({ kind: "rename", oldUri: pathToUri(move.from), newUri: pathToUri(move.to) });
  }
  for (const file of plan.files) {
    if (file.before !== null && file.after === null) documentChanges.push({ kind: "delete", uri: pathToUri(file.path) });
  }
  await applyWorkspaceEdit({ documentChanges });
  await refreshExplorer([...plan.files.map((file) => file.path), ...plan.moves.flatMap((move) => [move.from, move.to])]);
  if (record) {
    undoStack.push(plan);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
}

/** The plan that puts back what `plan` did. */
function reversed(plan: RefactoringPlan): RefactoringPlan {
  const movedTo = new Map(plan.moves.map((move) => [move.from, move.to]));
  return {
    ...plan,
    title: `Undo ${plan.title}`,
    // Contents first at the moved-to paths, then the files move back.
    files: plan.files.map((file) => ({ path: movedTo.get(file.path) ?? file.path, before: file.after, after: file.before })),
    moves: plan.moves.map((move) => ({ from: move.to, to: move.from })).reverse(),
    conflicts: [],
  };
}

/** Undo the last refactoring, in every file it changed. */
export async function undoLastRefactoring(): Promise<void> {
  const plan = undoStack[undoStack.length - 1];
  const ui = useUiStore.getState();
  if (!plan) {
    ui.showStatus("No refactoring to undo");
    return;
  }
  const back = reversed(plan);
  const changed: string[] = [];
  for (const file of back.files) {
    if (file.before === null) {
      if (await pathExists(file.path)) changed.push(file.path);
    } else if ((await currentText(file.path)) !== file.before) {
      changed.push(file.path);
    }
  }
  if (changed.length > 0) {
    const names = changed.map((path) => path.split(/[/\\]/).pop()).join(", ");
    const proceed = await confirmNative(`${names} changed since “${plan.title}”. Undo anyway? Those changes will be lost.`, {
      title: "Undo Refactoring",
      kind: "warning",
    });
    if (!proceed) return;
    // Work from what's there now.
    for (const file of back.files) {
      if (file.before !== null) file.before = (await currentText(file.path)) ?? file.before;
    }
  }
  try {
    await applyPlan(back, { record: false });
    undoStack.pop();
    useRefactoringStore.getState().hideToast();
    ui.showStatus(`Undid ${plan.title}`);
  } catch (error) {
    ui.setLastError(`Undo failed: ${String(error)}`);
  }
}

/** Apply, then say what changed with an Undo button; open Move's target. */
export async function applyAndReport(plan: RefactoringPlan): Promise<void> {
  await applyPlan(plan);
  const files = new Set([...plan.files.map((file) => file.path), ...plan.moves.map((move) => move.to)]).size;
  useRefactoringStore
    .getState()
    .showToast(`${plan.title}: ${files} file${files === 1 ? "" : "s"} changed`, () => void undoLastRefactoring());
  if (plan.reveal) await goTo(plan.reveal.path, plan.reveal.line);
}
