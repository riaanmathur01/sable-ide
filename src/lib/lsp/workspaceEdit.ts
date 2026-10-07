import {
  createFile,
  deletePath,
  movePath,
  parentDirectoryOf,
  readFile,
  renamePath,
  writeFile,
} from "../ipc";
import { getModelValue, markSaved, pushModelEdits } from "../editorRegistry";
import { changeDocument, uriToPath } from "./lspClient";
import { isFileOpen, useTabsStore } from "../../store/tabsStore";
import { useBreakpointsStore } from "../../store/breakpointsStore";
import { useGitStore } from "../../store/gitStore";

/**
 * Apply an LSP WorkspaceEdit — what quick fixes and refactorings return.
 * Open files are edited through their Monaco model (one undoable step,
 * then saved like any edit); files that aren't open are edited on disk.
 */

interface LspPosition {
  line: number;
  character: number;
}
export interface LspTextEdit {
  range: { start: LspPosition; end: LspPosition };
  newText: string;
}
interface TextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}
interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}
interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
}
interface DeleteFile {
  kind: "delete";
  uri: string;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

/**
 * Apply LSP text edits to a string. Positions are UTF-16 offsets, which
 * is exactly how JS strings index. Edits are applied back to front; for
 * edits at the same position, LSP says array order wins, so ties are
 * applied in reverse index order.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const offsetOf = (position: LspPosition) => {
    if (position.line >= lineStarts.length) return text.length;
    const lineStart = lineStarts[position.line];
    const lineEnd =
      position.line + 1 < lineStarts.length
        ? lineStarts[position.line + 1] - 1
        : text.length;
    return Math.min(lineStart + position.character, lineEnd);
  };
  const ordered = edits
    .map((edit, index) => ({
      start: offsetOf(edit.range.start),
      end: offsetOf(edit.range.end),
      text: edit.newText,
      index,
    }))
    .sort((a, b) => b.start - a.start || b.index - a.index);
  let result = text;
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

async function editFile(path: string, edits: LspTextEdit[]) {
  if (edits.length === 0) return;
  const tabs = useTabsStore.getState();
  const isOpenTab = isFileOpen(path);
  const applied = pushModelEdits(
    path,
    edits.map((edit) => ({
      startLineNumber: edit.range.start.line + 1,
      startColumn: edit.range.start.character + 1,
      endLineNumber: edit.range.end.line + 1,
      endColumn: edit.range.end.character + 1,
      text: edit.newText,
    })),
  );
  if (applied) {
    const value = getModelValue(path) ?? "";
    void changeDocument(path, value);
    if (isOpenTab) {
      // Same as typing: dirty dot, then auto-save (if enabled).
      tabs.syncDirtyState(path);
      tabs.scheduleAutoSave(path);
    } else {
      // A model with no tab (e.g. created to preview a definition) is
      // never saved by the editor — write it now.
      await writeFile(path, value);
      markSaved(path);
    }
    return;
  }
  const before = await readFile(path);
  await writeFile(path, applyTextEdits(before, edits));
}

async function renameFile(oldPath: string, newPath: string) {
  const tabs = useTabsStore.getState();
  await tabs.saveTabsUnder(oldPath);
  let current = oldPath;
  const newParent = parentDirectoryOf(newPath);
  if (parentDirectoryOf(current) !== newParent) {
    current = await movePath(current, newParent);
  }
  const newName = newPath.split(/[/\\]/).pop() ?? newPath;
  if ((current.split(/[/\\]/).pop() ?? "") !== newName) {
    current = await renamePath(current, newName);
  }
  await tabs.remapMovedPaths(oldPath, current);
  useBreakpointsStore.getState().remapPath(oldPath, current);
}

export async function applyWorkspaceEdit(edit: LspWorkspaceEdit): Promise<void> {
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        await editFile(uriToPath(change.textDocument.uri), change.edits);
      } else if (change.kind === "create") {
        const path = uriToPath(change.uri);
        try {
          await createFile(path);
        } catch (error) {
          if (change.options?.overwrite) await writeFile(path, "");
          else if (!change.options?.ignoreIfExists) throw error;
        }
      } else if (change.kind === "rename") {
        await renameFile(uriToPath(change.oldUri), uriToPath(change.newUri));
      } else if (change.kind === "delete") {
        const path = uriToPath(change.uri);
        await deletePath(path);
        useTabsStore.getState().closeTabsUnder(path);
        useBreakpointsStore.getState().removeUnder(path);
      }
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await editFile(uriToPath(uri), edits);
    }
  }
  useGitStore.getState().refresh();
}
