import type * as MonacoTypes from "monaco-editor";
import { readFile } from "../ipc";
import { getEditor, isModelDirty, pathFromUri } from "../editorRegistry";
import { useTabsStore, type EditorTab } from "../../store/tabsStore";
import { folderName, useWorkspaceStore } from "../../store/workspaceStore";
import { useProblemsStore } from "../../store/problemsStore";
import { getSetting } from "../../store/settingsStore";
import { json, text, toolError, type ToolResult } from "./backend";
import { latestSelection, selectionOf } from "./selection";
import { closeAllProposals, closeProposalTab, openProposal } from "./proposals";

/**
 * The MCP tools Claude Code calls, done against Sable's editor. Results
 * follow Anthropic's VS Code extension (the CLI parses some of them).
 */

type Monaco = typeof MonacoTypes;
let monaco: Monaco | null = null;

/** Monaco loaded (it loads with the first editor). */
export function setMonaco(instance: Monaco) {
  monaco = instance;
}

const isWindowsPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path);

/** An absolute path for what the CLI sent (absolute, file:// or relative to the workspace). */
export function resolvePath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("file://")) path = pathFromFileUri(path);
  if (path.startsWith("/") || isWindowsPath(path)) return path;
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return path;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${separator}${path.replace(/^\.[/\\]/, "")}`;
}

function pathFromFileUri(uri: string): string {
  let path = uri.replace(/^file:\/\//, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    /* not encoded */
  }
  // file:///C:/x → C:/x
  if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
  return path;
}

/** The URI form the CLI itself uses for diagnostics (`file://` + path). */
const diagnosticsUri = (path: string) => `file://${path}`;

const allTabs = (): { tab: EditorTab; groupIndex: number }[] =>
  useTabsStore.getState().groups.flatMap((group, groupIndex) => group.tabs.map((tab) => ({ tab, groupIndex })));

const isOpenFile = (path: string) => allTabs().some(({ tab }) => tab.kind === "file" && tab.path === path);

function languageOf(path: string): string {
  const extension = "." + (path.split(".").pop()?.toLowerCase() ?? "");
  return monaco?.languages.getLanguages().find((language) => language.extensions?.includes(extension))?.id ?? "plaintext";
}

/** Wait for the focused editor to show `path` (opening is asynchronous). */
async function editorShowing(path: string): Promise<MonacoTypes.editor.ICodeEditor | null> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const editor = getEditor();
    const model = editor?.getModel();
    if (editor && model && model.uri.scheme === "file" && pathFromUri(model.uri) === path) return editor;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function openFile(args: Record<string, unknown>): Promise<ToolResult> {
  const path = resolvePath(String(args.filePath ?? ""));
  if (!path) return toolError("openFile needs a filePath");
  const makeFrontmost = args.makeFrontmost !== false;
  if (!makeFrontmost) {
    // The CLI asks this before editing a file: say what it is, without
    // pulling it in front of what you're doing.
    const contents = await readFile(path).catch(() => null);
    if (contents === null) return json({ success: false, message: `File not found: ${path}` });
    return json({ success: true, filePath: path, languageId: languageOf(path), lineCount: contents.split("\n").length });
  }
  await useTabsStore.getState().openFile(path);
  if (!isOpenFile(path)) return toolError(`Couldn't open ${path}`);
  const startText = typeof args.startText === "string" ? args.startText : "";
  const endText = typeof args.endText === "string" ? args.endText : "";
  const editor = await editorShowing(path);
  const model = editor?.getModel();
  if (editor && model && startText) {
    const value = model.getValue();
    const startOffset = value.indexOf(startText);
    if (startOffset !== -1) {
      let endOffset = startOffset + startText.length;
      if (endText) {
        const found = value.indexOf(endText, endOffset);
        if (found !== -1) endOffset = found + endText.length;
      }
      const start = model.getPositionAt(startOffset);
      let end = model.getPositionAt(endOffset);
      if (args.selectToEndOfLine === true) end = { lineNumber: end.lineNumber, column: model.getLineMaxColumn(end.lineNumber) } as typeof end;
      const range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
    }
  }
  editor?.focus();
  return text(`Opened file: ${path}`);
}

function currentSelection(): ToolResult {
  const payload = selectionOf(getEditor());
  if (!payload) return json({ success: false, message: "No active editor found" });
  return json({ success: true, ...payload });
}

function latestSelectionResult(): ToolResult {
  const payload = latestSelection() ?? selectionOf(getEditor());
  if (!payload) return json({ success: false, message: "No selection available" });
  return json({ success: true, ...payload });
}

