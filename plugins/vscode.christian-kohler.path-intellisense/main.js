// Converted from a VS Code extension by Sable (see README.md).
const __sableVscode = (() => {
// Sable's VS Code compatibility layer. A converted VS Code extension's
// main.js is this file, then the extension's own modules, then a call to
// __activate (see src-tauri/src/vscode.rs). It implements the commonly
// used parts of the `vscode` API on Sable's plugin API: commands, the
// active editor and its edits, messages, quick picks and input boxes, the
// status bar, configuration, workspace files, completions, hovers,
// formatters, diagnostics, code actions, code lenses, symbols, rename and
// the other language features, decorations, terminals, webview panels and
// views, tree views, the clipboard and extension state. What Sable has no
// equivalent for (debug adapters, notebooks, SCM providers) is accepted
// and ignored, with a note in the plugin's log, so an extension that
// touches it still loads.

let __sable = null;
let __extension = null;
let __context = null;
let __exports = null;
const __warned = new Set();
const __commands = new Map();

function __unsupported(what) {
  if (!__warned.has(what)) {
    __warned.add(what);
    console.warn(`${what} isn't supported in Sable — ignored.`);
  }
}

// --- Basics -------------------------------------------------------------------------

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }
  static from(...items) {
    return new Disposable(() => items.forEach((item) => item?.dispose?.()));
  }
  dispose() {
    const callback = this._callOnDispose;
    this._callOnDispose = undefined;
    if (typeof callback === "function") callback();
  }
}

const __noop = () => new Disposable(() => {});

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const entry = (value) => listener.call(thisArg, value);
      this._listeners.add(entry);
      const disposable = new Disposable(() => this._listeners.delete(entry));
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    };
  }
  fire(value) {
    for (const listener of [...this._listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: this._emitter.event };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose() {
    this._emitter.dispose();
  }
}

const __token = () => new CancellationTokenSource().token;

// --- Positions and ranges (0-based, as in VS Code) --------------------------------------

class Position {
  constructor(line, character) {
    this.line = Math.max(0, line | 0);
    this.character = Math.max(0, character | 0);
  }
  compareTo(other) {
    return this.line - other.line || this.character - other.character;
  }
  isBefore(other) {
    return this.compareTo(other) < 0;
  }
  isBeforeOrEqual(other) {
    return this.compareTo(other) <= 0;
  }
  isAfter(other) {
    return this.compareTo(other) > 0;
  }
  isAfterOrEqual(other) {
    return this.compareTo(other) >= 0;
  }
  isEqual(other) {
    return this.compareTo(other) === 0;
  }
  translate(lineDelta = 0, characterDelta = 0) {
    if (typeof lineDelta === "object") ({ lineDelta = 0, characterDelta = 0 } = lineDelta);
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character) {
    if (typeof line === "object") ({ line = this.line, character = this.character } = line);
    return new Position(line, character);
  }
}

class Range {
  constructor(a, b, c, d) {
    let start = typeof a === "number" ? new Position(a, b) : a;
    let end = typeof a === "number" ? new Position(c, d) : b;
    if (end.isBefore(start)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(value) {
    return value instanceof Range
      ? this.contains(value.start) && this.contains(value.end)
      : value.isAfterOrEqual(this.start) && value.isBeforeOrEqual(this.end);
  }
  isEqual(other) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other) {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other) {
    return new Range(this.start.isBefore(other.start) ? this.start : other.start, this.end.isAfter(other.end) ? this.end : other.end);
  }
  with(start = this.start, end = this.end) {
    if (start && !(start instanceof Position)) ({ start = this.start, end = this.end } = start);
    return new Range(start, end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    const anchor = typeof a === "number" ? new Position(a, b) : a;
    const active = typeof a === "number" ? new Position(c, d) : b;
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() {
    return this.active.isBefore(this.anchor);
  }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range, newText) {
    return new TextEdit(range, newText);
  }
  static insert(position, newText) {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range) {
    return new TextEdit(range, "");
  }
}

class Uri {
  constructor(scheme, authority, path, query, fragment) {
    this.scheme = scheme || "file";
    this.authority = authority || "";
    this.path = path || "";
    this.query = query || "";
    this.fragment = fragment || "";
  }
  static file(path) {
    return new Uri("file", "", String(path).replace(/\\/g, "/"));
  }
  static parse(value) {
    const match = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
    if (!match) return Uri.file(value);
    return new Uri(match[1], match[2], decodeURIComponent(match[3] || ""), match[4], match[5]);
  }
  static joinPath(base, ...parts) {
    return base.with({ path: __path.join(base.path, ...parts) });
  }
  static from(components) {
    return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment);
  }
  get fsPath() {
    return this.path;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString() {
    const authority = this.authority || this.scheme === "file" ? `//${this.authority}` : "";
    return `${this.scheme}:${authority}${encodeURI(this.path)}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
  }
  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

// Collapse doubled slashes (extensions build `${folder.path}/${relative}`
// from paths that already end in one), keeping a leading `//` (UNC).
const __pathOf = (value) =>
  String(value instanceof Uri ? value.fsPath : typeof value === "string" ? value : value?.uri?.fsPath ?? value?.fsPath ?? "").replace(/(?!^)\/{2,}/g, "/");

class WorkspaceEdit {
  constructor() {
    this._edits = new Map();
  }
  _list(uri) {
    const key = __pathOf(uri);
    if (!this._edits.has(key)) this._edits.set(key, { uri, edits: [] });
    return this._edits.get(key).edits;
  }
  replace(uri, range, newText) {
    this._list(uri).push(new TextEdit(range, newText));
  }
  insert(uri, position, newText) {
    this._list(uri).push(TextEdit.insert(position, newText));
  }
  delete(uri, range) {
    this._list(uri).push(TextEdit.delete(range));
  }
  set(uri, edits) {
    const list = this._list(uri);
    list.length = 0;
    list.push(...(edits || []).map((edit) => (Array.isArray(edit) ? edit[0] : edit)));
  }
  has(uri) {
    return this._edits.has(__pathOf(uri));
  }
  get(uri) {
    return this._edits.get(__pathOf(uri))?.edits ?? [];
  }
  entries() {
    return [...this._edits.values()].map(({ uri, edits }) => [uri, edits]);
  }
  get size() {
    return this._edits.size;
  }
  createFile() {
    __unsupported("WorkspaceEdit.createFile");
  }
  deleteFile() {
    __unsupported("WorkspaceEdit.deleteFile");
  }
  renameFile() {
    __unsupported("WorkspaceEdit.renameFile");
  }
}

// --- Values that providers return ----------------------------------------------------------

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8,
  Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
  Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24, User: 25, Issue: 26,
};
const __kindNames = {
  1: "method", 2: "function", 3: "function", 4: "field", 5: "variable", 6: "class", 7: "interface", 8: "module",
  9: "property", 11: "value", 13: "keyword", 14: "snippet", 15: "color", 16: "file", 20: "constant", 21: "class",
};
class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}
class CompletionList {
  constructor(items = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}
const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };

class SnippetString {
  constructor(value = "") {
    this.value = value;
  }
  appendText(text) {
    this.value += text.replace(/[$}\\]/g, "\\$&");
    return this;
  }
  appendTabstop(number = 0) {
    this.value += `$${number}`;
    return this;
  }
  appendPlaceholder(value, number = 1) {
    this.value += `\${${number}:${typeof value === "function" ? "" : value}}`;
    return this;
  }
  appendVariable(name, fallback = "") {
    this.value += `\${${name}:${fallback}}`;
    return this;
  }
}

class MarkdownString {
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = false;
  }
  appendText(text) {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }
  appendMarkdown(markdown) {
    this.value += markdown;
    return this;
  }
  appendCodeblock(code, language = "") {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

// A function, not a class: some extensions call it without `new` (Todo
// Tree, for highlights with no colours), which VS Code's older builds allowed.
function ThemeColor(id) {
  if (!new.target) return new ThemeColor(id);
  this.id = id;
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon("file");
ThemeIcon.Folder = new ThemeIcon("folder");

class CodeActionKind {
  constructor(value) {
    this.value = value;
  }
  append(part) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
}
for (const [name, value] of Object.entries({ Empty: "", QuickFix: "quickfix", Refactor: "refactor", Source: "source", SourceOrganizeImports: "source.organizeImports", SourceFixAll: "source.fixAll" })) {
  CodeActionKind[name] = new CodeActionKind(value);
}
class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
  }
}
class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
  }
}
class SymbolInformation {
  constructor(name, kind, containerName, location) {
    Object.assign(this, { name, kind, containerName, location });
  }
}
class DocumentHighlight {
  constructor(range, kind = 0) {
    this.range = range;
    this.kind = kind;
  }
}
class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}
class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}
class FoldingRange {
  constructor(start, end, kind) {
    Object.assign(this, { start, end, kind });
  }
}
class InlayHint {
  constructor(position, label, kind) {
    Object.assign(this, { position, label, kind });
  }
}
class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}
class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
  }
}
class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}
class Color {
  constructor(red, green, blue, alpha) {
    Object.assign(this, { red, green, blue, alpha });
  }
}
class ColorInformation {
  constructor(range, color) {
    Object.assign(this, { range, color });
  }
}
class ColorPresentation {
  constructor(label) {
    this.label = label;
  }
}
class SelectionRange {
  constructor(range, parent) {
    Object.assign(this, { range, parent });
  }
}
const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
  Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
  Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};
const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };
const InlayHintKind = { Type: 1, Parameter: 2 };
const SignatureHelpTriggerKind = { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 };
const CodeActionTriggerKind = { Invoke: 1, Automatic: 2 };
const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };

const StatusBarAlignment = { Left: 1, Right: 2 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const EndOfLine = { LF: 1, CRLF: 2 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const QuickPickItemKind = { Separator: -1, Default: 0 };
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const UIKind = { Desktop: 1, Web: 2 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 };
const TextEditorCursorStyle = { Line: 1, Block: 2, Underline: 3 };
const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };

// --- Documents and the active editor ------------------------------------------------------

/** A VS Code TextDocument over a snapshot of a file's text. */
class TextDocument {
  constructor(path, languageId, text, version = 1) {
    this.uri = Uri.file(path);
    this.fileName = path;
    this.languageId = languageId || "plaintext";
    this.version = version;
    this.isDirty = false;
    this.isUntitled = false;
    this.isClosed = false;
    this._text = text ?? "";
    this.eol = this._text.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF;
    this._lines = this._text.split(/\r?\n/);
  }
  get lineCount() {
    return this._lines.length;
  }
  getText(range) {
    if (!range) return this._text;
    const range2 = this.validateRange(range);
    return this._text.slice(this.offsetAt(range2.start), this.offsetAt(range2.end));
  }
  lineAt(lineOrPosition) {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    const text = this._lines[Math.min(Math.max(0, line), this._lines.length - 1)] ?? "";
    const firstNonWhitespace = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: line < this._lines.length - 1 ? new Range(line, 0, line + 1, 0) : new Range(line, 0, line, text.length),
      firstNonWhitespaceCharacterIndex: firstNonWhitespace < 0 ? text.length : firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace < 0,
    };
  }
  offsetAt(position) {
    const eolLength = this.eol === EndOfLine.CRLF ? 2 : 1;
    const line = Math.min(position.line, this._lines.length - 1);
    let offset = 0;
    for (let index = 0; index < line; index++) offset += this._lines[index].length + eolLength;
    return offset + Math.min(position.character, this._lines[line]?.length ?? 0);
  }
  positionAt(offset) {
    const eolLength = this.eol === EndOfLine.CRLF ? 2 : 1;
    let remaining = Math.max(0, Math.min(offset, this._text.length));
    for (let line = 0; line < this._lines.length; line++) {
      if (remaining <= this._lines[line].length) return new Position(line, remaining);
      remaining -= this._lines[line].length + eolLength;
    }
    const last = this._lines.length - 1;
    return new Position(last, this._lines[last].length);
  }
  validatePosition(position) {
    const line = Math.min(Math.max(0, position.line), this._lines.length - 1);
    return new Position(line, Math.min(Math.max(0, position.character), this._lines[line].length));
  }
  validateRange(range) {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }
  getWordRangeAtPosition(position, regex) {
    const text = this.lineAt(position.line).text;
    const pattern = regex ? new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`) : /[\w$]+/g;
    let match;
    while ((match = pattern.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (start <= position.character && position.character <= end && match[0].length > 0) return new Range(position.line, start, position.line, end);
      if (match[0].length === 0) pattern.lastIndex++;
    }
    return undefined;
  }
  save() {
    return Promise.resolve(true);
  }
}

/** 0-based VS Code positions ↔ Sable's 1-based ones. */
const __toSable = (position) => ({ line: position.line + 1, column: position.character + 1 });
const __toSableRange = (range) => ({ start: __toSable(range.start), end: __toSable(range.end) });
const __fromSable = (position) => new Position(position.line - 1, position.column - 1);
/** VS Code objects → the plain shapes Sable's host takes (0-based). */
const __plainPosition = (position) => ({ line: position.line, character: position.character });
const __plainRange = (range) => ({ start: __plainPosition(range.start), end: __plainPosition(range.end) });
const __rangeFrom = (plain) => new Range(plain.start.line, plain.start.character, plain.end.line, plain.end.character);
const __plainWorkspaceEdit = (edit) =>
  (edit?.entries?.() ?? []).map(([uri, edits]) => ({
    path: __pathOf(uri),
    edits: edits.map((item) => ({ range: __plainRange(item.range), text: item.newText ?? "" })),
  }));
const __plainCommand = (command) =>
  command ? { id: command.command ?? command.id, title: command.title, arguments: command.arguments ?? [] } : undefined;
/**
 * A theme colour: the extension's own colours (contributes.colors, e.g.
 * errorLens.errorForeground) as their default for a dark theme, which may
 * name another colour; VS Code's as { id } for the host to look up.
 */
function __themeColor(id, depth = 0) {
  const contributed = (__extension?.packageJSON?.contributes?.colors ?? []).find((color) => color?.id === id);
  const fallback = contributed?.defaults?.dark ?? contributed?.defaults?.light;
  if (typeof fallback !== "string" || depth > 3) return { id };
  return /^#|^rgba?\(|^hsla?\(|^transparent$/i.test(fallback) ? fallback : __themeColor(fallback, depth + 1);
}

/** Decoration options: theme colours as { id }, the rest as is. */
function __plainDecoration(options) {
  if (!options || typeof options !== "object") return options;
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (value instanceof ThemeColor) out[key] = __themeColor(value.id);
    else if (value instanceof Uri) continue;
    else if (value && typeof value === "object" && !Array.isArray(value)) out[key] = __plainDecoration(value);
    else out[key] = value;
  }
  return out;
}

/** Apply TextEdits to a text (for formatters and other files). */
function __applyEdits(document, edits) {
  const sorted = [...edits]
    .map((edit) => ({ start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText ?? "" }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let text = document.getText();
  for (const edit of sorted) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

let __active = null;
let __version = 1;
const __onDidChangeActiveTextEditor = new EventEmitter();
const __onDidChangeTextEditorSelection = new EventEmitter();
const __onDidChangeTextDocument = new EventEmitter();
const __onDidSaveTextDocument = new EventEmitter();
const __onDidOpenTextDocument = new EventEmitter();
const __onDidChangeConfiguration = new EventEmitter();
const __onDidChangeWorkspaceFolders = new EventEmitter();

class TextEditor {
  constructor(snapshot) {
    this.document = new TextDocument(snapshot.path, snapshot.language, snapshot.text, __version++);
    const selection = snapshot.selection;
    this._selection = selection
      ? new Selection(__fromSable(selection.start), __fromSable(selection.end))
      : new Selection(0, 0, 0, 0);
    this.options = { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 };
    this.viewColumn = ViewColumn.One;
    this.visibleRanges = [new Range(0, 0, this.document.lineCount, 0)];
  }
  get selection() {
    return this._selection;
  }
  set selection(value) {
    this._selection = value;
    void __sable.editor.setSelection(__toSableRange(value));
  }
  get selections() {
    return [this._selection];
  }
  set selections(values) {
    if (values?.length) this.selection = values[0];
  }
  async edit(callback) {
    const edits = [];
    const builder = {
      replace: (location, value) => edits.push({ range: location instanceof Position ? new Range(location, location) : location, text: value }),
      insert: (position, value) => edits.push({ range: new Range(position, position), text: value }),
      delete: (range) => edits.push({ range, text: "" }),
      setEndOfLine: () => __unsupported("TextEditorEdit.setEndOfLine"),
    };
    callback(builder);
    if (edits.length === 0) return true;
    await __sable.editor.applyEdits(edits.map((edit) => ({ range: __toSableRange(edit.range), text: edit.text })));
    await __refresh();
    return true;
  }
  async insertSnippet(snippet, location) {
    const text = (snippet?.value ?? String(snippet)).replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "").replace(/\\([$}\\])/g, "$1");
    if (location) {
      const range = location instanceof Position ? new Range(location, location) : Array.isArray(location) ? location[0] : location;
      await __sable.editor.applyEdits([{ range: __toSableRange(range), text }]);
    } else {
      await __sable.editor.replaceSelection(text);
    }
    await __refresh();
    return true;
  }
  revealRange() {}
  setDecorations(type, rangesOrOptions) {
    if (!type?.key) return;
    const items = (rangesOrOptions ?? []).map((item) => {
      const range = item instanceof Range ? item : item.range;
      return {
        range: __plainRange(range),
        hoverMessage: item.hoverMessage ? __markdown(Array.isArray(item.hoverMessage) ? item.hoverMessage[0] : item.hoverMessage) : undefined,
        renderOptions: item.renderOptions ? __plainDecoration(item.renderOptions) : undefined,
      };
    });
    void __sable.editor.setDecorations(this.document.fileName, type.key, items).catch(() => {});
  }
  show() {}
  hide() {}
}

/** Re-read the active editor (before commands, after edits, on events). */
async function __refresh() {
  const snapshot = await __sable.editor.active().catch(() => null);
  __active = snapshot ? new TextEditor(snapshot) : null;
  if (__active) __trackDocument(__active.document);
  return __active;
}

/**
 * The documents extensions have seen (workspace.textDocuments), and for
 * each the text they last saw, so a change event can say what changed:
 * Sable reports changes once typing settles, so contentChanges is one
 * edit covering everything that differs (as language clients and tag
 * closers need).
 */
const __documents = new Map();
const __seenText = new Map();
let __activated = false;
function __trackDocument(document) {
  const path = document.fileName;
  const known = __documents.has(path);
  __documents.set(path, document);
  if (known) return;
  __seenText.set(path, document.getText());
  if (__activated) __onDidOpenTextDocument.fire(document);
}

/** The single edit that turns `before` into `after`, in `before`'s coordinates. */
function __contentChange(before, after) {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  // Don't split a \r\n pair.
  if (start > 0 && before[start - 1] === "\r") start--;
  const old = new TextDocument("", "", before);
  return {
    range: new Range(old.positionAt(start), old.positionAt(before.length - end)),
    rangeOffset: start,
    rangeLength: before.length - end - start,
    text: after.slice(start, after.length - end),
  };
}

const __documentFrom = (request) => new TextDocument(request.path, request.language, request.text, __version++);

// --- Configuration and state ------------------------------------------------------------------

let __stored = {};
const __storageKey = (key) => key;

async function __loadStorage() {
  try {
    for (const key of await __sable.storage.keys()) __stored[key] = await __sable.storage.get(key);
  } catch {
    __stored = {};
  }
}

function __store(key, value) {
  if (value === undefined) delete __stored[key];
  else __stored[key] = value;
  return __sable.storage.set(__storageKey(key), value === undefined ? null : value).catch((error) => console.error(error));
}

function __memento(prefix) {
  return {
    get: (key, defaultValue) => (`${prefix}${key}` in __stored ? __stored[`${prefix}${key}`] : defaultValue),
    update: (key, value) => __store(`${prefix}${key}`, value),
    keys: () => Object.keys(__stored).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    setKeysForSync() {},
  };
}

function __configValue(full) {
  if (`config:${full}` in __stored) return __stored[`config:${full}`];
  if (full in __extension.configuration) return __extension.configuration[full];
  return __CORE_SETTINGS[full];
}

/** VS Code's own settings that extensions read (their defaults). */
const __CORE_SETTINGS = {
  "files.exclude": { "**/.git": true, "**/.svn": true, "**/.hg": true, "**/CVS": true, "**/.DS_Store": true, "**/Thumbs.db": true },
  "files.watcherExclude": { "**/.git/objects/**": true, "**/.git/subtree-cache/**": true, "**/node_modules/*/**": true },
  "search.exclude": { "**/node_modules": true, "**/bower_components": true, "**/*.code-search": true },
  "files.associations": {},
  "files.encoding": "utf8",
  "files.eol": "auto",
  "files.insertFinalNewline": false,
  "files.trimTrailingWhitespace": false,
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.detectIndentation": true,
  "editor.formatOnSave": false,
  "editor.defaultFormatter": null,
  "editor.wordWrap": "off",
  "editor.fontSize": 14,
  "editor.lineHeight": 0,
  "editor.fontFamily": "Menlo, Monaco, 'Courier New', monospace",
  "editor.codeActionsOnSave": {},
  "http.proxy": "",
  "http.proxyStrictSSL": true,
  "workbench.colorTheme": "Default Dark Modern",
  "explorer.excludeGitIgnore": false,
};

function getConfiguration(section) {
  const prefix = section ? `${section}.` : "";
  const configuration = {
    get(key, defaultValue) {
      const value = __configValue(`${prefix}${key}`);
      if (value !== undefined) return value;
      // A whole object section ("myExt.colors" → { a: …, b: … }).
      const nested = {};
      let found = false;
      for (const full of Object.keys(__extension.configuration)) {
        if (full.startsWith(`${prefix}${key}.`)) {
          nested[full.slice(`${prefix}${key}.`.length)] = __configValue(full);
          found = true;
        }
      }
      if (found) return nested;
      // A key inside an object setting ("highlights.defaultHighlight.icon").
      const parts = String(key).split(".");
      for (let index = parts.length - 1; index > 0; index--) {
        let inner = __configValue(`${prefix}${parts.slice(0, index).join(".")}`);
        if (!inner || typeof inner !== "object") continue;
        for (const part of parts.slice(index)) inner = inner?.[part];
        return inner === undefined ? defaultValue : inner;
      }
      return defaultValue;
    },
    has: (key) => __configValue(`${prefix}${key}`) !== undefined,
    inspect: (key) => ({ key: `${prefix}${key}`, defaultValue: __extension.configuration[`${prefix}${key}`], globalValue: __stored[`config:${prefix}${key}`] }),
    async update(key, value) {
      await __store(`config:${prefix}${key}`, value);
      __onDidChangeConfiguration.fire({ affectsConfiguration: (name) => `${prefix}${key}`.startsWith(name) || name.startsWith(`${prefix}${key}`) });
    },
  };
  // Direct property access (config.someKey) works too.
  return new Proxy(configuration, {
    get: (target, property) => (property in target || typeof property !== "string" ? target[property] : target.get(property)),
  });
}

// --- Commands --------------------------------------------------------------------------------

function registerCommand(id, callback, thisArg) {
  const run = async (...args) => {
    await __refresh();
    return callback.apply(thisArg, args);
  };
  __commands.set(id, run);
  const title = __extension.commands[id];
  // Declared commands show in the command palette; internal ones don't.
  const registration = title ? __sable.commands.register(id, title, (...args) => run(...args)) : null;
  return new Disposable(() => {
    __commands.delete(id);
    void registration?.dispose();
  });
}

function registerTextEditorCommand(id, callback, thisArg) {
  return registerCommand(id, async (...args) => {
    if (!__active) return;
    const edits = [];
    const builder = {
      replace: (location, value) => edits.push(new TextEdit(location instanceof Position ? new Range(location, location) : location, value)),
      insert: (position, value) => edits.push(TextEdit.insert(position, value)),
      delete: (range) => edits.push(TextEdit.delete(range)),
      setEndOfLine() {},
    };
    await callback.call(thisArg, __active, builder, ...args);
    if (edits.length) await __active.edit((edit) => edits.forEach((item) => edit.replace(item.range, item.newText)));
  });
}

async function executeCommand(id, ...args) {
  if (__commands.has(id)) return __commands.get(id)(...args);
  if (id.startsWith("editor.action.") || id === "editor.fold" || id === "editor.unfold") return __sable.editor.executeAction(id);
  if (id === "setContext") return undefined;
  if (id === "vscode.open") return window.showTextDocument(args[0]);
  if (id === "vscode.openFolder") return __unsupported("vscode.openFolder");
  __unsupported(`The command ${id}`);
  return undefined;
}

const commands = {
  registerCommand,
  registerTextEditorCommand,
  executeCommand,
  getCommands: async () => [...__commands.keys()],
};

// --- Window ----------------------------------------------------------------------------------

async function __message(kind, message, ...rest) {
  const items = rest.filter((item) => typeof item === "string" || (item && typeof item === "object" && "title" in item));
  if (items.length) {
    const labels = items.map((item) => (typeof item === "string" ? item : item.title));
    const chosen = await __sable.window.showQuickPick(labels, { placeholder: String(message) });
    return chosen === null ? undefined : items[labels.indexOf(chosen)];
  }
  if (kind === "error") await __sable.window.showError(String(message));
  else if (kind === "warning") await __sable.window.showWarning(String(message));
  else await __sable.window.showMessage(String(message));
  return undefined;
}

const __statusItems = new Set();
let __statusCommand = null;

function __renderStatus() {
  const visible = [...__statusItems].filter((item) => item._visible && item.text);
  visible.sort((a, b) => (a.alignment - b.alignment) || (b.priority ?? 0) - (a.priority ?? 0));
  if (visible.length === 0) {
    void __sable.statusBar.clear();
    return;
  }
  const first = visible.find((item) => item.command) ?? null;
  __statusCommand = first ? (typeof first.command === "string" ? { command: first.command } : first.command) : null;
  const text = visible.map((item) => item.text.replace(/\$\([\w-]+(~spin)?\)\s*/g, "")).join("   ");
  const tooltip = visible.map((item) => (typeof item.tooltip === "string" ? item.tooltip : item.tooltip?.value)).filter(Boolean).join("\n");
  void __sable.statusBar.set(text, { tooltip: tooltip || undefined, command: __statusCommand ? "__vscode.statusBar" : undefined });
}

function createStatusBarItem(a, b, c) {
  const [alignment, priority] = typeof a === "string" ? [b, c] : [a, b];
  const item = {
    id: typeof a === "string" ? a : undefined,
    alignment: alignment ?? StatusBarAlignment.Left,
    priority,
    _visible: false,
    _text: "",
    _tooltip: undefined,
    _command: undefined,
    name: undefined,
    color: undefined,
    backgroundColor: undefined,
    accessibilityInformation: undefined,
    get text() { return this._text; },
    set text(value) { this._text = value ?? ""; __renderStatus(); },
    get tooltip() { return this._tooltip; },
    set tooltip(value) { this._tooltip = value; __renderStatus(); },
    get command() { return this._command; },
    set command(value) { this._command = value; __renderStatus(); },
    show() { this._visible = true; __renderStatus(); },
    hide() { this._visible = false; __renderStatus(); },
    dispose() { __statusItems.delete(item); __renderStatus(); },
  };
  __statusItems.add(item);
  return item;
}

function createOutputChannel(name) {
  const log = (level) => (...parts) => console[level](`[${name}]`, ...parts);
  return {
    name,
    append: log("log"),
    appendLine: log("log"),
    replace: log("log"),
    clear() {},
    show() {},
    hide() {},
    dispose() {},
    trace: log("debug"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    logLevel: LogLevel.Info,
    onDidChangeLogLevel: new EventEmitter().event,
  };
}

let __ids = 0;

function __createTerminal(nameOrOptions, shellPath, shellArgs) {
  const options = typeof nameOrOptions === "object" && nameOrOptions !== null ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
  const queue = [];
  let terminalId = null;
  const created = __sable.terminal
    .create({ name: options.name, cwd: options.cwd ? __pathOf(options.cwd) : undefined, shellPath: options.shellPath, shellArgs: Array.isArray(options.shellArgs) ? options.shellArgs : undefined, env: options.env })
    .then((id) => {
      terminalId = id;
      for (const run of queue.splice(0)) run();
      return id;
    })
    .catch((error) => console.error(error));
  const whenReady = (run) => (terminalId ? run() : queue.push(run));
  return {
    name: options.name ?? "Terminal",
    processId: created.then(() => undefined),
    creationOptions: options,
    exitStatus: undefined,
    state: { isInteractedWith: false },
    sendText: (text, addNewLine = true) => whenReady(() => void __sable.terminal.sendText(terminalId, String(text), addNewLine).catch(() => {})),
    show: () => whenReady(() => void __sable.terminal.show(terminalId).catch(() => {})),
    hide() {},
    dispose: () => whenReady(() => void __sable.terminal.dispose(terminalId).catch(() => {})),
  };
}

/** asWebviewUri: Sable's frame inlines these (they're the plugin's own files). */
const __webviewUri = (uri) => {
  const path = __pathOf(uri);
  return { scheme: "sable-resource", path, fsPath: path, toString: () => `sable-resource:${encodeURI(path)}`, toJSON: () => `sable-resource:${encodeURI(path)}`, with: () => __webviewUri(uri) };
};

/** A webview object (for panels and views) bound to id `id`. */
function __makeWebview(id, options = {}) {
  const messages = new EventEmitter();
  let html = "";
  const webview = {
    options,
    cspSource: "'self' data: https:",
    onDidReceiveMessage: messages.event,
    get html() {
      return html;
    },
    set html(value) {
      html = String(value ?? "");
      void __sable.webview.setHtml(id, html).catch(() => {});
    },
    postMessage: (message) => __sable.webview.postMessage(id, message).then(() => true, () => false),
    asWebviewUri: __webviewUri,
  };
  return { webview, messages };
}

const __webviewViews = new Map();
const __trees = new Map();

function __createWebviewPanel(viewType, title, options) {
  const id = `w${++__ids}-${viewType}`;
  const disposed = new EventEmitter();
  const viewState = new EventEmitter();
  const { webview, messages } = __makeWebview(id, options);
  let currentTitle = title;
  let isDisposed = false;
  const panel = {
    viewType,
    webview,
    options,
    viewColumn: 1,
    active: true,
    visible: true,
    iconPath: undefined,
    get title() {
      return currentTitle;
    },
    set title(value) {
      currentTitle = value;
      void __sable.webview.setTitle(id, String(value)).catch(() => {});
    },
    reveal: () => void __sable.webview.reveal(id).catch(() => {}),
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      void __sable.webview.dispose(id).catch(() => {});
      disposed.fire();
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
  };
  void __sable.webview.create(id, { title, enableScripts: options?.enableScripts !== false }, (event) => {
    if (event?.type === "message") messages.fire(event.message);
    else if (event?.type === "dispose" && !isDisposed) {
      isDisposed = true;
      disposed.fire();
    }
  });
  return panel;
}

/** Requests from Sable's Plugin Views sidebar. */
async function __viewRequest(request) {
  if (request.op === "children") {
    const tree = __trees.get(request.viewId);
    if (!tree) return [];
    const element = request.nodeId ? tree.nodes.get(request.nodeId) : undefined;
    const children = (await tree.provider.getChildren(element)) ?? [];
    const out = [];
    for (const child of children) {
      const item = (await tree.provider.getTreeItem(child)) ?? {};
      const id = item.id ?? `n${++__ids}`;
      tree.nodes.set(id, child);
      const label = typeof item.label === "string" ? item.label : item.label?.label ?? (item.resourceUri ? __path.basename(__pathOf(item.resourceUri)) : "");
      out.push({
        id,
        label,
        description: typeof item.description === "string" ? item.description : undefined,
        tooltip: typeof item.tooltip === "string" ? item.tooltip : item.tooltip?.value,
        collapsible: item.collapsibleState ?? 0,
        command: __plainCommand(item.command),
      });
    }
    return out;
  }
  if (request.op === "resolve") {
    const provider = __webviewViews.get(request.viewId);
    if (!provider) return null;
    const { webview, messages } = __makeWebview(request.viewId, {});
    const disposed = new EventEmitter();
    const visibility = new EventEmitter();
    await __sable.webview.create(request.viewId, { title: request.viewId, view: true, enableScripts: true }, (event) => {
      if (event?.type === "message") messages.fire(event.message);
      else if (event?.type === "dispose") disposed.fire();
    });
    const view = {
      viewType: request.viewId,
      webview,
      title: undefined,
      description: undefined,
      badge: undefined,
      visible: true,
      show() {},
      onDidDispose: disposed.event,
      onDidChangeVisibility: visibility.event,
    };
    await provider.resolveWebviewView(view, { state: undefined }, __token());
    return null;
  }
  return null;
}

const window = {
  get activeTextEditor() {
    return __active ?? undefined;
  },
  get visibleTextEditors() {
    return __active ? [__active] : [];
  },
  onDidChangeActiveTextEditor: __onDidChangeActiveTextEditor.event,
  onDidChangeTextEditorSelection: __onDidChangeTextEditorSelection.event,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeTextEditorVisibleRanges: new EventEmitter().event,
  onDidChangeTextEditorOptions: new EventEmitter().event,
  onDidChangeWindowState: new EventEmitter().event,
  onDidChangeActiveColorTheme: new EventEmitter().event,
  onDidChangeActiveTerminal: new EventEmitter().event,
  onDidOpenTerminal: new EventEmitter().event,
  onDidCloseTerminal: new EventEmitter().event,
  state: { focused: true },
  activeColorTheme: { kind: 2 },
  terminals: [],
  tabGroups: { all: [], activeTabGroup: { tabs: [] }, onDidChangeTabs: new EventEmitter().event, onDidChangeTabGroups: new EventEmitter().event },
  showInformationMessage: (message, ...rest) => __message("info", message, ...rest),
  showWarningMessage: (message, ...rest) => __message("warning", message, ...rest),
  showErrorMessage: (message, ...rest) => __message("error", message, ...rest),
  async showQuickPick(items, options = {}) {
    const list = (await items) ?? [];
    const visible = list.filter((item) => typeof item === "string" || item.kind !== QuickPickItemKind.Separator);
    const chosen = await __sable.window.showQuickPick(
      visible.map((item) => (typeof item === "string" ? item : { label: String(item.label).replace(/\$\([\w-]+\)\s*/g, ""), description: item.description, detail: item.detail })),
      { placeholder: options.placeHolder ?? options.title },
    );
    if (chosen === null) return undefined;
    const index = visible.findIndex((item) => (typeof item === "string" ? item === chosen : String(item.label).replace(/\$\([\w-]+\)\s*/g, "") === chosen.label));
    const picked = visible[index];
    return options.canPickMany ? [picked] : picked;
  },
  async showInputBox(options = {}) {
    let value = options.value;
    for (;;) {
      const answer = await __sable.window.showInputBox({ prompt: options.prompt ?? options.title, placeholder: options.placeHolder, value });
      if (answer === null) return undefined;
      const problem = options.validateInput ? await options.validateInput(answer) : undefined;
      const message = typeof problem === "string" ? problem : problem?.message;
      if (!message) return answer;
      await __sable.window.showError(message);
      value = answer;
    }
  },
  createStatusBarItem,
  setStatusBarMessage(text) {
    void __sable.window.showMessage(String(text));
    return new Disposable(() => {});
  },
  createOutputChannel,
  async withProgress(options, task) {
    if (options?.title) void __sable.window.showMessage(String(options.title));
    return task({ report() {} }, __token());
  },
  async showTextDocument(documentOrUri, options) {
    const path = __pathOf(documentOrUri);
    await __sable.editor.open(path);
    await __refresh();
    if (options?.selection && __active) __active.selection = new Selection(options.selection.start, options.selection.end);
    return __active;
  },
  createTextEditorDecorationType(options) {
    const key = `d${++__ids}`;
    void __sable.editor.createDecorationType(key, __plainDecoration(options ?? {})).catch(() => {});
    return { key, dispose: () => void __sable.editor.disposeDecorationType(key).catch(() => {}) };
  },
  createTerminal: __createTerminal,
  registerTreeDataProvider(viewId, provider) {
    __trees.set(viewId, { provider, nodes: new Map() });
    provider.onDidChangeTreeData?.(() => void __sable.views.refresh(viewId).catch(() => {}));
    return new Disposable(() => __trees.delete(viewId));
  },
  createTreeView(viewId, options) {
    window.registerTreeDataProvider(viewId, options.treeDataProvider);
    const emitter = new EventEmitter();
    return {
      reveal: async () => void __sable.views.reveal(viewId).catch(() => {}),
      dispose() {},
      visible: true,
      selection: [],
      message: undefined,
      title: undefined,
      badge: undefined,
      onDidChangeSelection: emitter.event,
      onDidChangeVisibility: emitter.event,
      onDidExpandElement: emitter.event,
      onDidCollapseElement: emitter.event,
      onDidChangeCheckboxState: emitter.event,
    };
  },
  registerWebviewViewProvider(viewId, provider) {
    __webviewViews.set(viewId, provider);
    return new Disposable(() => __webviewViews.delete(viewId));
  },
  createWebviewPanel(viewType, title, _showOptions, options = {}) {
    return __createWebviewPanel(viewType, title, options);
  },
  registerUriHandler: () => __noop(),
  registerFileDecorationProvider: () => __noop(),
  registerTerminalLinkProvider: () => __noop(),
  registerCustomEditorProvider: () => (__unsupported("Custom editors"), __noop()),
  createQuickPick() {
    const accept = new EventEmitter(), hide = new EventEmitter(), selection = new EventEmitter(), active = new EventEmitter(), value = new EventEmitter(), button = new EventEmitter();
    const quickPick = {
      items: [], selectedItems: [], activeItems: [], value: "", placeholder: undefined, title: undefined, busy: false, enabled: true,
      canSelectMany: false, matchOnDescription: false, matchOnDetail: false, ignoreFocusOut: false, buttons: [], step: undefined, totalSteps: undefined,
      onDidAccept: accept.event, onDidHide: hide.event, onDidChangeSelection: selection.event, onDidChangeActive: active.event,
      onDidChangeValue: value.event, onDidTriggerButton: button.event, onDidTriggerItemButton: button.event,
      async show() {
        const chosen = await window.showQuickPick(quickPick.items, { placeHolder: quickPick.placeholder ?? quickPick.title });
        if (chosen === undefined) {
          hide.fire();
          return;
        }
        quickPick.selectedItems = [chosen];
        quickPick.activeItems = [chosen];
        active.fire(quickPick.activeItems);
        selection.fire(quickPick.selectedItems);
        accept.fire();
      },
      hide: () => hide.fire(),
      dispose() {},
    };
    return quickPick;
  },
  createInputBox() {
    const accept = new EventEmitter(), hide = new EventEmitter(), value = new EventEmitter(), button = new EventEmitter();
    const box = {
      value: "", prompt: undefined, placeholder: undefined, title: undefined, password: false, busy: false, enabled: true,
      validationMessage: undefined, buttons: [], ignoreFocusOut: false,
      onDidAccept: accept.event, onDidHide: hide.event, onDidChangeValue: value.event, onDidTriggerButton: button.event,
      async show() {
        const answer = await window.showInputBox({ prompt: box.prompt ?? box.title, placeHolder: box.placeholder, value: box.value });
        if (answer === undefined) {
          hide.fire();
          return;
        }
        box.value = answer;
        value.fire(answer);
        accept.fire();
      },
      hide: () => hide.fire(),
      dispose() {},
    };
    return box;
  },
};

// --- Workspace -------------------------------------------------------------------------------

/** "**​/*.{ts,js}" → a RegExp over relative paths. */
function __glob(pattern) {
  if (!pattern) return null;
  const source = typeof pattern === "string" ? pattern : pattern.pattern;
  let regex = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      regex += ".*";
      index++;
      if (source[index + 1] === "/") index++;
    } else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else if (char === "{") regex += "(";
    else if (char === "}") regex += ")";
    else if (char === "," ) regex += "|";
    else regex += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`);
}

