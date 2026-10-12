import type * as MonacoTypes from "monaco-editor";
import { toHex } from "./colors";
import { colorSlotAt, colorsOnLine, type ColorSlot } from "./slots";
import { useColorPickerStore } from "../../store/colorPickerStore";
import { getEditor } from "../editorRegistry";

/**
 * Colors in the editor, in every language:
 *  - "Pick a Color…" / "Change Color…" in the light bulb (⌘.) wherever a
 *    color goes (lib/colorPicker/slots.ts);
 *  - a swatch before each color written in the code; clicking it opens
 *    the same picker.
 * The picker shows its color in the code as you pick, and Escape puts
 * back what was there (one undo step either way).
 */

type Monaco = typeof MonacoTypes;
type Editor = MonacoTypes.editor.ICodeEditor;

const MAX_LINES = 20_000;

/** Open the picker for `slot` on `lineNumber`. */
export function openColorPicker(editor: Editor, lineNumber: number, slot: ColorSlot): void {
  const model = editor.getModel();
  const dom = editor.getDomNode();
  if (!model || !dom) return;
  const position = editor.getScrolledVisiblePosition({ lineNumber, column: slot.start });
  const box = dom.getBoundingClientRect();
  const original = model.getValueInRange({ startLineNumber: lineNumber, startColumn: slot.start, endLineNumber: lineNumber, endColumn: slot.end });
  let end = slot.end;
  let changed = false;
  const write = (text: string) => {
    const shown = slot.quote ? `"${text}"` : text;
    editor.executeEdits("color-picker", [
      { range: { startLineNumber: lineNumber, startColumn: slot.start, endLineNumber: lineNumber, endColumn: end }, text: shown, forceMoveMarkers: true },
    ]);
    end = slot.start + shown.length;
    changed = true;
  };
  // The picker's edits are one undo step.
  editor.pushUndoStop();
  const documentColors = [...new Set(scanColors(model).map((found) => toHex(found.color)))].slice(0, 24);
  useColorPickerStore.getState().open({
    x: box.left + (position?.left ?? 0),
    y: box.top + (position?.top ?? 0),
    lineHeight: position?.height ?? 18,
    initial: slot.current,
    documentColors,
    preview: (text) => write(text),
    commit: (text) => {
      write(text);
      editor.setPosition({ lineNumber, column: end });
      editor.pushUndoStop();
      editor.focus();
    },
    cancel: () => {
      if (changed) {
        editor.executeEdits("color-picker", [
          { range: { startLineNumber: lineNumber, startColumn: slot.start, endLineNumber: lineNumber, endColumn: end }, text: original },
        ]);
      }
      editor.pushUndoStop();
      editor.focus();
    },
  });
}

/** Every color in a model, by line. */
function scanColors(model: MonacoTypes.editor.ITextModel) {
  const language = model.getLanguageId();
  const found: { line: number; start: number; end: number; color: ReturnType<typeof colorsOnLine>[number]["color"] }[] = [];
  const lines = Math.min(model.getLineCount(), MAX_LINES);
  for (let line = 1; line <= lines; line++) {
    const text = model.getLineContent(line);
    if (text.length > 2000) continue;
    for (const match of colorsOnLine(text, language)) found.push({ line, start: match.start, end: match.end, color: match.color });
  }
  return found;
}

// --- Swatches -----------------------------------------------------------------------

/** One CSS class per color shown as a swatch. */
const swatchClasses = new Map<string, string>();
let swatchStyle: HTMLStyleElement | null = null;
function swatchClass(hex: string): string {
  let name = swatchClasses.get(hex);
  if (!name) {
    name = `sable-swatch-${hex.slice(1)}`;
    swatchClasses.set(hex, name);
    swatchStyle ??= document.head.appendChild(document.createElement("style"));
    swatchStyle.sheet?.insertRule(`.monaco-editor .${name}::before { background: ${hex}; }`);
  }
  return name;
}

function decorate(editor: Editor, collection: MonacoTypes.editor.IEditorDecorationsCollection) {
  const model = editor.getModel();
  if (!model || model.uri.scheme === "sable-diff") return collection.clear();
  collection.set(
    scanColors(model).map((found) => ({
      range: { startLineNumber: found.line, startColumn: found.start, endLineNumber: found.line, endColumn: found.start },
      options: {
        before: {
          content: " ",
          inlineClassName: `sable-color-swatch ${swatchClass(toHex(found.color))}`,
          cursorStops: 0 as MonacoTypes.editor.InjectedTextCursorStops,
        },
        showIfCollapsed: true,
      },
    })),
  );
}

export function registerEditorColors(monaco: Monaco): void {
  const style = document.createElement("style");
  style.textContent = `
.monaco-editor .sable-color-swatch { display: inline-block; position: relative; width: 0.8em; margin: 0 0.25em 0 0.05em; cursor: pointer; }
.monaco-editor .sable-color-swatch::before {
  content: ""; position: absolute; left: 0; top: 50%; width: 0.75em; height: 0.75em; transform: translateY(-50%);
  border-radius: 2px; box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.55);
}`;
  document.head.appendChild(style);

  monaco.editor.registerCommand("sable.pickColor", (_accessor, lineNumber: number, slot: ColorSlot) => {
    const editor = getEditor();
    if (editor) openColorPicker(editor, lineNumber, slot);
  });

  monaco.languages.registerCodeActionProvider("*", {
    provideCodeActions: (model, range) => {
      const line = range.startLineNumber;
      const slot = colorSlotAt(model.getLineContent(line), range.startColumn, model.getLanguageId());
      if (!slot) return { actions: [], dispose() {} };
      const title = slot.current ? `Change Color… (${toHex(slot.current)})` : "Pick a Color…";
      return {
        actions: [{ title, kind: "quickfix", command: { id: "sable.pickColor", title, arguments: [line, slot] } }],
        dispose() {},
      };
    },
  });

  monaco.editor.onDidCreateEditor((editor) => {
    const collection = editor.createDecorationsCollection();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => decorate(editor, collection), 150);
    };
    editor.onDidChangeModel(schedule);
    editor.onDidChangeModelContent(schedule);
    editor.onDidChangeModelLanguage(schedule);
    schedule();
    // Clicking a swatch opens the picker for its color.
    editor.onMouseDown((event) => {
      const target = event.target;
      const element = event.event.target as HTMLElement | null;
      if (!element?.classList?.contains("sable-color-swatch") || !target.position) return;
      const model = editor.getModel();
      if (!model) return;
      const { lineNumber, column } = target.position;
      const slot = colorSlotAt(model.getLineContent(lineNumber), column, model.getLanguageId());
      if (!slot?.current) return;
      event.event.preventDefault();
      event.event.stopPropagation();
      openColorPicker(editor, lineNumber, slot);
    });
    editor.onDidDispose(() => clearTimeout(timer));
  });
}

/** Command Palette: "Pick a Color…" at the cursor, slot or not. */
export function pickColorAtCursor(): void {
  const editor = getEditor();
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!editor || !model || !position) return;
  const slot = colorSlotAt(model.getLineContent(position.lineNumber), position.column, model.getLanguageId()) ?? {
    start: position.column,
    end: position.column,
    current: null,
    quote: false,
  };
  openColorPicker(editor, position.lineNumber, slot);
}