function openEditors(): ToolResult {
  const { groups, activeGroupId } = useTabsStore.getState();
  const tabs = groups.flatMap((group, groupIndex) =>
    group.tabs
      .filter((tab) => tab.kind === "file")
      .map((tab) => ({
        uri: `file://${tab.path}`,
        isActive: group.id === activeGroupId && group.activePath === tab.path,
        isPinned: false,
        isPreview: false,
        isDirty: tab.isDirty,
        label: tab.name,
        groupIndex,
        viewColumn: groupIndex + 1,
        isGroupActive: group.id === activeGroupId,
        fileName: tab.path,
        languageId: languageOf(tab.path),
        isUntitled: false,
      })),
  );
  return json({ tabs });
}

function workspaceFolders(): ToolResult {
  const { folders, rootPath } = useWorkspaceStore.getState();
  return json({
    success: true,
    folders: folders.map((path, index) => ({ name: folderName(path), uri: `file://${path}`, path, index })),
    rootPath: rootPath ?? "",
  });
}

const SEVERITY: Record<number, string> = { 8: "Error", 4: "Warning", 2: "Info", 1: "Hint" };

interface Diagnostic {
  message: string;
  severity: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  source?: string;
  code?: string;
}

/** Open files: their live markers (language servers and Monaco's own);
 *  other files: what language servers reported (Problems). */
function diagnostics(args: Record<string, unknown>): ToolResult {
  const wanted = typeof args.uri === "string" && args.uri ? resolvePath(args.uri) : null;
  const byPath = new Map<string, Diagnostic[]>();
  for (const marker of monaco?.editor.getModelMarkers({}) ?? []) {
    if (marker.resource.scheme !== "file" || marker.owner === "spell") continue;
    const path = pathFromUri(marker.resource);
    if (wanted && path !== wanted) continue;
    const list = byPath.get(path) ?? [];
    list.push({
      message: marker.message,
      severity: SEVERITY[marker.severity] ?? "Info",
      range: {
        start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
        end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
      },
      source: marker.source,
      code: marker.code === undefined ? undefined : typeof marker.code === "string" ? marker.code : marker.code.value,
    });
    byPath.set(path, list);
  }
  const modelPaths = new Set((monaco?.editor.getModels() ?? []).filter((model) => model.uri.scheme === "file").map((model) => pathFromUri(model.uri)));
  for (const [path, problems] of Object.entries(useProblemsStore.getState().lspByPath)) {
    if (modelPaths.has(path) || (wanted && path !== wanted)) continue;
    byPath.set(
      path,
      problems.map((problem) => {
        const position = { line: problem.line - 1, character: problem.column - 1 };
        return {
          message: problem.message,
          severity: problem.severity === "error" ? "Error" : problem.severity === "warning" ? "Warning" : "Info",
          range: { start: position, end: position },
          source: problem.source,
          code: problem.code,
        };
      }),
    );
  }
  if (wanted && !byPath.has(wanted)) byPath.set(wanted, []);
  return json([...byPath].map(([path, list]) => ({ uri: diagnosticsUri(path), diagnostics: list })));
}

function documentDirty(args: Record<string, unknown>): ToolResult {
  const path = resolvePath(String(args.filePath ?? ""));
  if (!isOpenFile(path)) return json({ success: false, message: `Document not open: ${path}` });
  return json({ success: true, filePath: path, isDirty: isModelDirty(path), isUntitled: false });
}

async function saveDocument(args: Record<string, unknown>): Promise<ToolResult> {
  const path = resolvePath(String(args.filePath ?? ""));
  if (!isOpenFile(path)) return json({ success: false, message: `Document not open: ${path}` });
  await useTabsStore.getState().saveTab(path);
  const saved = !isModelDirty(path);
  return json({ success: saved, filePath: path, saved, message: saved ? "Document saved successfully" : "Document could not be saved" });
}

/** Run one tool call. */
export async function runTool(id: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (tool) {
    case "openFile":
      return openFile(args);
    case "openDiff":
      if (!getSetting("claudeCode.reviewDiffs")) {
        return toolError("Diff review is turned off in Sable (Settings → Claude Code). Approve the change in the Claude Code terminal.");
      }
      return openProposal(id, args);
    case "getCurrentSelection":
      return currentSelection();
    case "getLatestSelection":
      return latestSelectionResult();
    case "getOpenEditors":
      return openEditors();
    case "getWorkspaceFolders":
      return workspaceFolders();
    case "getDiagnostics":
      return diagnostics(args);
    case "checkDocumentDirty":
      return documentDirty(args);
    case "saveDocument":
      return saveDocument(args);
    case "close_tab":
      closeProposalTab(String(args.tab_name ?? ""));
      return text("TAB_CLOSED");
    case "closeAllDiffTabs":
      return text(`CLOSED_${closeAllProposals()}_DIFF_TABS`);
    default:
      return toolError(`Sable doesn't offer ${tool}`);
  }
}
