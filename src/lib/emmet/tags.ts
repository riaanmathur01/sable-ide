/**
 * A forgiving HTML/XML/JSX tag scanner for Emmet's structural commands
 * (Balance, Go to Matching Pair, Remove Tag, Update Tag). It doesn't
 * build a DOM — it pairs opening and closing tags, skipping comments,
 * CDATA, <script>/<style> bodies, quoted attribute values and JSX
 * `{expressions}`. Offsets are 0-based into the text. Pure.
 */

export interface Span {
  start: number;
  end: number;
}

export interface Element {
  name: string;
  /** The opening tag, `<div class="a">` (or the whole `<br/>`). */
  open: Span;
  /** The closing tag, `</div>`; null for self-closing, void or unclosed tags. */
  close: Span | null;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/** The end of a tag starting at `start` (just past `>`), honouring quotes and braces. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'" || (char === "`" && depth > 0)) {
      const close = text.indexOf(char, index + 1);
      if (close === -1) return text.length;
      index = close;
    } else if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === ">" && depth === 0) return index + 1;
  }
  return text.length;
}

/** Every element in `text`, in document order of their opening tags. */
export function parseElements(text: string, { html = true } = {}): Element[] {
  const elements: Element[] = [];
  const open: Element[] = [];
  let index = 0;
  while (index < text.length) {
    const next = text.indexOf("<", index);
    if (next === -1) break;
    index = next;
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text[index + 1] === "!" || text[index + 1] === "?") {
      index = tagEnd(text, index + 1);
      continue;
    }
    const closing = text[index + 1] === "/";
    const nameMatch = /^[A-Za-z][\w:.-]*/.exec(text.slice(index + (closing ? 2 : 1), index + 200));
    // `a < b`, `</>` fragments and the like aren't tags (JSX fragments `<>` are skipped too).
    if (!nameMatch) {
      index++;
      continue;
    }
    const name = nameMatch[0];
    const end = tagEnd(text, index + 1);
    const span = { start: index, end };
    if (closing) {
      // Close the nearest open element of that name (anything left open inside it stays unclosed).
      for (let depth = open.length - 1; depth >= 0; depth--) {
        if (open[depth].name === name || (html && open[depth].name.toLowerCase() === name.toLowerCase())) {
          open[depth].close = span;
          open.length = depth;
          break;
        }
      }
      index = end;
      continue;
    }
    const element: Element = { name, open: span, close: null };
    elements.push(element);
    const selfClosing = text[end - 2] === "/" || (html && VOID_ELEMENTS.has(name.toLowerCase()));
    if (!selfClosing) {
      open.push(element);
      // Raw text: skip to the closing tag.
      if (html && RAW_TEXT.has(name.toLowerCase())) {
        const closeAt = text.toLowerCase().indexOf(`</${name.toLowerCase()}`, end);
        index = closeAt === -1 ? text.length : closeAt;
        continue;
      }
    }
    index = end;
  }
  return elements;
}

/** The element's whole extent: opening tag to closing tag. */
export const outerSpan = (element: Element): Span => ({ start: element.open.start, end: element.close?.end ?? element.open.end });
/** What's between its tags (null for a self-closing tag). */
export const innerSpan = (element: Element): Span | null =>
  element.close ? { start: element.open.end, end: element.close.start } : null;

const contains = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end;
const same = (a: Span, b: Span) => a.start === b.start && a.end === b.end;
const size = (span: Span) => span.end - span.start;

/** Balance outward: the smallest tag content or whole element around the selection. */
export function balanceOutward(elements: Element[], selection: Span): Span | null {
  let best: Span | null = null;
  for (const element of elements) {
    for (const span of [innerSpan(element), outerSpan(element)]) {
      if (!span || !contains(span, selection) || same(span, selection)) continue;
      if (!best || size(span) < size(best)) best = span;
    }
  }
  return best;
}

/** Balance inward: from an element to its content, from content to its first child element. */
export function balanceInward(elements: Element[], selection: Span): Span | null {
  if (selection.start === selection.end) return balanceOutward(elements, selection);
  const selected = elements.find((element) => same(outerSpan(element), selection));
  const inner = selected && innerSpan(selected);
  if (inner && size(inner) > 0 && !same(inner, selection)) return inner;
  // The first element inside the selection.
  const child = elements.find((element) => contains(selection, outerSpan(element)) && !same(outerSpan(element), selection));
  return child ? outerSpan(child) : null;
}

/** The innermost element whose extent holds `offset`. */
export function elementAt(elements: Element[], offset: number): Element | null {
  let best: Element | null = null;
  for (const element of elements) {
    const span = outerSpan(element);
    if (span.start <= offset && offset <= span.end && (!best || size(span) < size(outerSpan(best)))) best = element;
  }
  return best;
}

/** Go to Matching Pair: from inside an opening tag to its closing tag, and back. */
export function matchingPair(elements: Element[], offset: number): number | null {
  for (const element of elements) {
    if (!element.close) continue;
    if (element.open.start <= offset && offset < element.open.end) return element.close.start + 1;
    if (element.close.start <= offset && offset < element.close.end) return element.open.start + 1;
  }
  return null;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** A tag's span widened to whole lines when it's alone on its line(s). */
function wholeLines(text: string, span: Span): Span {
  const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", span.end);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  if (text.slice(lineStart, span.start).trim() || text.slice(span.end, lineEnd).trim()) return span;
  return { start: lineStart, end: lineEndIndex === -1 ? lineEnd : lineEnd + 1 };
}

/** Remove Tag: the element's tags go, its content stays. */
export function removeTagEdits(text: string, element: Element): TextEdit[] {
  const edits: TextEdit[] = [];
  if (element.close) edits.push({ ...wholeLines(text, element.close), text: "" });
  edits.push({ ...wholeLines(text, element.open), text: "" });
  return edits;
}

/** Update Tag: rename the element in both its tags. */
export function updateTagEdits(element: Element, name: string): TextEdit[] {
  const edits: TextEdit[] = [{ start: element.open.start + 1, end: element.open.start + 1 + element.name.length, text: name }];
  if (element.close) edits.push({ start: element.close.start + 2, end: element.close.start + 2 + element.name.length, text: name });
  return edits;
}
