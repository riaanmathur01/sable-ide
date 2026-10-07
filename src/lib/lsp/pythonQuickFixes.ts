import type * as MonacoTypes from "monaco-editor";
import { lspSetPythonPath, runShell } from "../ipc";
import { pathFromUri } from "../editorRegistry";
import { pathToUri, sendRequest } from "./lspClient";
import { applyWorkspaceEdit } from "./workspaceEdit";
import {
  KNOWN_IMPORTS,
  addImportEdit,
  importStatement,
  pipPackageFor,
  removeUnusedImportEdits,
  unaccessedName,
  undefinedName,
  unresolvedModule,
  type TextEdit,
} from "./pythonFixes";
import { useInterpreterStore } from "../../store/interpreterStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";

/**
 * Python quick fixes (lightbulb / ⌘.). Pyright reports problems but offers
 * almost no fixes, so Sable builds them from its diagnostics:
 *   - "X is not defined"         → Import X (Pyright's auto-import, plus
 *                                  a table of common names it misses)
 *   - "Import X could not be resolved" → Install X with pip (into the
 *                                  selected interpreter), then re-analyze
 *   - "X is not accessed" on an import → Remove unused import(s)
 *   - any Pyright error/warning  → Ignore on this line
 *                                  (`# pyright: ignore[rule]`)
 */

type Monaco = typeof MonacoTypes;

const APPLY_EDITS = "sable.python.applyEdits";
const PIP_INSTALL = "sable.python.pipInstall";

interface LspCompletionItem {
  label: string;
  detail?: string;
  labelDetails?: { description?: string };
  additionalTextEdits?: TextEdit[];
}

/** Pyright's auto-import suggestions for `name`, each with its edit.
 *  Cached per document version (Monaco asks again on every cursor move). */
const autoImportCache = new Map<string, Promise<{ module: string; edits: TextEdit[] }[]>>();

function autoImports(
  model: MonacoTypes.editor.ITextModel,
  path: string,
  name: string,
  position: { line: number; character: number },
) {
  const key = `${path}@${model.getVersionId()}:${name}`;
  let cached = autoImportCache.get(key);
  if (!cached) {
    if (autoImportCache.size > 50) autoImportCache.clear();
    cached = (async () => {
      const response = (await sendRequest("py", "textDocument/completion", {
        textDocument: { uri: pathToUri(path) },
        position,
        context: { triggerKind: 1 },
      })) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
      const items = (Array.isArray(response) ? response : (response?.items ?? []))
        .filter((item) => item.label === name && item.detail === "Auto-import")
        .slice(0, 4);
      const resolved = await Promise.all(
        items.map(async (item) => {
          // Pyright fills in the import edit on resolve.
          const full = ((await sendRequest("py", "completionItem/resolve", item)) ??
            item) as LspCompletionItem;
          return {
            module: item.labelDetails?.description ?? "",
            edits: full.additionalTextEdits ?? item.additionalTextEdits ?? [],
          };
        }),
      );
      return resolved.filter((candidate) => candidate.edits.length > 0);
    })();
    autoImportCache.set(key, cached);
  }
  return cached;
}

function isPyrightMarker(marker: MonacoTypes.editor.IMarkerData): boolean {
  return (marker.source ?? "").toLowerCase().includes("pyright");
}

function editAction(
  title: string,
  path: string,
  edits: TextEdit[],
  options: { kind?: string; preferred?: boolean; markers?: MonacoTypes.editor.IMarkerData[] } = {},
): MonacoTypes.languages.CodeAction {
  return {
    title,
    kind: options.kind ?? "quickfix",
    isPreferred: options.preferred,
    diagnostics: options.markers,
    command: { id: APPLY_EDITS, title, arguments: [path, edits] },
  };
}

/** Unused-import hints anywhere in the model, grouped by line. */
function unusedImportsByLine(monaco: Monaco, model: MonacoTypes.editor.ITextModel) {
  const byLine = new Map<number, string[]>();
  for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
    const name = unaccessedName(marker.message);
    if (!name || !marker.tags?.includes(monaco.MarkerTag.Unnecessary)) continue;
    const line = marker.startLineNumber - 1;
    if (!/^\s*(from\s+[\w.]+\s+)?import\s/.test(model.getLineContent(line + 1))) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), name]);
  }
  return byLine;
}