const __root = () => __sable.workspace.root;
/** The same folder objects while the folder doesn't change (extensions compare them). */
let __folderCache = { key: undefined, folders: undefined };
function __workspaceFolders() {
  const root = __root();
  // Every folder of a multi-root workspace, root first.
  const paths = __sable.workspace.folders?.length ? __sable.workspace.folders : root ? [root] : [];
  const key = paths.join("\n");
  if (__folderCache.key !== key) {
    __folderCache = {
      key,
      folders: paths.length ? paths.map((path, index) => ({ uri: Uri.file(path), name: path.split(/[/\\]/).pop(), index })) : undefined,
    };
  }
  return __folderCache.folders;
}
/** Node's fs (Node runtime only). */
let __node = null;
const __insideRoot = (path) => {
  const folders = __sable.workspace.folders?.length ? __sable.workspace.folders : [__root()].filter(Boolean);
  return folders.some((root) => path === root || path.startsWith(`${root}/`));
};
const __relative = (path) => {
  const root = __root();
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

async function __applyWorkspaceEdit(edit) {
  for (const [uri, edits] of edit.entries()) {
    const path = __pathOf(uri);
    await __refresh();
    if (__active && __active.document.fileName === path) {
      await __active.edit((builder) => edits.forEach((item) => builder.replace(item.range, item.newText)));
    } else {
      const text = await __sable.workspace.readFile(__relative(path));
      await __sable.workspace.writeFile(__relative(path), __applyEdits(new TextDocument(path, "", text), edits));
    }
  }
  return true;
}

const workspace = {
  get workspaceFolders() {
    return __workspaceFolders();
  },
  get rootPath() {
    return __root() ?? undefined;
  },
  get name() {
    return __root()?.split("/").pop();
  },
  get textDocuments() {
    return [...__documents.values()];
  },
  isTrusted: true,
  getConfiguration,
  getWorkspaceFolder: (uri) => __workspaceFolders()?.find((folder) => __pathOf(uri) === folder.uri.fsPath || __pathOf(uri).startsWith(`${folder.uri.fsPath}/`)),
  asRelativePath: (pathOrUri) => __relative(__pathOf(pathOrUri)),
  async openTextDocument(target) {
    if (target && typeof target === "object" && !(target instanceof Uri) && "content" in target) {
      return new TextDocument("untitled", target.language, target.content);
    }
    const path = __pathOf(target);
    if (__active?.document.fileName === path) return __active.document;
    const text = __node && !__insideRoot(path) ? await __node.fs.readFile(path, "utf8") : await __sable.workspace.readFile(__relative(path));
    return new TextDocument(path, "", text);
  },
  async findFiles(include, exclude, maxResults) {
    const including = __glob(include);
    const excluding = __glob(exclude);
    const root = __root();
    const files = (await __sable.workspace.listFiles()).filter((file) => (!including || including.test(file)) && !(excluding && excluding.test(file)));
    return files.slice(0, maxResults ?? files.length).map((file) => Uri.file(`${root}/${file}`));
  },
  applyEdit: __applyWorkspaceEdit,
  saveAll: async () => true,
  fs: {
    async readFile(uri) {
      const builtin = __builtinFile(__pathOf(uri));
      if (builtin !== null) return new TextEncoder().encode(builtin);
      // In Node, extensions read anything (their own files too), as in VS Code.
      if (__node) return new Uint8Array(await __node.fs.readFile(__pathOf(uri)));
      return new TextEncoder().encode(await __sable.workspace.readFile(__relative(__pathOf(uri))));
    },
    async writeFile(uri, content) {
      if (__node && !__insideRoot(__pathOf(uri))) return __node.fs.writeFile(__pathOf(uri), content);
      await __sable.workspace.writeFile(__relative(__pathOf(uri)), new TextDecoder().decode(content));
    },
    async stat(uri) {
      if (__node) {
        const stat = await __node.fs.stat(__pathOf(uri));
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
      }
      const text = await __sable.workspace.readFile(__relative(__pathOf(uri)));
      return { type: FileType.File, ctime: 0, mtime: 0, size: text.length };
    },
    readDirectory: async (uri) =>
      __node
        ? (await __node.fs.readdir(__pathOf(uri), { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File])
        : (await __sable.workspace.listDirectory(__relative(__pathOf(uri)))).map((entry) => [entry.name, entry.isDirectory ? FileType.Directory : FileType.File]),
    // In Node, files outside the open folder (the extension's storage…) go through Node's fs.
    createDirectory: async (uri) =>
      __node && !__insideRoot(__pathOf(uri)) ? void (await __node.fs.mkdir(__pathOf(uri), { recursive: true })) : __sable.workspace.createDirectory(__relative(__pathOf(uri))),
    delete: async (uri, options) =>
      __node && !__insideRoot(__pathOf(uri)) ? __node.fs.rm(__pathOf(uri), { recursive: !!options?.recursive, force: true }) : __sable.workspace.delete(__relative(__pathOf(uri))),
    rename: async (from, to) =>
      __node && !(__insideRoot(__pathOf(from)) && __insideRoot(__pathOf(to))) ? __node.fs.rename(__pathOf(from), __pathOf(to)) : __sable.workspace.rename(__relative(__pathOf(from)), __relative(__pathOf(to))),
    copy: async (from, to) =>
      __node && !(__insideRoot(__pathOf(from)) && __insideRoot(__pathOf(to))) ? __node.fs.cp(__pathOf(from), __pathOf(to), { recursive: true }) : __sable.workspace.writeFile(__relative(__pathOf(to)), await __sable.workspace.readFile(__relative(__pathOf(from)))),
    isWritableFileSystem: () => true,
  },
  onDidChangeConfiguration: __onDidChangeConfiguration.event,
  onDidChangeTextDocument: __onDidChangeTextDocument.event,
  onDidSaveTextDocument: __onDidSaveTextDocument.event,
  onDidOpenTextDocument: __onDidOpenTextDocument.event,
  onDidCloseTextDocument: new EventEmitter().event,
  onWillSaveTextDocument: new EventEmitter().event,
  onDidChangeWorkspaceFolders: __onDidChangeWorkspaceFolders.event,
  onDidCreateFiles: new EventEmitter().event,
  onDidDeleteFiles: new EventEmitter().event,
  onDidRenameFiles: new EventEmitter().event,
  onDidGrantWorkspaceTrust: new EventEmitter().event,
  createFileSystemWatcher: () => ({
    onDidChange: new EventEmitter().event,
    onDidCreate: new EventEmitter().event,
    onDidDelete: new EventEmitter().event,
    dispose() {},
  }),
  registerTextDocumentContentProvider: () => (__unsupported("Virtual documents"), __noop()),
  registerFileSystemProvider: () => (__unsupported("File system providers"), __noop()),
  registerTaskProvider: () => __noop(),
};

// --- Languages -------------------------------------------------------------------------------

/** A document selector → Sable language ids ("*" for any). */
function __languages(selector) {
  let list = Array.isArray(selector) ? selector : [selector];
  // A glob-only entry ({ pattern: "**/*.{js,css}" }) beside language entries
  // (Prettier's) would otherwise mean every language, taking Format
  // Document from the language's own formatter.
  const byLanguage = list.filter((entry) => typeof entry === "string" || entry?.language);
  if (byLanguage.length) list = byLanguage;
  const ids = list.map((entry) => (typeof entry === "string" ? entry : entry?.language ?? "*"));
  return ids.includes("*") ? ["*"] : [...new Set(ids)];
}

function __register(selector, make) {
  const registrations = __languages(selector).map(make);
  return new Disposable(() => registrations.forEach((registration) => void registration?.dispose()));
}

function __markdown(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (content instanceof MarkdownString || typeof content.value === "string" && !content.language) return content.value;
  if (content.language) return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
  return String(content);
}

function registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
  return __register(selector, (language) =>
    __sable.languages.registerCompletions(
      language,
      async (request) => {
        const document = __documentFrom(request);
        const position = new Position(request.line - 1, request.column - 1);
        const context = { triggerKind: CompletionTriggerKind.Invoke, triggerCharacter: undefined };
        const result = await provider.provideCompletionItems(document, position, __token(), context);
        const items = Array.isArray(result) ? result : result?.items ?? [];
        return Promise.all(
          items.map(async (original) => {
            const item = provider.resolveCompletionItem ? (await provider.resolveCompletionItem(original, __token())) ?? original : original;
            const label = typeof item.label === "string" ? item.label : item.label?.label ?? "";
            const insert = item.insertText ?? label;
            const range = item.range?.replacing ?? item.range;
            return {
              label,
              insertText: typeof insert === "string" ? insert : insert.value,
              snippet: insert instanceof SnippetString || (typeof insert === "object" && insert !== null),
              detail: item.detail ?? (typeof item.label === "object" ? item.label.description : undefined),
              documentation: item.documentation ? __markdown(item.documentation) : undefined,
              kind: __kindNames[item.kind],
              replace: range && range.start.line === position.line ? Math.max(0, position.character - range.start.character) : undefined,
            };
          }),
        );
      },
      { triggerCharacters },
    ),
  );
}

function registerHoverProvider(selector, provider) {
  return __register(selector, (language) =>
    __sable.languages.registerHover(language, async (request) => {
      const hover = await provider.provideHover(__documentFrom(request), new Position(request.line - 1, request.column - 1), __token());
      if (!hover) return null;
      const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(__markdown).filter(Boolean).join("\n\n---\n\n");
      return hover.range ? { contents, range: __toSableRange(hover.range) } : contents;
    }),
  );
}

function registerDocumentFormattingEditProvider(selector, provider) {
  return __register(selector, (language) =>
    __sable.languages.registerFormatter(language, async (request) => {
      const document = __documentFrom(request);
      const edits = await provider.provideDocumentFormattingEdits(document, { tabSize: 4, insertSpaces: true }, __token());
      return edits?.length ? __applyEdits(document, edits) : request.text;
    }),
  );
}

function registerDocumentRangeFormattingEditProvider(selector, provider) {
  return __register(selector, (language) =>
    __sable.languages.registerFormatter(language, async (request) => {
      const document = __documentFrom(request);
      const all = new Range(new Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
      const edits = await provider.provideDocumentRangeFormattingEdits(document, all, { tabSize: 4, insertSpaces: true }, __token());
      return edits?.length ? __applyEdits(document, edits) : request.text;
    }),
  );
}

const __severity = ["error", "warning", "info", "hint"];

function createDiagnosticCollection(name = __extension.name) {
  const entries = new Map();
  const publish = (path) => {
    const diagnostics = (entries.get(path) ?? []).map((diagnostic) => ({
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      message: diagnostic.message,
      severity: __severity[diagnostic.severity ?? 0] ?? "error",
      source: diagnostic.source ?? name,
    }));
    void __sable.languages.setDiagnostics(path, diagnostics).catch((error) => console.error(error));
  };
  return {
    name,
    set(uriOrEntries, diagnostics) {
      if (Array.isArray(uriOrEntries)) {
        for (const [uri, list] of uriOrEntries) this.set(uri, list);
        return;
      }
      const path = __pathOf(uriOrEntries);
      entries.set(path, diagnostics ?? []);
      publish(path);
    },
    delete(uri) {
      const path = __pathOf(uri);
      entries.delete(path);
      void __sable.languages.clearDiagnostics(path);
    },
    clear() {
      entries.clear();
      void __sable.languages.clearDiagnostics();
    },
    get: (uri) => entries.get(__pathOf(uri)),
    has: (uri) => entries.has(__pathOf(uri)),
    forEach(callback) {
      for (const [path, list] of entries) callback(Uri.file(path), list, this);
    },
    dispose() {
      this.clear();
    },
  };
}

const __ignoredProvider = (what) => () => (__unsupported(what), __noop());

/** A provider registered with Sable's host for `kind`. */
function __provider(kind, selector, provide) {
  return __register(selector, (language) =>
    __sable.languages.registerProvider(kind, language, async (request) => {
      try {
        // Providers often read window.activeTextEditor (Markdown All in
        // One's code lenses): make sure it's the file being asked about.
        if (__active?.document.fileName !== request.path) await __refresh();
        const document = __documentFrom(request);
        const position = request.position ? new Position(request.position.line, request.position.character) : undefined;
        return (await provide(document, position, request)) ?? null;
      } catch (error) {
        console.error(error);
        return null;
      }
    }),
  );
}

const __locations = (result) =>
  (Array.isArray(result) ? result : result ? [result] : []).map((item) =>
    item.targetUri
      ? { path: __pathOf(item.targetUri), range: __plainRange(item.targetSelectionRange ?? item.targetRange) }
      : { path: __pathOf(item.uri), range: __plainRange(item.range) },
  );

const __diagnosticsFrom = (request) =>
  (request.diagnostics ?? []).map((plain) => {
    const diagnostic = new Diagnostic(__rangeFrom(plain.range), plain.message, { 8: 0, 4: 1, 2: 2, 1: 3 }[plain.severity] ?? 0);
    diagnostic.source = plain.source;
    diagnostic.code = plain.code;
    return diagnostic;
  });

function __symbol(symbol) {
  if (symbol.location) return { name: symbol.name, detail: symbol.containerName ?? "", kind: symbol.kind, range: __plainRange(symbol.location.range), selectionRange: __plainRange(symbol.location.range), children: [] };
  return { name: symbol.name, detail: symbol.detail ?? "", kind: symbol.kind, range: __plainRange(symbol.range), selectionRange: __plainRange(symbol.selectionRange ?? symbol.range), children: (symbol.children ?? []).map(__symbol) };
}

const __labelText = (label) => (typeof label === "string" ? label : (label ?? []).map((part) => part.value).join(""));

/** Diagnostics everyone set (for getDiagnostics, which is synchronous). */
let __allDiagnostics = new Map();
const __onDidChangeDiagnostics = new EventEmitter();
async function __refreshDiagnostics() {
  try {
    const list = await __sable.languages.getDiagnostics();
    __allDiagnostics = new Map(list.map((entry) => [entry.path, entry.diagnostics.map((plain) => {
      const diagnostic = new Diagnostic(__rangeFrom(plain.range), plain.message, plain.severity);
      diagnostic.source = plain.source;
      diagnostic.code = plain.code;
      return diagnostic;
    })]));
    __onDidChangeDiagnostics.fire({ uris: [...__allDiagnostics.keys()].map((path) => Uri.file(path)) });
  } catch {
    /* not available */
  }
}

const languages = {
  registerCompletionItemProvider,
  registerHoverProvider,
  registerDocumentFormattingEditProvider,
  registerDocumentRangeFormattingEditProvider,
  createDiagnosticCollection,
  getDiagnostics: (uri) => (uri ? __allDiagnostics.get(__pathOf(uri)) ?? [] : [...__allDiagnostics].map(([path, list]) => [Uri.file(path), list])),
  getLanguages: async () => ["plaintext", "javascript", "typescript", "python", "rust", "go", "java", "json", "markdown", "html", "css"],
  match: (selector, document) => (__languages(selector).some((id) => id === "*" || id === document.languageId) ? 10 : 0),
  setTextDocumentLanguage: async (document) => document,
  setLanguageConfiguration: () => __noop(),
  onDidChangeDiagnostics: __onDidChangeDiagnostics.event,
  registerDefinitionProvider: (selector, provider) => __provider("definition", selector, async (d, p) => __locations(await provider.provideDefinition(d, p, __token()))),
  registerDeclarationProvider: (selector, provider) => __provider("declaration", selector, async (d, p) => __locations(await provider.provideDeclaration(d, p, __token()))),
  registerTypeDefinitionProvider: (selector, provider) => __provider("typeDefinition", selector, async (d, p) => __locations(await provider.provideTypeDefinition(d, p, __token()))),
  registerImplementationProvider: (selector, provider) => __provider("implementation", selector, async (d, p) => __locations(await provider.provideImplementation(d, p, __token()))),
  registerReferenceProvider: (selector, provider) =>
    __provider("references", selector, async (d, p, r) => __locations(await provider.provideReferences(d, p, { includeDeclaration: r.includeDeclaration !== false }, __token()))),
  registerDocumentHighlightProvider: (selector, provider) =>
    __provider("documentHighlight", selector, async (d, p) => ((await provider.provideDocumentHighlights(d, p, __token())) ?? []).map((h) => ({ range: __plainRange(h.range), kind: h.kind }))),
  registerDocumentSymbolProvider: (selector, provider) =>
    __provider("documentSymbol", selector, async (d) => ((await provider.provideDocumentSymbols(d, __token())) ?? []).map(__symbol)),
  registerWorkspaceSymbolProvider: __ignoredProvider("Workspace symbol providers"),
  registerCodeActionsProvider: (selector, provider) =>
    __provider("codeAction", selector, async (d, _p, r) => {
      const range = __rangeFrom(r.range);
      const context = { diagnostics: __diagnosticsFrom(r), only: r.only ? new CodeActionKind(r.only) : undefined, triggerKind: CodeActionTriggerKind.Invoke };
      const actions = (await provider.provideCodeActions(d, range, context, __token())) ?? [];
      const out = [];
      for (let action of actions) {
        if (typeof action.command === "string") {
          out.push({ title: action.title, command: __plainCommand(action) });
          continue;
        }
        if (!action.edit && !action.command && provider.resolveCodeAction) action = (await provider.resolveCodeAction(action, __token())) ?? action;
        out.push({ title: action.title, kind: action.kind?.value, isPreferred: action.isPreferred, edit: action.edit ? __plainWorkspaceEdit(action.edit) : undefined, command: __plainCommand(action.command) });
      }
      return out;
    }),
  registerCodeLensProvider(selector, provider) {
    provider.onDidChangeCodeLenses?.(() => void __sable.languages.refreshCodeLenses().catch(() => {}));
    return __provider("codeLens", selector, async (d) => {
      const lenses = (await provider.provideCodeLenses(d, __token())) ?? [];
      const out = [];
      for (let lens of lenses) {
        if (!lens.command && provider.resolveCodeLens) lens = (await provider.resolveCodeLens(lens, __token())) ?? lens;
        if (lens.command) out.push({ range: __plainRange(lens.range), command: __plainCommand(lens.command) });
      }
      return out;
    });
  },
  registerRenameProvider: (selector, provider) =>
    __provider("rename", selector, async (d, p, r) => {
      if (r.prepare) {
        if (!provider.prepareRename) return null;
        const prepared = await provider.prepareRename(d, p, __token());
        if (!prepared) return null;
        return prepared instanceof Range ? { range: __plainRange(prepared) } : { range: __plainRange(prepared.range), placeholder: prepared.placeholder };
      }
      return __plainWorkspaceEdit(await provider.provideRenameEdits(d, p, r.newName, __token()));
    }),
  registerOnTypeFormattingEditProvider: __ignoredProvider("On-type formatting"),
  registerSignatureHelpProvider: (selector, provider) =>
    __provider("signatureHelp", selector, async (d, p) => {
      const help = await provider.provideSignatureHelp(d, p, __token(), { triggerKind: SignatureHelpTriggerKind.Invoke, isRetrigger: false });
      if (!help) return null;
      return {
        activeSignature: help.activeSignature ?? 0,
        activeParameter: help.activeParameter ?? 0,
        signatures: (help.signatures ?? []).map((signature) => ({
          label: signature.label,
          documentation: signature.documentation ? __markdown(signature.documentation) : undefined,
          parameters: (signature.parameters ?? []).map((parameter) => ({ label: parameter.label, documentation: parameter.documentation ? __markdown(parameter.documentation) : undefined })),
        })),
      };
    }),
  registerDocumentLinkProvider: (selector, provider) =>
    __provider("documentLink", selector, async (d) => {
      const links = (await provider.provideDocumentLinks(d, __token())) ?? [];
      const out = [];
      for (let link of links) {
        if (!link.target && provider.resolveDocumentLink) link = (await provider.resolveDocumentLink(link, __token())) ?? link;
        if (link.target) out.push({ range: __plainRange(link.range), target: String(link.target), tooltip: link.tooltip });
      }
      return out;
    }),
  registerColorProvider: (selector, provider) =>
    __provider("color", selector, async (d, _p, r) => {
      if (r.op === "presentations") {
        const presentations = await provider.provideColorPresentations(new Color(r.color.red, r.color.green, r.color.blue, r.color.alpha), { document: d, range: __rangeFrom(r.range) }, __token());
        return (presentations ?? []).map((presentation) => ({ label: presentation.label }));
      }
      return ((await provider.provideDocumentColors(d, __token())) ?? []).map((info) => ({ range: __plainRange(info.range), color: { red: info.color.red, green: info.color.green, blue: info.color.blue, alpha: info.color.alpha } }));
    }),
  registerFoldingRangeProvider: (selector, provider) =>
    __provider("foldingRange", selector, async (d) =>
      ((await provider.provideFoldingRanges(d, {}, __token())) ?? []).map((range) => ({ start: range.start, end: range.end, kind: { 1: "comment", 2: "imports", 3: "region" }[range.kind] }))),
  registerSelectionRangeProvider: __ignoredProvider("Selection range providers"),
  registerCallHierarchyProvider: __ignoredProvider("Call hierarchy"),
  registerTypeHierarchyProvider: __ignoredProvider("Type hierarchy"),
  registerInlayHintsProvider: (selector, provider) =>
    __provider("inlayHint", selector, async (d, _p, r) =>
      ((await provider.provideInlayHints(d, __rangeFrom(r.range), __token())) ?? []).map((hint) => ({
        position: __plainPosition(hint.position),
        label: __labelText(hint.label),
        kind: hint.kind,
        paddingLeft: hint.paddingLeft,
        paddingRight: hint.paddingRight,
        tooltip: typeof hint.tooltip === "string" ? hint.tooltip : hint.tooltip?.value,
      }))),
  registerInlineCompletionItemProvider: __ignoredProvider("Inline completions"),
  registerDocumentSemanticTokensProvider: __ignoredProvider("Semantic tokens"),
  registerDocumentRangeSemanticTokensProvider: __ignoredProvider("Semantic tokens"),
  registerLinkedEditingRangeProvider: __ignoredProvider("Linked editing"),
  registerEvaluatableExpressionProvider: __ignoredProvider("Debug expressions"),
};

// --- Everything else -----------------------------------------------------------------------------

const env = {
  appName: "Sable",
  appRoot: "",
  appHost: "desktop",
  language: "en",
  uriScheme: "sable",
  machineId: "sable",
  sessionId: String(Date.now()),
  shell: "",
  remoteName: undefined,
  uiKind: UIKind.Desktop,
  isNewAppInstall: false,
  isTelemetryEnabled: false,
  onDidChangeTelemetryEnabled: new EventEmitter().event,
  onDidChangeShell: new EventEmitter().event,
  clipboard: {
    readText: () => __sable.env.clipboard.readText(),
    writeText: (text) => __sable.env.clipboard.writeText(String(text)),
  },
  async openExternal(uri) {
    await __sable.env.openExternal(String(uri));
    return true;
  },
  asExternalUri: async (uri) => uri,
  createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: new EventEmitter().event, isUsageEnabled: false, isErrorsEnabled: false }),
};

// VS Code's built-in language extensions (comment syntax), for
// extensions that read them (Better Comments, TODO highlighters…).
const __COMMENTS = {
  javascript: ["//", ["/*", "*/"]], typescript: ["//", ["/*", "*/"]], javascriptreact: ["//", ["/*", "*/"]], typescriptreact: ["//", ["/*", "*/"]],
  json: ["//", ["/*", "*/"]], jsonc: ["//", ["/*", "*/"]], java: ["//", ["/*", "*/"]], c: ["//", ["/*", "*/"]], cpp: ["//", ["/*", "*/"]],
  csharp: ["//", ["/*", "*/"]], go: ["//", ["/*", "*/"]], rust: ["//", ["/*", "*/"]], swift: ["//", ["/*", "*/"]], kotlin: ["//", ["/*", "*/"]],
  scala: ["//", ["/*", "*/"]], dart: ["//", ["/*", "*/"]], php: ["//", ["/*", "*/"]], "objective-c": ["//", ["/*", "*/"]], groovy: ["//", ["/*", "*/"]],
  zig: ["//", null], fsharp: ["//", ["(*", "*)"]], css: [null, ["/*", "*/"]], scss: ["//", ["/*", "*/"]], less: ["//", ["/*", "*/"]],
  python: ["#", ['"""', '"""']], ruby: ["#", ["=begin", "=end"]], shell: ["#", null], shellscript: ["#", null], yaml: ["#", null], toml: ["#", null],
  dockerfile: ["#", null], makefile: ["#", null], perl: ["#", null], r: ["#", null], julia: ["#", ["#=", "=#"]], elixir: ["#", null],
  powershell: ["#", ["<#", "#>"]], coffeescript: ["#", ["###", "###"]], nim: ["#", null], ini: [";", null], erlang: ["%", null], matlab: ["%", ["%{", "%}"]],
  sql: ["--", ["/*", "*/"]], lua: ["--", ["--[[", "]]"]], haskell: ["--", ["{-", "-}"]], ocaml: [null, ["(*", "*)"]], clojure: [";", null], lisp: [";", null],
  vb: ["'", null], html: [null, ["<!--", "-->"]], xml: [null, ["<!--", "-->"]], markdown: [null, ["<!--", "-->"]], vue: [null, ["<!--", "-->"]],
  svelte: [null, ["<!--", "-->"]], handlebars: [null, ["{{!--", "--}}"]], twig: [null, ["{#", "#}"]], razor: [null, ["@*", "*@"]],
};
const __BUILTIN_VIRTUAL = "/__sable_builtin_languages";
let __builtinPath = __BUILTIN_VIRTUAL;
const __builtinConfig = (id) => {
  const [lineComment, blockComment] = __COMMENTS[id] ?? [null, null];
  return JSON.stringify({ comments: { ...(lineComment ? { lineComment } : {}), ...(blockComment ? { blockComment } : {}) } });
};
const __builtinExtension = () => ({
  id: "vscode.sable-languages",
  extensionUri: Uri.file(__builtinPath),
  extensionPath: __builtinPath,
  isActive: true,
  extensionKind: 1,
  exports: undefined,
  activate: async () => undefined,
  packageJSON: {
    name: "sable-languages",
    publisher: "vscode",
    contributes: { languages: Object.keys(__COMMENTS).map((id) => ({ id, configuration: `./${id}.language-configuration.json` })) },
  },
});
/** Under Node the built-in configurations are real files (extensions read them with fs). */
function __writeBuiltinLanguages() {
  try {
    const fs = require("fs");
    const dir = require("path").join(require("os").tmpdir(), "sable-builtin-languages");
    fs.mkdirSync(dir, { recursive: true });
    for (const id of Object.keys(__COMMENTS)) fs.writeFileSync(require("path").join(dir, `${id}.language-configuration.json`), __builtinConfig(id));
    __builtinPath = dir;
  } catch (error) {
    console.warn(error);
  }
}
/** The sandbox: the virtual built-in files, read through workspace.fs. */
function __builtinFile(path) {
  if (!path.startsWith(`${__BUILTIN_VIRTUAL}/`)) return null;
  const id = path.slice(__BUILTIN_VIRTUAL.length + 1).replace(/\.language-configuration\.json$/, "");
  return __builtinConfig(id);
}

const __self = () => ({
  id: __extension.id,
  extensionUri: Uri.file(__context?.extensionPath ?? ""),
  extensionPath: __context?.extensionPath ?? "",
  isActive: true,
  packageJSON: __extension.packageJSON,
  extensionKind: 1,
  exports: __exports,
  activate: async () => __exports,
});

const extensions = {
  getExtension: (id) =>
    String(id).toLowerCase() === __extension.id.toLowerCase() ? __self() : String(id) === "vscode.sable-languages" ? __builtinExtension() : undefined,
  get all() {
    return [__self(), __builtinExtension()];
  },
  onDidChange: new EventEmitter().event,
};

const __disabledNamespace = (name) =>
  new Proxy(
    {},
    {
      get: (_, property) => {
        if (typeof property !== "string" || property === "then") return undefined;
        if (property.startsWith("onDid") || property.startsWith("onWill")) return new EventEmitter().event;
        return () => (__unsupported(`vscode.${name}`), __noop());
      },
    },
  );

// --- The rest of VS Code's API types ---------------------------------------------------------
// Classes and enums extensions construct or extend at load time (language
// clients extend CallHierarchyItem, linters build Tasks, Rainbow CSV builds
// semantic tokens…), so they load even where Sable has no equivalent.

/** A class whose constructor stores its arguments as `fields`. */
const __dataClass = (name, fields, extra = {}) => {
  const cls = {
    [name]: class {
      constructor(...args) {
        fields.forEach((field, index) => {
          if (args[index] !== undefined) this[field] = args[index];
        });
      }
    },
  }[name];
  Object.assign(cls.prototype, extra);
  return cls;
};

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}
class SemanticTokens {
  constructor(data, resultId) {
    this.data = data;
    this.resultId = resultId;
  }
}
/** VS Code's encoding: per token, 5 integers relative to the previous token. */
class SemanticTokensBuilder {
  constructor(legend) {
    this._legend = legend;
    this._tokens = [];
  }
  push(a, b, c, d, e) {
    if (typeof a === "number") {
      this._tokens.push([a, b, c, d, e ?? 0]);
      return;
    }
    // push(range, tokenType, tokenModifiers)
    const type = this._legend?.tokenTypes.indexOf(b) ?? -1;
    if (type < 0 || !a.isSingleLine) throw new Error("Unknown token type or a multi-line range");
    const modifiers = (c ?? []).reduce((bits, modifier) => {
      const index = this._legend.tokenModifiers.indexOf(modifier);
      return index < 0 ? bits : bits | (1 << index);
    }, 0);
    this._tokens.push([a.start.line, a.start.character, a.end.character - a.start.character, type, modifiers]);
  }
  build(resultId) {
    const tokens = [...this._tokens].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const data = new Uint32Array(tokens.length * 5);
    let line = 0;
    let character = 0;
    tokens.forEach(([tokenLine, tokenCharacter, length, type, modifiers], index) => {
      data.set([tokenLine - line, tokenLine === line ? tokenCharacter - character : tokenCharacter, length, type, modifiers], index * 5);
      line = tokenLine;
      character = tokenCharacter;
    });
    return new SemanticTokens(data, resultId);
  }
}
const SemanticTokensEdit = __dataClass("SemanticTokensEdit", ["start", "deleteCount", "data"]);
const SemanticTokensEdits = __dataClass("SemanticTokensEdits", ["edits", "resultId"]);

class SnippetTextEdit {
  constructor(range, snippet) {
    this.range = range;
    this.snippet = snippet;
  }
  static replace(range, snippet) {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position, snippet) {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
}

class TaskGroup {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.isDefault = undefined;
  }
}
TaskGroup.Clean = new TaskGroup("clean", "Clean");
TaskGroup.Build = new TaskGroup("build", "Build");
TaskGroup.Rebuild = new TaskGroup("rebuild", "Rebuild");
TaskGroup.Test = new TaskGroup("test", "Test");
class Task {
  constructor(definition, ...rest) {
    // (definition, scope, name, source, execution?, problemMatchers?) or the
    // old (definition, name, source, execution?, problemMatchers?).
    if (typeof rest[0] === "string") rest.unshift(undefined);
    const [scope, name, source, execution, problemMatchers] = rest;
    Object.assign(this, { definition, scope, name, source, execution, problemMatchers: problemMatchers ?? [] });
    this.presentationOptions = {};
    this.runOptions = {};
    this.isBackground = false;
  }
}
class ShellExecution {
  constructor(commandOrLine, argsOrOptions, options) {
    if (Array.isArray(argsOrOptions)) Object.assign(this, { command: commandOrLine, args: argsOrOptions, options });
    else Object.assign(this, { commandLine: commandOrLine, options: argsOrOptions });
  }
}
class ProcessExecution {
  constructor(process, argsOrOptions, options) {
    Object.assign(this, Array.isArray(argsOrOptions) ? { process, args: argsOrOptions, options } : { process, args: [], options: argsOrOptions });
  }
}
const CustomExecution = __dataClass("CustomExecution", ["callback"]);

