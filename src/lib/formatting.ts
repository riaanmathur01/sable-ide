import type * as MonacoTypes from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { pathFromUri } from "./editorRegistry";
import { capabilitiesOf, changeDocument, extensionOf, pathToUri, sendRequestWithError, serverIdFor } from "./lsp/lspClient";
import { useInterpreterStore } from "../store/interpreterStore";
import { useUiStore } from "../store/uiStore";

/**
 * Format Document / format on save for languages Monaco can't format
 * itself:
 *   - Go, Rust, C/C++ and Java through their language servers (gofmt,
 *     rustfmt, clang-format, Eclipse's formatter);
 *   - Python through Ruff (or Black) — Pyright doesn't format.
 * TypeScript/JavaScript, JSON, CSS and HTML use Monaco's built-in
 * formatters.
 */

type Monaco = typeof MonacoTypes;

/** Languages formatted by their language server. */
const SERVER_FORMATTED = ["go", "rust", "c", "cpp", "java", "php", "ruby", "csharp", "kotlin"];

interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

function toMonacoEdits(edits: LspTextEdit[]): MonacoTypes.languages.TextEdit[] {
  return edits.map((edit) => ({
    range: {
      startLineNumber: edit.range.start.line + 1,
      startColumn: edit.range.start.character + 1,
      endLineNumber: edit.range.end.line + 1,
      endColumn: edit.range.end.character + 1,
    },
    text: edit.newText,
  }));
}

/** Formatting failures are worth a status message, not an error dialog —
 *  the usual cause is code that doesn't parse yet. */
function reportFailure(message: string) {
  useUiStore.getState().showStatus(`Couldn't format: ${message}`);
}

async function lspFormat(
  model: MonacoTypes.editor.ITextModel,
  options: MonacoTypes.languages.FormattingOptions,
  range?: MonacoTypes.IRange,
): Promise<MonacoTypes.languages.TextEdit[]> {
  const path = pathFromUri(model.uri);
  const serverId = serverIdFor(path);
  const capabilities = serverId ? capabilitiesOf(serverId) : null;
  const capability = range ? "documentRangeFormattingProvider" : "documentFormattingProvider";
  if (!capabilities?.[capability]) return [];
  await changeDocument(path, model.getValue());
  const response = await sendRequestWithError(
    extensionOf(path),
    range ? "textDocument/rangeFormatting" : "textDocument/formatting",
    {
      textDocument: { uri: pathToUri(path) },
      options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      ...(range && {
        range: {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
        },
      }),
    },
    15_000,
  );
  if (response.error) {
    reportFailure(response.error);
    return [];
  }
  return toMonacoEdits((response.result as LspTextEdit[] | null) ?? []);
}

// --- Python -------------------------------------------------------------------------

interface Formatter {
  name: string;
  program: string;
  args: string[];
}

/** The formatter for each interpreter (looked up once). */
const pythonFormatters = new Map<string, Promise<Formatter | null>>();
let warnedNoFormatter = false;

function pythonFormatter(): Promise<Formatter | null> {
  const python = useInterpreterStore.getState().selectedPath ?? "";
  if (!pythonFormatters.has(python)) {
    pythonFormatters.set(python, invoke<Formatter | null>("python_formatter", { python: python || null }));
  }
  return pythonFormatters.get(python)!;
}

/** Download Ruff into Sable's tools folder (command palette). */
export async function installRuff(): Promise<void> {
  const ui = useUiStore.getState();
  ui.showStatus("Installing Ruff…");
  try {
    await invoke("install_ruff");
    pythonFormatters.clear();
    ui.showStatus("Ruff installed — Python files now format (Format Document, format on save)");
  } catch (error) {
    ui.setLastError(String(error));
  }
}

async function pythonFormat(model: MonacoTypes.editor.ITextModel): Promise<MonacoTypes.languages.TextEdit[]> {
  const formatter = await pythonFormatter();
  if (!formatter) {
    if (!warnedNoFormatter) {
      warnedNoFormatter = true;
      useUiStore
        .getState()
        .showStatus("No Python formatter found — run “Python: Install Ruff (formatter)” from the command palette");
    }
    return [];
  }
  const text = model.getValue();
  try {
    const formatted = await invoke<string>("format_with", { formatter, path: pathFromUri(model.uri), text });
    if (formatted === text || model.isDisposed()) return [];
    return [{ range: model.getFullModelRange(), text: formatted }];
  } catch (error) {
    reportFailure(String(error));
    return [];
  }
}

export function registerFormatting(monaco: Monaco) {
  for (const language of SERVER_FORMATTED) {
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: "Language server",
      provideDocumentFormattingEdits: (model, options) => lspFormat(model, options),
    });
    monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
      displayName: "Language server",
      provideDocumentRangeFormattingEdits: (model, range, options) => lspFormat(model, options, range),
    });
  }
  monaco.languages.registerDocumentFormattingEditProvider("python", {
    displayName: "Ruff",
    provideDocumentFormattingEdits: (model) => pythonFormat(model),
  });
  // A new interpreter may bring its own Ruff/Black.
  useInterpreterStore.subscribe((state, previous) => {
    if (state.selectedPath !== previous.selectedPath) pythonFormatters.clear();
  });
}