async function provideActions(
  monaco: Monaco,
  model: MonacoTypes.editor.ITextModel,
  context: MonacoTypes.languages.CodeActionContext,
): Promise<MonacoTypes.languages.CodeAction[]> {
  if (context.only && !"quickfix".startsWith(context.only) && !context.only.startsWith("source")) {
    return [];
  }
  const path = pathFromUri(model.uri);
  const text = model.getValue();
  const actions: MonacoTypes.languages.CodeAction[] = [];

  for (const marker of context.markers) {
    // --- Missing name → import it -----------------------------------------
    const missing = undefinedName(marker.message);
    if (missing) {
      const seen = new Set<string>();
      const candidates = await autoImports(model, path, missing, {
        line: marker.endLineNumber - 1,
        character: marker.endColumn - 1,
      });
      for (const candidate of candidates) {
        seen.add(candidate.module);
        actions.push(
          editAction(`Import "${missing}" from ${candidate.module}`, path, candidate.edits, {
            preferred: actions.length === 0,
            markers: [marker],
          }),
        );
      }
      const known = KNOWN_IMPORTS[missing];
      if (known && !seen.has(known.module)) {
        actions.push(
          editAction(importStatement(known), path, [addImportEdit(text, known)], {
            preferred: actions.length === 0,
            markers: [marker],
          }),
        );
      }
    }

    // --- Unresolved import → pip install ----------------------------------
    const module = unresolvedModule(marker.message);
    if (module) {
      const pkg = pipPackageFor(module);
      actions.push({
        title: `Install "${pkg}" with pip`,
        kind: "quickfix",
        isPreferred: true,
        diagnostics: [marker],
        command: { id: PIP_INSTALL, title: `Install ${pkg}`, arguments: [pkg] },
      });
    }

    // --- Unused import → remove ---------------------------------------------
    const unused = unaccessedName(marker.message);
    if (unused && marker.tags?.includes(monaco.MarkerTag.Unnecessary)) {
      const line = marker.startLineNumber - 1;
      const edits = removeUnusedImportEdits(text, new Map([[line, [unused]]]));
      if (edits.length > 0) {
        actions.push(
          editAction(`Remove unused import "${unused}"`, path, edits, { markers: [marker] }),
        );
        const all = unusedImportsByLine(monaco, model);
        const total = [...all.values()].reduce((sum, names) => sum + names.length, 0);
        if (total > 1) {
          actions.push(
            editAction(
              `Remove all ${total} unused imports`,
              path,
              removeUnusedImportEdits(text, all),
            ),
          );
        }
      }
    }

    // --- Any Pyright error/warning → ignore on this line --------------------
    if (isPyrightMarker(marker) && marker.severity >= monaco.MarkerSeverity.Warning) {
      const lineNumber = marker.startLineNumber;
      const content = model.getLineContent(lineNumber);
      if (!/#\s*(type|pyright):\s*ignore/.test(content)) {
        // Pyright puts the rule name in `code`; ignoring just that rule
        // keeps other problems on the line visible.
        const rule = typeof marker.code === "string" ? marker.code : marker.code?.value;
        const comment = rule ? `# pyright: ignore[${rule}]` : "# type: ignore";
        actions.push(
          editAction(
            `Ignore this problem (${comment})`,
            path,
            [
              {
                range: {
                  start: { line: lineNumber - 1, character: content.length },
                  end: { line: lineNumber - 1, character: content.length },
                },
                newText: `  ${comment}`,
              },
            ],
            { markers: [marker] },
          ),
        );
      }
    }
  }

  // De-duplicate by title (several markers can yield the same action).
  const byTitle = new Map(actions.map((action) => [action.title, action]));
  return [...byTitle.values()];
}

/** pip-install into the selected interpreter, then make Pyright re-scan. */
async function pipInstall(pkg: string) {
  const ui = useUiStore.getState();
  const python = useInterpreterStore.getState().selectedPath ?? "python3";
  const root = useWorkspaceStore.getState().rootPath ?? ".";
  ui.showStatus(`Installing ${pkg}…`);
  try {
    const result = await runShell(
      `"${python}" -m pip install --disable-pip-version-check ${pkg}`,
      root,
      600,
    );
    if (result.exitCode === 0) {
      ui.showStatus(`Installed ${pkg}`);
      // Pyright doesn't watch site-packages; re-sending the interpreter
      // makes it re-resolve imports.
      await lspSetPythonPath(python);
    } else if (result.stderr.includes("externally-managed-environment")) {
      ui.setLastError(
        `${python} won't accept packages (system/Homebrew Python). Create a virtual environment from the interpreter picker, select it, and try again.`,
      );
    } else {
      ui.setLastError(`pip install ${pkg} failed: ${result.stderr.trim().split("\n").pop() ?? ""}`);
    }
  } catch (error) {
    ui.setLastError(String(error));
  }
}

export function registerPythonQuickFixes(monaco: Monaco): void {
  monaco.editor.registerCommand(APPLY_EDITS, (_accessor, path: string, edits: TextEdit[]) => {
    void applyWorkspaceEdit({ changes: { [pathToUri(path)]: edits } }).catch((error) =>
      useUiStore.getState().setLastError(String(error)),
    );
  });
  monaco.editor.registerCommand(PIP_INSTALL, (_accessor, pkg: string) => void pipInstall(pkg));

  monaco.languages.registerCodeActionProvider(
    "python",
    {
      provideCodeActions: async (model, _range, context) => ({
        actions: await provideActions(monaco, model, context),
        dispose: () => {},
      }),
    },
    { providedCodeActionKinds: ["quickfix"] },
  );
}