class DataTransferItem {
  constructor(value) {
    this.value = value;
  }
  async asString() {
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile() {
    return undefined;
  }
}
class DataTransfer {
  constructor() {
    this._items = new Map();
  }
  get(mimeType) {
    return this._items.get(mimeType.toLowerCase());
  }
  set(mimeType, value) {
    this._items.set(mimeType.toLowerCase(), value);
  }
  forEach(callback, thisArg) {
    for (const [mimeType, item] of this._items) callback.call(thisArg, item, mimeType, this);
  }
  [Symbol.iterator]() {
    return this._items[Symbol.iterator]();
  }
}

class TestMessage {
  constructor(message) {
    this.message = message;
  }
  static diff(message, expected, actual) {
    return Object.assign(new TestMessage(message), { expectedOutput: expected, actualOutput: actual });
  }
}

const __moreApi = {
  SemanticTokensLegend, SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits, SnippetTextEdit,
  Task, TaskGroup, ShellExecution, ProcessExecution, CustomExecution, DataTransferItem, DataTransfer, TestMessage,
  EvaluatableExpression: __dataClass("EvaluatableExpression", ["range", "expression"]),
  InlineValueText: __dataClass("InlineValueText", ["range", "text"]),
  InlineValueVariableLookup: __dataClass("InlineValueVariableLookup", ["range", "variableName", "caseSensitiveLookup"]),
  InlineValueEvaluatableExpression: __dataClass("InlineValueEvaluatableExpression", ["range", "expression"]),
  NotebookEdit: __dataClass("NotebookEdit", ["range", "newCells"]),
  InlineCompletionList: __dataClass("InlineCompletionList", ["items"]),
  InlineCompletionItem: __dataClass("InlineCompletionItem", ["insertText", "range", "command"]),
  InlayHintLabelPart: __dataClass("InlayHintLabelPart", ["value"]),
  CallHierarchyItem: __dataClass("CallHierarchyItem", ["kind", "name", "detail", "uri", "range", "selectionRange"]),
  CallHierarchyIncomingCall: __dataClass("CallHierarchyIncomingCall", ["from", "fromRanges"]),
  CallHierarchyOutgoingCall: __dataClass("CallHierarchyOutgoingCall", ["to", "fromRanges"]),
  TypeHierarchyItem: __dataClass("TypeHierarchyItem", ["kind", "name", "detail", "uri", "range", "selectionRange"]),
  LinkedEditingRanges: __dataClass("LinkedEditingRanges", ["ranges", "wordPattern"]),
  DocumentDropEdit: __dataClass("DocumentDropEdit", ["insertText"]),
  DiagnosticRelatedInformation: __dataClass("DiagnosticRelatedInformation", ["location", "message"]),
  TerminalLink: __dataClass("TerminalLink", ["startIndex", "length", "tooltip"]),
  TerminalProfile: __dataClass("TerminalProfile", ["options"]),
  FileDecoration: __dataClass("FileDecoration", ["badge", "tooltip", "color"]),
  NotebookRange: __dataClass("NotebookRange", ["start", "end"]),
  NotebookCellOutputItem: __dataClass("NotebookCellOutputItem", ["data", "mime"]),
  NotebookCellOutput: __dataClass("NotebookCellOutput", ["items", "metadata"]),
  NotebookCellData: __dataClass("NotebookCellData", ["kind", "value", "languageId"]),
  NotebookData: __dataClass("NotebookData", ["cells"]),
  NotebookCellStatusBarItem: __dataClass("NotebookCellStatusBarItem", ["text", "alignment"]),
  DebugAdapterExecutable: __dataClass("DebugAdapterExecutable", ["command", "args", "options"]),
  DebugAdapterServer: __dataClass("DebugAdapterServer", ["port", "host"]),
  DebugAdapterNamedPipeServer: __dataClass("DebugAdapterNamedPipeServer", ["path"]),
  DebugAdapterInlineImplementation: __dataClass("DebugAdapterInlineImplementation", ["implementation"]),
  Breakpoint: __dataClass("Breakpoint", ["enabled", "condition", "hitCondition", "logMessage"]),
  SourceBreakpoint: __dataClass("SourceBreakpoint", ["location", "enabled", "condition", "hitCondition", "logMessage"]),
  FunctionBreakpoint: __dataClass("FunctionBreakpoint", ["functionName", "enabled", "condition", "hitCondition", "logMessage"]),
  DebugThread: __dataClass("DebugThread", ["session", "threadId"]),
  DebugStackFrame: __dataClass("DebugStackFrame", ["session", "threadId", "frameId"]),
  TestTag: __dataClass("TestTag", ["id"]),
  TestRunRequest: __dataClass("TestRunRequest", ["include", "exclude", "profile", "continuous"]),
  TestMessageStackFrame: __dataClass("TestMessageStackFrame", ["label", "uri", "position"]),
  TestCoverageCount: __dataClass("TestCoverageCount", ["covered", "total"]),
  FileCoverage: __dataClass("FileCoverage", ["uri", "statementCoverage", "branchCoverage", "declarationCoverage"]),
  StatementCoverage: __dataClass("StatementCoverage", ["executed", "location", "branches"]),
  BranchCoverage: __dataClass("BranchCoverage", ["executed", "location", "label"]),
  DeclarationCoverage: __dataClass("DeclarationCoverage", ["name", "executed", "location"]),
  TabInputText: __dataClass("TabInputText", ["uri"]),
  TabInputTextDiff: __dataClass("TabInputTextDiff", ["original", "modified"]),
  TabInputCustom: __dataClass("TabInputCustom", ["uri", "viewType"]),
  TabInputWebview: __dataClass("TabInputWebview", ["viewType"]),
  TabInputNotebook: __dataClass("TabInputNotebook", ["uri", "notebookType"]),
  TabInputNotebookDiff: __dataClass("TabInputNotebookDiff", ["original", "modified", "notebookType"]),
  TabInputTerminal: __dataClass("TabInputTerminal", []),
  TelemetryTrustedValue: __dataClass("TelemetryTrustedValue", ["value"]),
  LanguageModelError: class LanguageModelError extends Error {},
  QuickInputButtons: { Back: { iconPath: new ThemeIcon("arrow-left") } },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  TextEditorLineNumbersStyle: { Off: 0, On: 1, Relative: 2, Interval: 3 },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  SymbolTag: { Deprecated: 1 },
  CompletionItemTag: { Deprecated: 1 },
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
  SyntaxTokenType: { Other: 0, Comment: 1, String: 2, RegEx: 3 },
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
  TaskScope: { Global: 1, Workspace: 2 },
  FilePermission: { Readonly: 1 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookControllerAffinity: { Default: 1, Preferred: 2 },
  NotebookCellStatusBarAlignment: { Left: 1, Right: 2 },
  DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
  DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  ChatResultFeedbackKind: { Unhelpful: 0, Helpful: 1 },
  chat: __disabledNamespace("chat"),
  lm: __disabledNamespace("lm"),
};
Object.assign(ViewColumn, { Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 });
Object.assign(TextEditorCursorStyle, { LineThin: 4, BlockOutline: 5, UnderlineThin: 6 });
// Namespace members that have nothing to do in Sable (events that never
// fire, registrations that are accepted).
const __never = () => new EventEmitter().event;
Object.assign(env, { logLevel: LogLevel.Info, onDidChangeLogLevel: __never() });
for (const name of [
  "onDidChangeTextEditorViewColumn", "onDidChangeVisibleNotebookEditors", "onDidChangeActiveNotebookEditor", "onDidChangeNotebookEditorSelection",
  "onDidChangeNotebookEditorVisibleRanges", "onDidChangeTerminalState", "onDidChangeTerminalShellIntegration",
  "onDidStartTerminalShellExecution", "onDidEndTerminalShellExecution",
]) window[name] ??= __never();
for (const name of ["onDidChangeNotebookDocument", "onWillSaveNotebookDocument", "onDidSaveNotebookDocument", "onDidOpenNotebookDocument", "onDidCloseNotebookDocument", "onWillCreateFiles", "onWillDeleteFiles", "onWillRenameFiles"]) {
  workspace[name] ??= __never();
}
Object.assign(window, {
  visibleNotebookEditors: [],
  activeNotebookEditor: undefined,
  activeTerminal: undefined,
  showWorkspaceFolderPick: async () => __workspaceFolders()?.[0],
  showOpenDialog: async () => (__unsupported("window.showOpenDialog"), undefined),
  showSaveDialog: async () => (__unsupported("window.showSaveDialog"), undefined),
  showNotebookDocument: async () => (__unsupported("Notebooks"), undefined),
  withScmProgress: async (task) => task({ report() {} }),
  registerWebviewPanelSerializer: () => __noop(),
  registerTerminalProfileProvider: () => __noop(),
});
Object.assign(workspace, {
  workspaceFile: undefined,
  notebookDocuments: [],
  updateWorkspaceFolders: () => false,
  save: async (uri) => uri,
  saveAs: async () => undefined,
  openNotebookDocument: async () => (__unsupported("Notebooks"), undefined),
  registerNotebookSerializer: () => (__unsupported("Notebooks"), __noop()),
});
Object.assign(languages, {
  registerInlineValuesProvider: __ignoredProvider("Inline values"),
  registerDocumentDropEditProvider: __ignoredProvider("Drop edits"),
  createLanguageStatusItem: (id, selector) => ({
    id, selector, name: undefined, severity: 0, text: "", detail: undefined, busy: false, command: undefined, accessibilityInformation: undefined,
    dispose() {},
  }),
});

const vscode = {
  ...__moreApi,
  version: "1.107.0",
  Disposable, EventEmitter, CancellationTokenSource, Position, Range, Selection, TextEdit, Uri, WorkspaceEdit,
  Diagnostic, DiagnosticSeverity, CompletionItem, CompletionItemKind, CompletionList, CompletionTriggerKind,
  SnippetString, MarkdownString, Hover, ThemeColor, ThemeIcon, CodeAction, CodeActionKind, TreeItem,
  Location, DocumentSymbol, SymbolInformation, DocumentHighlight, CodeLens, DocumentLink, FoldingRange, InlayHint,
  SignatureHelp, SignatureInformation, ParameterInformation, Color, ColorInformation, ColorPresentation, SelectionRange,
  SymbolKind, DocumentHighlightKind, FoldingRangeKind, InlayHintKind, SignatureHelpTriggerKind, CodeActionTriggerKind,
  TextDocumentSaveReason,
  StatusBarAlignment, ConfigurationTarget, EndOfLine, TextEditorRevealType, ViewColumn, ProgressLocation,
  QuickPickItemKind, TreeItemCollapsibleState, ExtensionMode, UIKind, FileType, OverviewRulerLane,
  DecorationRangeBehavior, TextEditorCursorStyle, LogLevel,
  CancellationError: class CancellationError extends Error {},
  FileSystemError: class FileSystemError extends Error {
    static FileNotFound(uri) { return new this(`File not found: ${__pathOf(uri)}`); }
    static FileExists(uri) { return new this(`File exists: ${__pathOf(uri)}`); }
    static NoPermissions(uri) { return new this(`No permission: ${__pathOf(uri)}`); }
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = __pathOf(base);
      this.pattern = pattern;
    }
  },
  commands, window, workspace, languages, env, extensions,
  debug: __disabledNamespace("debug"),
  tasks: __disabledNamespace("tasks"),
  scm: __disabledNamespace("scm"),
  comments: __disabledNamespace("comments"),
  authentication: __disabledNamespace("authentication"),
  notebooks: __disabledNamespace("notebooks"),
  tests: __disabledNamespace("tests"),
  l10n: { t: (message, ...args) => String(typeof message === "object" ? message.message : message).replace(/\{(\d+)\}/g, (_, index) => String(args[index] ?? "")) },
};

// --- Node's basics, as far as a sandboxed worker can offer them --------------------------------

const __path = {
  sep: "/",
  delimiter: ":",
  normalize(path) {
    const absolute = path.startsWith("/");
    const parts = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
        else if (!absolute) parts.push("..");
      } else parts.push(part);
    }
    return (absolute ? "/" : "") + parts.join("/") || (absolute ? "/" : ".");
  },
  join: (...parts) => __path.normalize(parts.filter((part) => part !== "").join("/")),
  resolve: (...parts) => {
    let resolved = "";
    for (const part of parts) resolved = part.startsWith("/") ? part : `${resolved}/${part}`;
    return __path.normalize(resolved.startsWith("/") ? resolved : `/${resolved}`);
  },
  isAbsolute: (path) => path.startsWith("/"),
  dirname: (path) => {
    const index = path.replace(/\/+$/, "").lastIndexOf("/");
    return index < 0 ? "." : index === 0 ? "/" : path.slice(0, index);
  },
  basename: (path, extension) => {
    const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
    return extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base;
  },
  extname: (path) => {
    const base = __path.basename(path);
    const index = base.lastIndexOf(".");
    return index <= 0 ? "" : base.slice(index);
  },
  relative: (from, to) => {
    const a = __path.resolve(from).split("/").filter(Boolean);
    const b = __path.resolve(to).split("/").filter(Boolean);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return [...a.slice(common).map(() => ".."), ...b.slice(common)].join("/");
  },
  parse: (path) => ({ root: path.startsWith("/") ? "/" : "", dir: __path.dirname(path), base: __path.basename(path), ext: __path.extname(path), name: __path.basename(path, __path.extname(path)) }),
  format: (parts) => `${parts.dir ? `${parts.dir}/` : ""}${parts.base ?? `${parts.name ?? ""}${parts.ext ?? ""}`}`,
};
__path.posix = __path;
__path.win32 = __path;

class __NodeEventEmitter {
  constructor() {
    this._events = new Map();
  }
  on(name, listener) {
    this._events.set(name, [...(this._events.get(name) ?? []), listener]);
    return this;
  }
  addListener(name, listener) {
    return this.on(name, listener);
  }
  once(name, listener) {
    const wrapper = (...args) => {
      this.off(name, wrapper);
      listener(...args);
    };
    return this.on(name, wrapper);
  }
  off(name, listener) {
    this._events.set(name, (this._events.get(name) ?? []).filter((entry) => entry !== listener));
    return this;
  }
  removeListener(name, listener) {
    return this.off(name, listener);
  }
  removeAllListeners(name) {
    if (name) this._events.delete(name);
    else this._events.clear();
    return this;
  }
  emit(name, ...args) {
    const listeners = this._events.get(name) ?? [];
    listeners.forEach((listener) => listener(...args));
    return listeners.length > 0;
  }
}

const __process = {
  env: {},
  platform: "linux",
  arch: "x64",
  version: "v18.0.0",
  versions: { node: "18.0.0" },
  argv: [],
  execArgv: [],
  pid: 1,
  cwd: () => __root() ?? "/",
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  hrtime: Object.assign(() => [Math.floor(performance.now() / 1000), 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
  on() { return __process; },
  once() { return __process; },
  off() { return __process; },
  emitWarning: (warning) => console.warn(warning),
};

const __builtins = {
  vscode,
  path: __path,
  "path/posix": __path,
  events: Object.assign(__NodeEventEmitter, { EventEmitter: __NodeEventEmitter }),
  util: {
    format: (...args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    inspect: (value) => JSON.stringify(value),
    promisify: (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value)))),
    inherits: (child, parent) => Object.setPrototypeOf(child.prototype, parent.prototype),
    deprecate: (fn) => fn,
    isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    TextEncoder,
    TextDecoder,
    types: { isPromise: (value) => value instanceof Promise },
  },
  os: { EOL: "\n", platform: () => "linux", homedir: () => "/", tmpdir: () => "/tmp", hostname: () => "sable", cpus: () => [], type: () => "Linux", release: () => "", arch: () => "x64" },
  process: __process,
  assert: Object.assign((value, message) => { if (!value) throw new Error(message ?? "Assertion failed"); }, { ok: (value, message) => { if (!value) throw new Error(message ?? "Assertion failed"); } }),
  url: { URL, URLSearchParams, fileURLToPath: (url) => decodeURIComponent(new URL(url).pathname), pathToFileURL: (path) => new URL(`file://${encodeURI(path)}`) },
  timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (callback, ...args) => setTimeout(callback, 0, ...args) },
  string_decoder: { StringDecoder: class { constructor() { this._decoder = new TextDecoder(); } write(bytes) { return this._decoder.decode(bytes, { stream: true }); } end() { return ""; } } },
};

/** A module Sable can't offer: loading it works; using it explains why it fails. */
function __unavailable(name) {
  const fail = () => {
    throw new Error(`The extension uses Node's "${name}", which isn't available in Sable (plugins run sandboxed, without Node).`);
  };
  return new Proxy(fail, { get: (_, property) => (property === "__esModule" ? false : property === "default" ? fail : property === "then" ? undefined : fail), apply: fail, construct: fail });
}

// --- CommonJS loader over the extension's modules ---------------------------------------------------

function __makeRequire(modules, cache, from) {
  const resolveFile = (path) => {
    for (const candidate of [path, `${path}.js`, `${path}.cjs`, `${path}.json`, `${path}/index.js`]) {
      if (modules[candidate]) return candidate;
    }
    if (modules[`${path}/package.json`]) {
      const manifest = __load(modules, cache, `${path}/package.json`);
      const main = manifest.browser && typeof manifest.browser === "string" ? manifest.browser : manifest.main;
      if (main) return resolveFile(__path.join(path, main));
    }
    return null;
  };
  return function require(name) {
    const bare = String(name).replace(/^node:/, "");
    if (bare in __builtins) return __builtins[bare];
    let target = null;
    if (bare.startsWith("./") || bare.startsWith("../") || bare.startsWith("/")) {
      target = resolveFile(__path.join(__path.dirname(from), bare).replace(/^\//, ""));
    } else {
      // node_modules, from this file's folder up.
      let dir = __path.dirname(from);
      for (;;) {
        target = resolveFile(__path.join(dir === "." ? "" : dir, "node_modules", bare).replace(/^\//, ""));
        if (target || dir === "." || dir === "/" || dir === "") break;
        dir = __path.dirname(dir);
      }
    }
    if (!target) return __unavailable(bare);
    return __load(modules, cache, target);
  };
}

function __load(modules, cache, path) {
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {}, id: path, filename: path, loaded: false };
  cache.set(path, module);
  modules[path](module, module.exports, __makeRequire(modules, cache, path), `/${path}`, `/${__path.dirname(path)}`);
  module.loaded = true;
  return module.exports;
}

// --- Activation -------------------------------------------------------------------------------------

function __wireEvents(sable) {
  // Folders opened, added or removed (multi-root workspaces).
  const currentFolders = () => (sable.workspace.folders?.length ? [...sable.workspace.folders] : sable.workspace.root ? [sable.workspace.root] : []);
  let lastFolders = currentFolders();
  sable.workspace.onDidChangeRoot?.(() => {
    const folders = currentFolders();
    const folder = (path, index) => ({ uri: Uri.file(path), name: path.split(/[/\\]/).pop(), index });
    const added = folders.filter((path) => !lastFolders.includes(path)).map((path) => folder(path, folders.indexOf(path)));
    const removed = lastFolders.filter((path) => !folders.includes(path)).map((path) => folder(path, lastFolders.indexOf(path)));
    lastFolders = folders;
    if (added.length || removed.length) __onDidChangeWorkspaceFolders.fire({ added, removed });
  });
  // Keep window.activeTextEditor current, and pass events on.
  sable.events.onDidChangeActiveEditor(async () => __onDidChangeActiveTextEditor.fire(await __refresh() ?? undefined));
  sable.events.onDidChangeSelection(async (event) => {
    if (!__active || __active.document.fileName !== event.path) await __refresh();
    else if (event.selection) __active._selection = new Selection(__fromSable(event.selection.start), __fromSable(event.selection.end));
    if (__active) __onDidChangeTextEditorSelection.fire({ textEditor: __active, selections: __active.selections, kind: 1 });
  });
  // Each edit as it happens: apply it to the text extensions have seen and
  // report it (language clients sync documents this way; Auto Close Tag
  // reacts to the ">" just typed). As in VS Code, the editor's selection
  // is still where it was before the edit while listeners run.
  sable.events.onDidChangeContent?.((event) => {
    const before = __seenText.get(event.path);
    if (before === undefined || !event.changes?.length) return;
    let text = before;
    for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
    }
    __seenText.set(event.path, text);
    const previous = __documents.get(event.path);
    const language = previous?.languageId ?? __active?.document.languageId;
    const start = event.changes[event.changes.length - 1].range.start;
    const editor = new TextEditor({ path: event.path, language, text, selection: { start: { line: start.line + 1, column: start.character + 1 }, end: { line: start.line + 1, column: start.character + 1 } } });
    __documents.set(event.path, editor.document);
    if (!__active || __active.document.fileName === event.path) __active = editor;
    __onDidChangeTextDocument.fire({
      document: editor.document,
      contentChanges: event.changes.map((change) => ({ ...change, range: __rangeFrom(change.range) })),
      reason: event.isUndoing ? 1 : event.isRedoing ? 2 : undefined,
    });
  });
  // Once typing settles: catch up with any edit not reported above.
  sable.events.onDidChange(async (event) => {
    const editor = await __refresh();
    if (!editor || editor.document.fileName !== event.path) return;
    const text = editor.document.getText();
    const before = __seenText.get(event.path) ?? text;
    if (before === text) return;
    __seenText.set(event.path, text);
    __onDidChangeTextDocument.fire({ document: editor.document, contentChanges: [__contentChange(before, text)], reason: undefined });
  });
  sable.events.onDidSave(async (event) => {
    const editor = await __refresh();
    const document = editor && editor.document.fileName === event.path ? editor.document : new TextDocument(event.path, "", "");
    __onDidSaveTextDocument.fire(document);
  });
  // Opening a file fires onDidOpenTextDocument through __trackDocument (once per document).
  sable.events.onDidOpen(() => void __refresh());
  // The status bar's click runs the first item's command; Sable runs the
  // extension's internal commands (code lenses, tree items) through
  // __vscode.execute. Neither shows in the command palette.
  sable.commands.register("__vscode.statusBar", "Status bar item", async () => {
    if (__statusCommand) await executeCommand(__statusCommand.command, ...(__statusCommand.arguments ?? []));
  }, { hidden: true });
  sable.commands.register("__vscode.execute", "Run an extension command", async (id, ...args) => {
    await __refresh();
    return executeCommand(id, ...args);
  }, { hidden: true });
  void __refreshDiagnostics();
  sable.events.onDidChangeDiagnostics?.(() => void __refreshDiagnostics());
}

/** Under Node: real folders for the extension's storage, beside the plugins (kept across updates). */
function __storageFolders(extensionPath) {
  if (!__node || !extensionPath) return { global: "", workspace: undefined, log: "" };
  const path = require("path");
  const base = path.join(extensionPath, "..", "..", ".storage", __extension.id);
  const root = __root();
  const workspaceKey = root ? require("crypto").createHash("sha1").update(root).digest("hex").slice(0, 16) : null;
  const folders = { global: path.join(base, "global"), workspace: workspaceKey ? path.join(base, "workspace", workspaceKey) : undefined, log: path.join(base, "logs") };
  try {
    require("fs").mkdirSync(folders.log, { recursive: true });
  } catch {
    /* read-only */
  }
  return folders;
}

function __makeContext(extensionPath) {
  const storage = __storageFolders(extensionPath);
  return {
    subscriptions: [],
    extensionPath,
    extensionUri: Uri.file(extensionPath),
    storagePath: storage.workspace,
    globalStoragePath: storage.global,
    logPath: storage.log,
    storageUri: storage.workspace ? Uri.file(storage.workspace) : undefined,
    globalStorageUri: Uri.file(storage.global),
    logUri: Uri.file(storage.log),
    extensionMode: ExtensionMode.Production,
    get extension() {
      return __self();
    },
    globalState: __memento("global:"),
    workspaceState: __memento("workspace:"),
    secrets: {
      get: async (key) => __stored[`secret:${key}`],
      store: async (key, value) => __store(`secret:${key}`, value),
      delete: async (key) => __store(`secret:${key}`, undefined),
      onDidChange: new EventEmitter().event,
    },
    environmentVariableCollection: { replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {}, persistent: false },
    asAbsolutePath: (relative) => (extensionPath ? __path.join(extensionPath, relative) : relative),
  };
}

async function __activate(sable, modules, extension) {
  __sable = sable;
  __extension = extension;
  globalThis.process ??= __process;
  globalThis.global ??= globalThis;
  globalThis.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
  globalThis.clearImmediate ??= clearTimeout;
  await __loadStorage();
  await __refresh();

  __wireEvents(sable);
  __context = __makeContext("");
  const cache = new Map();
  __exports = __load(modules, cache, extension.entry);
  await __runActivate();
}

/**
 * env.appRoot under Node: a folder laid out like VS Code's, whose bundled
 * ripgrep (which Todo Tree and other search extensions run) is the `rg`
 * on PATH, when there is one.
 */
function __appRoot() {
  try {
    const fs = require("fs");
    const path = require("path");
    const exe = process.platform === "win32" ? "rg.exe" : "rg";
    const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    const rg = dirs.filter(Boolean).map((dir) => path.join(dir, exe)).find((file) => fs.existsSync(file));
    const root = path.join(require("os").tmpdir(), "sable-vscode-app-root");
    for (const relative of ["node_modules/@vscode/ripgrep/bin", "node_modules/vscode-ripgrep/bin"]) {
      const dir = path.join(root, relative);
      fs.mkdirSync(dir, { recursive: true });
      const link = path.join(dir, exe);
      if (rg && !fs.existsSync(link)) fs.symlinkSync(rg, link);
    }
    env.appRoot = root;
  } catch (error) {
    console.warn(error);
  }
}

/**
 * Extensions built as ES modules (Prettier 12, …) `import` "vscode", which
 * goes through Node's module hooks rather than Module._load: answer it with
 * a module re-exporting the layer. Needs Node 22.15+ (module.registerHooks).
 */
function __esmVscode(Module) {
  if (typeof Module.registerHooks !== "function") return;
  globalThis.__sableVscode = vscode;
  const names = Object.keys(vscode).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const source = `const api = globalThis.__sableVscode;\nexport default api;\n${names.map((name) => `export const ${name} = api.${name};`).join("\n")}\n`;
  Module.registerHooks({
    resolve: (specifier, context, next) => (specifier === "vscode" ? { url: "sable:vscode", shortCircuit: true } : next(specifier, context)),
    load: (url, context, next) => (url === "sable:vscode" ? { format: "module", source, shortCircuit: true } : next(url, context)),
  });
}

/**
 * Node: load the extension with Node's own require (real fs, child
 * processes, its node_modules), answering only `require("vscode")`.
 */
async function __activateNode(sable, extension, entryPath, extensionRoot) {
  __node = { fs: require("fs").promises };
  __writeBuiltinLanguages();
  __sable = sable;
  __extension = extension;
  const Module = require("module");
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return load.call(this, request, parent, isMain);
  };
  __esmVscode(Module);
  __appRoot();
  await __loadStorage();
  await __refresh();
  __wireEvents(sable);
  __context = __makeContext(extensionRoot);
  try {
    __exports = require(entryPath);
  } catch (error) {
    // An ES module with top-level await (or a Node that can't require ESM).
    if (!["ERR_REQUIRE_ASYNC_MODULE", "ERR_REQUIRE_ESM"].includes(error?.code)) throw error;
    __exports = await import(require("url").pathToFileURL(entryPath).href);
  }
  await __runActivate();
}

/** The extension's views (package.json contributes.views), for Sable's sidebar. */
function __declareViews() {
  const containers = __extension.packageJSON?.contributes?.views ?? {};
  const views = Object.values(containers).flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((view) => view?.id)
    .map((view) => ({ id: view.id, name: typeof view.name === "string" ? view.name : view.id, kind: view.type === "webview" ? "webview" : "tree" }));
  if (views.length) void __sable.views.declare(views, __viewRequest).catch((error) => console.error(error));
}

async function __runActivate() {
  // Languages and grammars the extension adds (e.g. .http for REST Client).
  if (__extension.languages?.length || __extension.grammars?.length) {
    await __sable.languages.contribute?.(__extension.languages ?? [], __extension.grammars ?? []).catch((error) => console.warn(error));
  }
  const activate = __exports?.activate ?? __exports?.default?.activate;
  // Documents opened from now on fire onDidOpenTextDocument (the ones
  // before are in workspace.textDocuments).
  __activated = true;
  if (typeof activate === "function") {
    const result = await activate(__context);
    if (result !== undefined) __exports = Object.assign(Object.create(null), __exports, { api: result });
  }
  __declareViews();
}

async function __deactivate() {
  try {
    await (__exports?.deactivate ?? __exports?.default?.deactivate)?.();
  } finally {
    for (const disposable of __context?.subscriptions ?? []) {
      try {
        disposable?.dispose?.();
      } catch (error) {
        console.error(error);
      }
    }
  }
}

return { activate: __activate, deactivate: __deactivate };
})();

