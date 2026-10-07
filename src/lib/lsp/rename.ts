import type * as MonacoTypes from "monaco-editor";
import { pathFromUri } from "../editorRegistry";
import { scopesForLines } from "../shikiMonaco";
import { identifierOccurrences, isCodeScope, isKeywordScope, scopesAt } from "./renameInFile";
import { useUiStore } from "../../store/uiStore";
import {
  capabilitiesOf,
  extensionOf,
  pathToUri,
  sendRequestWithError,
  serverIdFor,
} from "./lspClient";
import { applyWorkspaceEdit, type LspTextEdit, type LspWorkspaceEdit } from "./workspaceEdit";

/**
 * Rename (F2, or Shift+F6 as in JetBrains IDEs).
 *
 * With a language server, the rename is the server's: every reference in
 * the project, and the file too when a Java class is renamed. Monaco's
 * own rename can only edit open files, so Sable applies the server's
 * WorkspaceEdit itself (open files as one undoable edit, the rest on
 * disk) and hands Monaco an empty result.
 *
 * Languages without a server (or whose server isn't installed) get an
 * in-file rename of the identifier's occurrences in code — never inside
 * strings or comments, judged by the TextMate grammar's scopes.
 * CSS, SCSS, Less, HTML and (without its server) TypeScript use Monaco's
 * built-in rename.
 */

type Monaco = typeof MonacoTypes;

/** Languages whose rename comes from Monaco's own language services. */
const BUILTIN_RENAME = new Set(["css", "scss", "less", "html", "typescript", "javascript"]);

/** Prose and data: nothing to rename. */
const NOT_CODE = new Set(["plaintext", "markdown", "json", "jsonc"]);

/** Renames can touch many files; give the server time. */
const RENAME_TIMEOUT_MS = 30_000;

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function toMonacoRange(range: LspRange): MonacoTypes.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** The running server for a file, if it can rename. */
function renameServer(path: string): string | null {
  const serverId = serverIdFor(path);
  return serverId && capabilitiesOf(serverId)?.renameProvider ? serverId : null;
}

/** "3 occurrences in 2 files" for the status bar. */
export function describeEdit(edit: LspWorkspaceEdit): string {
  const perFile: LspTextEdit[][] = edit.documentChanges
    ? edit.documentChanges.flatMap((change) => ("edits" in change ? [change.edits] : []))
    : Object.values(edit.changes ?? {});
  const occurrences = perFile.reduce((total, edits) => total + edits.length, 0);
  const files = perFile.filter((edits) => edits.length > 0).length;
  const moved = (edit.documentChanges ?? []).filter((change) => "kind" in change && change.kind === "rename").length;
  const parts = [`${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`];
  if (moved > 0) parts.push(`${moved} file${moved === 1 ? "" : "s"} renamed`);
  return parts.join(", ");
}

function lspRenameProvider(): MonacoTypes.languages.RenameProvider {
  return {
    async resolveRenameLocation(model, position) {
      const path = pathFromUri(model.uri);
      const serverId = renameServer(path);
      // No server: let the next provider (built-in or in-file) try.
      if (!serverId) return null;
      const word = model.getWordAtPosition(position);
      const supportsPrepare = Boolean(capabilitiesOf(serverId)?.renameProvider?.prepareProvider);
      if (!supportsPrepare) {
        if (!word) return { rejectReason: "Nothing to rename here", range: emptyRange(position), text: "" };
        return {
          range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn },
          text: word.word,
        };
      }
      const response = await sendRequestWithError(extensionOf(path), "textDocument/prepareRename", {
        textDocument: { uri: pathToUri(path) },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      });
      if (response.error) return { rejectReason: response.error, range: emptyRange(position), text: "" };
      const result = response.result as LspRange | { range: LspRange; placeholder: string } | { defaultBehavior: boolean } | null;
      if (!result) return { rejectReason: "This element can't be renamed", range: emptyRange(position), text: "" };
      if ("defaultBehavior" in result) {
        if (!word) return { rejectReason: "Nothing to rename here", range: emptyRange(position), text: "" };
        return {
          range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn },
          text: word.word,
        };
      }
      const range = "range" in result ? result.range : result;
      const monacoRange = toMonacoRange(range);
      return { range: monacoRange, text: "placeholder" in result ? result.placeholder : model.getValueInRange(monacoRange) };
    },

    async provideRenameEdits(model, position, newName) {
      const path = pathFromUri(model.uri);
      if (!renameServer(path)) return null;
      const response = await sendRequestWithError(
        extensionOf(path),
        "textDocument/rename",
        {
          textDocument: { uri: pathToUri(path) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
          newName,
        },
        RENAME_TIMEOUT_MS,
      );
      // Monaco reports edit-stage failures through a notification service
      // the standalone editor doesn't show, so report them here too.
      const fail = (reason: string) => {
        useUiStore.getState().setLastError(reason);
        return { edits: [], rejectReason: reason };
      };
      if (response.error) return fail(`Rename failed: ${response.error}`);
      const edit = response.result as LspWorkspaceEdit | null;
      if (!edit || (!edit.changes && !edit.documentChanges)) return fail("Nothing was renamed");
      try {
        await applyWorkspaceEdit(edit);
        useUiStore.getState().showStatus(`Renamed to ${newName}: ${describeEdit(edit)}`);
      } catch (error) {
        return fail(`Rename failed: ${String(error)}`);
      }
      return { edits: [] };
    },
  };
}

