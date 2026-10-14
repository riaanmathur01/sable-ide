import type * as MonacoTypes from "monaco-editor";
import { getSetting } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { getEditor } from "../editorRegistry";
import { scopeTokenizer } from "../shikiMonaco";
import { emmetSyntaxAt, hostKind, type EmmetSyntax } from "./context";
import { abbreviationBefore, expandToSnippet, isMarkupAbbreviation, snippetPreview } from "./expand";
import {
  balanceInward,
  balanceOutward,
  elementAt,
  matchingPair,
  parseElements,
  removeTagEdits,
  updateTagEdits,
  type Span,
  type TextEdit,
} from "./tags";

/**
 * Emmet in Monaco, built directly on the `emmet` library:
 *   - an "Emmet Abbreviation" item in the suggestion list while you type
 *     one, with a preview of what it expands to;
 *   - Tab expands the abbreviation before the cursor (when no suggestion,
 *     snippet or inline completion is showing), its tab stops becoming
 *     snippet placeholders;
 *   - Wrap with Abbreviation, Balance outward/inward, Remove Tag, Update
 *     Tag and Go to Matching Pair (palette and editor actions).
 *
 * (`emmet-monaco-es` decides where Emmet applies from Monaco's own token
 * types, which Sable replaces with TextMate's — so it can't tell JSX from
 * JavaScript here. The TextMate scopes can: see context.ts.)
 */

type Monaco = typeof MonacoTypes;
type Editor = MonacoTypes.editor.ICodeEditor;
type Model = MonacoTypes.editor.ITextModel;

/** Lines tokenized before the cursor to learn its scope (enough to be in the right block). */
const SCOPE_LOOKBACK_LINES = 300;
/** Text before the abbreviation given to the context check. */
const TEXT_LOOKBACK = 4000;

const LANGUAGES = [
  "html", "xml", "xsl", "css", "scss", "less", "sass", "typescript", "javascript", "javascriptreact",
  "typescriptreact", "php", "handlebars", "razor", "vue", "svelte", "plaintext",
];

function modelPath(model: Model): string {
  return model.uri.path;
}

/** The TextMate scopes of the character before `column` (1-based) on a line. */
function scopesAt(model: Model, lineNumber: number, column: number): string[] | null {
  const tokenize = scopeTokenizer(model.getLanguageId());
  if (!tokenize) return null;
  let tokens: ReturnType<typeof tokenize> = [];
  for (let line = Math.max(1, lineNumber - SCOPE_LOOKBACK_LINES); line <= lineNumber; line++) {
    tokens = tokenize(model.getLineContent(line));
  }
  const offset = Math.max(0, column - 2);
  const token = tokens.find((candidate) => candidate.start <= offset && offset < candidate.end) ?? tokens[tokens.length - 1];
  return token?.scopes ?? [];
}

export interface AbbreviationAtCursor {
  abbreviation: string;
  range: MonacoTypes.IRange;
  syntax: EmmetSyntax;
  snippet: string;
}

/** The abbreviation before the cursor, if Emmet applies there. */
export function abbreviationAt(model: Model, position: MonacoTypes.IPosition): AbbreviationAtCursor | null {
  const path = modelPath(model);
  const host = hostKind(model.getLanguageId(), path);
  if (!host) return null;
  const line = model.getLineContent(position.lineNumber);
  const stylesheetHost = host === "css" || host === "scss" || host === "less" || host === "sass";
  let found = abbreviationBefore(line, position.column - 1, stylesheetHost ? "stylesheet" : "markup");
  if (!found) return null;
  // Cheap checks first: most words typed aren't abbreviations.
  if (!stylesheetHost && !isMarkupAbbreviation(found.abbreviation, { type: "markup", syntax: host === "jsx" ? "jsx" : "html" })) {
    // (Embedded CSS is still possible: `m10` in a <style>.)
    if (host === "jsx" || !expandToSnippet(found.abbreviation, { type: "stylesheet", syntax: "css" })) return null;
  }
  const abbreviationStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: found.start + 1 });
  const textBefore = model.getValueInRange(
    monacoRange(model.getPositionAt(Math.max(0, abbreviationStart - TEXT_LOOKBACK)), model.getPositionAt(abbreviationStart)),
  );
  const syntax = emmetSyntaxAt({
    languageId: model.getLanguageId(),
    path,
    scopes: scopesAt(model, position.lineNumber, position.column),
    textBefore,
    abbreviation: found.abbreviation,
  });
  if (!syntax) return null;
  if (syntax.type === "stylesheet" && !stylesheetHost) {
    found = abbreviationBefore(line, position.column - 1, "stylesheet");
    if (!found) return null;
  }
  const snippet = expandToSnippet(found.abbreviation, syntax);
  if (!snippet) return null;
  return {
    abbreviation: found.abbreviation,
    range: { startLineNumber: position.lineNumber, startColumn: found.start + 1, endLineNumber: position.lineNumber, endColumn: found.end + 1 },
    syntax,
    snippet,
  };
}