const __modules = {
"dist/web/extension.js": function (module, exports, require, __filename, __dirname) {
(()=>{var u={623:u=>{"use strict";function e(u,e,n){u instanceof RegExp&&(u=t(u,n)),e instanceof RegExp&&(e=t(e,n));var D=r(u,e,n);return D&&{start:D[0],end:D[1],pre:n.slice(0,D[0]),body:n.slice(D[0]+u.length,D[1]),post:n.slice(D[1]+e.length)}}function t(u,e){var t=e.match(u);return t?t[0]:null}function r(u,e,t){var r,n,D,i,o,a=t.indexOf(u),s=t.indexOf(e,a+1),c=a;if(a>=0&&s>0){if(u===e)return[a,s];for(r=[],D=t.length;c>=0&&!o;)c==a?(r.push(c),a=t.indexOf(u,c+1)):1==r.length?o=[r.pop(),s]:((n=r.pop())<D&&(D=n,i=s),s=t.indexOf(e,c+1)),c=a<s&&a>=0?a:s;r.length&&(o=[D,i])}return o}u.exports=e,e.range=r},644:(u,e,t)=>{var r=t(48),n=t(623);u.exports=function(u){return u?("{}"===u.substr(0,2)&&(u="\\{\\}"+u.substr(2)),h(function(u){return u.split("\\\\").join(D).split("\\{").join(i).split("\\}").join(o).split("\\,").join(a).split("\\.").join(s)}(u),!0).map(F)):[]};var D="\0SLASH"+Math.random()+"\0",i="\0OPEN"+Math.random()+"\0",o="\0CLOSE"+Math.random()+"\0",a="\0COMMA"+Math.random()+"\0",s="\0PERIOD"+Math.random()+"\0";function c(u){return parseInt(u,10)==u?parseInt(u,10):u.charCodeAt(0)}function F(u){return u.split(D).join("\\").split(i).join("{").split(o).join("}").split(a).join(",").split(s).join(".")}function C(u){if(!u)return[""];var e=[],t=n("{","}",u);if(!t)return u.split(",");var r=t.pre,D=t.body,i=t.post,o=r.split(",");o[o.length-1]+="{"+D+"}";var a=C(i);return i.length&&(o[o.length-1]+=a.shift(),o.push.apply(o,a)),e.push.apply(e,o),e}function A(u){return"{"+u+"}"}function l(u){return/^-?0\d/.test(u)}function f(u,e){return u<=e}function E(u,e){return u>=e}function h(u,e){var t=[],D=n("{","}",u);if(!D||/\$$/.test(D.pre))return[u];var i,a=/^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(D.body),s=/^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(D.body),F=a||s,d=D.body.indexOf(",")>=0;if(!F&&!d)return D.post.match(/,.*\}/)?h(u=D.pre+"{"+D.body+o+D.post):[u];if(F)i=D.body.split(/\.\./);else if(1===(i=C(D.body)).length&&1===(i=h(i[0],!1).map(A)).length)return(g=D.post.length?h(D.post,!1):[""]).map((function(u){return D.pre+i[0]+u}));var p,B=D.pre,g=D.post.length?h(D.post,!1):[""];if(F){var v=c(i[0]),m=c(i[1]),y=Math.max(i[0].length,i[1].length),b=3==i.length?Math.abs(c(i[2])):1,w=f;m<v&&(b*=-1,w=E);var x=i.some(l);p=[];for(var P=v;w(P,m);P+=b){var O;if(s)"\\"===(O=String.fromCharCode(P))&&(O="");else if(O=String(P),x){var S=y-O.length;if(S>0){var k=new Array(S+1).join("0");O=P<0?"-"+k+O.slice(1):k+O}}p.push(O)}}else p=r(i,(function(u){return h(u,!1)}));for(var j=0;j<p.length;j++)for(var T=0;T<g.length;T++){var N=B+p[j]+g[T];(!e||F||N)&&t.push(N)}return t}},48:u=>{u.exports=function(u,t){for(var r=[],n=0;n<u.length;n++){var D=t(u[n],n);e(D)?r.push.apply(r,D):r.push(D)}return r};var e=Array.isArray||function(u){return"[object Array]"===Object.prototype.toString.call(u)}},171:(u,e,t)=>{u.exports=C,C.Minimatch=A;var r={sep:"/"};try{r=t(470)}catch(u){}var n=C.GLOBSTAR=A.GLOBSTAR={},D=t(644),i={"!":{open:"(?:(?!(?:",close:"))[^/]*?)"},"?":{open:"(?:",close:")?"},"+":{open:"(?:",close:")+"},"*":{open:"(?:",close:")*"},"@":{open:"(?:",close:")"}},o="[^/]",a="[^/]*?",s="().*{}+?[]^$\\!".split("").reduce((function(u,e){return u[e]=!0,u}),{}),c=/\/+/;function F(u,e){u=u||{},e=e||{};var t={};return Object.keys(e).forEach((function(u){t[u]=e[u]})),Object.keys(u).forEach((function(e){t[e]=u[e]})),t}function C(u,e,t){if("string"!=typeof e)throw new TypeError("glob pattern string required");return t||(t={}),!(!t.nocomment&&"#"===e.charAt(0))&&(""===e.trim()?""===u:new A(e,t).match(u))}function A(u,e){if(!(this instanceof A))return new A(u,e);if("string"!=typeof u)throw new TypeError("glob pattern string required");e||(e={}),u=u.trim(),"/"!==r.sep&&(u=u.split(r.sep).join("/")),this.options=e,this.set=[],this.pattern=u,this.regexp=null,this.negate=!1,this.comment=!1,this.empty=!1,this.make()}function l(u,e){if(e||(e=this instanceof A?this.options:{}),void 0===(u=void 0===u?this.pattern:u))throw new TypeError("undefined pattern");return e.nobrace||!u.match(/\{.*\}/)?[u]:D(u)}C.filter=function(u,e){return e=e||{},function(t,r,n){return C(t,u,e)}},C.defaults=function(u){if(!u||!Object.keys(u).length)return C;var e=C,t=function(t,r,n){return e.minimatch(t,r,F(u,n))};return t.Minimatch=function(t,r){return new e.Minimatch(t,F(u,r))},t},A.defaults=function(u){return u&&Object.keys(u).length?C.defaults(u).Minimatch:A},A.prototype.debug=function(){},A.prototype.make=function(){if(!this._made){var u=this.pattern,e=this.options;if(e.nocomment||"#"!==u.charAt(0))if(u){this.parseNegate();var t=this.globSet=this.braceExpand();e.debug&&(this.debug=console.error),this.debug(this.pattern,t),t=this.globParts=t.map((function(u){return u.split(c)})),this.debug(this.pattern,t),t=t.map((function(u,e,t){return u.map(this.parse,this)}),this),this.debug(this.pattern,t),t=t.filter((function(u){return-1===u.indexOf(!1)})),this.debug(this.pattern,t),this.set=t}else this.empty=!0;else this.comment=!0}},A.prototype.parseNegate=function(){var u=this.pattern,e=!1,t=0;if(!this.options.nonegate){for(var r=0,n=u.length;r<n&&"!"===u.charAt(r);r++)e=!e,t++;t&&(this.pattern=u.substr(t)),this.negate=e}},C.braceExpand=function(u,e){return l(u,e)},A.prototype.braceExpand=l,A.prototype.parse=function(u,e){if(u.length>65536)throw new TypeError("pattern is too long");var t=this.options;if(!t.noglobstar&&"**"===u)return n;if(""===u)return"";var r,D="",c=!!t.nocase,F=!1,C=[],A=[],l=!1,E=-1,h=-1,d="."===u.charAt(0)?"":t.dot?"(?!(?:^|\\/)\\.{1,2}(?:$|\\/))":"(?!\\.)",p=this;function B(){if(r){switch(r){case"*":D+=a,c=!0;break;case"?":D+=o,c=!0;break;default:D+="\\"+r}p.debug("clearStateChar %j %j",r,D),r=!1}}for(var g,v=0,m=u.length;v<m&&(g=u.charAt(v));v++)if(this.debug("%s\t%s %s %j",u,v,D,g),F&&s[g])D+="\\"+g,F=!1;else switch(g){case"/":return!1;case"\\":B(),F=!0;continue;case"?":case"*":case"+":case"@":case"!":if(this.debug("%s\t%s %s %j <-- stateChar",u,v,D,g),l){this.debug("  in class"),"!"===g&&v===h+1&&(g="^"),D+=g;continue}p.debug("call clearStateChar %j",r),B(),r=g,t.noext&&B();continue;case"(":if(l){D+="(";continue}if(!r){D+="\\(";continue}C.push({type:r,start:v-1,reStart:D.length,open:i[r].open,close:i[r].close}),D+="!"===r?"(?:(?!(?:":"(?:",this.debug("plType %j %j",r,D),r=!1;continue;case")":if(l||!C.length){D+="\\)";continue}B(),c=!0;var y=C.pop();D+=y.close,"!"===y.type&&A.push(y),y.reEnd=D.length;continue;case"|":if(l||!C.length||F){D+="\\|",F=!1;continue}B(),D+="|";continue;case"[":if(B(),l){D+="\\"+g;continue}l=!0,h=v,E=D.length,D+=g;continue;case"]":if(v===h+1||!l){D+="\\"+g,F=!1;continue}if(l){var b=u.substring(h+1,v);try{RegExp("["+b+"]")}catch(u){var w=this.parse(b,f);D=D.substr(0,E)+"\\["+w[0]+"\\]",c=c||w[1],l=!1;continue}}c=!0,l=!1,D+=g;continue;default:B(),F?F=!1:!s[g]||"^"===g&&l||(D+="\\"),D+=g}for(l&&(b=u.substr(h+1),w=this.parse(b,f),D=D.substr(0,E)+"\\["+w[0],c=c||w[1]),y=C.pop();y;y=C.pop()){var x=D.slice(y.reStart+y.open.length);this.debug("setting tail",D,y),x=x.replace(/((?:\\{2}){0,64})(\\?)\|/g,(function(u,e,t){return t||(t="\\"),e+e+t+"|"})),this.debug("tail=%j\n   %s",x,x,y,D);var P="*"===y.type?a:"?"===y.type?o:"\\"+y.type;c=!0,D=D.slice(0,y.reStart)+P+"\\("+x}B(),F&&(D+="\\\\");var O=!1;switch(D.charAt(0)){case".":case"[":case"(":O=!0}for(var S=A.length-1;S>-1;S--){var k=A[S],j=D.slice(0,k.reStart),T=D.slice(k.reStart,k.reEnd-8),N=D.slice(k.reEnd-8,k.reEnd),_=D.slice(k.reEnd);N+=_;var $=j.split("(").length-1,I=_;for(v=0;v<$;v++)I=I.replace(/\)[+*?]?/,"");var M="";""===(_=I)&&e!==f&&(M="$"),D=j+T+_+M+N}if(""!==D&&c&&(D="(?=.)"+D),O&&(D=d+D),e===f)return[D,c];if(!c)return u.replace(/\\(.)/g,"$1");var R=t.nocase?"i":"";try{var L=new RegExp("^"+D+"$",R)}catch(u){return new RegExp("$.")}return L._glob=u,L._src=D,L};var f={};C.makeRe=function(u,e){return new A(u,e||{}).makeRe()},A.prototype.makeRe=function(){if(this.regexp||!1===this.regexp)return this.regexp;var u=this.set;if(!u.length)return this.regexp=!1,this.regexp;var e=this.options,t=e.noglobstar?a:e.dot?"(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?":"(?:(?!(?:\\/|^)\\.).)*?",r=e.nocase?"i":"",D=u.map((function(u){return u.map((function(u){return u===n?t:"string"==typeof u?u.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,"\\$&"):u._src})).join("\\/")})).join("|");D="^(?:"+D+")$",this.negate&&(D="^(?!"+D+").*$");try{this.regexp=new RegExp(D,r)}catch(u){this.regexp=!1}return this.regexp},C.match=function(u,e,t){var r=new A(e,t=t||{});return u=u.filter((function(u){return r.match(u)})),r.options.nonull&&!u.length&&u.push(e),u},A.prototype.match=function(u,e){if(this.debug("match",u,this.pattern),this.comment)return!1;if(this.empty)return""===u;if("/"===u&&e)return!0;var t=this.options;"/"!==r.sep&&(u=u.split(r.sep).join("/")),u=u.split(c),this.debug(this.pattern,"split",u);var n,D,i=this.set;for(this.debug(this.pattern,"set",i),D=u.length-1;D>=0&&!(n=u[D]);D--);for(D=0;D<i.length;D++){var o=i[D],a=u;if(t.matchBase&&1===o.length&&(a=[n]),this.matchOne(a,o,e))return!!t.flipNegate||!this.negate}return!t.flipNegate&&this.negate},A.prototype.matchOne=function(u,e,t){var r=this.options;this.debug("matchOne",{this:this,file:u,pattern:e}),this.debug("matchOne",u.length,e.length);for(var D=0,i=0,o=u.length,a=e.length;D<o&&i<a;D++,i++){this.debug("matchOne loop");var s,c=e[i],F=u[D];if(this.debug(e,c,F),!1===c)return!1;if(c===n){this.debug("GLOBSTAR",[e,c,F]);var C=D,A=i+1;if(A===a){for(this.debug("** at the end");D<o;D++)if("."===u[D]||".."===u[D]||!r.dot&&"."===u[D].charAt(0))return!1;return!0}for(;C<o;){var l=u[C];if(this.debug("\nglobstar while",u,C,e,A,l),this.matchOne(u.slice(C),e.slice(A),t))return this.debug("globstar found match!",C,o,l),!0;if("."===l||".."===l||!r.dot&&"."===l.charAt(0)){this.debug("dot detected!",u,C,e,A);break}this.debug("globstar swallow a segment, and continue"),C++}return!(!t||(this.debug("\n>>> no match, partial?",u,C,e,A),C!==o))}if("string"==typeof c?(s=r.nocase?F.toLowerCase()===c.toLowerCase():F===c,this.debug("string match",c,F,s)):(s=F.match(c),this.debug("pattern match",c,F,s)),!s)return!1}if(D===o&&i===a)return!0;if(D===o)return t;if(i===a)return D===o-1&&""===u[D];throw new Error("wtf?")}},470:(u,e,t)=>{"use strict";var r=t(155);function n(u){if("string"!=typeof u)throw new TypeError("Path must be a string. Received "+JSON.stringify(u))}function D(u,e){for(var t,r="",n=0,D=-1,i=0,o=0;o<=u.length;++o){if(o<u.length)t=u.charCodeAt(o);else{if(47===t)break;t=47}if(47===t){if(D===o-1||1===i);else if(D!==o-1&&2===i){if(r.length<2||2!==n||46!==r.charCodeAt(r.length-1)||46!==r.charCodeAt(r.length-2))if(r.length>2){var a=r.lastIndexOf("/");if(a!==r.length-1){-1===a?(r="",n=0):n=(r=r.slice(0,a)).length-1-r.lastIndexOf("/"),D=o,i=0;continue}}else if(2===r.length||1===r.length){r="",n=0,D=o,i=0;continue}e&&(r.length>0?r+="/..":r="..",n=2)}else r.length>0?r+="/"+u.slice(D+1,o):r=u.slice(D+1,o),n=o-D-1;D=o,i=0}else 46===t&&-1!==i?++i:i=-1}return r}var i={resolve:function(){for(var u,e="",t=!1,i=arguments.length-1;i>=-1&&!t;i--){var o;i>=0?o=arguments[i]:(void 0===u&&(u=r.cwd()),o=u),n(o),0!==o.length&&(e=o+"/"+e,t=47===o.charCodeAt(0))}return e=D(e,!t),t?e.length>0?"/"+e:"/":e.length>0?e:"."},normalize:function(u){if(n(u),0===u.length)return".";var e=47===u.charCodeAt(0),t=47===u.charCodeAt(u.length-1);return 0!==(u=D(u,!e)).length||e||(u="."),u.length>0&&t&&(u+="/"),e?"/"+u:u},isAbsolute:function(u){return n(u),u.length>0&&47===u.charCodeAt(0)},join:function(){if(0===arguments.length)return".";for(var u,e=0;e<arguments.length;++e){var t=arguments[e];n(t),t.length>0&&(void 0===u?u=t:u+="/"+t)}return void 0===u?".":i.normalize(u)},relative:function(u,e){if(n(u),n(e),u===e)return"";if((u=i.resolve(u))===(e=i.resolve(e)))return"";for(var t=1;t<u.length&&47===u.charCodeAt(t);++t);for(var r=u.length,D=r-t,o=1;o<e.length&&47===e.charCodeAt(o);++o);for(var a=e.length-o,s=D<a?D:a,c=-1,F=0;F<=s;++F){if(F===s){if(a>s){if(47===e.charCodeAt(o+F))return e.slice(o+F+1);if(0===F)return e.slice(o+F)}else D>s&&(47===u.charCodeAt(t+F)?c=F:0===F&&(c=0));break}var C=u.charCodeAt(t+F);if(C!==e.charCodeAt(o+F))break;47===C&&(c=F)}var A="";for(F=t+c+1;F<=r;++F)F!==r&&47!==u.charCodeAt(F)||(0===A.length?A+="..":A+="/..");return A.length>0?A+e.slice(o+c):(o+=c,47===e.charCodeAt(o)&&++o,e.slice(o))},_makeLong:function(u){return u},dirname:function(u){if(n(u),0===u.length)return".";for(var e=u.charCodeAt(0),t=47===e,r=-1,D=!0,i=u.length-1;i>=1;--i)if(47===(e=u.charCodeAt(i))){if(!D){r=i;break}}else D=!1;return-1===r?t?"/":".":t&&1===r?"//":u.slice(0,r)},basename:function(u,e){if(void 0!==e&&"string"!=typeof e)throw new TypeError('"ext" argument must be a string');n(u);var t,r=0,D=-1,i=!0;if(void 0!==e&&e.length>0&&e.length<=u.length){if(e.length===u.length&&e===u)return"";var o=e.length-1,a=-1;for(t=u.length-1;t>=0;--t){var s=u.charCodeAt(t);if(47===s){if(!i){r=t+1;break}}else-1===a&&(i=!1,a=t+1),o>=0&&(s===e.charCodeAt(o)?-1==--o&&(D=t):(o=-1,D=a))}return r===D?D=a:-1===D&&(D=u.length),u.slice(r,D)}for(t=u.length-1;t>=0;--t)if(47===u.charCodeAt(t)){if(!i){r=t+1;break}}else-1===D&&(i=!1,D=t+1);return-1===D?"":u.slice(r,D)},extname:function(u){n(u);for(var e=-1,t=0,r=-1,D=!0,i=0,o=u.length-1;o>=0;--o){var a=u.charCodeAt(o);if(47!==a)-1===r&&(D=!1,r=o+1),46===a?-1===e?e=o:1!==i&&(i=1):-1!==e&&(i=-1);else if(!D){t=o+1;break}}return-1===e||-1===r||0===i||1===i&&e===r-1&&e===t+1?"":u.slice(e,r)},format:function(u){if(null===u||"object"!=typeof u)throw new TypeError('The "pathObject" argument must be of type Object. Received type '+typeof u);return function(u,e){var t=e.dir||e.root,r=e.base||(e.name||"")+(e.ext||"");return t?t===e.root?t+r:t+"/"+r:r}(0,u)},parse:function(u){n(u);var e={root:"",dir:"",base:"",ext:"",name:""};if(0===u.length)return e;var t,r=u.charCodeAt(0),D=47===r;D?(e.root="/",t=1):t=0;for(var i=-1,o=0,a=-1,s=!0,c=u.length-1,F=0;c>=t;--c)if(47!==(r=u.charCodeAt(c)))-1===a&&(s=!1,a=c+1),46===r?-1===i?i=c:1!==F&&(F=1):-1!==i&&(F=-1);else if(!s){o=c+1;break}return-1===i||-1===a||0===F||1===F&&i===a-1&&i===o+1?-1!==a&&(e.base=e.name=0===o&&D?u.slice(1,a):u.slice(o,a)):(0===o&&D?(e.name=u.slice(1,i),e.base=u.slice(1,a)):(e.name=u.slice(o,i),e.base=u.slice(o,a)),e.ext=u.slice(i,a)),o>0?e.dir=u.slice(0,o-1):D&&(e.dir="/"),e},sep:"/",delimiter:":",win32:null,posix:null};i.posix=i,u.exports=i},155:u=>{var e,t,r=u.exports={};function n(){throw new Error("setTimeout has not been defined")}function D(){throw new Error("clearTimeout has not been defined")}function i(u){if(e===setTimeout)return setTimeout(u,0);if((e===n||!e)&&setTimeout)return e=setTimeout,setTimeout(u,0);try{return e(u,0)}catch(t){try{return e.call(null,u,0)}catch(t){return e.call(this,u,0)}}}!function(){try{e="function"==typeof setTimeout?setTimeout:n}catch(u){e=n}try{t="function"==typeof clearTimeout?clearTimeout:D}catch(u){t=D}}();var o,a=[],s=!1,c=-1;function F(){s&&o&&(s=!1,o.length?a=o.concat(a):c=-1,a.length&&C())}function C(){if(!s){var u=i(F);s=!0;for(var e=a.length;e;){for(o=a,a=[];++c<e;)o&&o[c].run();c=-1,e=a.length}o=null,s=!1,function(u){if(t===clearTimeout)return clearTimeout(u);if((t===D||!t)&&clearTimeout)return t=clearTimeout,clearTimeout(u);try{t(u)}catch(e){try{return t.call(null,u)}catch(e){return t.call(this,u)}}}(u)}}function A(u,e){this.fun=u,this.array=e}function l(){}r.nextTick=function(u){var e=new Array(arguments.length-1);if(arguments.length>1)for(var t=1;t<arguments.length;t++)e[t-1]=arguments[t];a.push(new A(u,e)),1!==a.length||s||i(C)},A.prototype.run=function(){this.fun.apply(null,this.array)},r.title="browser",r.browser=!0,r.env={},r.argv=[],r.version="",r.versions={},r.on=l,r.addListener=l,r.once=l,r.off=l,r.removeListener=l,r.removeAllListeners=l,r.emit=l,r.prependListener=l,r.prependOnceListener=l,r.listeners=function(u){return[]},r.binding=function(u){throw new Error("process.binding is not supported")},r.cwd=function(){return"/"},r.chdir=function(u){throw new Error("process.chdir is not supported")},r.umask=function(){return 0}},598:function(u,e,t){"use strict";var r=this&&this.__awaiter||function(u,e,t,r){return new(t||(t=Promise))((function(n,D){function i(u){try{a(r.next(u))}catch(u){D(u)}}function o(u){try{a(r.throw(u))}catch(u){D(u)}}function a(u){var e;u.done?n(u.value):(e=u.value,e instanceof t?e:new t((function(u){u(e)}))).then(i,o)}a((r=r.apply(u,e||[])).next())}))};Object.defineProperty(e,"__esModule",{value:!0}),e.getConfiguration=void 0;const n=t(496),D=t(733),i=t(754),o=t(738);function a(u,e){const t=null==e?void 0:e.uri.path;return t&&u?o.replaceWorkspaceFolderWithRootPath(u,t):null}e.getConfiguration=function(u){return r(this,void 0,void 0,(function*(){const e=n.workspace.getWorkspaceFolder(u),t=e=>n.workspace.getConfiguration(e,u),o=t("path-intellisense"),s=t("files"),c=yield function(u,e){return r(this,void 0,void 0,(function*(){const t=i.parseMappings(u.mappings),r=u.ignoreTsConfigBaseUrl,n=u.showHiddenFiles,o=u.exclude,a=[...t,...yield r?[]:D.getWorkfolderTsConfigConfiguration(e,n,o)];return i.replaceWorkspaceFolder(a,e)}))}(o,e);return{autoSlash:o.autoSlashAfterDirectory,autoTrigger:o.autoTriggerNextSuggestion,showHiddenFiles:o.showHiddenFiles,withExtension:o.extensionOnImport,absolutePathToWorkspace:o.absolutePathToWorkspace,absolutePathTo:a(o.absolutePathTo,e),showOnAbsoluteSlash:o.showOnAbsoluteSlash,filesExclude:s.exclude,mappings:c}}))}},754:(u,e,t)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.replaceWorkspaceFolder=e.parseMappings=void 0;const r=t(738);e.parseMappings=function(u){return Object.entries(u).map((([u,e])=>({key:u,value:e})))},e.replaceWorkspaceFolder=function(u,e){const t=null==e?void 0:e.uri.path;return t?u.map((({key:u,value:e})=>({key:u,value:r.replaceWorkspaceFolderWithRootPath(e,t)}))):u.filter((({value:u})=>!function(u){return u.indexOf("${workspaceRoot}")>=0||u.indexOf("${workspaceFolder}")>=0}(u)))}},733:function(u,e,t){"use strict";var r=this&&this.__awaiter||function(u,e,t,r){return new(t||(t=Promise))((function(n,D){function i(u){try{a(r.next(u))}catch(u){D(u)}}function o(u){try{a(r.throw(u))}catch(u){D(u)}}function a(u){var e;u.done?n(u.value):(e=u.value,e instanceof t?e:new t((function(u){u(e)}))).then(i,o)}a((r=r.apply(u,e||[])).next())}))};Object.defineProperty(e,"__esModule",{value:!0}),e.subscribeToTsConfigChanges=e.getWorkfolderTsConfigConfiguration=void 0;const n=t(496),D=t(876),i=t(470),o=t(738);var a;function s(u){var e;return r(this,void 0,void 0,(function*(){const t=[],r=yield F(u);for(const D of r){const r=null===(e=null==D?void 0:D.compilerOptions)||void 0===e?void 0:e.baseUrl;if(!r)continue;const o=new n.RelativePattern(i.join(u.uri.fsPath,r),"*"),a=n.workspace.createFileSystemWatcher(o,!1,!0,!1);a.onDidCreate((e=>c(e,u))),a.onDidDelete((e=>c(e,u))),t.push(a)}return t}))}function c(u,e){return r(this,void 0,void 0,(function*(){(yield n.workspace.fs.stat(u)).type===n.FileType.Directory&&l(e)}))}function F(u){return r(this,void 0,void 0,(function*(){const e=new n.RelativePattern(u,"[tj]sconfig.json"),t=new n.RelativePattern(u,"**/node_modules/**"),r=yield n.workspace.findFiles(e,t),i=[];for(const u of r)try{const e=n.Uri.file(u.fsPath),t=yield n.workspace.fs.readFile(e),r=D.parse(t.toString());i.push(r)}catch(u){}return i}))}function C(u,e,t,n){var D;return r(this,void 0,void 0,(function*(){const a=[],s=null===(D=null==u?void 0:u.compilerOptions)||void 0===D?void 0:D.baseUrl;if(s&&e){const u=yield function(u,e,t,n){return r(this,void 0,void 0,(function*(){return(yield o.getChildrenOfPath(i.join(u.uri.fsPath,e),t,n)).filter((u=>!u.isFile)).map((u=>u.file))}))}(e,s,t,n);for(const e of u)a.push({key:e,value:"${workspaceFolder}/"+s+"/"+e})}return a}))}e.getWorkfolderTsConfigConfiguration=(a=function(u,e,t){return r(this,void 0,void 0,(function*(){const r=yield F(u);let n=[];for(const D of r)try{const r=yield C(D,u,e,t);n.push(...r)}catch(u){}return n}))},function(u,e,t){return r(this,void 0,void 0,(function*(){if(!u)return Promise.resolve([]);const r=u.name,n=A.get(r);if(n)return n;{let n=yield a(u,e||!1,t||{});return A.set(r,n),n}}))}),e.subscribeToTsConfigChanges=function(u){return r(this,void 0,void 0,(function*(){for(const e of n.workspace.workspaceFolders||[]){let t=yield s(e);u.subscriptions.push(...t);const D=new n.RelativePattern(e,"[tj]sconfig.json"),i=n.workspace.createFileSystemWatcher(D);i.onDidChange((()=>r(this,void 0,void 0,(function*(){l(e);for(const u of t)u.dispose();t=yield s(e),u.subscriptions.push(...t)})))),u.subscriptions.push(i)}}))};let A=new Map;function l(u){A.delete(u.name)}},767:(u,e,t)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.DefaultProvider=void 0;const r=t(794);e.DefaultProvider={selector:"*",provider:r.JavaScriptProvider.provider,triggerCharacters:["/",'"',"'"]}},539:(u,e,t)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.providers=void 0;const r=t(767),n=t(794);e.providers=[n.JavaScriptProvider,r.DefaultProvider]},952:(u,e,t)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.createPathCompletionItem=void 0;const r=t(496);e.createPathCompletionItem=function(u,e,t){return u.isFile?function(u,e,t){const n=function(u,e,t){return t.isImport&&!e.withExtension&&u.documentExtension===t.documentExtension?function(u){let e=u.lastIndexOf(".");return-1!==e?u.substring(0,e):u}(u.file):u.file}(u,e,t);return{label:u.file,kind:r.CompletionItemKind.File,sortText:`b_${u.file}`,range:t.importRange,insertText:n}}(u,e,t):function(u,e,t,n){var D=e||t?`${u.file}/`:`${u.file}`;return{label:u.file,kind:r.CompletionItemKind.Folder,sortText:`a_${u.file}`,range:n,insertText:D,command:t?{title:"Trigger suggest",command:"editor.action.triggerSuggest"}:void 0}}(u,e.autoSlash,e.autoTrigger,t.importRange)}},407:(u,e,t)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.extractExtension=e.createContext=void 0;const r=t(496);function n(u){if(u.isUntitled)return;const e=u.fileName.split("."),t=e[e.length-1];return!t||t.length>3?void 0:t}e.createContext=function(u,e){const t=u.getText(u.lineAt(e).range),D=function(u,e){const t=u.substring(0,e),r=Math.max(t.lastIndexOf('"'),t.lastIndexOf("'"),t.lastIndexOf("`"));return-1!==r?t.substring(r+1,t.length):void 0}(t,e.character),i=function(u){let e="import"===u.substring(0,6),t="export"===u.substring(0,6),r=-1!==u.indexOf("require(");return e||t||r}(t),o=function(u,e){const t=u.substring(0,e.character).lastIndexOf("/"),n=new r.Position(e.line,t+1),D=e;return new r.Range(n,D)}(t,e);return{textFullLine:t,fromString:D,isImport:i,document:u,importRange:o,documentExtension:n(u)}},e.extractExtension=n},794:function(u,e,t){"use strict";var r=this&&this.__awaiter||function(u,e,t,r){return new(t||(t=Promise))((function(n,D){function i(u){try{a(r.next(u))}catch(u){D(u)}}function o(u){try{a(r.throw(u))}catch(u){D(u)}}function a(u){var e;u.done?n(u.value):(e=u.value,e instanceof t?e:new t((function(u){u(e)}))).then(i,o)}a((r=r.apply(u,e||[])).next())}))};Object.defineProperty(e,"__esModule",{value:!0}),e.JavaScriptProvider=void 0;const n=t(496),D=t(598),i=t(407),o=t(952),a=t(738);e.JavaScriptProvider={selector:{language:"javascript",scheme:"file"},provider:{provideCompletionItems:function(u,e){return r(this,void 0,void 0,(function*(){const t=i.createContext(u,e),s=yield D.getConfiguration(u.uri);return function(u,e){const{fromString:t,isImport:r}=u;if(!t||0===t.length)return!1;if(!r)return!0;const n="."===t[0],D="/"===t[0],i=e.mappings.some((({key:u})=>t.startsWith(u)));return r&&(n||i||D&&e.showOnAbsoluteSlash)}(t,s)?function(u,e){return r(this,void 0,void 0,(function*(){const t=n.workspace.getWorkspaceFolder(u.document.uri),r=e.absolutePathTo||(e.absolutePathToWorkspace?null==t?void 0:t.uri.fsPath:void 0),D=a.getPathOfFolderToLookupFiles(u.document.uri.fsPath,u.fromString,r,e.mappings);return[...(yield a.getChildrenOfPath(D,e.showHiddenFiles,e.filesExclude)).map((t=>o.createPathCompletionItem(t,e,u)))]}))}(t,s):Promise.resolve([])}))}},triggerCharacters:["/",'"',"'"]}},738:function(u,e,t){"use strict";var r=this&&this.__awaiter||function(u,e,t,r){return new(t||(t=Promise))((function(n,D){function i(u){try{a(r.next(u))}catch(u){D(u)}}function o(u){try{a(r.throw(u))}catch(u){D(u)}}function a(u){var e;u.done?n(u.value):(e=u.value,e instanceof t?e:new t((function(u){u(e)}))).then(i,o)}a((r=r.apply(u,e||[])).next())}))};Object.defineProperty(e,"__esModule",{value:!0}),e.replaceWorkspaceFolderWithRootPath=e.getChildrenOfPath=e.getPathOfFolderToLookupFiles=void 0;const n=t(171),D=t(470),i=t(470),o=t(496);function a(u,e){if(e.type!==o.FileType.File)return;const t=u.split(".");return t[t.length-1]}e.getPathOfFolderToLookupFiles=function(u,e,t,r){const n=D.normalize(e||""),i=n.startsWith(D.sep),o=r&&r.reduce(((u,e)=>u||n.startsWith(D.normalize(e.key))&&e),void 0);let a,s;return o?(a=o.value,s=n.slice(D.normalize(o.key).length,n.length)):(a=i?t||"":D.dirname(u),s=n),D.join(a,s)},e.getChildrenOfPath=function(u,e,t){return r(this,void 0,void 0,(function*(){try{const r=(yield o.workspace.fs.readDirectory(o.Uri.file(u))).map((u=>u[0])).filter((u=>function(u,e,t){return!!e||!function(u,e){return u.startsWith(".")||function(u,e){return e&&Object.keys(e).some((t=>e[t]&&n(u,t)))}(u,e)}(u,t)}(u,e,t))),D=[];for(const e of r){const t=yield o.workspace.fs.stat(o.Uri.file(i.join(u,e)));D.push({file:e,isFile:t.type===o.FileType.File,documentExtension:a(e,t)})}return D}catch(u){return[]}}))},e.replaceWorkspaceFolderWithRootPath=function(u,e){return u.replace("${workspaceRoot}",e).replace("${workspaceFolder}",e)}},496:u=>{"use strict";u.exports=require("vscode")},876:(u,e,t)=>{"use strict";t.r(e),t.d(e,{default:()=>L});var r={Space_Separator:/[\u1680\u2000-\u200A\u202F\u205F\u3000]/,ID_Start:/[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/,ID_Continue:/[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/},n=u=>"string"==typeof u&&r.Space_Separator.test(u),D=u=>"string"==typeof u&&(u>="a"&&u<="z"||u>="A"&&u<="Z"||"$"===u||"_"===u||r.ID_Start.test(u)),i=u=>"string"==typeof u&&(u>="a"&&u<="z"||u>="A"&&u<="Z"||u>="0"&&u<="9"||"$"===u||"_"===u||"‌"===u||"‍"===u||r.ID_Continue.test(u)),o=u=>"string"==typeof u&&/[0-9]/.test(u),a=u=>"string"==typeof u&&/[0-9A-Fa-f]/.test(u);let s,c,F,C,A,l,f,E,h,d,p,B,g,v;function m(u,e,t){const r=u[e];if(null!=r&&"object"==typeof r)for(const u in r){const e=m(r,u,t);void 0===e?delete r[u]:r[u]=e}return t.call(u,e,r)}function y(){for(d="default",p="",B=!1,g=1;;){v=b();const u=x[d]();if(u)return u}}function b(){if(s[C])return String.fromCodePoint(s.codePointAt(C))}function w(){const u=b();return"\n"===u?(A++,l=0):u?l+=u.length:l++,u&&(C+=u.length),u}const x={default(){switch(v){case"\t":case"\v":case"\f":case" ":case" ":case"\ufeff":case"\n":case"\r":case"\u2028":case"\u2029":return void w();case"/":return w(),void(d="comment");case void 0:return w(),P("eof")}if(!n(v))return x[c]();w()},comment(){switch(v){case"*":return w(),void(d="multiLineComment");case"/":return w(),void(d="singleLineComment")}throw N(w())},multiLineComment(){switch(v){case"*":return w(),void(d="multiLineCommentAsterisk");case void 0:throw N(w())}w()},multiLineCommentAsterisk(){switch(v){case"*":return void w();case"/":return w(),void(d="default");case void 0:throw N(w())}w(),d="multiLineComment"},singleLineComment(){switch(v){case"\n":case"\r":case"\u2028":case"\u2029":return w(),void(d="default");case void 0:return w(),P("eof")}w()},value(){switch(v){case"{":case"[":return P("punctuator",w());case"n":return w(),O("ull"),P("null",null);case"t":return w(),O("rue"),P("boolean",!0);case"f":return w(),O("alse"),P("boolean",!1);case"-":case"+":return"-"===w()&&(g=-1),void(d="sign");case".":return p=w(),void(d="decimalPointLeading");case"0":return p=w(),void(d="zero");case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":return p=w(),void(d="decimalInteger");case"I":return w(),O("nfinity"),P("numeric",1/0);case"N":return w(),O("aN"),P("numeric",NaN);case'"':case"'":return B='"'===w(),p="",void(d="string")}throw N(w())},identifierNameStartEscape(){if("u"!==v)throw N(w());w();const u=S();switch(u){case"$":case"_":break;default:if(!D(u))throw $()}p+=u,d="identifierName"},identifierName(){switch(v){case"$":case"_":case"‌":case"‍":return void(p+=w());case"\\":return w(),void(d="identifierNameEscape")}if(!i(v))return P("identifier",p);p+=w()},identifierNameEscape(){if("u"!==v)throw N(w());w();const u=S();switch(u){case"$":case"_":case"‌":case"‍":break;default:if(!i(u))throw $()}p+=u,d="identifierName"},sign(){switch(v){case".":return p=w(),void(d="decimalPointLeading");case"0":return p=w(),void(d="zero");case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":return p=w(),void(d="decimalInteger");case"I":return w(),O("nfinity"),P("numeric",g*(1/0));case"N":return w(),O("aN"),P("numeric",NaN)}throw N(w())},zero(){switch(v){case".":return p+=w(),void(d="decimalPoint");case"e":case"E":return p+=w(),void(d="decimalExponent");case"x":case"X":return p+=w(),void(d="hexadecimal")}return P("numeric",0*g)},decimalInteger(){switch(v){case".":return p+=w(),void(d="decimalPoint");case"e":case"E":return p+=w(),void(d="decimalExponent")}if(!o(v))return P("numeric",g*Number(p));p+=w()},decimalPointLeading(){if(o(v))return p+=w(),void(d="decimalFraction");throw N(w())},decimalPoint(){switch(v){case"e":case"E":return p+=w(),void(d="decimalExponent")}return o(v)?(p+=w(),void(d="decimalFraction")):P("numeric",g*Number(p))},decimalFraction(){switch(v){case"e":case"E":return p+=w(),void(d="decimalExponent")}if(!o(v))return P("numeric",g*Number(p));p+=w()},decimalExponent(){switch(v){case"+":case"-":return p+=w(),void(d="decimalExponentSign")}if(o(v))return p+=w(),void(d="decimalExponentInteger");throw N(w())},decimalExponentSign(){if(o(v))return p+=w(),void(d="decimalExponentInteger");throw N(w())},decimalExponentInteger(){if(!o(v))return P("numeric",g*Number(p));p+=w()},hexadecimal(){if(a(v))return p+=w(),void(d="hexadecimalInteger");throw N(w())},hexadecimalInteger(){if(!a(v))return P("numeric",g*Number(p));p+=w()},string(){switch(v){case"\\":return w(),void(p+=function(){switch(b()){case"b":return w(),"\b";case"f":return w(),"\f";case"n":return w(),"\n";case"r":return w(),"\r";case"t":return w(),"\t";case"v":return w(),"\v";case"0":if(w(),o(b()))throw N(w());return"\0";case"x":return w(),function(){let u="",e=b();if(!a(e))throw N(w());if(u+=w(),e=b(),!a(e))throw N(w());return u+=w(),String.fromCodePoint(parseInt(u,16))}();case"u":return w(),S();case"\n":case"\u2028":case"\u2029":return w(),"";case"\r":return w(),"\n"===b()&&w(),"";case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":case void 0:throw N(w())}return w()}());case'"':return B?(w(),P("string",p)):void(p+=w());case"'":return B?void(p+=w()):(w(),P("string",p));case"\n":case"\r":case void 0:throw N(w());case"\u2028":case"\u2029":!function(u){console.warn(`JSON5: '${I(u)}' in strings is not valid ECMAScript; consider escaping`)}(v)}p+=w()},start(){switch(v){case"{":case"[":return P("punctuator",w())}d="value"},beforePropertyName(){switch(v){case"$":case"_":return p=w(),void(d="identifierName");case"\\":return w(),void(d="identifierNameStartEscape");case"}":return P("punctuator",w());case'"':case"'":return B='"'===w(),void(d="string")}if(D(v))return p+=w(),void(d="identifierName");throw N(w())},afterPropertyName(){if(":"===v)return P("punctuator",w());throw N(w())},beforePropertyValue(){d="value"},afterPropertyValue(){switch(v){case",":case"}":return P("punctuator",w())}throw N(w())},beforeArrayValue(){if("]"===v)return P("punctuator",w());d="value"},afterArrayValue(){switch(v){case",":case"]":return P("punctuator",w())}throw N(w())},end(){throw N(w())}};function P(u,e){return{type:u,value:e,line:A,column:l}}function O(u){for(const e of u){if(b()!==e)throw N(w());w()}}function S(){let u="",e=4;for(;e-- >0;){const e=b();if(!a(e))throw N(w());u+=w()}return String.fromCodePoint(parseInt(u,16))}const k={start(){if("eof"===f.type)throw _();j()},beforePropertyName(){switch(f.type){case"identifier":case"string":return E=f.value,void(c="afterPropertyName");case"punctuator":return void T();case"eof":throw _()}},afterPropertyName(){if("eof"===f.type)throw _();c="beforePropertyValue"},beforePropertyValue(){if("eof"===f.type)throw _();j()},beforeArrayValue(){if("eof"===f.type)throw _();"punctuator"!==f.type||"]"!==f.value?j():T()},afterPropertyValue(){if("eof"===f.type)throw _();switch(f.value){case",":return void(c="beforePropertyName");case"}":T()}},afterArrayValue(){if("eof"===f.type)throw _();switch(f.value){case",":return void(c="beforeArrayValue");case"]":T()}},end(){}};function j(){let u;switch(f.type){case"punctuator":switch(f.value){case"{":u={};break;case"[":u=[]}break;case"null":case"boolean":case"numeric":case"string":u=f.value}if(void 0===h)h=u;else{const e=F[F.length-1];Array.isArray(e)?e.push(u):e[E]=u}if(null!==u&&"object"==typeof u)F.push(u),c=Array.isArray(u)?"beforeArrayValue":"beforePropertyName";else{const u=F[F.length-1];c=null==u?"end":Array.isArray(u)?"afterArrayValue":"afterPropertyValue"}}function T(){F.pop();const u=F[F.length-1];c=null==u?"end":Array.isArray(u)?"afterArrayValue":"afterPropertyValue"}function N(u){return M(void 0===u?`JSON5: invalid end of input at ${A}:${l}`:`JSON5: invalid character '${I(u)}' at ${A}:${l}`)}function _(){return M(`JSON5: invalid end of input at ${A}:${l}`)}function $(){return l-=5,M(`JSON5: invalid identifier character at ${A}:${l}`)}function I(u){const e={"'":"\\'",'"':'\\"',"\\":"\\\\","\b":"\\b","\f":"\\f","\n":"\\n","\r":"\\r","\t":"\\t","\v":"\\v","\0":"\\0","\u2028":"\\u2028","\u2029":"\\u2029"};if(e[u])return e[u];if(u<" "){const e=u.charCodeAt(0).toString(16);return"\\x"+("00"+e).substring(e.length)}return u}function M(u){const e=new SyntaxError(u);return e.lineNumber=A,e.columnNumber=l,e}const R={parse:function(u,e){s=String(u),c="start",F=[],C=0,A=1,l=0,f=void 0,E=void 0,h=void 0;do{f=y(),k[c]()}while("eof"!==f.type);return"function"==typeof e?m({"":h},"",e):h},stringify:function(u,e,t){const r=[];let n,a,s,c="",F="";if(null==e||"object"!=typeof e||Array.isArray(e)||(t=e.space,s=e.quote,e=e.replacer),"function"==typeof e)a=e;else if(Array.isArray(e)){n=[];for(const u of e){let e;"string"==typeof u?e=u:("number"==typeof u||u instanceof String||u instanceof Number)&&(e=String(u)),void 0!==e&&n.indexOf(e)<0&&n.push(e)}}return t instanceof Number?t=Number(t):t instanceof String&&(t=String(t)),"number"==typeof t?t>0&&(t=Math.min(10,Math.floor(t)),F="          ".substr(0,t)):"string"==typeof t&&(F=t.substr(0,10)),function u(e,t){let D=t[e];switch(null!=D&&("function"==typeof D.toJSON5?D=D.toJSON5(e):"function"==typeof D.toJSON&&(D=D.toJSON(e))),a&&(D=a.call(t,e,D)),D instanceof Number?D=Number(D):D instanceof String?D=String(D):D instanceof Boolean&&(D=D.valueOf()),D){case null:return"null";case!0:return"true";case!1:return"false"}return"string"==typeof D?C(D):"number"==typeof D?String(D):"object"==typeof D?Array.isArray(D)?function(e){if(r.indexOf(e)>=0)throw TypeError("Converting circular structure to JSON5");r.push(e);let t=c;c+=F;let n,D=[];for(let t=0;t<e.length;t++){const r=u(String(t),e);D.push(void 0!==r?r:"null")}if(0===D.length)n="[]";else if(""===F)n="["+D.join(",")+"]";else{let u=",\n"+c,e=D.join(u);n="[\n"+c+e+",\n"+t+"]"}return r.pop(),c=t,n}(D):function(e){if(r.indexOf(e)>=0)throw TypeError("Converting circular structure to JSON5");r.push(e);let t=c;c+=F;let D,i=n||Object.keys(e),o=[];for(const t of i){const r=u(t,e);if(void 0!==r){let u=A(t)+":";""!==F&&(u+=" "),u+=r,o.push(u)}}if(0===o.length)D="{}";else{let u;if(""===F)u=o.join(","),D="{"+u+"}";else{let e=",\n"+c;u=o.join(e),D="{\n"+c+u+",\n"+t+"}"}}return r.pop(),c=t,D}(D):void 0}("",{"":u});function C(u){const e={"'":.1,'"':.2},t={"'":"\\'",'"':'\\"',"\\":"\\\\","\b":"\\b","\f":"\\f","\n":"\\n","\r":"\\r","\t":"\\t","\v":"\\v","\0":"\\0","\u2028":"\\u2028","\u2029":"\\u2029"};let r="";for(let n=0;n<u.length;n++){const D=u[n];switch(D){case"'":case'"':e[D]++,r+=D;continue;case"\0":if(o(u[n+1])){r+="\\x00";continue}}if(t[D])r+=t[D];else if(D<" "){let u=D.charCodeAt(0).toString(16);r+="\\x"+("00"+u).substring(u.length)}else r+=D}const n=s||Object.keys(e).reduce(((u,t)=>e[u]<e[t]?u:t));return r=r.replace(new RegExp(n,"g"),t[n]),n+r+n}function A(u){if(0===u.length)return C(u);const e=String.fromCodePoint(u.codePointAt(0));if(!D(e))return C(u);for(let t=e.length;t<u.length;t++)if(!i(String.fromCodePoint(u.codePointAt(t))))return C(u);return u}}},L=R}},e={};function t(r){var n=e[r];if(void 0!==n)return n.exports;var D=e[r]={exports:{}};return u[r].call(D.exports,D,D.exports,t),D.exports}t.d=(u,e)=>{for(var r in e)t.o(e,r)&&!t.o(u,r)&&Object.defineProperty(u,r,{enumerable:!0,get:e[r]})},t.o=(u,e)=>Object.prototype.hasOwnProperty.call(u,e),t.r=u=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(u,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(u,"__esModule",{value:!0})};var r={};(()=>{"use strict";var u=r;Object.defineProperty(u,"__esModule",{value:!0}),u.deactivate=u.activate=void 0;const e=t(496),n=t(539),D=t(733);u.activate=function(u){D.subscribeToTsConfigChanges(u),n.providers.forEach((t=>{const r=e.languages.registerCompletionItemProvider(t.selector,t.provider,...t.triggerCharacters||[]);u.subscriptions.push(r)}))},u.deactivate=function(){}})();var n=exports;for(var D in r)n[D]=r[D];r.__esModule&&Object.defineProperty(n,"__esModule",{value:!0})})();
},
"node_modules/balanced-match/index.js": function (module, exports, require, __filename, __dirname) {
'use strict';
module.exports = balanced;
function balanced(a, b, str) {
  if (a instanceof RegExp) a = maybeMatch(a, str);
  if (b instanceof RegExp) b = maybeMatch(b, str);

  var r = range(a, b, str);

  return r && {
    start: r[0],
    end: r[1],
    pre: str.slice(0, r[0]),
    body: str.slice(r[0] + a.length, r[1]),
    post: str.slice(r[1] + b.length)
  };
}

function maybeMatch(reg, str) {
  var m = str.match(reg);
  return m ? m[0] : null;
}

balanced.range = range;
function range(a, b, str) {
  var begs, beg, left, right, result;
  var ai = str.indexOf(a);
  var bi = str.indexOf(b, ai + 1);
  var i = ai;

  if (ai >= 0 && bi > 0) {
    if(a===b) {
      return [ai, bi];
    }
    begs = [];
    left = str.length;

    while (i >= 0 && !result) {
      if (i == ai) {
        begs.push(i);
        ai = str.indexOf(a, i + 1);
      } else if (begs.length == 1) {
        result = [ begs.pop(), bi ];
      } else {
        beg = begs.pop();
        if (beg < left) {
          left = beg;
          right = bi;
        }

        bi = str.indexOf(b, i + 1);
      }

      i = ai < bi && ai >= 0 ? ai : bi;
    }

    if (begs.length) {
      result = [ left, right ];
    }
  }

  return result;
}

},
"node_modules/balanced-match/package.json": function (module) { module.exports = {
  "name": "balanced-match",
  "description": "Match balanced character pairs, like \"{\" and \"}\"",
  "version": "1.0.2",
  "repository": {
    "type": "git",
    "url": "git://github.com/juliangruber/balanced-match.git"
  },
  "homepage": "https://github.com/juliangruber/balanced-match",
  "main": "index.js",
  "scripts": {
    "test": "tape test/test.js",
    "bench": "matcha test/bench.js"
  },
  "devDependencies": {
    "matcha": "^0.7.0",
    "tape": "^4.6.0"
  },
  "keywords": [
    "match",
    "regexp",
    "test",
    "balanced",
    "parse"
  ],
  "author": {
    "name": "Julian Gruber",
    "email": "mail@juliangruber.com",
    "url": "http://juliangruber.com"
  },
  "license": "MIT",
  "testling": {
    "files": "test/*.js",
    "browsers": [
      "ie/8..latest",
      "firefox/20..latest",
      "firefox/nightly",
      "chrome/25..latest",
      "chrome/canary",
      "opera/12..latest",
      "opera/next",
      "safari/5.1..latest",
      "ipad/6.0..latest",
      "iphone/6.0..latest",
      "android-browser/4.2..latest"
    ]
  }
}
; },
"node_modules/brace-expansion/index.js": function (module, exports, require, __filename, __dirname) {
var concatMap = require('concat-map');
var balanced = require('balanced-match');

module.exports = expandTop;

var escSlash = '\0SLASH'+Math.random()+'\0';
var escOpen = '\0OPEN'+Math.random()+'\0';
var escClose = '\0CLOSE'+Math.random()+'\0';
var escComma = '\0COMMA'+Math.random()+'\0';
var escPeriod = '\0PERIOD'+Math.random()+'\0';

function numeric(str) {
  return parseInt(str, 10) == str
    ? parseInt(str, 10)
    : str.charCodeAt(0);
}

function escapeBraces(str) {
  return str.split('\\\\').join(escSlash)
            .split('\\{').join(escOpen)
            .split('\\}').join(escClose)
            .split('\\,').join(escComma)
            .split('\\.').join(escPeriod);
}

function unescapeBraces(str) {
  return str.split(escSlash).join('\\')
            .split(escOpen).join('{')
            .split(escClose).join('}')
            .split(escComma).join(',')
            .split(escPeriod).join('.');
}


// Basically just str.split(","), but handling cases
// where we have nested braced sections, which should be
// treated as individual members, like {a,{b,c},d}
function parseCommaParts(str) {
  if (!str)
    return [''];

  var parts = [];
  var m = balanced('{', '}', str);

  if (!m)
    return str.split(',');

  var pre = m.pre;
  var body = m.body;
  var post = m.post;
  var p = pre.split(',');

  p[p.length-1] += '{' + body + '}';
  var postParts = parseCommaParts(post);
  if (post.length) {
    p[p.length-1] += postParts.shift();
    p.push.apply(p, postParts);
  }

  parts.push.apply(parts, p);

  return parts;
}

function expandTop(str) {
  if (!str)
    return [];

  // I don't know why Bash 4.3 does this, but it does.
  // Anything starting with {} will have the first two bytes preserved
  // but *only* at the top level, so {},a}b will not expand to anything,
  // but a{},b}c will be expanded to [a}c,abc].
  // One could argue that this is a bug in Bash, but since the goal of
  // this module is to match Bash's rules, we escape a leading {}
  if (str.substr(0, 2) === '{}') {
    str = '\\{\\}' + str.substr(2);
  }

  return expand(escapeBraces(str), true).map(unescapeBraces);
}

function identity(e) {
  return e;
}

function embrace(str) {
  return '{' + str + '}';
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}

function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}

function expand(str, isTop) {
  var expansions = [];

  var m = balanced('{', '}', str);
  if (!m || /\$$/.test(m.pre)) return [str];

  var isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
  var isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
  var isSequence = isNumericSequence || isAlphaSequence;
  var isOptions = m.body.indexOf(',') >= 0;
  if (!isSequence && !isOptions) {
    // {a},b}
    if (m.post.match(/,.*\}/)) {
      str = m.pre + '{' + m.body + escClose + m.post;
      return expand(str);
    }
    return [str];
  }

  var n;
  if (isSequence) {
    n = m.body.split(/\.\./);
  } else {
    n = parseCommaParts(m.body);
    if (n.length === 1) {
      // x{{a,b}}y ==> x{a}y x{b}y
      n = expand(n[0], false).map(embrace);
      if (n.length === 1) {
        var post = m.post.length
          ? expand(m.post, false)
          : [''];
        return post.map(function(p) {
          return m.pre + n[0] + p;
        });
      }
    }
  }

  // at this point, n is the parts, and we know it's not a comma set
  // with a single entry.

  // no need to expand pre, since it is guaranteed to be free of brace-sets
  var pre = m.pre;
  var post = m.post.length
    ? expand(m.post, false)
    : [''];

  var N;

  if (isSequence) {
    var x = numeric(n[0]);
    var y = numeric(n[1]);
    var width = Math.max(n[0].length, n[1].length)
    var incr = n.length == 3
      ? Math.abs(numeric(n[2]))
      : 1;
    var test = lte;
    var reverse = y < x;
    if (reverse) {
      incr *= -1;
      test = gte;
    }
    var pad = n.some(isPadded);

    N = [];

    for (var i = x; test(i, y); i += incr) {
      var c;
      if (isAlphaSequence) {
        c = String.fromCharCode(i);
        if (c === '\\')
          c = '';
      } else {
        c = String(i);
        if (pad) {
          var need = width - c.length;
          if (need > 0) {
            var z = new Array(need + 1).join('0');
            if (i < 0)
              c = '-' + z + c.slice(1);
            else
              c = z + c;
          }
        }
      }
      N.push(c);
    }
  } else {
    N = concatMap(n, function(el) { return expand(el, false) });
  }

  for (var j = 0; j < N.length; j++) {
    for (var k = 0; k < post.length; k++) {
      var expansion = pre + N[j] + post[k];
      if (!isTop || isSequence || expansion)
        expansions.push(expansion);
    }
  }

  return expansions;
}


},
"node_modules/brace-expansion/package.json": function (module) { module.exports = {
  "name": "brace-expansion",
  "description": "Brace expansion as known from sh/bash",
  "version": "1.1.11",
  "repository": {
    "type": "git",
    "url": "git://github.com/juliangruber/brace-expansion.git"
  },
  "homepage": "https://github.com/juliangruber/brace-expansion",
  "main": "index.js",
  "scripts": {
    "test": "tape test/*.js",
    "gentest": "bash test/generate.sh",
    "bench": "matcha test/perf/bench.js"
  },
  "dependencies": {
    "balanced-match": "^1.0.0",
    "concat-map": "0.0.1"
  },
  "devDependencies": {
    "matcha": "^0.7.0",
    "tape": "^4.6.0"
  },
  "keywords": [],
  "author": {
    "name": "Julian Gruber",
    "email": "mail@juliangruber.com",
    "url": "http://juliangruber.com"
  },
  "license": "MIT",
  "testling": {
    "files": "test/*.js",
    "browsers": [
      "ie/8..latest",
      "firefox/20..latest",
      "firefox/nightly",
      "chrome/25..latest",
      "chrome/canary",
      "opera/12..latest",
      "opera/next",
      "safari/5.1..latest",
      "ipad/6.0..latest",
      "iphone/6.0..latest",
      "android-browser/4.2..latest"
    ]
  }
}
; },
"node_modules/concat-map/index.js": function (module, exports, require, __filename, __dirname) {
module.exports = function (xs, fn) {
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        var x = fn(xs[i], i);
        if (isArray(x)) res.push.apply(res, x);
        else res.push(x);
    }
    return res;
};

