import type * as MonacoTypes from "monaco-editor";
import { parseConflicts, resolvedLines, type Conflict, type Resolution } from "./conflicts";
import { pathFromUri } from "../editorRegistry";
import { useTabsStore } from "../../store/tabsStore";
import "./conflicts.css";

/**
 * Conflict markers in any editor: the two sides tinted, and "Accept
 * Current | Accept Incoming | Accept Both | Merge Tool" above each
 * conflict. The merge tool's result pane is an ordinary editor on the
 * file, so it gets these too.
 */

type Monaco = typeof MonacoTypes;
type Model = MonacoTypes.editor.ITextModel;

/** Each model's conflicts (only models that have any). */
const conflictsByModel = new Map<string, Conflict[]>();

/** The conflicts in a model, as last parsed. */
export function conflictsIn(model: Model): Conflict[] {
  return conflictsByModel.get(model.uri.toString()) ?? [];
}

/** Replace one conflict (found by its first line) with a resolution. */
export function resolveConflict(model: Model, startLine: number, resolution: Resolution) {
  const conflict = parseConflicts(model.getLinesContent()).find((candidate) => candidate.startLine === startLine);
  if (!conflict) return;
  const eol = model.getEOL();
  const lines = resolvedLines(conflict, resolution);
  const last = model.getLineCount();
  // Replace whole lines, markers included (and the line break after them).
  const range =
    conflict.endLine < last
      ? { startLineNumber: conflict.startLine, startColumn: 1, endLineNumber: conflict.endLine + 1, endColumn: 1 }
      : conflict.startLine > 1
        ? {
            startLineNumber: conflict.startLine - 1,
            startColumn: model.getLineMaxColumn(conflict.startLine - 1),
            endLineNumber: last,
            endColumn: model.getLineMaxColumn(last),
          }
        : { startLineNumber: 1, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) };
  const text =
    conflict.endLine < last
      ? lines.map((line) => line + eol).join("")
      : conflict.startLine > 1
        ? lines.map((line) => eol + line).join("")
        : lines.join(eol);
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text }], () => null);
  model.pushStackElement();
}

export function registerConflictSupport(monaco: Monaco) {
  const changed = new monaco.Emitter<MonacoTypes.languages.CodeLensProvider>();

  const decorationsByModel = new Map<string, string[]>();
  const refresh = (model: Model) => {
    const key = model.uri.toString();
    const conflicts = model.getValue().includes("<<<<<<<") ? parseConflicts(model.getLinesContent()) : [];
    const hadConflicts = conflictsByModel.has(key);
    if (conflicts.length) conflictsByModel.set(key, conflicts);
    else conflictsByModel.delete(key);
    if (!conflicts.length && !hadConflicts) return;
    const whole = (from: number, to: number, className: string): MonacoTypes.editor.IModelDeltaDecoration[] =>
      to < from
        ? []
        : [
            {
              range: { startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: 1 },
              options: {
                isWholeLine: true,
                className,
                overviewRuler: { color: className.includes("ours") ? "#3fb95066" : "#4f8fe666", position: 4 },
              },
            },
          ];
    const decorations = conflicts.flatMap((conflict) => {
      const oursEnd = (conflict.baseLine ?? conflict.separatorLine) - 1;
      return [
        ...whole(conflict.startLine, conflict.startLine, "conflict-marker conflict-marker-ours"),
        ...whole(conflict.startLine + 1, oursEnd, "conflict-ours"),
        ...(conflict.baseLine !== null
          ? [
              ...whole(conflict.baseLine, conflict.baseLine, "conflict-marker"),
              ...whole(conflict.baseLine + 1, conflict.separatorLine - 1, "conflict-base"),
            ]
          : []),
        ...whole(conflict.separatorLine, conflict.separatorLine, "conflict-marker"),
        ...whole(conflict.separatorLine + 1, conflict.endLine - 1, "conflict-theirs"),
        ...whole(conflict.endLine, conflict.endLine, "conflict-marker conflict-marker-theirs"),
      ];
    });
    decorationsByModel.set(key, model.deltaDecorations(decorationsByModel.get(key) ?? [], decorations));
    changed.fire(provider);
  };

  const watch = (model: Model) => {
    if (model.uri.scheme !== "file") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    refresh(model);
    const listener = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => !model.isDisposed() && refresh(model), 120);
    });
    model.onWillDispose(() => {
      clearTimeout(timer);
      listener.dispose();
      conflictsByModel.delete(model.uri.toString());
      decorationsByModel.delete(model.uri.toString());
    });
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);

  monaco.editor.registerCommand("sable.conflict.resolve", (_accessor, uri: string, startLine: number, resolution: Resolution) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) resolveConflict(model, startLine, resolution);
  });
  monaco.editor.registerCommand("sable.conflict.openMergeTool", (_accessor, uri: string) => {
    useTabsStore.getState().openMerge(pathFromUri(monaco.Uri.parse(uri)));
  });

  const provider: MonacoTypes.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses: (model) => {
      const lenses = conflictsIn(model).flatMap((conflict) => {
        const range = {
          startLineNumber: conflict.startLine,
          startColumn: 1,
          endLineNumber: conflict.startLine,
          endColumn: 1,
        };
        const uri = model.uri.toString();
        const lens = (title: string, tooltip: string, resolution: Resolution) => ({
          range,
          command: { id: "sable.conflict.resolve", title, tooltip, arguments: [uri, conflict.startLine, resolution] },
        });
        return [
          lens("Accept Current", `Keep ${conflict.oursLabel || "your side"}`, "ours"),
          lens("Accept Incoming", `Take ${conflict.theirsLabel || "the incoming side"}`, "theirs"),
          lens("Accept Both", "Keep both, current first", "both"),
          {
            range,
            command: { id: "sable.conflict.openMergeTool", title: "Merge Tool", tooltip: "Resolve side by side", arguments: [uri] },
          },
        ];
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("*", provider);
}