function monacoRange(start: MonacoTypes.IPosition, end: MonacoTypes.IPosition): MonacoTypes.IRange {
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
}

interface SnippetController {
  insert(template: string, options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): void;
}

/** Replace `range` with a snippet (placeholders and all). */
function insertSnippet(editor: Editor, range: MonacoTypes.IRange, snippet: string) {
  const controller = editor.getContribution<SnippetController & MonacoTypes.editor.IEditorContribution>("snippetController2");
  editor.setSelection(range);
  if (controller) controller.insert(snippet);
  else editor.executeEdits("emmet", [{ range, text: snippetPreview(snippet) }]);
}

/** Tab: expand the abbreviation before the cursor; otherwise an ordinary Tab. */
function expandOrTab(editor: Editor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  const found =
    model && position && getSetting("emmet.enabled") && getSetting("emmet.triggerOnTab") && editor.getSelections()?.length === 1
      ? abbreviationAt(model, position)
      : null;
  if (!found) {
    editor.trigger("keyboard", "tab", null);
    return;
  }
  editor.pushUndoStop();
  insertSnippet(editor, found.range, found.snippet);
}

// --- Structural commands -----------------------------------------------------------------------

function markupEditor(): { editor: Editor; model: Model; text: string } | null {
  const editor = getEditor();
  const model = editor?.getModel();
  if (!editor || !model) return null;
  editor.focus();
  return { editor, model, text: model.getValue() };
}

const isHtmlLike = (model: Model) => hostKind(model.getLanguageId(), modelPath(model)) !== "xml";

function selectionSpan(editor: Editor, model: Model): Span {
  const selection = editor.getSelection()!;
  return { start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()) };
}

function selectSpan(editor: Editor, model: Model, span: Span) {
  const start = model.getPositionAt(span.start);
  const end = model.getPositionAt(span.end);
  editor.setSelection({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column });
  editor.revealRangeInCenterIfOutsideViewport(editor.getSelection()!);
}

/** Selections balance outward pushed, so inward walks back the same way. */
const balanceHistory = new WeakMap<Model, Span[]>();

export function balance(direction: "outward" | "inward"): void {
  const target = markupEditor();
  if (!target) return;
  const { editor, model, text } = target;
  const elements = parseElements(text, { html: isHtmlLike(model) });
  const current = selectionSpan(editor, model);
  const history = balanceHistory.get(model) ?? [];
  if (direction === "outward") {
    const span = balanceOutward(elements, current);
    if (!span) return;
    balanceHistory.set(model, [...history, current]);
    selectSpan(editor, model, span);
    return;
  }
  // Back the way balance outward came, while the selection is still its.
  const previous = history[history.length - 1];
  const inside = previous && previous.start >= current.start && previous.end <= current.end;
  if (inside && (previous.start !== current.start || previous.end !== current.end)) {
    history.pop();
    selectSpan(editor, model, previous);
    return;
  }
  const span = balanceInward(elements, current);
  if (span) selectSpan(editor, model, span);
}

export function goToMatchingPair(): void {
  const target = markupEditor();
  if (!target) return;
  const { editor, model, text } = target;
  const offset = model.getOffsetAt(editor.getPosition()!);
  const destination = matchingPair(parseElements(text, { html: isHtmlLike(model) }), offset);
  if (destination === null) return;
  const position = model.getPositionAt(destination);
  editor.setPosition(position);
  editor.revealPositionInCenterIfOutsideViewport(position);
}

function applyEdits(editor: Editor, model: Model, edits: TextEdit[], source: string) {
  editor.pushUndoStop();
  editor.executeEdits(
    source,
    edits.map((edit) => ({ range: monacoRange(model.getPositionAt(edit.start), model.getPositionAt(edit.end)), text: edit.text })),
  );
  editor.pushUndoStop();
}

export function removeTag(): void {
  const target = markupEditor();
  if (!target) return;
  const { editor, model, text } = target;
  const element = elementAt(parseElements(text, { html: isHtmlLike(model) }), model.getOffsetAt(editor.getPosition()!));
  if (element) applyEdits(editor, model, removeTagEdits(text, element), "emmet.removeTag");
}

export async function updateTag(): Promise<void> {
  const target = markupEditor();
  if (!target) return;
  const { editor, model, text } = target;
  const element = elementAt(parseElements(text, { html: isHtmlLike(model) }), model.getOffsetAt(editor.getPosition()!));
  if (!element) return;
  const name = await useUiStore.getState().openPickOrText([], "Enter the new tag name", "Rename the tag to <%s>", element.name);
  editor.focus();
  if (typeof name !== "string" || !/^[A-Za-z][\w:.-]*$/.test(name.trim())) return;
  applyEdits(editor, model, updateTagEdits(element, name.trim()), "emmet.updateTag");
}