var isArray = Array.isArray || function (xs) {
    return Object.prototype.toString.call(xs) === '[object Array]';
};

},
"node_modules/concat-map/package.json": function (module) { module.exports = {
    "name" : "concat-map",
    "description" : "concatenative mapdashery",
    "version" : "0.0.1",
    "repository" : {
        "type" : "git",
        "url" : "git://github.com/substack/node-concat-map.git"
    },
    "main" : "index.js",
    "keywords" : [
        "concat",
        "concatMap",
        "map",
        "functional",
        "higher-order"
    ],
    "directories" : {
        "example" : "example",
        "test" : "test"
    },
    "scripts" : {
        "test" : "tape test/*.js"
    },
    "devDependencies" : {
        "tape" : "~2.4.0"
    },
    "license" : "MIT",
    "author" : {
        "name" : "James Halliday",
        "email" : "mail@substack.net",
        "url" : "http://substack.net"
    },
    "testling" : {
        "files" : "test/*.js",
        "browsers" : {
            "ie" : [ 6, 7, 8, 9 ],
            "ff" : [ 3.5, 10, 15.0 ],
            "chrome" : [ 10, 22 ],
            "safari" : [ 5.1 ],
            "opera" : [ 12 ]
        }
    }
}
; },
"node_modules/json5/dist/index.js": function (module, exports, require, __filename, __dirname) {
(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.JSON5 = factory());
}(this, (function () { 'use strict';

	function createCommonjsModule(fn, module) {
		return module = { exports: {} }, fn(module, module.exports), module.exports;
	}

	var _global = createCommonjsModule(function (module) {
	// https://github.com/zloirock/core-js/issues/86#issuecomment-115759028
	var global = module.exports = typeof window != 'undefined' && window.Math == Math
	  ? window : typeof self != 'undefined' && self.Math == Math ? self
	  // eslint-disable-next-line no-new-func
	  : Function('return this')();
	if (typeof __g == 'number') { __g = global; } // eslint-disable-line no-undef
	});

	var _core = createCommonjsModule(function (module) {
	var core = module.exports = { version: '2.6.5' };
	if (typeof __e == 'number') { __e = core; } // eslint-disable-line no-undef
	});
	var _core_1 = _core.version;

	var _isObject = function (it) {
	  return typeof it === 'object' ? it !== null : typeof it === 'function';
	};

	var _anObject = function (it) {
	  if (!_isObject(it)) { throw TypeError(it + ' is not an object!'); }
	  return it;
	};

	var _fails = function (exec) {
	  try {
	    return !!exec();
	  } catch (e) {
	    return true;
	  }
	};

	// Thank's IE8 for his funny defineProperty
	var _descriptors = !_fails(function () {
	  return Object.defineProperty({}, 'a', { get: function () { return 7; } }).a != 7;
	});

	var document = _global.document;
	// typeof document.createElement is 'object' in old IE
	var is = _isObject(document) && _isObject(document.createElement);
	var _domCreate = function (it) {
	  return is ? document.createElement(it) : {};
	};

	var _ie8DomDefine = !_descriptors && !_fails(function () {
	  return Object.defineProperty(_domCreate('div'), 'a', { get: function () { return 7; } }).a != 7;
	});

	// 7.1.1 ToPrimitive(input [, PreferredType])

	// instead of the ES6 spec version, we didn't implement @@toPrimitive case
	// and the second argument - flag - preferred type is a string
	var _toPrimitive = function (it, S) {
	  if (!_isObject(it)) { return it; }
	  var fn, val;
	  if (S && typeof (fn = it.toString) == 'function' && !_isObject(val = fn.call(it))) { return val; }
	  if (typeof (fn = it.valueOf) == 'function' && !_isObject(val = fn.call(it))) { return val; }
	  if (!S && typeof (fn = it.toString) == 'function' && !_isObject(val = fn.call(it))) { return val; }
	  throw TypeError("Can't convert object to primitive value");
	};

	var dP = Object.defineProperty;

	var f = _descriptors ? Object.defineProperty : function defineProperty(O, P, Attributes) {
	  _anObject(O);
	  P = _toPrimitive(P, true);
	  _anObject(Attributes);
	  if (_ie8DomDefine) { try {
	    return dP(O, P, Attributes);
	  } catch (e) { /* empty */ } }
	  if ('get' in Attributes || 'set' in Attributes) { throw TypeError('Accessors not supported!'); }
	  if ('value' in Attributes) { O[P] = Attributes.value; }
	  return O;
	};

	var _objectDp = {
		f: f
	};

	var _propertyDesc = function (bitmap, value) {
	  return {
	    enumerable: !(bitmap & 1),
	    configurable: !(bitmap & 2),
	    writable: !(bitmap & 4),
	    value: value
	  };
	};

	var _hide = _descriptors ? function (object, key, value) {
	  return _objectDp.f(object, key, _propertyDesc(1, value));
	} : function (object, key, value) {
	  object[key] = value;
	  return object;
	};

	var hasOwnProperty = {}.hasOwnProperty;
	var _has = function (it, key) {
	  return hasOwnProperty.call(it, key);
	};

	var id = 0;
	var px = Math.random();
	var _uid = function (key) {
	  return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++id + px).toString(36));
	};

	var _library = false;

	var _shared = createCommonjsModule(function (module) {
	var SHARED = '__core-js_shared__';
	var store = _global[SHARED] || (_global[SHARED] = {});

	(module.exports = function (key, value) {
	  return store[key] || (store[key] = value !== undefined ? value : {});
	})('versions', []).push({
	  version: _core.version,
	  mode: _library ? 'pure' : 'global',
	  copyright: '© 2019 Denis Pushkarev (zloirock.ru)'
	});
	});

	var _functionToString = _shared('native-function-to-string', Function.toString);

	var _redefine = createCommonjsModule(function (module) {
	var SRC = _uid('src');

	var TO_STRING = 'toString';
	var TPL = ('' + _functionToString).split(TO_STRING);

	_core.inspectSource = function (it) {
	  return _functionToString.call(it);
	};

	(module.exports = function (O, key, val, safe) {
	  var isFunction = typeof val == 'function';
	  if (isFunction) { _has(val, 'name') || _hide(val, 'name', key); }
	  if (O[key] === val) { return; }
	  if (isFunction) { _has(val, SRC) || _hide(val, SRC, O[key] ? '' + O[key] : TPL.join(String(key))); }
	  if (O === _global) {
	    O[key] = val;
	  } else if (!safe) {
	    delete O[key];
	    _hide(O, key, val);
	  } else if (O[key]) {
	    O[key] = val;
	  } else {
	    _hide(O, key, val);
	  }
	// add fake Function#toString for correct work wrapped methods / constructors with methods like LoDash isNative
	})(Function.prototype, TO_STRING, function toString() {
	  return typeof this == 'function' && this[SRC] || _functionToString.call(this);
	});
	});

	var _aFunction = function (it) {
	  if (typeof it != 'function') { throw TypeError(it + ' is not a function!'); }
	  return it;
	};

	// optional / simple context binding

	var _ctx = function (fn, that, length) {
	  _aFunction(fn);
	  if (that === undefined) { return fn; }
	  switch (length) {
	    case 1: return function (a) {
	      return fn.call(that, a);
	    };
	    case 2: return function (a, b) {
	      return fn.call(that, a, b);
	    };
	    case 3: return function (a, b, c) {
	      return fn.call(that, a, b, c);
	    };
	  }
	  return function (/* ...args */) {
	    return fn.apply(that, arguments);
	  };
	};

	var PROTOTYPE = 'prototype';

	var $export = function (type, name, source) {
	  var IS_FORCED = type & $export.F;
	  var IS_GLOBAL = type & $export.G;
	  var IS_STATIC = type & $export.S;
	  var IS_PROTO = type & $export.P;
	  var IS_BIND = type & $export.B;
	  var target = IS_GLOBAL ? _global : IS_STATIC ? _global[name] || (_global[name] = {}) : (_global[name] || {})[PROTOTYPE];
	  var exports = IS_GLOBAL ? _core : _core[name] || (_core[name] = {});
	  var expProto = exports[PROTOTYPE] || (exports[PROTOTYPE] = {});
	  var key, own, out, exp;
	  if (IS_GLOBAL) { source = name; }
	  for (key in source) {
	    // contains in native
	    own = !IS_FORCED && target && target[key] !== undefined;
	    // export native or passed
	    out = (own ? target : source)[key];
	    // bind timers to global for call from export context
	    exp = IS_BIND && own ? _ctx(out, _global) : IS_PROTO && typeof out == 'function' ? _ctx(Function.call, out) : out;
	    // extend global
	    if (target) { _redefine(target, key, out, type & $export.U); }
	    // export
	    if (exports[key] != out) { _hide(exports, key, exp); }
	    if (IS_PROTO && expProto[key] != out) { expProto[key] = out; }
	  }
	};
	_global.core = _core;
	// type bitmap
	$export.F = 1;   // forced
	$export.G = 2;   // global
	$export.S = 4;   // static
	$export.P = 8;   // proto
	$export.B = 16;  // bind
	$export.W = 32;  // wrap
	$export.U = 64;  // safe
	$export.R = 128; // real proto method for `library`
	var _export = $export;

	// 7.1.4 ToInteger
	var ceil = Math.ceil;
	var floor = Math.floor;
	var _toInteger = function (it) {
	  return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
	};

	// 7.2.1 RequireObjectCoercible(argument)
	var _defined = function (it) {
	  if (it == undefined) { throw TypeError("Can't call method on  " + it); }
	  return it;
	};

	// true  -> String#at
	// false -> String#codePointAt
	var _stringAt = function (TO_STRING) {
	  return function (that, pos) {
	    var s = String(_defined(that));
	    var i = _toInteger(pos);
	    var l = s.length;
	    var a, b;
	    if (i < 0 || i >= l) { return TO_STRING ? '' : undefined; }
	    a = s.charCodeAt(i);
	    return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff
	      ? TO_STRING ? s.charAt(i) : a
	      : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
	  };
	};

	var $at = _stringAt(false);
	_export(_export.P, 'String', {
	  // 21.1.3.3 String.prototype.codePointAt(pos)
	  codePointAt: function codePointAt(pos) {
	    return $at(this, pos);
	  }
	});

	var codePointAt = _core.String.codePointAt;

	var max = Math.max;
	var min = Math.min;
	var _toAbsoluteIndex = function (index, length) {
	  index = _toInteger(index);
	  return index < 0 ? max(index + length, 0) : min(index, length);
	};

	var fromCharCode = String.fromCharCode;
	var $fromCodePoint = String.fromCodePoint;

	// length should be 1, old FF problem
	_export(_export.S + _export.F * (!!$fromCodePoint && $fromCodePoint.length != 1), 'String', {
	  // 21.1.2.2 String.fromCodePoint(...codePoints)
	  fromCodePoint: function fromCodePoint(x) {
	    var arguments$1 = arguments;
	 // eslint-disable-line no-unused-vars
	    var res = [];
	    var aLen = arguments.length;
	    var i = 0;
	    var code;
	    while (aLen > i) {
	      code = +arguments$1[i++];
	      if (_toAbsoluteIndex(code, 0x10ffff) !== code) { throw RangeError(code + ' is not a valid code point'); }
	      res.push(code < 0x10000
	        ? fromCharCode(code)
	        : fromCharCode(((code -= 0x10000) >> 10) + 0xd800, code % 0x400 + 0xdc00)
	      );
	    } return res.join('');
	  }
	});

	var fromCodePoint = _core.String.fromCodePoint;

	// This is a generated file. Do not edit.
	var Space_Separator = /[\u1680\u2000-\u200A\u202F\u205F\u3000]/;
	var ID_Start = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/;
	var ID_Continue = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/;

	var unicode = {
		Space_Separator: Space_Separator,
		ID_Start: ID_Start,
		ID_Continue: ID_Continue
	};

	var util = {
	    isSpaceSeparator: function isSpaceSeparator (c) {
	        return typeof c === 'string' && unicode.Space_Separator.test(c)
	    },

	    isIdStartChar: function isIdStartChar (c) {
	        return typeof c === 'string' && (
	            (c >= 'a' && c <= 'z') ||
	        (c >= 'A' && c <= 'Z') ||
	        (c === '$') || (c === '_') ||
	        unicode.ID_Start.test(c)
	        )
	    },

	    isIdContinueChar: function isIdContinueChar (c) {
	        return typeof c === 'string' && (
	            (c >= 'a' && c <= 'z') ||
	        (c >= 'A' && c <= 'Z') ||
	        (c >= '0' && c <= '9') ||
	        (c === '$') || (c === '_') ||
	        (c === '\u200C') || (c === '\u200D') ||
	        unicode.ID_Continue.test(c)
	        )
	    },

	    isDigit: function isDigit (c) {
	        return typeof c === 'string' && /[0-9]/.test(c)
	    },

	    isHexDigit: function isHexDigit (c) {
	        return typeof c === 'string' && /[0-9A-Fa-f]/.test(c)
	    },
	};

	var source;
	var parseState;
	var stack;
	var pos;
	var line;
	var column;
	var token;
	var key;
	var root;

	var parse = function parse (text, reviver) {
	    source = String(text);
	    parseState = 'start';
	    stack = [];
	    pos = 0;
	    line = 1;
	    column = 0;
	    token = undefined;
	    key = undefined;
	    root = undefined;

	    do {
	        token = lex();

	        // This code is unreachable.
	        // if (!parseStates[parseState]) {
	        //     throw invalidParseState()
	        // }

	        parseStates[parseState]();
	    } while (token.type !== 'eof')

	    if (typeof reviver === 'function') {
	        return internalize({'': root}, '', reviver)
	    }

	    return root
	};

	function internalize (holder, name, reviver) {
	    var value = holder[name];
	    if (value != null && typeof value === 'object') {
	        for (var key in value) {
	            var replacement = internalize(value, key, reviver);
	            if (replacement === undefined) {
	                delete value[key];
	            } else {
	                value[key] = replacement;
	            }
	        }
	    }

	    return reviver.call(holder, name, value)
	}

	var lexState;
	var buffer;
	var doubleQuote;
	var sign;
	var c;

	function lex () {
	    lexState = 'default';
	    buffer = '';
	    doubleQuote = false;
	    sign = 1;

	    for (;;) {
	        c = peek();

	        // This code is unreachable.
	        // if (!lexStates[lexState]) {
	        //     throw invalidLexState(lexState)
	        // }

	        var token = lexStates[lexState]();
	        if (token) {
	            return token
	        }
	    }
	}

	function peek () {
	    if (source[pos]) {
	        return String.fromCodePoint(source.codePointAt(pos))
	    }
	}

	function read () {
	    var c = peek();

	    if (c === '\n') {
	        line++;
	        column = 0;
	    } else if (c) {
	        column += c.length;
	    } else {
	        column++;
	    }

	    if (c) {
	        pos += c.length;
	    }

	    return c
	}

	var lexStates = {
	    default: function default$1 () {
	        switch (c) {
	        case '\t':
	        case '\v':
	        case '\f':
	        case ' ':
	        case '\u00A0':
	        case '\uFEFF':
	        case '\n':
	        case '\r':
	        case '\u2028':
	        case '\u2029':
	            read();
	            return

	        case '/':
	            read();
	            lexState = 'comment';
	            return

	        case undefined:
	            read();
	            return newToken('eof')
	        }

	        if (util.isSpaceSeparator(c)) {
	            read();
	            return
	        }

	        // This code is unreachable.
	        // if (!lexStates[parseState]) {
	        //     throw invalidLexState(parseState)
	        // }

	        return lexStates[parseState]()
	    },

	    comment: function comment () {
	        switch (c) {
	        case '*':
	            read();
	            lexState = 'multiLineComment';
	            return

	        case '/':
	            read();
	            lexState = 'singleLineComment';
	            return
	        }

	        throw invalidChar(read())
	    },

	    multiLineComment: function multiLineComment () {
	        switch (c) {
	        case '*':
	            read();
	            lexState = 'multiLineCommentAsterisk';
	            return

	        case undefined:
	            throw invalidChar(read())
	        }

	        read();
	    },

	    multiLineCommentAsterisk: function multiLineCommentAsterisk () {
	        switch (c) {
	        case '*':
	            read();
	            return

	        case '/':
	            read();
	            lexState = 'default';
	            return

	        case undefined:
	            throw invalidChar(read())
	        }

	        read();
	        lexState = 'multiLineComment';
	    },

	    singleLineComment: function singleLineComment () {
	        switch (c) {
	        case '\n':
	        case '\r':
	        case '\u2028':
	        case '\u2029':
	            read();
	            lexState = 'default';
	            return

	        case undefined:
	            read();
	            return newToken('eof')
	        }

	        read();
	    },

	    value: function value () {
	        switch (c) {
	        case '{':
	        case '[':
	            return newToken('punctuator', read())

	        case 'n':
	            read();
	            literal('ull');
	            return newToken('null', null)

	        case 't':
	            read();
	            literal('rue');
	            return newToken('boolean', true)

	        case 'f':
	            read();
	            literal('alse');
	            return newToken('boolean', false)

	        case '-':
	        case '+':
	            if (read() === '-') {
	                sign = -1;
	            }

	            lexState = 'sign';
	            return

	        case '.':
	            buffer = read();
	            lexState = 'decimalPointLeading';
	            return

	        case '0':
	            buffer = read();
	            lexState = 'zero';
	            return

	        case '1':
	        case '2':
	        case '3':
	        case '4':
	        case '5':
	        case '6':
	        case '7':
	        case '8':
	        case '9':
	            buffer = read();
	            lexState = 'decimalInteger';
	            return

	        case 'I':
	            read();
	            literal('nfinity');
	            return newToken('numeric', Infinity)

	        case 'N':
	            read();
	            literal('aN');
	            return newToken('numeric', NaN)

	        case '"':
	        case "'":
	            doubleQuote = (read() === '"');
	            buffer = '';
	            lexState = 'string';
	            return
	        }

	        throw invalidChar(read())
	    },

	    identifierNameStartEscape: function identifierNameStartEscape () {
	        if (c !== 'u') {
	            throw invalidChar(read())
	        }

	        read();
	        var u = unicodeEscape();
	        switch (u) {
	        case '$':
	        case '_':
	            break

	        default:
	            if (!util.isIdStartChar(u)) {
	                throw invalidIdentifier()
	            }

	            break
	        }

	        buffer += u;
	        lexState = 'identifierName';
	    },

	    identifierName: function identifierName () {
	        switch (c) {
	        case '$':
	        case '_':
	        case '\u200C':
	        case '\u200D':
	            buffer += read();
	            return

	        case '\\':
	            read();
	            lexState = 'identifierNameEscape';
	            return
	        }

	        if (util.isIdContinueChar(c)) {
	            buffer += read();
	            return
	        }

	        return newToken('identifier', buffer)
	    },

	    identifierNameEscape: function identifierNameEscape () {
	        if (c !== 'u') {
	            throw invalidChar(read())
	        }

	        read();
	        var u = unicodeEscape();
	        switch (u) {
	        case '$':
	        case '_':
	        case '\u200C':
	        case '\u200D':
	            break

	        default:
	            if (!util.isIdContinueChar(u)) {
	                throw invalidIdentifier()
	            }

	            break
	        }

	        buffer += u;
	        lexState = 'identifierName';
	    },

	    sign: function sign$1 () {
	        switch (c) {
	        case '.':
	            buffer = read();
	            lexState = 'decimalPointLeading';
	            return

	        case '0':
	            buffer = read();
	            lexState = 'zero';
	            return

	        case '1':
	        case '2':
	        case '3':
	        case '4':
	        case '5':
	        case '6':
	        case '7':
	        case '8':
	        case '9':
	            buffer = read();
	            lexState = 'decimalInteger';
	            return

	        case 'I':
	            read();
	            literal('nfinity');
	            return newToken('numeric', sign * Infinity)

	        case 'N':
	            read();
	            literal('aN');
	            return newToken('numeric', NaN)
	        }

	        throw invalidChar(read())
	    },

	    zero: function zero () {
	        switch (c) {
	        case '.':
	            buffer += read();
	            lexState = 'decimalPoint';
	            return

	        case 'e':
	        case 'E':
	            buffer += read();
	            lexState = 'decimalExponent';
	            return

	        case 'x':
	        case 'X':
	            buffer += read();
	            lexState = 'hexadecimal';
	            return
	        }

	        return newToken('numeric', sign * 0)
	    },

	    decimalInteger: function decimalInteger () {
	        switch (c) {
	        case '.':
	            buffer += read();
	            lexState = 'decimalPoint';
	            return

	        case 'e':
	        case 'E':
	            buffer += read();
	            lexState = 'decimalExponent';
	            return
	        }

	        if (util.isDigit(c)) {
	            buffer += read();
	            return
	        }

	        return newToken('numeric', sign * Number(buffer))
	    },

	    decimalPointLeading: function decimalPointLeading () {
	        if (util.isDigit(c)) {
	            buffer += read();
	            lexState = 'decimalFraction';
	            return
	        }

	        throw invalidChar(read())
	    },

	    decimalPoint: function decimalPoint () {
	        switch (c) {
	        case 'e':
	        case 'E':
	            buffer += read();
	            lexState = 'decimalExponent';
	            return
	        }

	        if (util.isDigit(c)) {
	            buffer += read();
	            lexState = 'decimalFraction';
	            return
	        }

	        return newToken('numeric', sign * Number(buffer))
	    },

	    decimalFraction: function decimalFraction () {
	        switch (c) {
	        case 'e':
	        case 'E':
	            buffer += read();
	            lexState = 'decimalExponent';
	            return
	        }

	        if (util.isDigit(c)) {
	            buffer += read();
	            return
	        }

	        return newToken('numeric', sign * Number(buffer))
	    },

	    decimalExponent: function decimalExponent () {
	        switch (c) {
	        case '+':
	        case '-':
	            buffer += read();
	            lexState = 'decimalExponentSign';
	            return
	        }

	        if (util.isDigit(c)) {
	            buffer += read();
	            lexState = 'decimalExponentInteger';
	            return
	        }

	        throw invalidChar(read())
	    },

	    decimalExponentSign: function decimalExponentSign () {
	        if (util.isDigit(c)) {
	            buffer += read();
	            lexState = 'decimalExponentInteger';
	            return
	        }

	        throw invalidChar(read())
	    },

	    decimalExponentInteger: function decimalExponentInteger () {
	        if (util.isDigit(c)) {
	            buffer += read();
	            return
	        }

	        return newToken('numeric', sign * Number(buffer))
	    },

	    hexadecimal: function hexadecimal () {
	        if (util.isHexDigit(c)) {
	            buffer += read();
	            lexState = 'hexadecimalInteger';
	            return
	        }

	        throw invalidChar(read())
	    },

	    hexadecimalInteger: function hexadecimalInteger () {
	        if (util.isHexDigit(c)) {
	            buffer += read();
	            return
	        }

	        return newToken('numeric', sign * Number(buffer))
	    },

	    string: function string () {
	        switch (c) {
	        case '\\':
	            read();
	            buffer += escape();
	            return

	        case '"':
	            if (doubleQuote) {
	                read();
	                return newToken('string', buffer)
	            }

	            buffer += read();
	            return

	        case "'":
	            if (!doubleQuote) {
	                read();
	                return newToken('string', buffer)
	            }

	            buffer += read();
	            return

	        case '\n':
	        case '\r':
	            throw invalidChar(read())

	        case '\u2028':
	        case '\u2029':
	            separatorChar(c);
	            break

	        case undefined:
	            throw invalidChar(read())
	        }

	        buffer += read();
	    },

	    start: function start () {
	        switch (c) {
	        case '{':
	        case '[':
	            return newToken('punctuator', read())

	        // This code is unreachable since the default lexState handles eof.
	        // case undefined:
	        //     return newToken('eof')
	        }

	        lexState = 'value';
	    },

	    beforePropertyName: function beforePropertyName () {
	        switch (c) {
	        case '$':
	        case '_':
	            buffer = read();
	            lexState = 'identifierName';
	            return

	        case '\\':
	            read();
	            lexState = 'identifierNameStartEscape';
	            return

	        case '}':
	            return newToken('punctuator', read())

	        case '"':
	        case "'":
	            doubleQuote = (read() === '"');
	            lexState = 'string';
	            return
	        }

	        if (util.isIdStartChar(c)) {
	            buffer += read();
	            lexState = 'identifierName';
	            return
	        }

	        throw invalidChar(read())
	    },

	    afterPropertyName: function afterPropertyName () {
	        if (c === ':') {
	            return newToken('punctuator', read())
	        }

	        throw invalidChar(read())
	    },

	    beforePropertyValue: function beforePropertyValue () {
	        lexState = 'value';
	    },

	    afterPropertyValue: function afterPropertyValue () {
	        switch (c) {
	        case ',':
	        case '}':
	            return newToken('punctuator', read())
	        }

	        throw invalidChar(read())
	    },

	    beforeArrayValue: function beforeArrayValue () {
	        if (c === ']') {
	            return newToken('punctuator', read())
	        }

	        lexState = 'value';
	    },

	    afterArrayValue: function afterArrayValue () {
	        switch (c) {
	        case ',':
	        case ']':
	            return newToken('punctuator', read())
	        }

	        throw invalidChar(read())
	    },

	    end: function end () {
	        // This code is unreachable since it's handled by the default lexState.
	        // if (c === undefined) {
	        //     read()
	        //     return newToken('eof')
	        // }

	        throw invalidChar(read())
	    },
	};

	function newToken (type, value) {
	    return {
	        type: type,
	        value: value,
	        line: line,
	        column: column,
	    }
	}

	function literal (s) {
	    for (var i = 0, list = s; i < list.length; i += 1) {
	        var c = list[i];

	        var p = peek();

	        if (p !== c) {
	            throw invalidChar(read())
	        }

	        read();
	    }
	}

	function escape () {
	    var c = peek();
	    switch (c) {
	    case 'b':
	        read();
	        return '\b'

	    case 'f':
	        read();
	        return '\f'

	    case 'n':
	        read();
	        return '\n'

	    case 'r':
	        read();
	        return '\r'

	    case 't':
	        read();
	        return '\t'

	    case 'v':
	        read();
	        return '\v'

	    case '0':
	        read();
	        if (util.isDigit(peek())) {
	            throw invalidChar(read())
	        }

	        return '\0'

	    case 'x':
	        read();
	        return hexEscape()

	    case 'u':
	        read();
	        return unicodeEscape()

	    case '\n':
	    case '\u2028':
	    case '\u2029':
	        read();
	        return ''

	    case '\r':
	        read();
	        if (peek() === '\n') {
	            read();
	        }

	        return ''

	    case '1':
	    case '2':
	    case '3':
	    case '4':
	    case '5':
	    case '6':
	    case '7':
	    case '8':
	    case '9':
	        throw invalidChar(read())

	    case undefined:
	        throw invalidChar(read())
	    }

	    return read()
	}

	function hexEscape () {
	    var buffer = '';
	    var c = peek();

	    if (!util.isHexDigit(c)) {
	        throw invalidChar(read())
	    }

	    buffer += read();

	    c = peek();
	    if (!util.isHexDigit(c)) {
	        throw invalidChar(read())
	    }

	    buffer += read();

	    return String.fromCodePoint(parseInt(buffer, 16))
	}

	function unicodeEscape () {
	    var buffer = '';
	    var count = 4;

	    while (count-- > 0) {
	        var c = peek();
	        if (!util.isHexDigit(c)) {
	            throw invalidChar(read())
	        }

	        buffer += read();
	    }

	    return String.fromCodePoint(parseInt(buffer, 16))
	}

	var parseStates = {
	    start: function start () {
	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        push();
	    },

	    beforePropertyName: function beforePropertyName () {
	        switch (token.type) {
	        case 'identifier':
	        case 'string':
	            key = token.value;
	            parseState = 'afterPropertyName';
	            return

	        case 'punctuator':
	            // This code is unreachable since it's handled by the lexState.
	            // if (token.value !== '}') {
	            //     throw invalidToken()
	            // }

	            pop();
	            return

	        case 'eof':
	            throw invalidEOF()
	        }

	        // This code is unreachable since it's handled by the lexState.
	        // throw invalidToken()
	    },

	    afterPropertyName: function afterPropertyName () {
	        // This code is unreachable since it's handled by the lexState.
	        // if (token.type !== 'punctuator' || token.value !== ':') {
	        //     throw invalidToken()
	        // }

	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        parseState = 'beforePropertyValue';
	    },

	    beforePropertyValue: function beforePropertyValue () {
	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        push();
	    },

	    beforeArrayValue: function beforeArrayValue () {
	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        if (token.type === 'punctuator' && token.value === ']') {
	            pop();
	            return
	        }

	        push();
	    },

	    afterPropertyValue: function afterPropertyValue () {
	        // This code is unreachable since it's handled by the lexState.
	        // if (token.type !== 'punctuator') {
	        //     throw invalidToken()
	        // }

	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        switch (token.value) {
	        case ',':
	            parseState = 'beforePropertyName';
	            return

	        case '}':
	            pop();
	        }

	        // This code is unreachable since it's handled by the lexState.
	        // throw invalidToken()
	    },

	    afterArrayValue: function afterArrayValue () {
	        // This code is unreachable since it's handled by the lexState.
	        // if (token.type !== 'punctuator') {
	        //     throw invalidToken()
	        // }

	        if (token.type === 'eof') {
	            throw invalidEOF()
	        }

	        switch (token.value) {
	        case ',':
	            parseState = 'beforeArrayValue';
	            return

	        case ']':
	            pop();
	        }

	        // This code is unreachable since it's handled by the lexState.
	        // throw invalidToken()
	    },

	    end: function end () {
	        // This code is unreachable since it's handled by the lexState.
	        // if (token.type !== 'eof') {
	        //     throw invalidToken()
	        // }
	    },
	};

	function push () {
	    var value;

	    switch (token.type) {
	    case 'punctuator':
	        switch (token.value) {
	        case '{':
	            value = {};
	            break

	        case '[':
	            value = [];
	            break
	        }

	        break

	    case 'null':
	    case 'boolean':
	    case 'numeric':
	    case 'string':
	        value = token.value;
	        break

	    // This code is unreachable.
	    // default:
	    //     throw invalidToken()
	    }

	    if (root === undefined) {
	        root = value;
	    } else {
	        var parent = stack[stack.length - 1];
	        if (Array.isArray(parent)) {
	            parent.push(value);
	        } else {
	            parent[key] = value;
	        }
	    }

	    if (value !== null && typeof value === 'object') {
	        stack.push(value);

	        if (Array.isArray(value)) {
	            parseState = 'beforeArrayValue';
	        } else {
	            parseState = 'beforePropertyName';
	        }
	    } else {
	        var current = stack[stack.length - 1];
	        if (current == null) {
	            parseState = 'end';
	        } else if (Array.isArray(current)) {
	            parseState = 'afterArrayValue';
	        } else {
	            parseState = 'afterPropertyValue';
	        }
	    }
	}

	function pop () {
	    stack.pop();

	    var current = stack[stack.length - 1];
	    if (current == null) {
	        parseState = 'end';
	    } else if (Array.isArray(current)) {
	        parseState = 'afterArrayValue';
	    } else {
	        parseState = 'afterPropertyValue';
	    }
	}

	// This code is unreachable.
	// function invalidParseState () {
	//     return new Error(`JSON5: invalid parse state '${parseState}'`)
	// }

	// This code is unreachable.
	// function invalidLexState (state) {
	//     return new Error(`JSON5: invalid lex state '${state}'`)
	// }

	function invalidChar (c) {
	    if (c === undefined) {
	        return syntaxError(("JSON5: invalid end of input at " + line + ":" + column))
	    }

	    return syntaxError(("JSON5: invalid character '" + (formatChar(c)) + "' at " + line + ":" + column))
	}

	function invalidEOF () {
	    return syntaxError(("JSON5: invalid end of input at " + line + ":" + column))
	}

	// This code is unreachable.
	// function invalidToken () {
	//     if (token.type === 'eof') {
	//         return syntaxError(`JSON5: invalid end of input at ${line}:${column}`)
	//     }

	//     const c = String.fromCodePoint(token.value.codePointAt(0))
	//     return syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${line}:${column}`)
	// }

	function invalidIdentifier () {
	    column -= 5;
	    return syntaxError(("JSON5: invalid identifier character at " + line + ":" + column))
	}

	function separatorChar (c) {
	    console.warn(("JSON5: '" + (formatChar(c)) + "' in strings is not valid ECMAScript; consider escaping"));
	}

	function formatChar (c) {
	    var replacements = {
	        "'": "\\'",
	        '"': '\\"',
	        '\\': '\\\\',
	        '\b': '\\b',
	        '\f': '\\f',
	        '\n': '\\n',
	        '\r': '\\r',
	        '\t': '\\t',
	        '\v': '\\v',
	        '\0': '\\0',
	        '\u2028': '\\u2028',
	        '\u2029': '\\u2029',
	    };

	    if (replacements[c]) {
	        return replacements[c]
	    }

	    if (c < ' ') {
	        var hexString = c.charCodeAt(0).toString(16);
	        return '\\x' + ('00' + hexString).substring(hexString.length)
	    }

	    return c
	}

	function syntaxError (message) {
	    var err = new SyntaxError(message);
	    err.lineNumber = line;
	    err.columnNumber = column;
	    return err
	}

	var stringify = function stringify (value, replacer, space) {
	    var stack = [];
	    var indent = '';
	    var propertyList;
	    var replacerFunc;
	    var gap = '';
	    var quote;

	    if (
	        replacer != null &&
	        typeof replacer === 'object' &&
	        !Array.isArray(replacer)
	    ) {
	        space = replacer.space;
	        quote = replacer.quote;
	        replacer = replacer.replacer;
	    }

	    if (typeof replacer === 'function') {
	        replacerFunc = replacer;
	    } else if (Array.isArray(replacer)) {
	        propertyList = [];
	        for (var i = 0, list = replacer; i < list.length; i += 1) {
	            var v = list[i];

	            var item = (void 0);

	            if (typeof v === 'string') {
	                item = v;
	            } else if (
	                typeof v === 'number' ||
	                v instanceof String ||
	                v instanceof Number
	            ) {
	                item = String(v);
	            }

	            if (item !== undefined && propertyList.indexOf(item) < 0) {
	                propertyList.push(item);
	            }
	        }
	    }

	    if (space instanceof Number) {
	        space = Number(space);
	    } else if (space instanceof String) {
	        space = String(space);
	    }

	    if (typeof space === 'number') {
	        if (space > 0) {
	            space = Math.min(10, Math.floor(space));
	            gap = '          '.substr(0, space);
	        }
	    } else if (typeof space === 'string') {
	        gap = space.substr(0, 10);
	    }

	    return serializeProperty('', {'': value})

	    function serializeProperty (key, holder) {
	        var value = holder[key];
	        if (value != null) {
	            if (typeof value.toJSON5 === 'function') {
	                value = value.toJSON5(key);
	            } else if (typeof value.toJSON === 'function') {
	                value = value.toJSON(key);
	            }
	        }

	        if (replacerFunc) {
	            value = replacerFunc.call(holder, key, value);
	        }

	        if (value instanceof Number) {
	            value = Number(value);
	        } else if (value instanceof String) {
	            value = String(value);
	        } else if (value instanceof Boolean) {
	            value = value.valueOf();
	        }

	        switch (value) {
	        case null: return 'null'
	        case true: return 'true'
	        case false: return 'false'
	        }

	        if (typeof value === 'string') {
	            return quoteString(value, false)
	        }

	        if (typeof value === 'number') {
	            return String(value)
	        }

	        if (typeof value === 'object') {
	            return Array.isArray(value) ? serializeArray(value) : serializeObject(value)
	        }

	        return undefined
	    }

	    function quoteString (value) {
	        var quotes = {
	            "'": 0.1,
	            '"': 0.2,
	        };

	        var replacements = {
	            "'": "\\'",
	            '"': '\\"',
	            '\\': '\\\\',
	            '\b': '\\b',
	            '\f': '\\f',
	            '\n': '\\n',
	            '\r': '\\r',
	            '\t': '\\t',
	            '\v': '\\v',
	            '\0': '\\0',
	            '\u2028': '\\u2028',
	            '\u2029': '\\u2029',
	        };

	        var product = '';

	        for (var i = 0; i < value.length; i++) {
	            var c = value[i];
	            switch (c) {
	            case "'":
	            case '"':
	                quotes[c]++;
	                product += c;
	                continue

	            case '\0':
	                if (util.isDigit(value[i + 1])) {
	                    product += '\\x00';
	                    continue
	                }
	            }

	            if (replacements[c]) {
	                product += replacements[c];
	                continue
	            }

	            if (c < ' ') {
	                var hexString = c.charCodeAt(0).toString(16);
	                product += '\\x' + ('00' + hexString).substring(hexString.length);
	                continue
	            }

	            product += c;
	        }

	        var quoteChar = quote || Object.keys(quotes).reduce(function (a, b) { return (quotes[a] < quotes[b]) ? a : b; });

	        product = product.replace(new RegExp(quoteChar, 'g'), replacements[quoteChar]);

	        return quoteChar + product + quoteChar
	    }

	    function serializeObject (value) {
	        if (stack.indexOf(value) >= 0) {
	            throw TypeError('Converting circular structure to JSON5')
	        }

	        stack.push(value);

	        var stepback = indent;
	        indent = indent + gap;

	        var keys = propertyList || Object.keys(value);
	        var partial = [];
	        for (var i = 0, list = keys; i < list.length; i += 1) {
	            var key = list[i];

	            var propertyString = serializeProperty(key, value);
	            if (propertyString !== undefined) {
	                var member = serializeKey(key) + ':';
	                if (gap !== '') {
	                    member += ' ';
	                }
	                member += propertyString;
	                partial.push(member);
	            }
	        }

	        var final;
	        if (partial.length === 0) {
	            final = '{}';
	        } else {
	            var properties;
	            if (gap === '') {
	                properties = partial.join(',');
	                final = '{' + properties + '}';
	            } else {
	                var separator = ',\n' + indent;
	                properties = partial.join(separator);
	                final = '{\n' + indent + properties + ',\n' + stepback + '}';
	            }
	        }

	        stack.pop();
	        indent = stepback;
	        return final
	    }

	    function serializeKey (key) {
	        if (key.length === 0) {
	            return quoteString(key, true)
	        }

	        var firstChar = String.fromCodePoint(key.codePointAt(0));
	        if (!util.isIdStartChar(firstChar)) {
	            return quoteString(key, true)
	        }

	        for (var i = firstChar.length; i < key.length; i++) {
	            if (!util.isIdContinueChar(String.fromCodePoint(key.codePointAt(i)))) {
	                return quoteString(key, true)
	            }
	        }

	        return key
	    }

	    function serializeArray (value) {
	        if (stack.indexOf(value) >= 0) {
	            throw TypeError('Converting circular structure to JSON5')
	        }

	        stack.push(value);

	        var stepback = indent;
	        indent = indent + gap;

	        var partial = [];
	        for (var i = 0; i < value.length; i++) {
	            var propertyString = serializeProperty(String(i), value);
	            partial.push((propertyString !== undefined) ? propertyString : 'null');
	        }

	        var final;
	        if (partial.length === 0) {
	            final = '[]';
	        } else {
	            if (gap === '') {
	                var properties = partial.join(',');
	                final = '[' + properties + ']';
	            } else {
	                var separator = ',\n' + indent;
	                var properties$1 = partial.join(separator);
	                final = '[\n' + indent + properties$1 + ',\n' + stepback + ']';
	            }
	        }

	        stack.pop();
	        indent = stepback;
	        return final
	    }
	};

	var JSON5 = {
	    parse: parse,
	    stringify: stringify,
	};

	var lib = JSON5;

	var es5 = lib;

	return es5;

})));

},
"node_modules/json5/dist/index.min.js": function (module, exports, require, __filename, __dirname) {
!function(u,D){"object"==typeof exports&&"undefined"!=typeof module?module.exports=D():"function"==typeof define&&define.amd?define(D):u.JSON5=D()}(this,function(){"use strict";function u(u,D){return u(D={exports:{}},D.exports),D.exports}var D=u(function(u){var D=u.exports="undefined"!=typeof window&&window.Math==Math?window:"undefined"!=typeof self&&self.Math==Math?self:Function("return this")();"number"==typeof __g&&(__g=D)}),e=u(function(u){var D=u.exports={version:"2.6.5"};"number"==typeof __e&&(__e=D)}),t=(e.version,function(u){return"object"==typeof u?null!==u:"function"==typeof u}),r=function(u){if(!t(u))throw TypeError(u+" is not an object!");return u},F=function(u){try{return!!u()}catch(u){return!0}},n=!F(function(){return 7!=Object.defineProperty({},"a",{get:function(){return 7}}).a}),C=D.document,A=t(C)&&t(C.createElement),i=!n&&!F(function(){return 7!=Object.defineProperty((u="div",A?C.createElement(u):{}),"a",{get:function(){return 7}}).a;var u}),E=Object.defineProperty,o={f:n?Object.defineProperty:function(u,D,e){if(r(u),D=function(u,D){if(!t(u))return u;var e,r;if(D&&"function"==typeof(e=u.toString)&&!t(r=e.call(u)))return r;if("function"==typeof(e=u.valueOf)&&!t(r=e.call(u)))return r;if(!D&&"function"==typeof(e=u.toString)&&!t(r=e.call(u)))return r;throw TypeError("Can't convert object to primitive value")}(D,!0),r(e),i)try{return E(u,D,e)}catch(u){}if("get"in e||"set"in e)throw TypeError("Accessors not supported!");return"value"in e&&(u[D]=e.value),u}},a=n?function(u,D,e){return o.f(u,D,function(u,D){return{enumerable:!(1&u),configurable:!(2&u),writable:!(4&u),value:D}}(1,e))}:function(u,D,e){return u[D]=e,u},c={}.hasOwnProperty,B=function(u,D){return c.call(u,D)},s=0,f=Math.random(),l=u(function(u){var t=D["__core-js_shared__"]||(D["__core-js_shared__"]={});(u.exports=function(u,D){return t[u]||(t[u]=void 0!==D?D:{})})("versions",[]).push({version:e.version,mode:"global",copyright:"© 2019 Denis Pushkarev (zloirock.ru)"})})("native-function-to-string",Function.toString),d=u(function(u){var t,r="Symbol(".concat(void 0===(t="src")?"":t,")_",(++s+f).toString(36)),F=(""+l).split("toString");e.inspectSource=function(u){return l.call(u)},(u.exports=function(u,e,t,n){var C="function"==typeof t;C&&(B(t,"name")||a(t,"name",e)),u[e]!==t&&(C&&(B(t,r)||a(t,r,u[e]?""+u[e]:F.join(String(e)))),u===D?u[e]=t:n?u[e]?u[e]=t:a(u,e,t):(delete u[e],a(u,e,t)))})(Function.prototype,"toString",function(){return"function"==typeof this&&this[r]||l.call(this)})}),v=function(u,D,e){if(function(u){if("function"!=typeof u)throw TypeError(u+" is not a function!")}(u),void 0===D)return u;switch(e){case 1:return function(e){return u.call(D,e)};case 2:return function(e,t){return u.call(D,e,t)};case 3:return function(e,t,r){return u.call(D,e,t,r)}}return function(){return u.apply(D,arguments)}},p=function(u,t,r){var F,n,C,A,i=u&p.F,E=u&p.G,o=u&p.S,c=u&p.P,B=u&p.B,s=E?D:o?D[t]||(D[t]={}):(D[t]||{}).prototype,f=E?e:e[t]||(e[t]={}),l=f.prototype||(f.prototype={});for(F in E&&(r=t),r)C=((n=!i&&s&&void 0!==s[F])?s:r)[F],A=B&&n?v(C,D):c&&"function"==typeof C?v(Function.call,C):C,s&&d(s,F,C,u&p.U),f[F]!=C&&a(f,F,A),c&&l[F]!=C&&(l[F]=C)};D.core=e,p.F=1,p.G=2,p.S=4,p.P=8,p.B=16,p.W=32,p.U=64,p.R=128;var h,m=p,g=Math.ceil,y=Math.floor,w=function(u){return isNaN(u=+u)?0:(u>0?y:g)(u)},S=(h=!1,function(u,D){var e,t,r=String(function(u){if(null==u)throw TypeError("Can't call method on  "+u);return u}(u)),F=w(D),n=r.length;return F<0||F>=n?h?"":void 0:(e=r.charCodeAt(F))<55296||e>56319||F+1===n||(t=r.charCodeAt(F+1))<56320||t>57343?h?r.charAt(F):e:h?r.slice(F,F+2):t-56320+(e-55296<<10)+65536});m(m.P,"String",{codePointAt:function(u){return S(this,u)}});e.String.codePointAt;var b=Math.max,x=Math.min,N=String.fromCharCode,P=String.fromCodePoint;m(m.S+m.F*(!!P&&1!=P.length),"String",{fromCodePoint:function(u){for(var D,e,t,r=arguments,F=[],n=arguments.length,C=0;n>C;){if(D=+r[C++],t=1114111,((e=w(e=D))<0?b(e+t,0):x(e,t))!==D)throw RangeError(D+" is not a valid code point");F.push(D<65536?N(D):N(55296+((D-=65536)>>10),D%1024+56320))}return F.join("")}});e.String.fromCodePoint;var _,I,O,j,V,J,M,k,L,T,z,H,$,R,G={Space_Separator:/[\u1680\u2000-\u200A\u202F\u205F\u3000]/,ID_Start:/[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/,ID_Continue:/[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/},U={isSpaceSeparator:function(u){return"string"==typeof u&&G.Space_Separator.test(u)},isIdStartChar:function(u){return"string"==typeof u&&(u>="a"&&u<="z"||u>="A"&&u<="Z"||"$"===u||"_"===u||G.ID_Start.test(u))},isIdContinueChar:function(u){return"string"==typeof u&&(u>="a"&&u<="z"||u>="A"&&u<="Z"||u>="0"&&u<="9"||"$"===u||"_"===u||"‌"===u||"‍"===u||G.ID_Continue.test(u))},isDigit:function(u){return"string"==typeof u&&/[0-9]/.test(u)},isHexDigit:function(u){return"string"==typeof u&&/[0-9A-Fa-f]/.test(u)}};function Z(){for(T="default",z="",H=!1,$=1;;){R=q();var u=X[T]();if(u)return u}}function q(){if(_[j])return String.fromCodePoint(_.codePointAt(j))}function W(){var u=q();return"\n"===u?(V++,J=0):u?J+=u.length:J++,u&&(j+=u.length),u}var X={default:function(){switch(R){case"\t":case"\v":case"\f":case" ":case" ":case"\ufeff":case"\n":case"\r":case"\u2028":case"\u2029":return void W();case"/":return W(),void(T="comment");case void 0:return W(),K("eof")}if(!U.isSpaceSeparator(R))return X[I]();W()},comment:function(){switch(R){case"*":return W(),void(T="multiLineComment");case"/":return W(),void(T="singleLineComment")}throw tu(W())},multiLineComment:function(){switch(R){case"*":return W(),void(T="multiLineCommentAsterisk");case void 0:throw tu(W())}W()},multiLineCommentAsterisk:function(){switch(R){case"*":return void W();case"/":return W(),void(T="default");case void 0:throw tu(W())}W(),T="multiLineComment"},singleLineComment:function(){switch(R){case"\n":case"\r":case"\u2028":case"\u2029":return W(),void(T="default");case void 0:return W(),K("eof")}W()},value:function(){switch(R){case"{":case"[":return K("punctuator",W());case"n":return W(),Q("ull"),K("null",null);case"t":return W(),Q("rue"),K("boolean",!0);case"f":return W(),Q("alse"),K("boolean",!1);case"-":case"+":return"-"===W()&&($=-1),void(T="sign");case".":return z=W(),void(T="decimalPointLeading");case"0":return z=W(),void(T="zero");case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":return z=W(),void(T="decimalInteger");case"I":return W(),Q("nfinity"),K("numeric",1/0);case"N":return W(),Q("aN"),K("numeric",NaN);case'"':case"'":return H='"'===W(),z="",void(T="string")}throw tu(W())},identifierNameStartEscape:function(){if("u"!==R)throw tu(W());W();var u=Y();switch(u){case"$":case"_":break;default:if(!U.isIdStartChar(u))throw Fu()}z+=u,T="identifierName"},identifierName:function(){switch(R){case"$":case"_":case"‌":case"‍":return void(z+=W());case"\\":return W(),void(T="identifierNameEscape")}if(!U.isIdContinueChar(R))return K("identifier",z);z+=W()},identifierNameEscape:function(){if("u"!==R)throw tu(W());W();var u=Y();switch(u){case"$":case"_":case"‌":case"‍":break;default:if(!U.isIdContinueChar(u))throw Fu()}z+=u,T="identifierName"},sign:function(){switch(R){case".":return z=W(),void(T="decimalPointLeading");case"0":return z=W(),void(T="zero");case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":return z=W(),void(T="decimalInteger");case"I":return W(),Q("nfinity"),K("numeric",$*(1/0));case"N":return W(),Q("aN"),K("numeric",NaN)}throw tu(W())},zero:function(){switch(R){case".":return z+=W(),void(T="decimalPoint");case"e":case"E":return z+=W(),void(T="decimalExponent");case"x":case"X":return z+=W(),void(T="hexadecimal")}return K("numeric",0*$)},decimalInteger:function(){switch(R){case".":return z+=W(),void(T="decimalPoint");case"e":case"E":return z+=W(),void(T="decimalExponent")}if(!U.isDigit(R))return K("numeric",$*Number(z));z+=W()},decimalPointLeading:function(){if(U.isDigit(R))return z+=W(),void(T="decimalFraction");throw tu(W())},decimalPoint:function(){switch(R){case"e":case"E":return z+=W(),void(T="decimalExponent")}return U.isDigit(R)?(z+=W(),void(T="decimalFraction")):K("numeric",$*Number(z))},decimalFraction:function(){switch(R){case"e":case"E":return z+=W(),void(T="decimalExponent")}if(!U.isDigit(R))return K("numeric",$*Number(z));z+=W()},decimalExponent:function(){switch(R){case"+":case"-":return z+=W(),void(T="decimalExponentSign")}if(U.isDigit(R))return z+=W(),void(T="decimalExponentInteger");throw tu(W())},decimalExponentSign:function(){if(U.isDigit(R))return z+=W(),void(T="decimalExponentInteger");throw tu(W())},decimalExponentInteger:function(){if(!U.isDigit(R))return K("numeric",$*Number(z));z+=W()},hexadecimal:function(){if(U.isHexDigit(R))return z+=W(),void(T="hexadecimalInteger");throw tu(W())},hexadecimalInteger:function(){if(!U.isHexDigit(R))return K("numeric",$*Number(z));z+=W()},string:function(){switch(R){case"\\":return W(),void(z+=function(){switch(q()){case"b":return W(),"\b";case"f":return W(),"\f";case"n":return W(),"\n";case"r":return W(),"\r";case"t":return W(),"\t";case"v":return W(),"\v";case"0":if(W(),U.isDigit(q()))throw tu(W());return"\0";case"x":return W(),function(){var u="",D=q();if(!U.isHexDigit(D))throw tu(W());if(u+=W(),D=q(),!U.isHexDigit(D))throw tu(W());return u+=W(),String.fromCodePoint(parseInt(u,16))}();case"u":return W(),Y();case"\n":case"\u2028":case"\u2029":return W(),"";case"\r":return W(),"\n"===q()&&W(),"";case"1":case"2":case"3":case"4":case"5":case"6":case"7":case"8":case"9":case void 0:throw tu(W())}return W()}());case'"':return H?(W(),K("string",z)):void(z+=W());case"'":return H?void(z+=W()):(W(),K("string",z));case"\n":case"\r":throw tu(W());case"\u2028":case"\u2029":!function(u){console.warn("JSON5: '"+nu(u)+"' in strings is not valid ECMAScript; consider escaping")}(R);break;case void 0:throw tu(W())}z+=W()},start:function(){switch(R){case"{":case"[":return K("punctuator",W())}T="value"},beforePropertyName:function(){switch(R){case"$":case"_":return z=W(),void(T="identifierName");case"\\":return W(),void(T="identifierNameStartEscape");case"}":return K("punctuator",W());case'"':case"'":return H='"'===W(),void(T="string")}if(U.isIdStartChar(R))return z+=W(),void(T="identifierName");throw tu(W())},afterPropertyName:function(){if(":"===R)return K("punctuator",W());throw tu(W())},beforePropertyValue:function(){T="value"},afterPropertyValue:function(){switch(R){case",":case"}":return K("punctuator",W())}throw tu(W())},beforeArrayValue:function(){if("]"===R)return K("punctuator",W());T="value"},afterArrayValue:function(){switch(R){case",":case"]":return K("punctuator",W())}throw tu(W())},end:function(){throw tu(W())}};function K(u,D){return{type:u,value:D,line:V,column:J}}function Q(u){for(var D=0,e=u;D<e.length;D+=1){var t=e[D];if(q()!==t)throw tu(W());W()}}function Y(){for(var u="",D=4;D-- >0;){var e=q();if(!U.isHexDigit(e))throw tu(W());u+=W()}return String.fromCodePoint(parseInt(u,16))}var uu={start:function(){if("eof"===M.type)throw ru();Du()},beforePropertyName:function(){switch(M.type){case"identifier":case"string":return k=M.value,void(I="afterPropertyName");case"punctuator":return void eu();case"eof":throw ru()}},afterPropertyName:function(){if("eof"===M.type)throw ru();I="beforePropertyValue"},beforePropertyValue:function(){if("eof"===M.type)throw ru();Du()},beforeArrayValue:function(){if("eof"===M.type)throw ru();"punctuator"!==M.type||"]"!==M.value?Du():eu()},afterPropertyValue:function(){if("eof"===M.type)throw ru();switch(M.value){case",":return void(I="beforePropertyName");case"}":eu()}},afterArrayValue:function(){if("eof"===M.type)throw ru();switch(M.value){case",":return void(I="beforeArrayValue");case"]":eu()}},end:function(){}};function Du(){var u;switch(M.type){case"punctuator":switch(M.value){case"{":u={};break;case"[":u=[]}break;case"null":case"boolean":case"numeric":case"string":u=M.value}if(void 0===L)L=u;else{var D=O[O.length-1];Array.isArray(D)?D.push(u):D[k]=u}if(null!==u&&"object"==typeof u)O.push(u),I=Array.isArray(u)?"beforeArrayValue":"beforePropertyName";else{var e=O[O.length-1];I=null==e?"end":Array.isArray(e)?"afterArrayValue":"afterPropertyValue"}}function eu(){O.pop();var u=O[O.length-1];I=null==u?"end":Array.isArray(u)?"afterArrayValue":"afterPropertyValue"}function tu(u){return Cu(void 0===u?"JSON5: invalid end of input at "+V+":"+J:"JSON5: invalid character '"+nu(u)+"' at "+V+":"+J)}function ru(){return Cu("JSON5: invalid end of input at "+V+":"+J)}function Fu(){return Cu("JSON5: invalid identifier character at "+V+":"+(J-=5))}function nu(u){var D={"'":"\\'",'"':'\\"',"\\":"\\\\","\b":"\\b","\f":"\\f","\n":"\\n","\r":"\\r","\t":"\\t","\v":"\\v","\0":"\\0","\u2028":"\\u2028","\u2029":"\\u2029"};if(D[u])return D[u];if(u<" "){var e=u.charCodeAt(0).toString(16);return"\\x"+("00"+e).substring(e.length)}return u}function Cu(u){var D=new SyntaxError(u);return D.lineNumber=V,D.columnNumber=J,D}return{parse:function(u,D){_=String(u),I="start",O=[],j=0,V=1,J=0,M=void 0,k=void 0,L=void 0;do{M=Z(),uu[I]()}while("eof"!==M.type);return"function"==typeof D?function u(D,e,t){var r=D[e];if(null!=r&&"object"==typeof r)for(var F in r){var n=u(r,F,t);void 0===n?delete r[F]:r[F]=n}return t.call(D,e,r)}({"":L},"",D):L},stringify:function(u,D,e){var t,r,F,n=[],C="",A="";if(null==D||"object"!=typeof D||Array.isArray(D)||(e=D.space,F=D.quote,D=D.replacer),"function"==typeof D)r=D;else if(Array.isArray(D)){t=[];for(var i=0,E=D;i<E.length;i+=1){var o=E[i],a=void 0;"string"==typeof o?a=o:("number"==typeof o||o instanceof String||o instanceof Number)&&(a=String(o)),void 0!==a&&t.indexOf(a)<0&&t.push(a)}}return e instanceof Number?e=Number(e):e instanceof String&&(e=String(e)),"number"==typeof e?e>0&&(e=Math.min(10,Math.floor(e)),A="          ".substr(0,e)):"string"==typeof e&&(A=e.substr(0,10)),c("",{"":u});function c(u,D){var e=D[u];switch(null!=e&&("function"==typeof e.toJSON5?e=e.toJSON5(u):"function"==typeof e.toJSON&&(e=e.toJSON(u))),r&&(e=r.call(D,u,e)),e instanceof Number?e=Number(e):e instanceof String?e=String(e):e instanceof Boolean&&(e=e.valueOf()),e){case null:return"null";case!0:return"true";case!1:return"false"}return"string"==typeof e?B(e):"number"==typeof e?String(e):"object"==typeof e?Array.isArray(e)?function(u){if(n.indexOf(u)>=0)throw TypeError("Converting circular structure to JSON5");n.push(u);var D=C;C+=A;for(var e,t=[],r=0;r<u.length;r++){var F=c(String(r),u);t.push(void 0!==F?F:"null")}if(0===t.length)e="[]";else if(""===A){var i=t.join(",");e="["+i+"]"}else{var E=",\n"+C,o=t.join(E);e="[\n"+C+o+",\n"+D+"]"}return n.pop(),C=D,e}(e):function(u){if(n.indexOf(u)>=0)throw TypeError("Converting circular structure to JSON5");n.push(u);var D=C;C+=A;for(var e,r,F=t||Object.keys(u),i=[],E=0,o=F;E<o.length;E+=1){var a=o[E],B=c(a,u);if(void 0!==B){var f=s(a)+":";""!==A&&(f+=" "),f+=B,i.push(f)}}if(0===i.length)e="{}";else if(""===A)r=i.join(","),e="{"+r+"}";else{var l=",\n"+C;r=i.join(l),e="{\n"+C+r+",\n"+D+"}"}return n.pop(),C=D,e}(e):void 0}function B(u){for(var D={"'":.1,'"':.2},e={"'":"\\'",'"':'\\"',"\\":"\\\\","\b":"\\b","\f":"\\f","\n":"\\n","\r":"\\r","\t":"\\t","\v":"\\v","\0":"\\0","\u2028":"\\u2028","\u2029":"\\u2029"},t="",r=0;r<u.length;r++){var n=u[r];switch(n){case"'":case'"':D[n]++,t+=n;continue;case"\0":if(U.isDigit(u[r+1])){t+="\\x00";continue}}if(e[n])t+=e[n];else if(n<" "){var C=n.charCodeAt(0).toString(16);t+="\\x"+("00"+C).substring(C.length)}else t+=n}var A=F||Object.keys(D).reduce(function(u,e){return D[u]<D[e]?u:e});return A+(t=t.replace(new RegExp(A,"g"),e[A]))+A}function s(u){if(0===u.length)return B(u);var D=String.fromCodePoint(u.codePointAt(0));if(!U.isIdStartChar(D))return B(u);for(var e=D.length;e<u.length;e++)if(!U.isIdContinueChar(String.fromCodePoint(u.codePointAt(e))))return B(u);return u}}}});

},
"node_modules/json5/lib/cli.js": function (module, exports, require, __filename, __dirname) {

const fs = require('fs')
const path = require('path')
const minimist = require('minimist')
const pkg = require('../package.json')
const JSON5 = require('./')

const argv = minimist(process.argv.slice(2), {
    alias: {
        'convert': 'c',
        'space': 's',
        'validate': 'v',
        'out-file': 'o',
        'version': 'V',
        'help': 'h',
    },
    boolean: [
        'convert',
        'validate',
        'version',
        'help',
    ],
    string: [
        'space',
        'out-file',
    ],
})

if (argv.version) {
    version()
} else if (argv.help) {
    usage()
} else {
    const inFilename = argv._[0]

    let readStream
    if (inFilename) {
        readStream = fs.createReadStream(inFilename)
    } else {
        readStream = process.stdin
    }

    let json5 = ''
    readStream.on('data', data => {
        json5 += data
    })

    readStream.on('end', () => {
        let space
        if (argv.space === 't' || argv.space === 'tab') {
            space = '\t'
        } else {
            space = Number(argv.space)
        }

        let value
        try {
            value = JSON5.parse(json5)
            if (!argv.validate) {
                const json = JSON.stringify(value, null, space)

                let writeStream

                // --convert is for backward compatibility with v0.5.1. If
                // specified with <file> and not --out-file, then a file with
                // the same name but with a .json extension will be written.
                if (argv.convert && inFilename && !argv.o) {
                    const parsedFilename = path.parse(inFilename)
                    const outFilename = path.format(
                        Object.assign(
                            parsedFilename,
                            {base: path.basename(parsedFilename.base, parsedFilename.ext) + '.json'}
                        )
                    )

                    writeStream = fs.createWriteStream(outFilename)
                } else if (argv.o) {
                    writeStream = fs.createWriteStream(argv.o)
                } else {
                    writeStream = process.stdout
                }

                writeStream.write(json)
            }
        } catch (err) {
            console.error(err.message)
            process.exit(1)
        }
    })
}

function version () {
    console.log(pkg.version)
}

function usage () {
    console.log(
        `
  Usage: json5 [options] <file>

  If <file> is not provided, then STDIN is used.

  Options:

    -s, --space              The number of spaces to indent or 't' for tabs
    -o, --out-file [file]    Output to the specified file, otherwise STDOUT
    -v, --validate           Validate JSON5 but do not output JSON
    -V, --version            Output the version number
    -h, --help               Output usage information`
    )
}

},
"node_modules/json5/lib/index.js": function (module, exports, require, __filename, __dirname) {
const parse = require('./parse')
const stringify = require('./stringify')

const JSON5 = {
    parse,
    stringify,
}

module.exports = JSON5

},
"node_modules/json5/lib/parse.js": function (module, exports, require, __filename, __dirname) {
const util = require('./util')

let source
let parseState
let stack
let pos
let line
let column
let token
let key
let root

module.exports = function parse (text, reviver) {
    source = String(text)
    parseState = 'start'
    stack = []
    pos = 0
    line = 1
    column = 0
    token = undefined
    key = undefined
    root = undefined

    do {
        token = lex()

        // This code is unreachable.
        // if (!parseStates[parseState]) {
        //     throw invalidParseState()
        // }

        parseStates[parseState]()
    } while (token.type !== 'eof')

    if (typeof reviver === 'function') {
        return internalize({'': root}, '', reviver)
    }

    return root
}

function internalize (holder, name, reviver) {
    const value = holder[name]
    if (value != null && typeof value === 'object') {
        for (const key in value) {
            const replacement = internalize(value, key, reviver)
            if (replacement === undefined) {
                delete value[key]
            } else {
                value[key] = replacement
            }
        }
    }

    return reviver.call(holder, name, value)
}

let lexState
let buffer
let doubleQuote
let sign
let c

function lex () {
    lexState = 'default'
    buffer = ''
    doubleQuote = false
    sign = 1

    for (;;) {
        c = peek()

        // This code is unreachable.
        // if (!lexStates[lexState]) {
        //     throw invalidLexState(lexState)
        // }

        const token = lexStates[lexState]()
        if (token) {
            return token
        }
    }
}

function peek () {
    if (source[pos]) {
        return String.fromCodePoint(source.codePointAt(pos))
    }
}

function read () {
    const c = peek()

    if (c === '\n') {
        line++
        column = 0
    } else if (c) {
        column += c.length
    } else {
        column++
    }

    if (c) {
        pos += c.length
    }

    return c
}

const lexStates = {
    default () {
        switch (c) {
        case '\t':
        case '\v':
        case '\f':
        case ' ':
        case '\u00A0':
        case '\uFEFF':
        case '\n':
        case '\r':
        case '\u2028':
        case '\u2029':
            read()
            return

        case '/':
            read()
            lexState = 'comment'
            return

        case undefined:
            read()
            return newToken('eof')
        }

        if (util.isSpaceSeparator(c)) {
            read()
            return
        }

        // This code is unreachable.
        // if (!lexStates[parseState]) {
        //     throw invalidLexState(parseState)
        // }

        return lexStates[parseState]()
    },

    comment () {
        switch (c) {
        case '*':
            read()
            lexState = 'multiLineComment'
            return

        case '/':
            read()
            lexState = 'singleLineComment'
            return
        }

        throw invalidChar(read())
    },

    multiLineComment () {
        switch (c) {
        case '*':
            read()
            lexState = 'multiLineCommentAsterisk'
            return

        case undefined:
            throw invalidChar(read())
        }

        read()
    },

    multiLineCommentAsterisk () {
        switch (c) {
        case '*':
            read()
            return

        case '/':
            read()
            lexState = 'default'
            return

        case undefined:
            throw invalidChar(read())
        }

        read()
        lexState = 'multiLineComment'
    },

    singleLineComment () {
        switch (c) {
        case '\n':
        case '\r':
        case '\u2028':
        case '\u2029':
            read()
            lexState = 'default'
            return

        case undefined:
            read()
            return newToken('eof')
        }

        read()
    },

    value () {
        switch (c) {
        case '{':
        case '[':
            return newToken('punctuator', read())

        case 'n':
            read()
            literal('ull')
            return newToken('null', null)

        case 't':
            read()
            literal('rue')
            return newToken('boolean', true)

        case 'f':
            read()
            literal('alse')
            return newToken('boolean', false)

        case '-':
        case '+':
            if (read() === '-') {
                sign = -1
            }

            lexState = 'sign'
            return

        case '.':
            buffer = read()
            lexState = 'decimalPointLeading'
            return

        case '0':
            buffer = read()
            lexState = 'zero'
            return

        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
            buffer = read()
            lexState = 'decimalInteger'
            return

        case 'I':
            read()
            literal('nfinity')
            return newToken('numeric', Infinity)

        case 'N':
            read()
            literal('aN')
            return newToken('numeric', NaN)

        case '"':
        case "'":
            doubleQuote = (read() === '"')
            buffer = ''
            lexState = 'string'
            return
        }

        throw invalidChar(read())
    },

    identifierNameStartEscape () {
        if (c !== 'u') {
            throw invalidChar(read())
        }

        read()
        const u = unicodeEscape()
        switch (u) {
        case '$':
        case '_':
            break

        default:
            if (!util.isIdStartChar(u)) {
                throw invalidIdentifier()
            }

            break
        }

        buffer += u
        lexState = 'identifierName'
    },

    identifierName () {
        switch (c) {
        case '$':
        case '_':
        case '\u200C':
        case '\u200D':
            buffer += read()
            return

        case '\\':
            read()
            lexState = 'identifierNameEscape'
            return
        }

        if (util.isIdContinueChar(c)) {
            buffer += read()
            return
        }

        return newToken('identifier', buffer)
    },

    identifierNameEscape () {
        if (c !== 'u') {
            throw invalidChar(read())
        }

        read()
        const u = unicodeEscape()
        switch (u) {
        case '$':
        case '_':
        case '\u200C':
        case '\u200D':
            break

        default:
            if (!util.isIdContinueChar(u)) {
                throw invalidIdentifier()
            }

            break
        }

        buffer += u
        lexState = 'identifierName'
    },

    sign () {
        switch (c) {
        case '.':
            buffer = read()
            lexState = 'decimalPointLeading'
            return

        case '0':
            buffer = read()
            lexState = 'zero'
            return

        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
            buffer = read()
            lexState = 'decimalInteger'
            return

        case 'I':
            read()
            literal('nfinity')
            return newToken('numeric', sign * Infinity)

        case 'N':
            read()
            literal('aN')
            return newToken('numeric', NaN)
        }

        throw invalidChar(read())
    },

    zero () {
        switch (c) {
        case '.':
            buffer += read()
            lexState = 'decimalPoint'
            return

        case 'e':
        case 'E':
            buffer += read()
            lexState = 'decimalExponent'
            return

        case 'x':
        case 'X':
            buffer += read()
            lexState = 'hexadecimal'
            return
        }

        return newToken('numeric', sign * 0)
    },

    decimalInteger () {
        switch (c) {
        case '.':
            buffer += read()
            lexState = 'decimalPoint'
            return

        case 'e':
        case 'E':
            buffer += read()
            lexState = 'decimalExponent'
            return
        }

        if (util.isDigit(c)) {
            buffer += read()
            return
        }

        return newToken('numeric', sign * Number(buffer))
    },

    decimalPointLeading () {
        if (util.isDigit(c)) {
            buffer += read()
            lexState = 'decimalFraction'
            return
        }

        throw invalidChar(read())
    },

    decimalPoint () {
        switch (c) {
        case 'e':
        case 'E':
            buffer += read()
            lexState = 'decimalExponent'
            return
        }

        if (util.isDigit(c)) {
            buffer += read()
            lexState = 'decimalFraction'
            return
        }

        return newToken('numeric', sign * Number(buffer))
    },

    decimalFraction () {
        switch (c) {
        case 'e':
        case 'E':
            buffer += read()
            lexState = 'decimalExponent'
            return
        }

        if (util.isDigit(c)) {
            buffer += read()
            return
        }

        return newToken('numeric', sign * Number(buffer))
    },

    decimalExponent () {
        switch (c) {
        case '+':
        case '-':
            buffer += read()
            lexState = 'decimalExponentSign'
            return
        }

        if (util.isDigit(c)) {
            buffer += read()
            lexState = 'decimalExponentInteger'
            return
        }

        throw invalidChar(read())
    },

    decimalExponentSign () {
        if (util.isDigit(c)) {
            buffer += read()
            lexState = 'decimalExponentInteger'
            return
        }

        throw invalidChar(read())
    },

    decimalExponentInteger () {
        if (util.isDigit(c)) {
            buffer += read()
            return
        }

        return newToken('numeric', sign * Number(buffer))
    },

    hexadecimal () {
        if (util.isHexDigit(c)) {
            buffer += read()
            lexState = 'hexadecimalInteger'
            return
        }

        throw invalidChar(read())
    },

    hexadecimalInteger () {
        if (util.isHexDigit(c)) {
            buffer += read()
            return
        }

        return newToken('numeric', sign * Number(buffer))
    },

    string () {
        switch (c) {
        case '\\':
            read()
            buffer += escape()
            return

        case '"':
            if (doubleQuote) {
                read()
                return newToken('string', buffer)
            }

            buffer += read()
            return

        case "'":
            if (!doubleQuote) {
                read()
                return newToken('string', buffer)
            }

            buffer += read()
            return

        case '\n':
        case '\r':
            throw invalidChar(read())

        case '\u2028':
        case '\u2029':
            separatorChar(c)
            break

        case undefined:
            throw invalidChar(read())
        }

        buffer += read()
    },

    start () {
        switch (c) {
        case '{':
        case '[':
            return newToken('punctuator', read())

        // This code is unreachable since the default lexState handles eof.
        // case undefined:
        //     return newToken('eof')
        }

        lexState = 'value'
    },

    beforePropertyName () {
        switch (c) {
        case '$':
        case '_':
            buffer = read()
            lexState = 'identifierName'
            return

        case '\\':
            read()
            lexState = 'identifierNameStartEscape'
            return

        case '}':
            return newToken('punctuator', read())

        case '"':
        case "'":
            doubleQuote = (read() === '"')
            lexState = 'string'
            return
        }

        if (util.isIdStartChar(c)) {
            buffer += read()
            lexState = 'identifierName'
            return
        }

        throw invalidChar(read())
    },

    afterPropertyName () {
        if (c === ':') {
            return newToken('punctuator', read())
        }

        throw invalidChar(read())
    },

    beforePropertyValue () {
        lexState = 'value'
    },

    afterPropertyValue () {
        switch (c) {
        case ',':
        case '}':
            return newToken('punctuator', read())
        }

        throw invalidChar(read())
    },

    beforeArrayValue () {
        if (c === ']') {
            return newToken('punctuator', read())
        }

        lexState = 'value'
    },

    afterArrayValue () {
        switch (c) {
        case ',':
        case ']':
            return newToken('punctuator', read())
        }

        throw invalidChar(read())
    },

    end () {
        // This code is unreachable since it's handled by the default lexState.
        // if (c === undefined) {
        //     read()
        //     return newToken('eof')
        // }

        throw invalidChar(read())
    },
}

function newToken (type, value) {
    return {
        type,
        value,
        line,
        column,
    }
}

function literal (s) {
    for (const c of s) {
        const p = peek()

        if (p !== c) {
            throw invalidChar(read())
        }

        read()
    }
}

function escape () {
    const c = peek()
    switch (c) {
    case 'b':
        read()
        return '\b'

    case 'f':
        read()
        return '\f'

    case 'n':
        read()
        return '\n'

    case 'r':
        read()
        return '\r'

    case 't':
        read()
        return '\t'

    case 'v':
        read()
        return '\v'

    case '0':
        read()
        if (util.isDigit(peek())) {
            throw invalidChar(read())
        }

        return '\0'

    case 'x':
        read()
        return hexEscape()

    case 'u':
        read()
        return unicodeEscape()

    case '\n':
    case '\u2028':
    case '\u2029':
        read()
        return ''

    case '\r':
        read()
        if (peek() === '\n') {
            read()
        }

        return ''

    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9':
        throw invalidChar(read())

    case undefined:
        throw invalidChar(read())
    }

    return read()
}

function hexEscape () {
    let buffer = ''
    let c = peek()

    if (!util.isHexDigit(c)) {
        throw invalidChar(read())
    }

    buffer += read()

    c = peek()
    if (!util.isHexDigit(c)) {
        throw invalidChar(read())
    }

    buffer += read()

    return String.fromCodePoint(parseInt(buffer, 16))
}

function unicodeEscape () {
    let buffer = ''
    let count = 4

    while (count-- > 0) {
        const c = peek()
        if (!util.isHexDigit(c)) {
            throw invalidChar(read())
        }

        buffer += read()
    }

    return String.fromCodePoint(parseInt(buffer, 16))
}

const parseStates = {
    start () {
        if (token.type === 'eof') {
            throw invalidEOF()
        }

        push()
    },

    beforePropertyName () {
        switch (token.type) {
        case 'identifier':
        case 'string':
            key = token.value
            parseState = 'afterPropertyName'
            return

        case 'punctuator':
            // This code is unreachable since it's handled by the lexState.
            // if (token.value !== '}') {
            //     throw invalidToken()
            // }

            pop()
            return

        case 'eof':
            throw invalidEOF()
        }

        // This code is unreachable since it's handled by the lexState.
        // throw invalidToken()
    },

    afterPropertyName () {
        // This code is unreachable since it's handled by the lexState.
        // if (token.type !== 'punctuator' || token.value !== ':') {
        //     throw invalidToken()
        // }

        if (token.type === 'eof') {
            throw invalidEOF()
        }

        parseState = 'beforePropertyValue'
    },

    beforePropertyValue () {
        if (token.type === 'eof') {
            throw invalidEOF()
        }

        push()
    },

    beforeArrayValue () {
        if (token.type === 'eof') {
            throw invalidEOF()
        }

        if (token.type === 'punctuator' && token.value === ']') {
            pop()
            return
        }

        push()
    },

    afterPropertyValue () {
        // This code is unreachable since it's handled by the lexState.
        // if (token.type !== 'punctuator') {
        //     throw invalidToken()
        // }

        if (token.type === 'eof') {
            throw invalidEOF()
        }

        switch (token.value) {
        case ',':
            parseState = 'beforePropertyName'
            return

        case '}':
            pop()
        }

        // This code is unreachable since it's handled by the lexState.
        // throw invalidToken()
    },

    afterArrayValue () {
        // This code is unreachable since it's handled by the lexState.
        // if (token.type !== 'punctuator') {
        //     throw invalidToken()
        // }

        if (token.type === 'eof') {
            throw invalidEOF()
        }

        switch (token.value) {
        case ',':
            parseState = 'beforeArrayValue'
            return

        case ']':
            pop()
        }

        // This code is unreachable since it's handled by the lexState.
        // throw invalidToken()
    },

    end () {
        // This code is unreachable since it's handled by the lexState.
        // if (token.type !== 'eof') {
        //     throw invalidToken()
        // }
    },
}

function push () {
    let value

    switch (token.type) {
    case 'punctuator':
        switch (token.value) {
        case '{':
            value = {}
            break

        case '[':
            value = []
            break
        }

        break

    case 'null':
    case 'boolean':
    case 'numeric':
    case 'string':
        value = token.value
        break

    // This code is unreachable.
    // default:
    //     throw invalidToken()
    }

    if (root === undefined) {
        root = value
    } else {
        const parent = stack[stack.length - 1]
        if (Array.isArray(parent)) {
            parent.push(value)
        } else {
            parent[key] = value
        }
    }

    if (value !== null && typeof value === 'object') {
        stack.push(value)

        if (Array.isArray(value)) {
            parseState = 'beforeArrayValue'
        } else {
            parseState = 'beforePropertyName'
        }
    } else {
        const current = stack[stack.length - 1]
        if (current == null) {
            parseState = 'end'
        } else if (Array.isArray(current)) {
            parseState = 'afterArrayValue'
        } else {
            parseState = 'afterPropertyValue'
        }
    }
}

function pop () {
    stack.pop()

    const current = stack[stack.length - 1]
    if (current == null) {
        parseState = 'end'
    } else if (Array.isArray(current)) {
        parseState = 'afterArrayValue'
    } else {
        parseState = 'afterPropertyValue'
    }
}

// This code is unreachable.
// function invalidParseState () {
//     return new Error(`JSON5: invalid parse state '${parseState}'`)
// }

// This code is unreachable.
// function invalidLexState (state) {
//     return new Error(`JSON5: invalid lex state '${state}'`)
// }

function invalidChar (c) {
    if (c === undefined) {
        return syntaxError(`JSON5: invalid end of input at ${line}:${column}`)
    }

    return syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${line}:${column}`)
}

function invalidEOF () {
    return syntaxError(`JSON5: invalid end of input at ${line}:${column}`)
}

// This code is unreachable.
// function invalidToken () {
//     if (token.type === 'eof') {
//         return syntaxError(`JSON5: invalid end of input at ${line}:${column}`)
//     }

//     const c = String.fromCodePoint(token.value.codePointAt(0))
//     return syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${line}:${column}`)
// }

function invalidIdentifier () {
    column -= 5
    return syntaxError(`JSON5: invalid identifier character at ${line}:${column}`)
}

function separatorChar (c) {
    console.warn(`JSON5: '${formatChar(c)}' in strings is not valid ECMAScript; consider escaping`)
}

function formatChar (c) {
    const replacements = {
        "'": "\\'",
        '"': '\\"',
        '\\': '\\\\',
        '\b': '\\b',
        '\f': '\\f',
        '\n': '\\n',
        '\r': '\\r',
        '\t': '\\t',
        '\v': '\\v',
        '\0': '\\0',
        '\u2028': '\\u2028',
        '\u2029': '\\u2029',
    }

    if (replacements[c]) {
        return replacements[c]
    }

    if (c < ' ') {
        const hexString = c.charCodeAt(0).toString(16)
        return '\\x' + ('00' + hexString).substring(hexString.length)
    }

    return c
}

function syntaxError (message) {
    const err = new SyntaxError(message)
    err.lineNumber = line
    err.columnNumber = column
    return err
}

},
"node_modules/json5/lib/register.js": function (module, exports, require, __filename, __dirname) {
const fs = require('fs')
const JSON5 = require('./')

// eslint-disable-next-line node/no-deprecated-api
require.extensions['.json5'] = function (module, filename) {
    const content = fs.readFileSync(filename, 'utf8')
    try {
        module.exports = JSON5.parse(content)
    } catch (err) {
        err.message = filename + ': ' + err.message
        throw err
    }
}

},
"node_modules/json5/lib/require.js": function (module, exports, require, __filename, __dirname) {
// This file is for backward compatibility with v0.5.1.
require('./register')

console.warn("'json5/require' is deprecated. Please use 'json5/register' instead.")

},
"node_modules/json5/lib/stringify.js": function (module, exports, require, __filename, __dirname) {
const util = require('./util')

module.exports = function stringify (value, replacer, space) {
    const stack = []
    let indent = ''
    let propertyList
    let replacerFunc
    let gap = ''
    let quote

    if (
        replacer != null &&
        typeof replacer === 'object' &&
        !Array.isArray(replacer)
    ) {
        space = replacer.space
        quote = replacer.quote
        replacer = replacer.replacer
    }

    if (typeof replacer === 'function') {
        replacerFunc = replacer
    } else if (Array.isArray(replacer)) {
        propertyList = []
        for (const v of replacer) {
            let item

            if (typeof v === 'string') {
                item = v
            } else if (
                typeof v === 'number' ||
                v instanceof String ||
                v instanceof Number
            ) {
                item = String(v)
            }

            if (item !== undefined && propertyList.indexOf(item) < 0) {
                propertyList.push(item)
            }
        }
    }

    if (space instanceof Number) {
        space = Number(space)
    } else if (space instanceof String) {
        space = String(space)
    }

    if (typeof space === 'number') {
        if (space > 0) {
            space = Math.min(10, Math.floor(space))
            gap = '          '.substr(0, space)
        }
    } else if (typeof space === 'string') {
        gap = space.substr(0, 10)
    }

    return serializeProperty('', {'': value})

    function serializeProperty (key, holder) {
        let value = holder[key]
        if (value != null) {
            if (typeof value.toJSON5 === 'function') {
                value = value.toJSON5(key)
            } else if (typeof value.toJSON === 'function') {
                value = value.toJSON(key)
            }
        }

        if (replacerFunc) {
            value = replacerFunc.call(holder, key, value)
        }

        if (value instanceof Number) {
            value = Number(value)
        } else if (value instanceof String) {
            value = String(value)
        } else if (value instanceof Boolean) {
            value = value.valueOf()
        }

        switch (value) {
        case null: return 'null'
        case true: return 'true'
        case false: return 'false'
        }

        if (typeof value === 'string') {
            return quoteString(value, false)
        }

        if (typeof value === 'number') {
            return String(value)
        }

        if (typeof value === 'object') {
            return Array.isArray(value) ? serializeArray(value) : serializeObject(value)
        }

        return undefined
    }

    function quoteString (value) {
        const quotes = {
            "'": 0.1,
            '"': 0.2,
        }

        const replacements = {
            "'": "\\'",
            '"': '\\"',
            '\\': '\\\\',
            '\b': '\\b',
            '\f': '\\f',
            '\n': '\\n',
            '\r': '\\r',
            '\t': '\\t',
            '\v': '\\v',
            '\0': '\\0',
            '\u2028': '\\u2028',
            '\u2029': '\\u2029',
        }

        let product = ''

        for (let i = 0; i < value.length; i++) {
            const c = value[i]
            switch (c) {
            case "'":
            case '"':
                quotes[c]++
                product += c
                continue

            case '\0':
                if (util.isDigit(value[i + 1])) {
                    product += '\\x00'
                    continue
                }
            }

            if (replacements[c]) {
                product += replacements[c]
                continue
            }

            if (c < ' ') {
                let hexString = c.charCodeAt(0).toString(16)
                product += '\\x' + ('00' + hexString).substring(hexString.length)
                continue
            }

            product += c
        }

        const quoteChar = quote || Object.keys(quotes).reduce((a, b) => (quotes[a] < quotes[b]) ? a : b)

        product = product.replace(new RegExp(quoteChar, 'g'), replacements[quoteChar])

        return quoteChar + product + quoteChar
    }

    function serializeObject (value) {
        if (stack.indexOf(value) >= 0) {
            throw TypeError('Converting circular structure to JSON5')
        }

        stack.push(value)

        let stepback = indent
        indent = indent + gap

        let keys = propertyList || Object.keys(value)
        let partial = []
        for (const key of keys) {
            const propertyString = serializeProperty(key, value)
            if (propertyString !== undefined) {
                let member = serializeKey(key) + ':'
                if (gap !== '') {
                    member += ' '
                }
                member += propertyString
                partial.push(member)
            }
        }

        let final
        if (partial.length === 0) {
            final = '{}'
        } else {
            let properties
            if (gap === '') {
                properties = partial.join(',')
                final = '{' + properties + '}'
            } else {
                let separator = ',\n' + indent
                properties = partial.join(separator)
                final = '{\n' + indent + properties + ',\n' + stepback + '}'
            }
        }

        stack.pop()
        indent = stepback
        return final
    }

    function serializeKey (key) {
        if (key.length === 0) {
            return quoteString(key, true)
        }

        const firstChar = String.fromCodePoint(key.codePointAt(0))
        if (!util.isIdStartChar(firstChar)) {
            return quoteString(key, true)
        }

        for (let i = firstChar.length; i < key.length; i++) {
            if (!util.isIdContinueChar(String.fromCodePoint(key.codePointAt(i)))) {
                return quoteString(key, true)
            }
        }

        return key
    }

    function serializeArray (value) {
        if (stack.indexOf(value) >= 0) {
            throw TypeError('Converting circular structure to JSON5')
        }

        stack.push(value)

        let stepback = indent
        indent = indent + gap

        let partial = []
        for (let i = 0; i < value.length; i++) {
            const propertyString = serializeProperty(String(i), value)
            partial.push((propertyString !== undefined) ? propertyString : 'null')
        }

        let final
        if (partial.length === 0) {
            final = '[]'
        } else {
            if (gap === '') {
                let properties = partial.join(',')
                final = '[' + properties + ']'
            } else {
                let separator = ',\n' + indent
                let properties = partial.join(separator)
                final = '[\n' + indent + properties + ',\n' + stepback + ']'
            }
        }

        stack.pop()
        indent = stepback
        return final
    }
}

},
"node_modules/json5/lib/unicode.js": function (module, exports, require, __filename, __dirname) {
// This is a generated file. Do not edit.
module.exports.Space_Separator = /[\u1680\u2000-\u200A\u202F\u205F\u3000]/
module.exports.ID_Start = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/
module.exports.ID_Continue = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/

},
"node_modules/json5/lib/util.js": function (module, exports, require, __filename, __dirname) {
const unicode = require('../lib/unicode')

module.exports = {
    isSpaceSeparator (c) {
        return typeof c === 'string' && unicode.Space_Separator.test(c)
    },

    isIdStartChar (c) {
        return typeof c === 'string' && (
            (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c === '$') || (c === '_') ||
        unicode.ID_Start.test(c)
        )
    },

    isIdContinueChar (c) {
        return typeof c === 'string' && (
            (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') ||
        (c === '$') || (c === '_') ||
        (c === '\u200C') || (c === '\u200D') ||
        unicode.ID_Continue.test(c)
        )
    },

    isDigit (c) {
        return typeof c === 'string' && /[0-9]/.test(c)
    },

    isHexDigit (c) {
        return typeof c === 'string' && /[0-9A-Fa-f]/.test(c)
    },
}

},
"node_modules/json5/package.json": function (module) { module.exports = {
  "name": "json5",
  "version": "2.2.0",
  "description": "JSON for humans.",
  "main": "lib/index.js",
  "module": "dist/index.mjs",
  "bin": "lib/cli.js",
  "browser": "dist/index.js",
  "types": "lib/index.d.ts",
  "files": [
    "lib/",
    "dist/"
  ],
  "engines": {
    "node": ">=6"
  },
  "scripts": {
    "build": "rollup -c",
    "build-package": "node build/package.js",
    "build-unicode": "node build/unicode.js",
    "coverage": "tap --coverage-report html test",
    "lint": "eslint --fix .",
    "prepublishOnly": "npm run production",
    "preversion": "npm run production",
    "production": "npm run lint && npm test && npm run build",
    "test": "tap -Rspec --100 test",
    "version": "npm run build-package && git add package.json5"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/json5/json5.git"
  },
  "keywords": [
    "json",
    "json5",
    "es5",
    "es2015",
    "ecmascript"
  ],
  "author": "Aseem Kishore <aseem.kishore@gmail.com>",
  "contributors": [
    "Max Nanasy <max.nanasy@gmail.com>",
    "Andrew Eisenberg <andrew@eisenberg.as>",
    "Jordan Tucker <jordanbtucker@gmail.com>"
  ],
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/json5/json5/issues"
  },
  "homepage": "http://json5.org/",
  "dependencies": {
    "minimist": "^1.2.5"
  },
  "devDependencies": {
    "core-js": "^2.6.5",
    "eslint": "^5.15.3",
    "eslint-config-standard": "^12.0.0",
    "eslint-plugin-import": "^2.16.0",
    "eslint-plugin-node": "^8.0.1",
    "eslint-plugin-promise": "^4.0.1",
    "eslint-plugin-standard": "^4.0.0",
    "regenerate": "^1.4.0",
    "rollup": "^0.64.1",
    "rollup-plugin-buble": "^0.19.6",
    "rollup-plugin-commonjs": "^9.2.1",
    "rollup-plugin-node-resolve": "^3.4.0",
    "rollup-plugin-terser": "^1.0.1",
    "sinon": "^6.3.5",
    "tap": "^12.6.0",
    "unicode-10.0.0": "^0.7.5"
  }
}
; },
"node_modules/minimatch/minimatch.js": function (module, exports, require, __filename, __dirname) {
module.exports = minimatch
minimatch.Minimatch = Minimatch

var path = { sep: '/' }
try {
  path = require('path')
} catch (er) {}

var GLOBSTAR = minimatch.GLOBSTAR = Minimatch.GLOBSTAR = {}
var expand = require('brace-expansion')

var plTypes = {
  '!': { open: '(?:(?!(?:', close: '))[^/]*?)'},
  '?': { open: '(?:', close: ')?' },
  '+': { open: '(?:', close: ')+' },
  '*': { open: '(?:', close: ')*' },
  '@': { open: '(?:', close: ')' }
}

// any single thing other than /
// don't need to escape / when using new RegExp()
var qmark = '[^/]'

// * => any number of characters
var star = qmark + '*?'

// ** when dots are allowed.  Anything goes, except .. and .
// not (^ or / followed by one or two dots followed by $ or /),
// followed by anything, any number of times.
var twoStarDot = '(?:(?!(?:\\\/|^)(?:\\.{1,2})($|\\\/)).)*?'

// not a ^ or / followed by a dot,
// followed by anything, any number of times.
var twoStarNoDot = '(?:(?!(?:\\\/|^)\\.).)*?'

// characters that need to be escaped in RegExp.
var reSpecials = charSet('().*{}+?[]^$\\!')

// "abc" -> { a:true, b:true, c:true }
function charSet (s) {
  return s.split('').reduce(function (set, c) {
    set[c] = true
    return set
  }, {})
}

// normalizes slashes.
var slashSplit = /\/+/

minimatch.filter = filter
function filter (pattern, options) {
  options = options || {}
  return function (p, i, list) {
    return minimatch(p, pattern, options)
  }
}

function ext (a, b) {
  a = a || {}
  b = b || {}
  var t = {}
  Object.keys(b).forEach(function (k) {
    t[k] = b[k]
  })
  Object.keys(a).forEach(function (k) {
    t[k] = a[k]
  })
  return t
}

minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return minimatch

  var orig = minimatch

  var m = function minimatch (p, pattern, options) {
    return orig.minimatch(p, pattern, ext(def, options))
  }

  m.Minimatch = function Minimatch (pattern, options) {
    return new orig.Minimatch(pattern, ext(def, options))
  }

  return m
}

Minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return Minimatch
  return minimatch.defaults(def).Minimatch
}

function minimatch (p, pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {}

  // shortcut: comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    return false
  }

  // "" only matches ""
  if (pattern.trim() === '') return p === ''

  return new Minimatch(pattern, options).match(p)
}

function Minimatch (pattern, options) {
  if (!(this instanceof Minimatch)) {
    return new Minimatch(pattern, options)
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {}
  pattern = pattern.trim()

  // windows support: need to use /, not \
  if (path.sep !== '/') {
    pattern = pattern.split(path.sep).join('/')
  }

  this.options = options
  this.set = []
  this.pattern = pattern
  this.regexp = null
  this.negate = false
  this.comment = false
  this.empty = false

  // make the set of regexps etc.
  this.make()
}

Minimatch.prototype.debug = function () {}

Minimatch.prototype.make = make
function make () {
  // don't do it more than once.
  if (this._made) return

  var pattern = this.pattern
  var options = this.options

  // empty patterns and comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    this.comment = true
    return
  }
  if (!pattern) {
    this.empty = true
    return
  }

  // step 1: figure out negation, etc.
  this.parseNegate()

  // step 2: expand braces
  var set = this.globSet = this.braceExpand()

  if (options.debug) this.debug = console.error

  this.debug(this.pattern, set)

  // step 3: now we have a set, so turn each one into a series of path-portion
  // matching patterns.
  // These will be regexps, except in the case of "**", which is
  // set to the GLOBSTAR object for globstar behavior,
  // and will not contain any / characters
  set = this.globParts = set.map(function (s) {
    return s.split(slashSplit)
  })

  this.debug(this.pattern, set)

  // glob --> regexps
  set = set.map(function (s, si, set) {
    return s.map(this.parse, this)
  }, this)

  this.debug(this.pattern, set)

  // filter out everything that didn't compile properly.
  set = set.filter(function (s) {
    return s.indexOf(false) === -1
  })

  this.debug(this.pattern, set)

  this.set = set
}

Minimatch.prototype.parseNegate = parseNegate
function parseNegate () {
  var pattern = this.pattern
  var negate = false
  var options = this.options
  var negateOffset = 0

  if (options.nonegate) return

  for (var i = 0, l = pattern.length
    ; i < l && pattern.charAt(i) === '!'
    ; i++) {
    negate = !negate
    negateOffset++
  }

  if (negateOffset) this.pattern = pattern.substr(negateOffset)
  this.negate = negate
}

// Brace expansion:
// a{b,c}d -> abd acd
// a{b,}c -> abc ac
// a{0..3}d -> a0d a1d a2d a3d
// a{b,c{d,e}f}g -> abg acdfg acefg
// a{b,c}d{e,f}g -> abdeg acdeg abdeg abdfg
//
// Invalid sets are not expanded.
// a{2..}b -> a{2..}b
// a{b}c -> a{b}c
minimatch.braceExpand = function (pattern, options) {
  return braceExpand(pattern, options)
}

Minimatch.prototype.braceExpand = braceExpand

function braceExpand (pattern, options) {
  if (!options) {
    if (this instanceof Minimatch) {
      options = this.options
    } else {
      options = {}
    }
  }

  pattern = typeof pattern === 'undefined'
    ? this.pattern : pattern

  if (typeof pattern === 'undefined') {
    throw new TypeError('undefined pattern')
  }

  if (options.nobrace ||
    !pattern.match(/\{.*\}/)) {
    // shortcut. no need to expand.
    return [pattern]
  }

  return expand(pattern)
}

// parse a component of the expanded set.
// At this point, no pattern may contain "/" in it
// so we're going to return a 2d array, where each entry is the full
// pattern, split on '/', and then turned into a regular expression.
// A regexp is made at the end which joins each array with an
// escaped /, and another full one which joins each regexp with |.
//
// Following the lead of Bash 4.1, note that "**" only has special meaning
// when it is the *only* thing in a path portion.  Otherwise, any series
// of * is equivalent to a single *.  Globstar behavior is enabled by
// default, and can be disabled by setting options.noglobstar.
Minimatch.prototype.parse = parse
var SUBPARSE = {}
function parse (pattern, isSub) {
  if (pattern.length > 1024 * 64) {
    throw new TypeError('pattern is too long')
  }

  var options = this.options

  // shortcuts
  if (!options.noglobstar && pattern === '**') return GLOBSTAR
  if (pattern === '') return ''

  var re = ''
  var hasMagic = !!options.nocase
  var escaping = false
  // ? => one single character
  var patternListStack = []
  var negativeLists = []
  var stateChar
  var inClass = false
  var reClassStart = -1
  var classStart = -1
  // . and .. never match anything that doesn't start with .,
  // even when options.dot is set.
  var patternStart = pattern.charAt(0) === '.' ? '' // anything
  // not (start or / followed by . or .. followed by / or end)
  : options.dot ? '(?!(?:^|\\\/)\\.{1,2}(?:$|\\\/))'
  : '(?!\\.)'
  var self = this

  function clearStateChar () {
    if (stateChar) {
      // we had some state-tracking character
      // that wasn't consumed by this pass.
      switch (stateChar) {
        case '*':
          re += star
          hasMagic = true
        break
        case '?':
          re += qmark
          hasMagic = true
        break
        default:
          re += '\\' + stateChar
        break
      }
      self.debug('clearStateChar %j %j', stateChar, re)
      stateChar = false
    }
  }

  for (var i = 0, len = pattern.length, c
    ; (i < len) && (c = pattern.charAt(i))
    ; i++) {
    this.debug('%s\t%s %s %j', pattern, i, re, c)

    // skip over any that are escaped.
    if (escaping && reSpecials[c]) {
      re += '\\' + c
      escaping = false
      continue
    }

    switch (c) {
      case '/':
        // completely not allowed, even escaped.
        // Should already be path-split by now.
        return false

      case '\\':
        clearStateChar()
        escaping = true
      continue

      // the various stateChar values
      // for the "extglob" stuff.
      case '?':
      case '*':
      case '+':
      case '@':
      case '!':
        this.debug('%s\t%s %s %j <-- stateChar', pattern, i, re, c)

        // all of those are literals inside a class, except that
        // the glob [!a] means [^a] in regexp
        if (inClass) {
          this.debug('  in class')
          if (c === '!' && i === classStart + 1) c = '^'
          re += c
          continue
        }

        // if we already have a stateChar, then it means
        // that there was something like ** or +? in there.
        // Handle the stateChar, then proceed with this one.
        self.debug('call clearStateChar %j', stateChar)
        clearStateChar()
        stateChar = c
        // if extglob is disabled, then +(asdf|foo) isn't a thing.
        // just clear the statechar *now*, rather than even diving into
        // the patternList stuff.
        if (options.noext) clearStateChar()
      continue

      case '(':
        if (inClass) {
          re += '('
          continue
        }

        if (!stateChar) {
          re += '\\('
          continue
        }

        patternListStack.push({
          type: stateChar,
          start: i - 1,
          reStart: re.length,
          open: plTypes[stateChar].open,
          close: plTypes[stateChar].close
        })
        // negation is (?:(?!js)[^/]*)
        re += stateChar === '!' ? '(?:(?!(?:' : '(?:'
        this.debug('plType %j %j', stateChar, re)
        stateChar = false
      continue

      case ')':
        if (inClass || !patternListStack.length) {
          re += '\\)'
          continue
        }

        clearStateChar()
        hasMagic = true
        var pl = patternListStack.pop()
        // negation is (?:(?!js)[^/]*)
        // The others are (?:<pattern>)<type>
        re += pl.close
        if (pl.type === '!') {
          negativeLists.push(pl)
        }
        pl.reEnd = re.length
      continue

      case '|':
        if (inClass || !patternListStack.length || escaping) {
          re += '\\|'
          escaping = false
          continue
        }

        clearStateChar()
        re += '|'
      continue

      // these are mostly the same in regexp and glob
      case '[':
        // swallow any state-tracking char before the [
        clearStateChar()

        if (inClass) {
          re += '\\' + c
          continue
        }

        inClass = true
        classStart = i
        reClassStart = re.length
        re += c
      continue

      case ']':
        //  a right bracket shall lose its special
        //  meaning and represent itself in
        //  a bracket expression if it occurs
        //  first in the list.  -- POSIX.2 2.8.3.2
        if (i === classStart + 1 || !inClass) {
          re += '\\' + c
          escaping = false
          continue
        }

        // handle the case where we left a class open.
        // "[z-a]" is valid, equivalent to "\[z-a\]"
        if (inClass) {
          // split where the last [ was, make sure we don't have
          // an invalid re. if so, re-walk the contents of the
          // would-be class to re-translate any characters that
          // were passed through as-is
          // TODO: It would probably be faster to determine this
          // without a try/catch and a new RegExp, but it's tricky
          // to do safely.  For now, this is safe and works.
          var cs = pattern.substring(classStart + 1, i)
          try {
            RegExp('[' + cs + ']')
          } catch (er) {
            // not a valid class!
            var sp = this.parse(cs, SUBPARSE)
            re = re.substr(0, reClassStart) + '\\[' + sp[0] + '\\]'
            hasMagic = hasMagic || sp[1]
            inClass = false
            continue
          }
        }

        // finish up the class.
        hasMagic = true
        inClass = false
        re += c
      continue

      default:
        // swallow any state char that wasn't consumed
        clearStateChar()

        if (escaping) {
          // no need
          escaping = false
        } else if (reSpecials[c]
          && !(c === '^' && inClass)) {
          re += '\\'
        }

        re += c

    } // switch
  } // for

  // handle the case where we left a class open.
  // "[abc" is valid, equivalent to "\[abc"
  if (inClass) {
    // split where the last [ was, and escape it
    // this is a huge pita.  We now have to re-walk
    // the contents of the would-be class to re-translate
    // any characters that were passed through as-is
    cs = pattern.substr(classStart + 1)
    sp = this.parse(cs, SUBPARSE)
    re = re.substr(0, reClassStart) + '\\[' + sp[0]
    hasMagic = hasMagic || sp[1]
  }

  // handle the case where we had a +( thing at the *end*
  // of the pattern.
  // each pattern list stack adds 3 chars, and we need to go through
  // and escape any | chars that were passed through as-is for the regexp.
  // Go through and escape them, taking care not to double-escape any
  // | chars that were already escaped.
  for (pl = patternListStack.pop(); pl; pl = patternListStack.pop()) {
    var tail = re.slice(pl.reStart + pl.open.length)
    this.debug('setting tail', re, pl)
    // maybe some even number of \, then maybe 1 \, followed by a |
    tail = tail.replace(/((?:\\{2}){0,64})(\\?)\|/g, function (_, $1, $2) {
      if (!$2) {
        // the | isn't already escaped, so escape it.
        $2 = '\\'
      }

      // need to escape all those slashes *again*, without escaping the
      // one that we need for escaping the | character.  As it works out,
      // escaping an even number of slashes can be done by simply repeating
      // it exactly after itself.  That's why this trick works.
      //
      // I am sorry that you have to see this.
      return $1 + $1 + $2 + '|'
    })

    this.debug('tail=%j\n   %s', tail, tail, pl, re)
    var t = pl.type === '*' ? star
      : pl.type === '?' ? qmark
      : '\\' + pl.type

    hasMagic = true
    re = re.slice(0, pl.reStart) + t + '\\(' + tail
  }

  // handle trailing things that only matter at the very end.
  clearStateChar()
  if (escaping) {
    // trailing \\
    re += '\\\\'
  }

  // only need to apply the nodot start if the re starts with
  // something that could conceivably capture a dot
  var addPatternStart = false
  switch (re.charAt(0)) {
    case '.':
    case '[':
    case '(': addPatternStart = true
  }

  // Hack to work around lack of negative lookbehind in JS
  // A pattern like: *.!(x).!(y|z) needs to ensure that a name
  // like 'a.xyz.yz' doesn't match.  So, the first negative
  // lookahead, has to look ALL the way ahead, to the end of
  // the pattern.
  for (var n = negativeLists.length - 1; n > -1; n--) {
    var nl = negativeLists[n]

    var nlBefore = re.slice(0, nl.reStart)
    var nlFirst = re.slice(nl.reStart, nl.reEnd - 8)
    var nlLast = re.slice(nl.reEnd - 8, nl.reEnd)
    var nlAfter = re.slice(nl.reEnd)

    nlLast += nlAfter

    // Handle nested stuff like *(*.js|!(*.json)), where open parens
    // mean that we should *not* include the ) in the bit that is considered
    // "after" the negated section.
    var openParensBefore = nlBefore.split('(').length - 1
    var cleanAfter = nlAfter
    for (i = 0; i < openParensBefore; i++) {
      cleanAfter = cleanAfter.replace(/\)[+*?]?/, '')
    }
    nlAfter = cleanAfter

    var dollar = ''
    if (nlAfter === '' && isSub !== SUBPARSE) {
      dollar = '$'
    }
    var newRe = nlBefore + nlFirst + nlAfter + dollar + nlLast
    re = newRe
  }

  // if the re is not "" at this point, then we need to make sure
  // it doesn't match against an empty path part.
  // Otherwise a/* will match a/, which it should not.
  if (re !== '' && hasMagic) {
    re = '(?=.)' + re
  }

  if (addPatternStart) {
    re = patternStart + re
  }

  // parsing just a piece of a larger pattern.
  if (isSub === SUBPARSE) {
    return [re, hasMagic]
  }

  // skip the regexp for non-magical patterns
  // unescape anything in it, though, so that it'll be
  // an exact match against a file etc.
  if (!hasMagic) {
    return globUnescape(pattern)
  }

  var flags = options.nocase ? 'i' : ''
  try {
    var regExp = new RegExp('^' + re + '$', flags)
  } catch (er) {
    // If it was an invalid regular expression, then it can't match
    // anything.  This trick looks for a character after the end of
    // the string, which is of course impossible, except in multi-line
    // mode, but it's not a /m regex.
    return new RegExp('$.')
  }

  regExp._glob = pattern
  regExp._src = re

  return regExp
}