function emptyRange(position: MonacoTypes.IPosition): MonacoTypes.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

function inFileRenameProvider(languageName: (id: string) => string): MonacoTypes.languages.RenameProvider {
  return {
    resolveRenameLocation(model, position) {
      // A language server (or Monaco's built-in service) does it better.
      if (renameServer(pathFromUri(model.uri))) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return { rejectReason: "Nothing to rename here", range: emptyRange(position), text: "" };
      const scopes = scopesForLines(model.getLanguageId(), [model.getLineContent(position.lineNumber)]);
      const here = scopes ? scopesAt(scopes[0], word.startColumn - 1) : null;
      if (here && isKeywordScope(here)) {
        return { rejectReason: `“${word.word}” is a keyword`, range: emptyRange(position), text: "" };
      }
      if (here && !isCodeScope(here)) {
        return { rejectReason: "Only code can be renamed — this is inside a string or comment", range: emptyRange(position), text: "" };
      }
      return {
        range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn },
        text: word.word,
      };
    },

    provideRenameEdits(model, position, newName) {
      const word = model.getWordAtPosition(position);
      if (!word) return { edits: [], rejectReason: "Nothing to rename here" };
      const lines = model.getLinesContent();
      const occurrences = identifierOccurrences(lines, scopesForLines(model.getLanguageId(), lines), word.word);
      const versionId = model.getVersionId();
      const name = languageName(model.getLanguageId());
      useUiStore
        .getState()
        .showStatus(
          `Renamed ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} in this file — no ${name} language server for a project-wide rename`,
        );
      return {
        edits: occurrences.map((occurrence) => ({
          resource: model.uri,
          versionId,
          textEdit: {
            range: {
              startLineNumber: occurrence.line + 1,
              startColumn: occurrence.start + 1,
              endLineNumber: occurrence.line + 1,
              endColumn: occurrence.end + 1,
            },
            text: newName,
          },
        })),
      };
    },
  };
}

/**
 * Register rename for every language. `lspLanguages` have servers; the
 * in-file fallback is registered first so the server provider (newer
 * registrations are asked first) wins whenever its server is running.
 */
export function registerRename(monaco: Monaco, lspLanguages: readonly string[]) {
  const names = new Map(monaco.languages.getLanguages().map((language) => [language.id, language.aliases?.[0] ?? language.id]));
  const fallback = inFileRenameProvider((id) => names.get(id) ?? id);
  for (const id of names.keys()) {
    if (NOT_CODE.has(id)) continue;
    if (BUILTIN_RENAME.has(id) && !lspLanguages.includes(id)) continue;
    if (id === "typescript" || id === "javascript") continue; // built-in when the server is off
    monaco.languages.registerRenameProvider(id, fallback);
  }
  const lsp = lspRenameProvider();
  for (const language of lspLanguages) monaco.languages.registerRenameProvider(language, lsp);
  // JetBrains' rename shortcut, alongside F2.
  monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyMod.Shift | monaco.KeyCode.F6,
    command: "editor.action.rename",
    when: "editorHasRenameProvider && editorTextFocus && !editorReadonly",
  });
}