/** Wrap the selection (or the element at the cursor, or the line) with an abbreviation. */
export async function wrapWithAbbreviation(): Promise<void> {
  const target = markupEditor();
  if (!target) return;
  const { editor, model, text } = target;
  const host = hostKind(model.getLanguageId(), modelPath(model)) ?? "html";
  const syntax: EmmetSyntax = { type: "markup", syntax: host === "jsx" ? "jsx" : host === "xml" ? "xml" : "html" };
  let span = selectionSpan(editor, model);
  if (span.start === span.end) {
    const element = elementAt(parseElements(text, { html: host !== "xml" }), span.start);
    if (element) span = { start: element.open.start, end: element.close?.end ?? element.open.end };
    else {
      const line = editor.getPosition()!.lineNumber;
      span = {
        start: model.getOffsetAt({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 }),
        end: model.getOffsetAt({ lineNumber: line, column: model.getLineLastNonWhitespaceColumn(line) || 1 }),
      };
    }
  }
  const abbreviation = await useUiStore.getState().openPickOrText([], "Enter an abbreviation to wrap with (e.g. div.card>p)", "Wrap with %s");
  editor.focus();
  if (typeof abbreviation !== "string" || !abbreviation.trim()) return;
  // The selected lines, without their common indentation (Emmet re-indents them).
  const lines = text.slice(span.start, span.end).split(/\r?\n/);
  const indent = Math.min(...lines.slice(1).filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length), Infinity);
  const content = lines.map((line, index) => (index > 0 && Number.isFinite(indent) ? line.slice(indent) : line));
  const snippet = expandToSnippet(abbreviation.trim(), syntax, content);
  if (!snippet) {
    useUiStore.getState().setLastError(`Not an Emmet abbreviation: ${abbreviation}`);
    return;
  }
  editor.pushUndoStop();
  insertSnippet(editor, monacoRange(model.getPositionAt(span.start), model.getPositionAt(span.end)), snippet);
}

// --- Wiring ----------------------------------------------------------------------------------------------

const EXPAND_COMMAND = "sable.emmet.expandAbbreviation";

/** VS Code's ids, so keybindings.json entries carry over. */
export const EMMET_ACTIONS: { id: string; label: string; run: () => unknown }[] = [
  { id: "editor.emmet.action.wrapWithAbbreviation", label: "Emmet: Wrap with Abbreviation", run: wrapWithAbbreviation },
  { id: "editor.emmet.action.balanceOut", label: "Emmet: Balance (outward)", run: () => balance("outward") },
  { id: "editor.emmet.action.balanceIn", label: "Emmet: Balance (inward)", run: () => balance("inward") },
  { id: "editor.emmet.action.matchTag", label: "Emmet: Go to Matching Pair", run: goToMatchingPair },
  { id: "editor.emmet.action.removeTag", label: "Emmet: Remove Tag", run: removeTag },
  { id: "editor.emmet.action.updateTag", label: "Emmet: Update Tag", run: updateTag },
];

export function registerEmmet(monaco: Monaco): void {
  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      // Operators start new parts of an abbreviation (`ul>`, `.card`, `*3`).
      triggerCharacters: [">", "+", "*", ".", "#", "]", ")", "}", "^"],
      provideCompletionItems: (model, position) => {
        if (!getSetting("emmet.enabled")) return { suggestions: [] };
        const found = abbreviationAt(model, position);
        if (!found) return { suggestions: [] };
        const preview = snippetPreview(found.snippet);
        const fence = found.syntax.type === "stylesheet" ? found.syntax.syntax : found.syntax.syntax === "jsx" ? "tsx" : found.syntax.syntax;
        return {
          suggestions: [
            {
              label: { label: found.abbreviation, description: "Emmet" },
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: "Emmet Abbreviation",
              documentation: { value: "```" + fence + "\n" + preview + "\n```" },
              insertText: found.snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range: found.range,
              filterText: found.abbreviation,
              // Above the word-based suggestions for the same text.
              sortText: `\u0000${found.abbreviation}`,
            },
          ],
        };
      },
    });
  }

  monaco.editor.addCommand({
    id: EXPAND_COMMAND,
    run: () => {
      const editor = monaco.editor.getEditors().find((candidate) => candidate.hasTextFocus());
      if (editor) expandOrTab(editor);
    },
  });
  monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyCode.Tab,
    command: EXPAND_COMMAND,
    when:
      "editorTextFocus && !editorReadonly && !editorHasSelection && !editorHasMultipleSelections && !suggestWidgetVisible && " +
      "!inSnippetMode && !inlineSuggestionVisible && !editorTabMovesFocus && !parameterHintsVisible",
  });

  for (const action of EMMET_ACTIONS) {
    monaco.editor.addEditorAction({ id: action.id, label: action.label, run: () => void action.run() });
  }
}