minimatch.makeRe = function (pattern, options) {
  return new Minimatch(pattern, options || {}).makeRe()
}

Minimatch.prototype.makeRe = makeRe
function makeRe () {
  if (this.regexp || this.regexp === false) return this.regexp

  // at this point, this.set is a 2d array of partial
  // pattern strings, or "**".
  //
  // It's better to use .match().  This function shouldn't
  // be used, really, but it's pretty convenient sometimes,
  // when you just want to work with a regex.
  var set = this.set

  if (!set.length) {
    this.regexp = false
    return this.regexp
  }
  var options = this.options

  var twoStar = options.noglobstar ? star
    : options.dot ? twoStarDot
    : twoStarNoDot
  var flags = options.nocase ? 'i' : ''

  var re = set.map(function (pattern) {
    return pattern.map(function (p) {
      return (p === GLOBSTAR) ? twoStar
      : (typeof p === 'string') ? regExpEscape(p)
      : p._src
    }).join('\\\/')
  }).join('|')

  // must match entire pattern
  // ending in a * or ** will make it less strict.
  re = '^(?:' + re + ')$'

  // can match anything, as long as it's not this.
  if (this.negate) re = '^(?!' + re + ').*$'

  try {
    this.regexp = new RegExp(re, flags)
  } catch (ex) {
    this.regexp = false
  }
  return this.regexp
}

