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
"out/src/extension.js": function (module, exports, require, __filename, __dirname) {
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
function activate(context) {
    vscode.workspace.onDidChangeTextDocument(event => {
        insertAutoCloseTag(event);
    });
    let closeTag = vscode.commands.registerCommand('auto-close-tag.closeTag', () => {
        insertCloseTag();
    });
    context.subscriptions.push(closeTag);
}
exports.activate = activate;
// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;
function insertAutoCloseTag(event) {
    if (!event.contentChanges[0] || (event.reason && event.reason == vscode.TextDocumentChangeReason.Undo) || (event.reason && event.reason == vscode.TextDocumentChangeReason.Redo)) {
        return;
    }
    let isRightAngleBracket = CheckRightAngleBracket(event.contentChanges[0]);
    if (!isRightAngleBracket && event.contentChanges[0].text !== "/") {
        return;
    }
    let editor = vscode.window.activeTextEditor;
    if (!editor || (editor && event.document !== editor.document)) {
        return;
    }
    let config = vscode.workspace.getConfiguration('auto-close-tag', editor.document.uri);
    if (!config.get("enableAutoCloseTag", true)) {
        return;
    }
    let languageId = editor.document.languageId;
    let languages = config.get("activationOnLanguage", ["*"]);
    let disableOnLanguage = config.get("disableOnLanguage", []);
    if ((languages.indexOf("*") === -1 && languages.indexOf(languageId) === -1) || disableOnLanguage.indexOf(languageId) !== -1) {
        return;
    }
    let selection = editor.selection;
    let originalPosition = selection.start.translate(0, 1);
    let excludedTags = config.get("excludedTags", []);
    let isSublimeText3Mode = config.get("SublimeText3Mode", false);
    let enableAutoCloseSelfClosingTag = config.get("enableAutoCloseSelfClosingTag", true);
    let isFullMode = config.get("fullMode");
    if ((isSublimeText3Mode || isFullMode) && event.contentChanges[0].text === "/") {
        let text = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), originalPosition));
        let last2chars = "";
        if (text.length > 2) {
            last2chars = text.substr(text.length - 2);
        }
        if (last2chars === "</") {
            let closeTag = getCloseTag(text, excludedTags);
            if (closeTag) {
                let nextChar = getNextChar(editor, originalPosition);
                if (nextChar === ">") {
                    closeTag = closeTag.substr(0, closeTag.length - 1);
                }
                editor.edit((editBuilder) => {
                    editBuilder.insert(originalPosition, closeTag);
                }).then(() => {
                    if (nextChar === ">") {
                        editor.selection = moveSelectionRight(editor.selection, 1);
                    }
                });
            }
        }
    }
    if (((!isSublimeText3Mode || isFullMode) && isRightAngleBracket) ||
        (enableAutoCloseSelfClosingTag && event.contentChanges[0].text === "/")) {
        let textLine = editor.document.lineAt(selection.start);
        let text = textLine.text.substring(0, selection.start.character + 1);
        let result = /<([_a-zA-Z][a-zA-Z0-9:\-_.]*)(?:\s+[^<>]*?[^\s/<>=]+?)*?\s?(\/|>)$/.exec(text);
        if (result !== null && ((occurrenceCount(result[0], "'") % 2 === 0)
            && (occurrenceCount(result[0], "\"") % 2 === 0) && (occurrenceCount(result[0], "`") % 2 === 0))) {
            if (result[2] === ">") {
                if (excludedTags.indexOf(result[1].toLowerCase()) === -1) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(originalPosition, "</" + result[1] + ">");
                    }).then(() => {
                        editor.selection = new vscode.Selection(originalPosition, originalPosition);
                    });
                }
            }
            else {
                if (textLine.text.length <= selection.start.character + 1 || textLine.text[selection.start.character + 1] !== '>') { // if not typing "/" just before ">", add the ">" after "/"
                    editor.edit((editBuilder) => {
                        if (config.get("insertSpaceBeforeSelfClosingTag")) {
                            const spacePosition = originalPosition.translate(0, -1);
                            editBuilder.insert(spacePosition, " ");
                        }
                        editBuilder.insert(originalPosition, ">");
                    });
                }
            }
        }
    }
}
function CheckRightAngleBracket(contentChange) {
    return contentChange.text === ">" || CheckRightAngleBracketInVSCode_1_8(contentChange);
}
function CheckRightAngleBracketInVSCode_1_8(contentChange) {
    return contentChange.text.endsWith(">") && contentChange.range.start.character === 0
        && contentChange.range.start.line === contentChange.range.end.line
        && !contentChange.range.end.isEqual(new vscode.Position(0, 0));
}
function insertCloseTag() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    let selection = editor.selection;
    let originalPosition = selection.start;
    let config = vscode.workspace.getConfiguration('auto-close-tag', editor.document.uri);
    let excludedTags = config.get("excludedTags", []);
    let text = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), originalPosition));
    if (text.length > 2) {
        let closeTag = getCloseTag(text, excludedTags);
        if (closeTag) {
            editor.edit((editBuilder) => {
                editBuilder.insert(originalPosition, closeTag);
            });
        }
    }
}
function getNextChar(editor, position) {
    let nextPosition = position.translate(0, 1);
    let text = editor.document.getText(new vscode.Range(position, nextPosition));
    return text;
}
function getCloseTag(text, excludedTags) {
    let regex = /<(\/?[_a-zA-Z][a-zA-Z0-9:\-_.]*)(?:\s+[^<>]*?[^\s/<>=]+?)*?\s?>/g;
    let result = null;
    let stack = [];
    while ((result = regex.exec(text)) !== null) {
        let isStartTag = result[1].substr(0, 1) !== "/";
        let tag = isStartTag ? result[1] : result[1].substr(1);
        if (excludedTags.indexOf(tag.toLowerCase()) === -1) {
            if (isStartTag) {
                stack.push(tag);
            }
            else if (stack.length > 0) {
                let lastTag = stack[stack.length - 1];
                if (lastTag === tag) {
                    stack.pop();
                }
            }
        }
    }
    if (stack.length > 0) {
        let closeTag = stack[stack.length - 1];
        if (text.substr(text.length - 2) === "</") {
            return closeTag + ">";
        }
        if (text.substr(text.length - 1) === "<") {
            return "/" + closeTag + ">";
        }
        return "</" + closeTag + ">";
    }
    else {
        return null;
    }
}
function moveSelectionRight(selection, shift) {
    let newPosition = selection.active.translate(0, shift);
    let newSelection = new vscode.Selection(newPosition, newPosition);
    return newSelection;
}
function occurrenceCount(source, find) {
    return source.split(find).length - 1;
}
//# sourceMappingURL=extension.js.map
},
"package.json": function (module) { module.exports = {
    "name": "auto-close-tag",
    "displayName": "Auto Close Tag",
    "description": "Automatically add HTML/XML close tag, same as Visual Studio IDE or Sublime Text",
    "version": "0.5.15",
    "publisher": "formulahendry",
    "icon": "images/logo.png",
    "engines": {
        "vscode": "^1.49.0"
    },
    "categories": [
        "Other",
        "Programming Languages"
    ],
    "keywords": [
        "AutoComplete",
        "close",
        "tag",
        "html",
        "xml",
        "multi-root ready"
    ],
    "bugs": {
        "url": "https://github.com/formulahendry/vscode-auto-close-tag/issues",
        "email": "formulahendry@gmail.com"
    },
    "homepage": "https://github.com/formulahendry/vscode-auto-close-tag/blob/master/README.md",
    "repository": {
        "type": "git",
        "url": "https://github.com/formulahendry/vscode-auto-close-tag.git"
    },
    "extensionKind": [
        "ui",
        "workspace"
    ],
    "activationEvents": [
        "*",
        "onCommand:auto-close-tag.closeTag"
    ],
    "main": "./out/src/extension",
    "capabilities": {
        "untrustedWorkspaces": {
            "supported": true
        },
        "virtualWorkspaces": true
    },
    "contributes": {
        "commands": [
            {
                "command": "auto-close-tag.closeTag",
                "title": "Close Tag"
            }
        ],
        "keybindings": [
            {
                "command": "auto-close-tag.closeTag",
                "key": "alt+.",
                "mac": "cmd+alt+."
            }
        ],
        "configuration": {
            "type": "object",
            "title": "Auto Close Tag configuration",
            "properties": {
                "auto-close-tag.activationOnLanguage": {
                    "type": "array",
                    "default": [
                        "xml",
                        "php",
                        "blade",
                        "ejs",
                        "jinja",
                        "javascript",
                        "javascriptreact",
                        "typescript",
                        "typescriptreact",
                        "plaintext",
                        "markdown",
                        "vue",
                        "liquid",
                        "erb",
                        "lang-cfml",
                        "cfml",
                        "HTML (EEx)",
                        "HTML (Eex)",
                        "plist"
                    ],
                    "description": "Set the languages that the extension will be activated.  e.g. [\"html\",\"xml\",\"php\"]. Use [\"*\"] to activate for all languages.",
                    "scope": "resource"
                },
                "auto-close-tag.disableOnLanguage": {
                    "type": "array",
                    "default": [],
                    "description": "Set the languages where the extension will be disabled.  e.g. [\"html\",\"xml\",\"php\"].",
                    "scope": "resource"
                },
                "auto-close-tag.excludedTags": {
                    "type": "array",
                    "default": [
                        "area",
                        "base",
                        "br",
                        "col",
                        "command",
                        "embed",
                        "hr",
                        "img",
                        "input",
                        "keygen",
                        "link",
                        "meta",
                        "param",
                        "source",
                        "track",
                        "wbr"
                    ],
                    "description": "Set the tag list that would not be auto closed.",
                    "scope": "resource"
                },
                "auto-close-tag.SublimeText3Mode": {
                    "type": "boolean",
                    "default": false,
                    "description": "Auto close tag when </ is typed, same as Sublime Text 3",
                    "scope": "resource"
                },
                "auto-close-tag.enableAutoCloseTag": {
                    "type": "boolean",
                    "default": true,
                    "description": "Whether to insert close tag automatically",
                    "scope": "resource"
                },
                "auto-close-tag.enableAutoCloseSelfClosingTag": {
                    "type": "boolean",
                    "default": true,
                    "description": "Whether to close self-closing tag automatically",
                    "scope": "resource"
                },
                "auto-close-tag.insertSpaceBeforeSelfClosingTag": {
                    "type": "boolean",
                    "default": false,
                    "description": "Insert a space before the forward slash in a self-closing tag.",
                    "scope": "resource"
                },
                "auto-close-tag.fullMode": {
                    "type": "boolean",
                    "default": false,
                    "description": "Enable both Visual Studio and Sublime Text mode",
                    "scope": "resource"
                }
            }
        }
    },
    "scripts": {
        "vscode:prepublish": "tsc -p ./",
        "compile": "tsc -watch -p ./"
    },
    "devDependencies": {
        "@types/mocha": "^2.2.32",
        "@types/node": "^6.0.40",
        "@types/vscode": "^1.49.0",
        "mocha": "^2.3.3",
        "typescript": "^3.9.10"
    }
}
; },
};

