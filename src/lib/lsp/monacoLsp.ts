import type * as MonacoTypes from "monaco-editor";
import { changeDocument, pathToUri, sendRequest } from "./lspClient";

/**
 * Hand-wired Monaco language providers backed by the LSP relay. Each
 * provider turns a Monaco request into an LSP request through Rust,
 * awaits the response, and maps the result into Monaco's shape.
 *
 * Registered once from monacoSetup. Phase 6c wires completions; hover
 * follows in 6d.
 */

type Monaco = typeof MonacoTypes;

/** Minimal shape of an LSP CompletionItem (only the fields we use). */
interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
  textEdit?: { newText: string };
}

interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

/**
 * LSP CompletionItemKind (1–25) → Monaco's CompletionItemKind. The two
 * enums use different numeric values, so map by name.
 */
function lspKindToMonaco(
  monaco: Monaco,
  kind: number | undefined,
): MonacoTypes.languages.CompletionItemKind {
  const Kind = monaco.languages.CompletionItemKind;
  const byLspKind: Record<number, MonacoTypes.languages.CompletionItemKind> = {
    1: Kind.Text,
    2: Kind.Method,
    3: Kind.Function,
    4: Kind.Constructor,
    5: Kind.Field,
    6: Kind.Variable,
    7: Kind.Class,
    8: Kind.Interface,
    9: Kind.Module,
    10: Kind.Property,
    11: Kind.Unit,
    12: Kind.Value,
    13: Kind.Enum,
    14: Kind.Keyword,
    15: Kind.Snippet,
    16: Kind.Color,
    17: Kind.File,
    18: Kind.Reference,
    19: Kind.Folder,
    20: Kind.EnumMember,
    21: Kind.Constant,
    22: Kind.Struct,
    23: Kind.Event,
    24: Kind.Operator,
    25: Kind.TypeParameter,
  };
  return kind != null ? (byLspKind[kind] ?? Kind.Text) : Kind.Text;
}

/** LSP Hover contents can take several shapes; normalize to Monaco. */
type LspMarkedString = string | { language: string; value: string };
interface LspHover {
  contents:
    | { kind: string; value: string } // MarkupContent
    | LspMarkedString
    | LspMarkedString[];
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** One LSP hover content piece → a Monaco markdown string. */
function markedStringToMarkdown(
  content: LspMarkedString | { kind: string; value: string },
): { value: string } {
  if (typeof content === "string") return { value: content };
  // MarkupContent ({kind, value}) is already markdown/plaintext text.
  if ("kind" in content) return { value: content.value };
  // MarkedString ({language, value}) → a fenced code block.
  return { value: "```" + content.language + "\n" + content.value + "\n```" };
}

export function registerLspProviders(monaco: Monaco): void {
  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position) {
      const path = model.uri.path;
      await changeDocument(path, model.getValue());

      const hover = (await sendRequest("textDocument/hover", {
        textDocument: { uri: pathToUri(path) },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      })) as LspHover | null;

      if (!hover || !hover.contents) return null;

      const pieces = Array.isArray(hover.contents)
        ? hover.contents
        : [hover.contents];
      const contents = pieces
        .map(markedStringToMarkdown)
        .filter((piece) => piece.value.trim().length > 0);
      if (contents.length === 0) return null;

      // Optional range highlights the hovered symbol (LSP 0-based → Monaco).
      const range = hover.range
        ? {
            startLineNumber: hover.range.start.line + 1,
            startColumn: hover.range.start.character + 1,
            endLineNumber: hover.range.end.line + 1,
            endColumn: hover.range.end.character + 1,
          }
        : undefined;

      return { contents, range };
    },
  });

  monaco.languages.registerCompletionItemProvider("python", {
    // Re-query on "." (member access) in addition to identifier typing.
    triggerCharacters: ["."],

    async provideCompletionItems(model, position) {
      // model.uri.path is the absolute path we opened the file with.
      const path = model.uri.path;

      // Make sure the server's buffer matches the screen before asking —
      // otherwise `os.` completes against a stale document. Awaiting this
      // guarantees the didChange reaches the server before the request.
      await changeDocument(path, model.getValue());

      const response = (await sendRequest("textDocument/completion", {
        textDocument: { uri: pathToUri(path) },
        position: {
          line: position.lineNumber - 1, // LSP is 0-based
          character: position.column - 1,
        },
      })) as LspCompletionItem[] | LspCompletionList | null;

      if (!response) return { suggestions: [] };
      const items = Array.isArray(response) ? response : response.items;
      const isIncomplete = Array.isArray(response)
        ? false
        : (response.isIncomplete ?? false);

      // Replace the identifier fragment under the cursor.
      const word = model.getWordUntilPosition(position);
      const range: MonacoTypes.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = items.map((item) => {
        const insertText =
          item.insertText ?? item.textEdit?.newText ?? item.label;
        let documentation: string | { value: string } | undefined;
        if (typeof item.documentation === "string") {
          documentation = item.documentation;
        } else if (item.documentation?.value) {
          // MarkupContent → Monaco markdown string.
          documentation = { value: item.documentation.value };
        }
        return {
          label: item.label,
          kind: lspKindToMonaco(monaco, item.kind),
          insertText,
          detail: item.detail,
          documentation,
          sortText: item.sortText,
          filterText: item.filterText,
          range,
        };
      });

      return { suggestions, incomplete: isIncomplete };
    },
  });
}