minimatch.match = function (list, pattern, options) {
  options = options || {}
  var mm = new Minimatch(pattern, options)
  list = list.filter(function (f) {
    return mm.match(f)
  })
  if (mm.options.nonull && !list.length) {
    list.push(pattern)
  }
  return list
}

Minimatch.prototype.match = match
function match (f, partial) {
  this.debug('match', f, this.pattern)
  // short-circuit in the case of busted things.
  // comments, etc.
  if (this.comment) return false
  if (this.empty) return f === ''

  if (f === '/' && partial) return true

  var options = this.options

  // windows: need to use /, not \
  if (path.sep !== '/') {
    f = f.split(path.sep).join('/')
  }

  // treat the test path as a set of pathparts.
  f = f.split(slashSplit)
  this.debug(this.pattern, 'split', f)

  // just ONE of the pattern sets in this.set needs to match
  // in order for it to be valid.  If negating, then just one
  // match means that we have failed.
  // Either way, return on the first hit.

  var set = this.set
  this.debug(this.pattern, 'set', set)

  // Find the basename of the path by looking for the last non-empty segment
  var filename
  var i
  for (i = f.length - 1; i >= 0; i--) {
    filename = f[i]
    if (filename) break
  }

  for (i = 0; i < set.length; i++) {
    var pattern = set[i]
    var file = f
    if (options.matchBase && pattern.length === 1) {
      file = [filename]
    }
    var hit = this.matchOne(file, pattern, partial)
    if (hit) {
      if (options.flipNegate) return true
      return !this.negate
    }
  }

  // didn't get any hits.  this is success if it's a negative
  // pattern, failure otherwise.
  if (options.flipNegate) return false
  return this.negate
}