const __extension = {"commands":{"auto-close-tag.closeTag":"Close Tag"},"configuration":{"auto-close-tag.SublimeText3Mode":false,"auto-close-tag.activationOnLanguage":["html","xml","php","blade","ejs","jinja","javascript","javascriptreact","typescript","typescriptreact","plaintext","markdown","vue","liquid","erb","lang-cfml","cfml","HTML (EEx)","HTML (Eex)","plist"],"auto-close-tag.disableOnLanguage":[],"auto-close-tag.enableAutoCloseSelfClosingTag":true,"auto-close-tag.enableAutoCloseTag":true,"auto-close-tag.excludedTags":["area","base","br","col","command","embed","hr","img","input","keygen","link","meta","param","source","track","wbr"],"auto-close-tag.fullMode":false,"auto-close-tag.insertSpaceBeforeSelfClosingTag":false},"entry":"out/src/extension.js","grammars":[],"id":"formulahendry.auto-close-tag","languages":[],"name":"Auto Close Tag","packageJSON":{"activationEvents":["*","onCommand:auto-close-tag.closeTag"],"bugs":{"email":"formulahendry@gmail.com","url":"https://github.com/formulahendry/vscode-auto-close-tag/issues"},"capabilities":{"untrustedWorkspaces":{"supported":true},"virtualWorkspaces":true},"categories":["Other","Programming Languages"],"contributes":{"commands":[{"command":"auto-close-tag.closeTag","title":"Close Tag"}],"configuration":{"properties":{"auto-close-tag.SublimeText3Mode":{"default":false,"description":"Auto close tag when </ is typed, same as Sublime Text 3","scope":"resource","type":"boolean"},"auto-close-tag.activationOnLanguage":{"default":["xml","php","blade","ejs","jinja","javascript","javascriptreact","typescript","typescriptreact","plaintext","markdown","vue","liquid","erb","lang-cfml","cfml","HTML (EEx)","HTML (Eex)","plist"],"description":"Set the languages that the extension will be activated.  e.g. [\"html\",\"xml\",\"php\"]. Use [\"*\"] to activate for all languages.","scope":"resource","type":"array"},"auto-close-tag.disableOnLanguage":{"default":[],"description":"Set the languages where the extension will be disabled.  e.g. [\"html\",\"xml\",\"php\"].","scope":"resource","type":"array"},"auto-close-tag.enableAutoCloseSelfClosingTag":{"default":true,"description":"Whether to close self-closing tag automatically","scope":"resource","type":"boolean"},"auto-close-tag.enableAutoCloseTag":{"default":true,"description":"Whether to insert close tag automatically","scope":"resource","type":"boolean"},"auto-close-tag.excludedTags":{"default":["area","base","br","col","command","embed","hr","img","input","keygen","link","meta","param","source","track","wbr"],"description":"Set the tag list that would not be auto closed.","scope":"resource","type":"array"},"auto-close-tag.fullMode":{"default":false,"description":"Enable both Visual Studio and Sublime Text mode","scope":"resource","type":"boolean"},"auto-close-tag.insertSpaceBeforeSelfClosingTag":{"default":false,"description":"Insert a space before the forward slash in a self-closing tag.","scope":"resource","type":"boolean"}},"title":"Auto Close Tag configuration","type":"object"},"keybindings":[{"command":"auto-close-tag.closeTag","key":"alt+.","mac":"cmd+alt+."}]},"description":"Automatically add HTML/XML close tag, same as Visual Studio IDE or Sublime Text","devDependencies":{"@types/mocha":"^2.2.32","@types/node":"^6.0.40","@types/vscode":"^1.49.0","mocha":"^2.3.3","typescript":"^3.9.10"},"displayName":"Auto Close Tag","engines":{"vscode":"^1.49.0"},"extensionKind":["ui","workspace"],"homepage":"https://github.com/formulahendry/vscode-auto-close-tag/blob/master/README.md","icon":"images/logo.png","keywords":["AutoComplete","close","tag","html","xml","multi-root ready"],"main":"./out/src/extension","name":"auto-close-tag","publisher":"formulahendry","repository":{"type":"git","url":"https://github.com/formulahendry/vscode-auto-close-tag.git"},"scripts":{"compile":"tsc -watch -p ./","vscode:prepublish":"tsc -p ./"},"version":"0.5.15"}};

/** @param {any} sable */
export async function activate(sable) {
  await __sableVscode.activate(sable, __modules, __extension);
}

export async function deactivate() {
  await __sableVscode.deactivate();
}
