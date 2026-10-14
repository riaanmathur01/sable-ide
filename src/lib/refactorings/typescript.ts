import type * as TS from "typescript";
import { getModelValue } from "../editorRegistry";
import { listWorkspaceFiles, parentDirectoryOf, readFile } from "../ipc";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { createTsProject, type TsProject, type TsResult } from "./tsEngine";
import type { PlannedFile, RefactoringPlan } from "./types";

/**
 * The TypeScript project the TS/JS refactorings run on: the workspace's
 * TypeScript and JavaScript files (open editors' text where open), in a
 * TypeScript language service on the TypeScript Monaco bundles — so they
 * work with or without typescript-language-server.
 */

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const SKIPPED = /[/\\](node_modules|\.git|dist|build|out|coverage|\.next|target)[/\\]/;
const MAX_FILES = 4000;

let typescript: Promise<typeof TS> | null = null;

/** Monaco's TypeScript, loaded on first use (it's large). */
export function loadTypeScript(): Promise<typeof TS> {
  typescript ??= import("monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js").then(
    (module) => module.typescript as unknown as typeof TS,
  );
  return typescript;
}

export function isScript(path: string): boolean {
  return SCRIPT.test(path);
}

/** A fresh project over the workspace (files change between refactorings). */
export async function openTsProject(also: string[] = []): Promise<TsProject> {
  const ui = useUiStore.getState();
  const { folders, rootPath } = useWorkspaceStore.getState();
  const roots = folders.length > 0 ? folders : rootPath ? [rootPath] : also.map(parentDirectoryOf);
  ui.showStatus("Reading the TypeScript project…");
  const [ts, listed] = await Promise.all([
    loadTypeScript(),
    Promise.all(roots.map((root) => listWorkspaceFiles(root).catch(() => [] as string[]))),
  ]);
  const paths = [...new Set([...also, ...listed.flat().filter((path) => SCRIPT.test(path) && !SKIPPED.test(path))])].slice(0, MAX_FILES);
  const files = new Map<string, string>();
  for (let index = 0; index < paths.length; index += 32) {
    const batch = paths.slice(index, index + 32);
    const texts = await Promise.all(batch.map((path) => Promise.resolve(getModelValue(path) ?? readFile(path)).catch(() => null)));
    batch.forEach((path, i) => {
      if (texts[i] !== null) files.set(path, texts[i]!);
    });
  }
  return createTsProject(ts, files, roots[0] ?? "/");
}

/** A TypeScript result as a plan. */
export function tsPlan(project: TsProject, title: string, result: TsResult, extra: Partial<RefactoringPlan> = {}): RefactoringPlan {
  const files: PlannedFile[] = [...result.changes].map(([fileName, after]) => ({
    path: project.toPath(fileName),
    before: project.files.get(fileName) ?? null,
    after,
  }));
  return { title, files, moves: [], conflicts: result.conflicts, engine: "TypeScript", ...extra };
}
