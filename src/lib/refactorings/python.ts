import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { invoke } from "../backend";
import { parentDirectoryOf } from "../ipc";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { folderOf, useWorkspaceStore } from "../../store/workspaceStore";
import { currentText } from "./apply";
import { newParamId } from "./signature";
import type { PlannedFile, RefactoringPlan, Signature, UsageItem } from "./types";

/**
 * Python's deeper refactorings through Rope (`python_rope_refactor`,
 * src-tauri/src/commands/refactor_deep.rs): usages for Safe Delete, the
 * signature for the Change Signature dialog, and each refactoring's
 * changes — whole new file contents, turned into a plan here.
 */

interface RopeReply {
  files?: { path: string; contents: string }[];
  creates?: string[];
  moves?: { from: string; to: string }[];
  conflicts?: string[];
  usages?: UsageItem[];
  symbol?: { name: string; kind: string; path: string; line: number; endLine?: number; function?: string };
}

export interface RopeSignature {
  name: string;
  params: { name: string; annotation: string | null; default: string | null; kind: string }[];
  returnType: string | null;
  implicit?: string;
  kind: string;
  path: string;
  line: number;
}

function projectRoot(path: string): string {
  return folderOf(path) ?? useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(path);
}

/** Run one Rope request (offering to install Rope if it's missing). */
async function rope<T = RopeReply>(
  path: string,
  kind: string,
  position: { lineNumber: number; column: number } | null,
  options: Record<string, unknown> = {},
  /** Offer to install Rope if it's missing (not for a background check). */
  offerInstall = true,
): Promise<T> {
  const root = projectRoot(path);
  // Rope reads the files on disk: save what's being edited in the project.
  await useTabsStore.getState().saveTabsUnder(root);
  const python = useInterpreterStore.getState().selectedPath ?? null;
  const request = () =>
    invoke<T>("python_rope_refactor", {
      python,
      root,
      request: { file: path, kind, position: position ? [position.lineNumber, position.column] : null, options },
    });
  try {
    return await request();
  } catch (error) {
    if (String(error) !== "rope-missing") throw error;
    if (!offerInstall) throw new Error("Rope isn't installed");
    const install = await confirmNative(
      "Python refactoring uses Rope, a small Python library. Install it into Sable's tools folder now?",
      { title: "Install Rope", kind: "info" },
    );
    if (!install) throw new Error("Rope isn't installed");
    useUiStore.getState().showStatus("Installing Rope…");
    await invoke("install_rope", { python });
    return request();
  }
}

/** Turn Rope's whole-file results into a plan (with each file's current text). */
async function toPlan(title: string, reply: RopeReply, reveal?: RefactoringPlan["reveal"]): Promise<RefactoringPlan> {
  const created = new Set(reply.creates ?? []);
  const files: PlannedFile[] = [];
  for (const file of reply.files ?? []) {
    files.push({ path: file.path, before: created.has(file.path) ? null : await currentText(file.path), after: file.contents });
  }
  return { title, files, moves: reply.moves ?? [], conflicts: reply.conflicts ?? [], engine: "Rope", reveal };
}

export async function pythonUsages(path: string, position: { lineNumber: number; column: number }) {
  const reply = await rope(path, "usages", position);
  return { symbol: reply.symbol!, usages: reply.usages ?? [] };
}

export async function pythonModuleUsages(path: string) {
  const reply = await rope(path, "module_usages", null);
  return reply.usages ?? [];
}

export async function pythonSafeDeletePlan(path: string, position: { lineNumber: number; column: number }, what: string) {
  return toPlan(`Safe Delete ${what}`, await rope(path, "safe_delete", position));
}

export async function pythonSignature(path: string, position: { lineNumber: number; column: number }): Promise<Signature & { path: string }> {
  const info = await rope<RopeSignature>(path, "signature", position);
  return {
    name: info.name,
    params: info.params.map((param, index) => ({
      id: newParamId(),
      name: param.name,
      type: param.annotation ?? "",
      defaultValue: param.default ?? "",
      value: "",
      original: index,
      kind: param.kind as Signature["params"][number]["kind"],
    })),
    returnType: info.returnType ?? "",
    implicit: info.implicit,
    language: "python",
    kind: info.kind,
    path: info.path,
  };
}

export async function pythonChangeSignaturePlan(
  path: string,
  position: { lineNumber: number; column: number },
  original: Signature,
  signature: Signature,
): Promise<RefactoringPlan> {
  const reply = await rope(path, "change_signature", position, {
    name: signature.name,
    params: signature.params.map((param) => ({
      name: param.name,
      annotation: param.type.trim() || null,
      default: param.defaultValue.trim() || null,
      value: param.value.trim() || null,
      original: param.original,
      kind: param.kind,
    })),
    returnType: (signature.returnType ?? "").trim() || null,
  });
  return toPlan(`Change Signature of ${original.name}`, reply);
}

export async function pythonMovePlan(path: string, position: { lineNumber: number; column: number }, what: string, target: string) {
  const reply = await rope(path, "move", position, { target });
  const moved = reply.files?.find((file) => file.path === target);
  const line = moved ? Math.max(1, moved.contents.split("\n").findIndex((text) => /^(async\s+def|def|class)\s|^[A-Za-z_]\w*\s*[:=]/.test(text)) + 1) : 1;
  return toPlan(`Move ${what} to ${target.split(/[/\\]/).pop()}`, reply, { path: target, line });
}

export async function pythonMoveModulePlan(path: string, target: string) {
  // (Every rename in the Explorer asks: don't offer an install each time.)
  const reply = await rope(path, "move_module", null, { target }, false);
  const from = path.split(/[/\\]/).pop();
  const to = target.split(/[/\\]/).pop();
  return toPlan(from === to ? `Move ${from}` : `Rename ${from} to ${to}`, reply);
}
