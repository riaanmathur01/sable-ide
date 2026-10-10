import { readFile, writeFile } from "./ipc";
import { getModelValue, hasModel, markSaved, replaceModelContent } from "./editorRegistry";
import { changeDocument, saveDocument } from "./lsp/lspClient";
import { useTabsStore } from "../store/tabsStore";
import { useGitStore } from "../store/gitStore";

/**
 * Reading and writing files the way the editor sees them. Used by
 * anything that changes files programmatically — the AI agent,
 * find-and-replace — so open files never go stale or lose edits.
 */

/** Current text of a file: the open editor buffer if any, else disk.
 *  `null` if it doesn't exist / can't be read. */
export async function readCurrentText(path: string): Promise<string | null> {
  const fromEditor = getModelValue(path);
  if (fromEditor !== null) return fromEditor;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Write a file the way the editor would: if it's open, update the model
 * as one undoable edit (so the user can ⌘Z it and never sees stale text),
 * then write to disk and mark it clean.
 */
export async function writeFileContents(path: string, content: string): Promise<void> {
  const open = hasModel(path);
  if (open) replaceModelContent(path, content);
  await writeFile(path, content);
  if (open) {
    markSaved(path);
    useTabsStore.getState().syncDirtyState(path);
    void changeDocument(path, content);
    void saveDocument(path);
  }
  useGitStore.getState().refresh();
}