// set partial to true to test if, for example,
// "/a/b" matches the start of "/*/b/*/d"
// Partial means, if you run out of file before you run
// out of pattern, then that's fine, as long as all
// the parts match.
Minimatch.prototype.matchOne = function (file, pattern, partial) {
  var options = this.options

  this.debug('matchOne',
    { 'this': this, file: file, pattern: pattern })

  this.debug('matchOne', file.length, pattern.length)

  for (var fi = 0,
      pi = 0,
      fl = file.length,
      pl = pattern.length
      ; (fi < fl) && (pi < pl)
      ; fi++, pi++) {
    this.debug('matchOne loop')
    var p = pattern[pi]
    var f = file[fi]

    this.debug(pattern, p, f)

    // should be impossible.
    // some invalid regexp stuff in the set.
    if (p === false) return false

    if (p === GLOBSTAR) {
      this.debug('GLOBSTAR', [pattern, p, f])

      // "**"
      // a/**/b/**/c would match the following:
      // a/b/x/y/z/c
      // a/x/y/z/b/c
      // a/b/x/b/x/c
      // a/b/c
      // To do this, take the rest of the pattern after
      // the **, and see if it would match the file remainder.
      // If so, return success.
      // If not, the ** "swallows" a segment, and try again.
      // This is recursively awful.
      //
      // a/**/b/**/c matching a/b/x/y/z/c
      // - a matches a
      // - doublestar
      //   - matchOne(b/x/y/z/c, b/**/c)
      //     - b matches b
      //     - doublestar
      //       - matchOne(x/y/z/c, c) -> no
      //       - matchOne(y/z/c, c) -> no
      //       - matchOne(z/c, c) -> no
      //       - matchOne(c, c) yes, hit
      var fr = fi
      var pr = pi + 1
      if (pr === pl) {
        this.debug('** at the end')
        // a ** at the end will just swallow the rest.
        // We have found a match.
        // however, it will not swallow /.x, unless
        // options.dot is set.
        // . and .. are *never* matched by **, for explosively
        // exponential reasons.
        for (; fi < fl; fi++) {
          if (file[fi] === '.' || file[fi] === '..' ||
            (!options.dot && file[fi].charAt(0) === '.')) return false
        }
        return true
      }

      // ok, let's see if we can swallow whatever we can.
      while (fr < fl) {
        var swallowee = file[fr]

        this.debug('\nglobstar while', file, fr, pattern, pr, swallowee)

        // XXX remove this slice.  Just pass the start index.
        if (this.matchOne(file.slice(fr), pattern.slice(pr), partial)) {
          this.debug('globstar found match!', fr, fl, swallowee)
          // found a match.
          return true
        } else {
          // can't swallow "." or ".." ever.
          // can only swallow ".foo" when explicitly asked.
          if (swallowee === '.' || swallowee === '..' ||
            (!options.dot && swallowee.charAt(0) === '.')) {
            this.debug('dot detected!', file, fr, pattern, pr)
            break
          }

          // ** swallows a segment, and continue.
          this.debug('globstar swallow a segment, and continue')
          fr++
        }
      }

      // no match was found.
      // However, in partial mode, we can't say this is necessarily over.
      // If there's more *pattern* left, then
      if (partial) {
        // ran out of file
        this.debug('\n>>> no match, partial?', file, fr, pattern, pr)
        if (fr === fl) return true
      }
      return false
    }

    // something other than **
    // non-magic patterns just have to match exactly
    // patterns with magic have been turned into regexps.
    var hit
    if (typeof p === 'string') {
      if (options.nocase) {
        hit = f.toLowerCase() === p.toLowerCase()
      } else {
        hit = f === p
      }
      this.debug('string match', p, f, hit)
    } else {
      hit = f.match(p)
      this.debug('pattern match', p, f, hit)
    }

    if (!hit) return false
  }

  // Note: ending in / means that we'll get a final ""
  // at the end of the pattern.  This can only match a
  // corresponding "" at the end of the file.
  // If the file ends in /, then it can only match a
  // a pattern that ends in /, unless the pattern just
  // doesn't have any more for it. But, a/b/ should *not*
  // match "a/b/*", even though "" matches against the
  // [^/]*? pattern, except in partial mode, where it might
  // simply not be reached yet.
  // However, a/b/ should still satisfy a/*

  // now either we fell off the end of the pattern, or we're done.
  if (fi === fl && pi === pl) {
    // ran out of pattern and filename at the same time.
    // an exact hit!
    return true
  } else if (fi === fl) {
    // ran out of file, but still had pattern left.
    // this is ok if we're doing the match as part of
    // a glob fs traversal.
    return partial
  } else if (pi === pl) {
    // ran out of pattern, still have file left.
    // this is only acceptable if we're on the very last
    // empty segment of a file with a trailing slash.
    // a/* should match a/b/
    var emptyFileEnd = (fi === fl - 1) && (file[fi] === '')
    return emptyFileEnd
  }

  // should be unreachable.
  throw new Error('wtf?')
}

// replace stuff like \* with *
function globUnescape (s) {
  return s.replace(/\\(.)/g, '$1')
}

function regExpEscape (s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

},
"node_modules/minimatch/package.json": function (module) { module.exports = {
  "author": "Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me)",
  "name": "minimatch",
  "description": "a glob matcher in javascript",
  "version": "3.0.4",
  "repository": {
    "type": "git",
    "url": "git://github.com/isaacs/minimatch.git"
  },
  "main": "minimatch.js",
  "scripts": {
    "test": "tap test/*.js --cov",
    "preversion": "npm test",
    "postversion": "npm publish",
    "postpublish": "git push origin --all; git push origin --tags"
  },
  "engines": {
    "node": "*"
  },
  "dependencies": {
    "brace-expansion": "^1.1.7"
  },
  "devDependencies": {
    "tap": "^10.3.2"
  },
  "license": "ISC",
  "files": [
    "minimatch.js"
  ]
}
; },
"out/configuration/configuration.interface.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=configuration.interface.js.map
},
"out/configuration/configuration.service.js": function (module, exports, require, __filename, __dirname) {
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfiguration = void 0;
const vscode = require("vscode");
const tsconfig_service_1 = require("./tsconfig.service");
const mapping_service_1 = require("./mapping.service");
const file_utills_1 = require("../utils/file-utills");
function getConfiguration(resource) {
    return __awaiter(this, void 0, void 0, function* () {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
        const getConfig = (key) => vscode.workspace.getConfiguration(key, resource);
        const cfgExtension = getConfig("path-intellisense");
        const cfgGeneral = getConfig("files");
        const mappings = yield getMappings(cfgExtension, workspaceFolder);
        return {
            autoSlash: cfgExtension["autoSlashAfterDirectory"],
            autoTrigger: cfgExtension["autoTriggerNextSuggestion"],
            showHiddenFiles: cfgExtension["showHiddenFiles"],
            withExtension: cfgExtension["extensionOnImport"],
            absolutePathToWorkspace: cfgExtension["absolutePathToWorkspace"],
            absolutePathTo: resolveAbsolutePathTo(cfgExtension["absolutePathTo"], workspaceFolder),
            showOnAbsoluteSlash: cfgExtension["showOnAbsoluteSlash"],
            filesExclude: cfgGeneral["exclude"],
            mappings,
        };
    });
}
exports.getConfiguration = getConfiguration;
function getMappings(configuration, workfolder) {
    return __awaiter(this, void 0, void 0, function* () {
        const mappings = mapping_service_1.parseMappings(configuration["mappings"]);
        const ignoreTsConfigBaseUrl = configuration["ignoreTsConfigBaseUrl"];
        const showHiddenFiles = configuration["showHiddenFiles"];
        const filesExclude = configuration["exclude"];
        const tsConfigMappings = yield (ignoreTsConfigBaseUrl
            ? []
            : tsconfig_service_1.getWorkfolderTsConfigConfiguration(workfolder, showHiddenFiles, filesExclude));
        const allMappings = [...mappings, ...tsConfigMappings];
        return mapping_service_1.replaceWorkspaceFolder(allMappings, workfolder);
    });
}
function resolveAbsolutePathTo(cfgPath, workfolder) {
    const rootPath = workfolder === null || workfolder === void 0 ? void 0 : workfolder.uri.path;
    return rootPath && cfgPath
        ? file_utills_1.replaceWorkspaceFolderWithRootPath(cfgPath, rootPath)
        : null;
}
//# sourceMappingURL=configuration.service.js.map
},
"out/configuration/mapping.service.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceWorkspaceFolder = exports.parseMappings = void 0;
const file_utills_1 = require("../utils/file-utills");
/**
 * From { "lib": "libraries", "other": "otherpath" }
 * To [ { key: "lib", value: "libraries" }, { key: "other", value: "otherpath" } ]
 * @param mappings { "lib": "libraries" }
 */
function parseMappings(mappings) {
    return Object.entries(mappings).map(([key, value]) => ({ key, value }));
}
exports.parseMappings = parseMappings;
/**
 * Replace ${workspaceRoot} with workfolder.uri.path
 * @param mappings
 * @param workfolder
 */
function replaceWorkspaceFolder(mappings, workfolder) {
    const rootPath = workfolder === null || workfolder === void 0 ? void 0 : workfolder.uri.path;
    if (rootPath) {
        /** Replace placeholder with workspace folder */
        return mappings.map(({ key, value }) => ({
            key,
            value: file_utills_1.replaceWorkspaceFolderWithRootPath(value, rootPath),
        }));
    }
    else {
        /** Filter items out which contain a workspace root */
        return mappings.filter(({ value }) => !valueContainsWorkspaceFolder(value));
    }
}
exports.replaceWorkspaceFolder = replaceWorkspaceFolder;
function valueContainsWorkspaceFolder(value) {
    return (value.indexOf("${workspaceRoot}") >= 0 ||
        value.indexOf("${workspaceFolder}") >= 0);
}
//# sourceMappingURL=mapping.service.js.map
},
"out/configuration/tsconfig.service.js": function (module, exports, require, __filename, __dirname) {
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeToTsConfigChanges = exports.getWorkfolderTsConfigConfiguration = void 0;
const vscode = require("vscode");
const JSON5 = require("json5");
const path_1 = require("path");
const file_utills_1 = require("../utils/file-utills");
exports.getWorkfolderTsConfigConfiguration = memoize(function (workfolder, showHiddenFiles, filesExclude) {
    return __awaiter(this, void 0, void 0, function* () {
        const parsedFiles = yield findTsConfigFiles(workfolder);
        let mappings = [];
        for (const parsedFile of parsedFiles) {
            try {
                const newMappings = yield createMappingsFromWorkspaceConfig(parsedFile, workfolder, showHiddenFiles, filesExclude);
                mappings.push(...newMappings);
            }
            catch (_a) { }
        }
        return mappings;
    });
});
function subscribeToTsConfigChanges(context) {
    return __awaiter(this, void 0, void 0, function* () {
        for (const workfolder of vscode.workspace.workspaceFolders || []) {
            /**
             * Invalidate Cache when tsconfig changes
             */
            let baseUrlWatchers = yield subscribeToBaseUrlFolderChanges(workfolder);
            context.subscriptions.push(...baseUrlWatchers);
            /**
             * Invalidate Cache when tsconfig changes
             */
            const pattern = new vscode.RelativePattern(workfolder, "[tj]sconfig.json");
            const fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            fileWatcher.onDidChange(() => __awaiter(this, void 0, void 0, function* () {
                invalidateCache(workfolder);
                // Throw away old base url subscriptions...
                for (const disposable of baseUrlWatchers) {
                    disposable.dispose();
                }
                // .. and create new subscriptions
                baseUrlWatchers = yield subscribeToBaseUrlFolderChanges(workfolder);
                context.subscriptions.push(...baseUrlWatchers);
            }));
            context.subscriptions.push(fileWatcher);
        }
    });
}
exports.subscribeToTsConfigChanges = subscribeToTsConfigChanges;
/**
 * Invalidate Cache when tsconfig changes
 */
function subscribeToBaseUrlFolderChanges(workfolder) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const disposables = [];
        const tsConfigs = yield findTsConfigFiles(workfolder);
        for (const tsconfig of tsConfigs) {
            const baseUrl = (_a = tsconfig === null || tsconfig === void 0 ? void 0 : tsconfig.compilerOptions) === null || _a === void 0 ? void 0 : _a.baseUrl;
            if (!baseUrl) {
                continue;
            }
            const patternBaseUrl = new vscode.RelativePattern(path_1.join(workfolder.uri.fsPath, baseUrl), "*");
            const fileWatcherBaseUrl = vscode.workspace.createFileSystemWatcher(patternBaseUrl, false, true, false);
            fileWatcherBaseUrl.onDidCreate((file) => invalidateCacheIfDirectory(file, workfolder));
            fileWatcherBaseUrl.onDidDelete((file) => invalidateCacheIfDirectory(file, workfolder));
            disposables.push(fileWatcherBaseUrl);
        }
        return disposables;
    });
}
function invalidateCacheIfDirectory(file, workdfolder) {
    return __awaiter(this, void 0, void 0, function* () {
        const fileStat = yield vscode.workspace.fs.stat(file);
        if (fileStat.type === vscode.FileType.Directory) {
            invalidateCache(workdfolder);
        }
    });
}
function findTsConfigFiles(workfolder) {
    return __awaiter(this, void 0, void 0, function* () {
        const include = new vscode.RelativePattern(workfolder, "[tj]sconfig.json");
        const exclude = new vscode.RelativePattern(workfolder, "**/node_modules/**");
        const files = yield vscode.workspace.findFiles(include, exclude);
        const parsedFiles = [];
        for (const file of files) {
            try {
                const fileUri = vscode.Uri.file(file.fsPath);
                const fileContents = yield vscode.workspace.fs.readFile(fileUri);
                const parsedFile = JSON5.parse(fileContents.toString());
                parsedFiles.push(parsedFile);
            }
            catch (_a) { }
        }
        return parsedFiles;
    });
}
function createMappingsFromWorkspaceConfig(tsconfig, workfolder, showHiddenFiles, filesExclude) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const mappings = [];
        const baseUrl = (_a = tsconfig === null || tsconfig === void 0 ? void 0 : tsconfig.compilerOptions) === null || _a === void 0 ? void 0 : _a.baseUrl;
        if (baseUrl && workfolder) {
            const foldersInBaseUrl = yield getFoldersInBaseUrl(workfolder, baseUrl, showHiddenFiles, filesExclude);
            for (const folderInBaseUrl of foldersInBaseUrl) {
                mappings.push({
                    key: folderInBaseUrl,
                    // value: `${workfolder.uri.path}/${baseUrl}`
                    value: "${workspaceFolder}/" + baseUrl + "/" + folderInBaseUrl,
                });
            }
        }
        return mappings;
    });
}
function getFoldersInBaseUrl(workfolder, baseUrl, showHiddenFiles, filesExclude) {
    return __awaiter(this, void 0, void 0, function* () {
        const allFiles = yield file_utills_1.getChildrenOfPath(path_1.join(workfolder.uri.fsPath, baseUrl), showHiddenFiles, filesExclude);
        const folders = allFiles.filter((file) => !file.isFile);
        return folders.map((folder) => folder.file);
    });
}
/** Caching */
let cachedMappings = new Map();
function memoize(fn) {
    function cachedFunction(workfolder, showHiddenFiles, filesExclude) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!workfolder) {
                return Promise.resolve([]);
            }
            const key = workfolder.name;
            const cachedMapping = cachedMappings.get(key);
            if (cachedMapping) {
                return cachedMapping;
            }
            else {
                let result = yield fn(workfolder, showHiddenFiles || false, filesExclude || {});
                cachedMappings.set(key, result);
                return result;
            }
        });
    }
    return cachedFunction;
}
function invalidateCache(workfolder) {
    cachedMappings.delete(workfolder.name);
}
//# sourceMappingURL=tsconfig.service.js.map
},
"out/extension.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode_1 = require("vscode");
const providers_1 = require("./providers");
const tsconfig_service_1 = require("./configuration/tsconfig.service");
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {
    /**
     * Subscribe to the ts config changes
     */
    tsconfig_service_1.subscribeToTsConfigChanges(context);
    /**
     * Register Providers
     * Add new providers in src/providers/
     * */
    providers_1.providers.forEach((provider) => {
        const disposable = vscode_1.languages.registerCompletionItemProvider(provider.selector, provider.provider, ...(provider.triggerCharacters || []));
        context.subscriptions.push(disposable);
    });
}
exports.activate = activate;
// this method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
},
"out/providers/default.provider.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultProvider = void 0;
const javascript_provider_1 = require("./javascript/javascript.provider");
exports.DefaultProvider = {
    selector: "*",
    provider: javascript_provider_1.JavaScriptProvider.provider,
    triggerCharacters: ["/", '"', "'"]
};
//# sourceMappingURL=default.provider.js.map
},
"out/providers/index.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providers = void 0;
const default_provider_1 = require("./default.provider");
const javascript_provider_1 = require("./javascript/javascript.provider");
exports.providers = [
    javascript_provider_1.JavaScriptProvider,
    default_provider_1.DefaultProvider,
];
//# sourceMappingURL=index.js.map
},
"out/providers/javascript/createCompletionItem.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPathCompletionItem = void 0;
const vscode = require("vscode");
function createPathCompletionItem(fileInfo, config, context) {
    return fileInfo.isFile
        ? createFileItem(fileInfo, config, context)
        : createFolderItem(fileInfo, config.autoSlash, config.autoTrigger, context.importRange);
}
exports.createPathCompletionItem = createPathCompletionItem;
function createFolderItem(fileInfo, autoSlash, autoTrigger, importRange) {
    var newText = autoSlash || autoTrigger ? `${fileInfo.file}/` : `${fileInfo.file}`;
    return {
        label: fileInfo.file,
        kind: vscode.CompletionItemKind.Folder,
        sortText: `a_${fileInfo.file}`,
        range: importRange,
        insertText: newText,
        command: autoTrigger
            ? {
                title: "Trigger suggest",
                command: "editor.action.triggerSuggest",
            }
            : undefined,
    };
}
function createFileItem(fileInfo, config, context) {
    const insertText = createCompletionItemInsertText(fileInfo, config, context);
    return {
        label: fileInfo.file,
        kind: vscode.CompletionItemKind.File,
        sortText: `b_${fileInfo.file}`,
        range: context.importRange,
        insertText: insertText,
    };
}
function createCompletionItemInsertText(fileInfo, config, context) {
    const shouldExcludeDocumentExtension = context.isImport &&
        !config.withExtension &&
        fileInfo.documentExtension === context.documentExtension;
    return shouldExcludeDocumentExtension
        ? getFileNameWithoutExtension(fileInfo.file)
        : fileInfo.file;
}
function getFileNameWithoutExtension(fileName) {
    let index = fileName.lastIndexOf(".");
    return index !== -1 ? fileName.substring(0, index) : fileName;
}
//# sourceMappingURL=createCompletionItem.js.map
},
"out/providers/javascript/createContext.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractExtension = exports.createContext = void 0;
const vscode = require("vscode");
function createContext(document, position) {
    const textFullLine = document.getText(document.lineAt(position).range);
    const fromString = getFromString(textFullLine, position.character);
    const isImport = isImportExportOrRequire(textFullLine);
    const importRange = importStringRange(textFullLine, position);
    const documentExtension = extractExtension(document);
    return {
        textFullLine,
        fromString,
        isImport,
        document,
        importRange,
        documentExtension,
    };
}
exports.createContext = createContext;
function getFromString(textFullLine, position) {
    const textToPosition = textFullLine.substring(0, position);
    const quoatationPosition = Math.max(textToPosition.lastIndexOf('"'), textToPosition.lastIndexOf("'"), textToPosition.lastIndexOf("`"));
    return quoatationPosition !== -1
        ? textToPosition.substring(quoatationPosition + 1, textToPosition.length)
        : undefined;
}
function isImportExportOrRequire(textFullLine) {
    let isImport = textFullLine.substring(0, 6) === "import";
    let isExport = textFullLine.substring(0, 6) === "export";
    let isRequire = textFullLine.indexOf("require(") !== -1;
    return isImport || isExport || isRequire;
}
function importStringRange(line, position) {
    const textToPosition = line.substring(0, position.character);
    const slashPosition = textToPosition.lastIndexOf("/");
    const startPosition = new vscode.Position(position.line, slashPosition + 1);
    const endPosition = position;
    return new vscode.Range(startPosition, endPosition);
}
function extractExtension(document) {
    if (document.isUntitled) {
        return undefined;
    }
    const fragments = document.fileName.split(".");
    const extension = fragments[fragments.length - 1];
    if (!extension || extension.length > 3) {
        return undefined;
    }
    return extension;
}
exports.extractExtension = extractExtension;
//# sourceMappingURL=createContext.js.map
},
"out/providers/javascript/javascript.provider.js": function (module, exports, require, __filename, __dirname) {
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JavaScriptProvider = void 0;
const vscode = require("vscode");
const configuration_service_1 = require("../../configuration/configuration.service");
const createContext_1 = require("./createContext");
const createCompletionItem_1 = require("./createCompletionItem");
const file_utills_1 = require("../../utils/file-utills");
exports.JavaScriptProvider = {
    selector: {
        language: "javascript",
        scheme: "file",
    },
    provider: {
        provideCompletionItems,
    },
    triggerCharacters: ["/", '"', "'"],
};
function provideCompletionItems(document, position) {
    return __awaiter(this, void 0, void 0, function* () {
        const context = createContext_1.createContext(document, position);
        const config = yield configuration_service_1.getConfiguration(document.uri);
        return shouldProvide(context, config)
            ? provide(context, config)
            : Promise.resolve([]);
    });
}
/**
 * Checks if we should provide any CompletionItems
 * @param context
 * @param config
 */
function shouldProvide(context, config) {
    const { fromString, isImport } = context;
    if (!fromString || fromString.length === 0) {
        return false;
    }
    if (!isImport) {
        return true;
    }
    const startsWithDot = fromString[0] === ".";
    const startsWithSlash = fromString[0] === "/";
    const startsWithMapping = config.mappings.some(({ key }) => fromString.startsWith(key));
    return (isImport &&
        (startsWithDot ||
            startsWithMapping ||
            (startsWithSlash && config.showOnAbsoluteSlash)));
}
/**
 * Provide Completion Items
 */
function provide(context, config) {
    return __awaiter(this, void 0, void 0, function* () {
        const workspace = vscode.workspace.getWorkspaceFolder(context.document.uri);
        const rootPath = config.absolutePathTo ||
            (config.absolutePathToWorkspace ? workspace === null || workspace === void 0 ? void 0 : workspace.uri.fsPath : undefined);
        const path = file_utills_1.getPathOfFolderToLookupFiles(context.document.uri.fsPath, context.fromString, rootPath, config.mappings);
        const childrenOfPath = yield file_utills_1.getChildrenOfPath(path, config.showHiddenFiles, config.filesExclude);
        return [
            ...childrenOfPath.map((child) => createCompletionItem_1.createPathCompletionItem(child, config, context)),
        ];
    });
}
//# sourceMappingURL=javascript.provider.js.map
},
"out/providers/provider.interface.js": function (module, exports, require, __filename, __dirname) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=provider.interface.js.map
},
"out/utils/file-utills.js": function (module, exports, require, __filename, __dirname) {
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceWorkspaceFolderWithRootPath = exports.getChildrenOfPath = exports.getPathOfFolderToLookupFiles = void 0;
const minimatch = require("minimatch");
const path = require("path");
const path_1 = require("path");
const vscode = require("vscode");
/**
 * @param fileName  {string} current filename the look up is done. Absolute path
 * @param text      {string} text in import string. e.g. './src/'
 */
function getPathOfFolderToLookupFiles(fileName, text, rootPath, mappings) {
    // Note: since we're normalizing the text here, we have to normalize everything we want
    //  to compare it against as path.normalize() turns forward slashes into backslashes on
    //  Windows.
    const normalizedText = path.normalize(text || "");
    const isPathAbsolute = normalizedText.startsWith(path.sep);
    // Search a mapping for the current text. First mapping is used where text starts with mapping
    const mapping = mappings &&
        mappings.reduce((prev, curr) => {
            return (prev || (normalizedText.startsWith(path.normalize(curr.key)) && curr));
        }, undefined);
    let rootFolder, pathEntered;
    if (mapping) {
        // The values of mapped (key,value)-pairs are all considered to be absolute paths, so
        //  this rootFolder value (taken from the mapping's value) is left unchanged.
        rootFolder = mapping.value;
        pathEntered = normalizedText.slice(path.normalize(mapping.key).length, normalizedText.length);
    }
    else {
        // We only care about whether the path specified was absolute if it's unmapped (e.g.
        //  we allow user-specified maps to "override" (skip) this root folder determination.)
        rootFolder = isPathAbsolute ? rootPath || "" : path.dirname(fileName);
        pathEntered = normalizedText;
    }
    return path.join(rootFolder, pathEntered);
}
exports.getPathOfFolderToLookupFiles = getPathOfFolderToLookupFiles;
function getChildrenOfPath(path, showHiddenFiles, filesExclude) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const filesTubles = yield vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
            const files = filesTubles
                .map((fileTuble) => fileTuble[0])
                .filter((filename) => filterHiddenFiles(filename, showHiddenFiles, filesExclude));
            const fileInfoList = [];
            for (const file of files) {
                const fileStat = yield vscode.workspace.fs.stat(vscode.Uri.file(path_1.join(path, file)));
                fileInfoList.push({
                    file,
                    isFile: fileStat.type === vscode.FileType.File,
                    documentExtension: getDocumentExtension(file, fileStat),
                });
            }
            return fileInfoList;
        }
        catch (error) {
            return [];
        }
    });
}
exports.getChildrenOfPath = getChildrenOfPath;
function getDocumentExtension(file, fileStat) {
    if (fileStat.type !== vscode.FileType.File) {
        return undefined;
    }
    const fragments = file.split(".");
    return fragments[fragments.length - 1];
}
function filterHiddenFiles(filename, showHiddenFiles, filesExclude) {
    if (showHiddenFiles) {
        return true;
    }
    return isFileHidden(filename, filesExclude) ? false : true;
}
function isFileHidden(filename, filesExclude) {
    return (filename.startsWith(".") || isFileHiddenByVsCode(filename, filesExclude));
}
// files.exclude has the following form. key is the glob
// {
//    "**//*.js": true
//    "**//*.js": true "*.git": true
// }
function isFileHiddenByVsCode(filename, filesExclude) {
    return (filesExclude &&
        Object.keys(filesExclude).some((key) => filesExclude[key] && minimatch(filename, key)));
}
/**
 * Replaces both placeholders with the rootpath
 * - ${workspaceRoot}    // old way and only legacy support
 * - ${workspaceFolder}  // new way
 * @param value
 * @param rootPath
 */
function replaceWorkspaceFolderWithRootPath(value, rootPath) {
    return value
        .replace("${workspaceRoot}", rootPath)
        .replace("${workspaceFolder}", rootPath);
}
exports.replaceWorkspaceFolderWithRootPath = replaceWorkspaceFolderWithRootPath;
//# sourceMappingURL=file-utills.js.map
},
"package.json": function (module) { module.exports = {
  "name": "path-intellisense",
  "private": true,
  "displayName": "Path Intellisense",
  "description": "Visual Studio Code plugin that autocompletes filenames",
  "version": "2.8.0",
  "publisher": "christian-kohler",
  "engines": {
    "vscode": "^1.43.0"
  },
  "homepage": "https://github.com/ChristianKohler/PathIntellisense",
  "repository": {
    "type": "git",
    "url": "https://github.com/ChristianKohler/PathIntellisense.git"
  },
  "categories": [
    "Other"
  ],
  "activationEvents": [
    "*"
  ],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": true
    },
    "virtualWorkspaces": {
      "supported": true
    }
  },
  "contributes": {
    "configuration": {
      "type": "object",
      "title": "path-intellisense",
      "properties": {
        "path-intellisense.extensionOnImport": {
          "type": "boolean",
          "default": false,
          "description": "Adds the file extension to a import statements"
        },
        "path-intellisense.mappings": {
          "type": "object",
          "default": {},
          "description": "Mappings for paths.  The values should be interpreted as absolute paths (and can use '${workspaceFolder}')"
        },
        "path-intellisense.showHiddenFiles": {
          "type": "boolean",
          "default": false,
          "description": "Show hidden files"
        },
        "path-intellisense.autoSlashAfterDirectory": {
          "type": "boolean",
          "default": false,
          "description": "Automatically adds slash after directory"
        },
        "path-intellisense.absolutePathToWorkspace": {
          "type": "boolean",
          "default": true,
          "description": "Sets an absolute path to the current workspace"
        },
        "path-intellisense.absolutePathTo": {
          "type": "string",
          "description": "If defined, unmapped absolute path imports are based on this location.  Takes priority over 'absolutePathToWorkspace' if both are defined"
        },
        "path-intellisense.showOnAbsoluteSlash": {
          "type": "boolean",
          "default": true,
          "description": "Shows suggestions when the import starts with a forward slash ('/')"
        },
        "path-intellisense.ignoreTsConfigBaseUrl": {
          "type": "boolean",
          "default": false,
          "description": "Ignores tsconfig file for mappings"
        },
        "path-intellisense.autoTriggerNextSuggestion": {
          "type": "boolean",
          "default": false,
          "description": "Automatically triggers next suggestion after previous suggestion"
        }
      }
    }
  },
  "main": "./out/extension.js",
  "browser": "./dist/web/extension.js",
  "icon": "icon/path-intellisense.png",
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "lint": "eslint src --ext ts",
    "watch": "tsc -watch -p ./",
    "pretest": "npm run compile && npm run lint",
    "test": "node ./out/test/runTest.js",
    "test-headless": "xvfb-run -a npm test",
    "package": "vsce package",
    "deploy": "vsce publish",
    "prepack": "npm run package && npm run package-web",
    "compile-web": "webpack --config ./build/web-extension.webpack.config.js",
    "watch-web": "webpack --watch --config ./build/web-extension.webpack.config.js",
    "package-web": "webpack --mode production --devtool hidden-source-map --config ./build/web-extension.webpack.config.js"
  },
  "devDependencies": {
    "@semantic-release/changelog": "^5.0.1",
    "@semantic-release/git": "^9.0.0",
    "@semantic-release/npm": "^7.0.5",
    "@types/benchmark": "^1.0.31",
    "@types/glob": "^7.1.1",
    "@types/mocha": "^7.0.1",
    "@types/node": "^12.11.7",
    "@types/vscode": "^1.43.0",
    "@typescript-eslint/eslint-plugin": "^2.18.0",
    "@typescript-eslint/parser": "^2.18.0",
    "eslint": "^6.8.0",
    "glob": "^7.1.6",
    "mocha": "^7.0.1",
    "path-browserify": "^1.0.1",
    "process": "^0.11.10",
    "ts-loader": "^9.2.5",
    "typescript": "^3.9.10",
    "vsce": "^1.76.0",
    "vscode-test": "^1.3.0",
    "webpack": "^5.51.1",
    "webpack-cli": "^4.8.0"
  },
  "dependencies": {
    "@types/json5": "0.0.30",
    "benchmark": "^2.1.4",
    "json5": "^2.1.2",
    "lodash": "^4.17.19",
    "minimatch": "^3.0.4"
  }
}
; },
};

const __extension = {"commands":{},"configuration":{"path-intellisense.absolutePathTo":"","path-intellisense.absolutePathToWorkspace":true,"path-intellisense.autoSlashAfterDirectory":false,"path-intellisense.autoTriggerNextSuggestion":false,"path-intellisense.extensionOnImport":false,"path-intellisense.ignoreTsConfigBaseUrl":false,"path-intellisense.mappings":{},"path-intellisense.showHiddenFiles":false,"path-intellisense.showOnAbsoluteSlash":true},"entry":"dist/web/extension.js","grammars":[],"id":"christian-kohler.path-intellisense","languages":[],"name":"Path Intellisense","packageJSON":{"activationEvents":["*"],"browser":"./dist/web/extension.js","capabilities":{"untrustedWorkspaces":{"supported":true},"virtualWorkspaces":{"supported":true}},"categories":["Other"],"contributes":{"configuration":{"properties":{"path-intellisense.absolutePathTo":{"description":"If defined, unmapped absolute path imports are based on this location.  Takes priority over 'absolutePathToWorkspace' if both are defined","type":"string"},"path-intellisense.absolutePathToWorkspace":{"default":true,"description":"Sets an absolute path to the current workspace","type":"boolean"},"path-intellisense.autoSlashAfterDirectory":{"default":false,"description":"Automatically adds slash after directory","type":"boolean"},"path-intellisense.autoTriggerNextSuggestion":{"default":false,"description":"Automatically triggers next suggestion after previous suggestion","type":"boolean"},"path-intellisense.extensionOnImport":{"default":false,"description":"Adds the file extension to a import statements","type":"boolean"},"path-intellisense.ignoreTsConfigBaseUrl":{"default":false,"description":"Ignores tsconfig file for mappings","type":"boolean"},"path-intellisense.mappings":{"default":{},"description":"Mappings for paths.  The values should be interpreted as absolute paths (and can use '${workspaceFolder}')","type":"object"},"path-intellisense.showHiddenFiles":{"default":false,"description":"Show hidden files","type":"boolean"},"path-intellisense.showOnAbsoluteSlash":{"default":true,"description":"Shows suggestions when the import starts with a forward slash ('/')","type":"boolean"}},"title":"path-intellisense","type":"object"}},"dependencies":{"@types/json5":"0.0.30","benchmark":"^2.1.4","json5":"^2.1.2","lodash":"^4.17.19","minimatch":"^3.0.4"},"description":"Visual Studio Code plugin that autocompletes filenames","devDependencies":{"@semantic-release/changelog":"^5.0.1","@semantic-release/git":"^9.0.0","@semantic-release/npm":"^7.0.5","@types/benchmark":"^1.0.31","@types/glob":"^7.1.1","@types/mocha":"^7.0.1","@types/node":"^12.11.7","@types/vscode":"^1.43.0","@typescript-eslint/eslint-plugin":"^2.18.0","@typescript-eslint/parser":"^2.18.0","eslint":"^6.8.0","glob":"^7.1.6","mocha":"^7.0.1","path-browserify":"^1.0.1","process":"^0.11.10","ts-loader":"^9.2.5","typescript":"^3.9.10","vsce":"^1.76.0","vscode-test":"^1.3.0","webpack":"^5.51.1","webpack-cli":"^4.8.0"},"displayName":"Path Intellisense","engines":{"vscode":"^1.43.0"},"homepage":"https://github.com/ChristianKohler/PathIntellisense","icon":"icon/path-intellisense.png","main":"./out/extension.js","name":"path-intellisense","private":true,"publisher":"christian-kohler","repository":{"type":"git","url":"https://github.com/ChristianKohler/PathIntellisense.git"},"scripts":{"compile":"tsc -p ./","compile-web":"webpack --config ./build/web-extension.webpack.config.js","deploy":"vsce publish","lint":"eslint src --ext ts","package":"vsce package","package-web":"webpack --mode production --devtool hidden-source-map --config ./build/web-extension.webpack.config.js","prepack":"npm run package && npm run package-web","pretest":"npm run compile && npm run lint","test":"node ./out/test/runTest.js","test-headless":"xvfb-run -a npm test","vscode:prepublish":"npm run compile","watch":"tsc -watch -p ./","watch-web":"webpack --watch --config ./build/web-extension.webpack.config.js"},"version":"2.8.0"}};

/** @param {any} sable */
export async function activate(sable) {
  await __sableVscode.activate(sable, __modules, __extension);
}

export async function deactivate() {
  await __sableVscode.deactivate();
}
