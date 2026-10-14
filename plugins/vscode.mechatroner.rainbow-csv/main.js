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
"contrib/textarea-caret-position/index.js": function (module, exports, require, __filename, __dirname) {
/* jshint browser: true */

(function () {

// We'll copy the properties below into the mirror div.
// Note that some browsers, such as Firefox, do not concatenate properties
// into their shorthand (e.g. padding-top, padding-bottom etc. -> padding),
// so we have to list every single property explicitly.
var properties = [
  'direction',  // RTL support
  'boxSizing',
  'width',  // on Chrome and IE, exclude the scrollbar, so the mirror div wraps exactly as the textarea does
  'height',
  'overflowX',
  'overflowY',  // copy the scrollbar for IE

  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',

  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',

  // https://developer.mozilla.org/en-US/docs/Web/CSS/font
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',

  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',  // might not make a difference, but better be safe

  'letterSpacing',
  'wordSpacing',

  'tabSize',
  'MozTabSize'

];

var isBrowser = (typeof window !== 'undefined');
var isFirefox = (isBrowser && window.mozInnerScreenX != null);

function getCaretCoordinates(element, position, options) {
  if (!isBrowser) {
    throw new Error('textarea-caret-position#getCaretCoordinates should only be called in a browser');
  }

  var debug = options && options.debug || false;
  if (debug) {
    var el = document.querySelector('#input-textarea-caret-position-mirror-div');
    if (el) el.parentNode.removeChild(el);
  }

  // The mirror div will replicate the textarea's style
  var div = document.createElement('div');
  div.id = 'input-textarea-caret-position-mirror-div';
  document.body.appendChild(div);

  var style = div.style;
  var computed = window.getComputedStyle ? window.getComputedStyle(element) : element.currentStyle;  // currentStyle for IE < 9
  var isInput = element.nodeName === 'INPUT';

  // Default textarea styles
  style.whiteSpace = 'pre-wrap';
  if (!isInput)
    style.wordWrap = 'break-word';  // only for textarea-s

  // Position off-screen
  style.position = 'absolute';  // required to return coordinates properly
  if (!debug)
    style.visibility = 'hidden';  // not 'display: none' because we want rendering

  // Transfer the element's properties to the div
  properties.forEach(function (prop) {
    if (isInput && prop === 'lineHeight') {
      // Special case for <input>s because text is rendered centered and line height may be != height
      if (computed.boxSizing === "border-box") {
        var height = parseInt(computed.height);
        var outerHeight =
          parseInt(computed.paddingTop) +
          parseInt(computed.paddingBottom) +
          parseInt(computed.borderTopWidth) +
          parseInt(computed.borderBottomWidth);
        var targetHeight = outerHeight + parseInt(computed.lineHeight);
        if (height > targetHeight) {
          style.lineHeight = height - outerHeight + "px";
        } else if (height === targetHeight) {
          style.lineHeight = computed.lineHeight;
        } else {
          style.lineHeight = 0;
        }
      } else {
        style.lineHeight = computed.height;
      }
    } else {
      style[prop] = computed[prop];
    }
  });

  if (isFirefox) {
    // Firefox lies about the overflow property for textareas: https://bugzilla.mozilla.org/show_bug.cgi?id=984275
    if (element.scrollHeight > parseInt(computed.height))
      style.overflowY = 'scroll';
  } else {
    style.overflow = 'hidden';  // for Chrome to not render a scrollbar; IE keeps overflowY = 'scroll'
  }

  div.textContent = element.value.substring(0, position);
  // The second special handling for input type="text" vs textarea:
  // spaces need to be replaced with non-breaking spaces - http://stackoverflow.com/a/13402035/1269037
  if (isInput)
    div.textContent = div.textContent.replace(/\s/g, '\u00a0');

  var span = document.createElement('span');
  // Wrapping must be replicated *exactly*, including when a long word gets
  // onto the next line, with whitespace at the end of the line before (#7).
  // The  *only* reliable way to do that is to copy the *entire* rest of the
  // textarea's content into the <span> created at the caret position.
  // For inputs, just '.' would be enough, but no need to bother.
  span.textContent = element.value.substring(position) || '.';  // || because a completely empty faux span doesn't render at all
  div.appendChild(span);

  var coordinates = {
    top: span.offsetTop + parseInt(computed['borderTopWidth']),
    left: span.offsetLeft + parseInt(computed['borderLeftWidth']),
    height: parseInt(computed['lineHeight'])
  };

  if (debug) {
    span.style.backgroundColor = '#aaa';
  } else {
    document.body.removeChild(div);
  }

  return coordinates;
}

if (typeof module != 'undefined' && typeof module.exports != 'undefined') {
  module.exports = getCaretCoordinates;
} else if(isBrowser) {
  window.getCaretCoordinates = getCaretCoordinates;
}

}());

},
"contrib/wcwidth/combining.js": function (module, exports, require, __filename, __dirname) {
module.exports = [
    [ 0x0300, 0x036F ], [ 0x0483, 0x0486 ], [ 0x0488, 0x0489 ],
    [ 0x0591, 0x05BD ], [ 0x05BF, 0x05BF ], [ 0x05C1, 0x05C2 ],
    [ 0x05C4, 0x05C5 ], [ 0x05C7, 0x05C7 ], [ 0x0600, 0x0603 ],
    [ 0x0610, 0x0615 ], [ 0x064B, 0x065E ], [ 0x0670, 0x0670 ],
    [ 0x06D6, 0x06E4 ], [ 0x06E7, 0x06E8 ], [ 0x06EA, 0x06ED ],
    [ 0x070F, 0x070F ], [ 0x0711, 0x0711 ], [ 0x0730, 0x074A ],
    [ 0x07A6, 0x07B0 ], [ 0x07EB, 0x07F3 ], [ 0x0901, 0x0902 ],
    [ 0x093C, 0x093C ], [ 0x0941, 0x0948 ], [ 0x094D, 0x094D ],
    [ 0x0951, 0x0954 ], [ 0x0962, 0x0963 ], [ 0x0981, 0x0981 ],
    [ 0x09BC, 0x09BC ], [ 0x09C1, 0x09C4 ], [ 0x09CD, 0x09CD ],
    [ 0x09E2, 0x09E3 ], [ 0x0A01, 0x0A02 ], [ 0x0A3C, 0x0A3C ],
    [ 0x0A41, 0x0A42 ], [ 0x0A47, 0x0A48 ], [ 0x0A4B, 0x0A4D ],
    [ 0x0A70, 0x0A71 ], [ 0x0A81, 0x0A82 ], [ 0x0ABC, 0x0ABC ],
    [ 0x0AC1, 0x0AC5 ], [ 0x0AC7, 0x0AC8 ], [ 0x0ACD, 0x0ACD ],
    [ 0x0AE2, 0x0AE3 ], [ 0x0B01, 0x0B01 ], [ 0x0B3C, 0x0B3C ],
    [ 0x0B3F, 0x0B3F ], [ 0x0B41, 0x0B43 ], [ 0x0B4D, 0x0B4D ],
    [ 0x0B56, 0x0B56 ], [ 0x0B82, 0x0B82 ], [ 0x0BC0, 0x0BC0 ],
    [ 0x0BCD, 0x0BCD ], [ 0x0C3E, 0x0C40 ], [ 0x0C46, 0x0C48 ],
    [ 0x0C4A, 0x0C4D ], [ 0x0C55, 0x0C56 ], [ 0x0CBC, 0x0CBC ],
    [ 0x0CBF, 0x0CBF ], [ 0x0CC6, 0x0CC6 ], [ 0x0CCC, 0x0CCD ],
    [ 0x0CE2, 0x0CE3 ], [ 0x0D41, 0x0D43 ], [ 0x0D4D, 0x0D4D ],
    [ 0x0DCA, 0x0DCA ], [ 0x0DD2, 0x0DD4 ], [ 0x0DD6, 0x0DD6 ],
    [ 0x0E31, 0x0E31 ], [ 0x0E34, 0x0E3A ], [ 0x0E47, 0x0E4E ],
    [ 0x0EB1, 0x0EB1 ], [ 0x0EB4, 0x0EB9 ], [ 0x0EBB, 0x0EBC ],
    [ 0x0EC8, 0x0ECD ], [ 0x0F18, 0x0F19 ], [ 0x0F35, 0x0F35 ],
    [ 0x0F37, 0x0F37 ], [ 0x0F39, 0x0F39 ], [ 0x0F71, 0x0F7E ],
    [ 0x0F80, 0x0F84 ], [ 0x0F86, 0x0F87 ], [ 0x0F90, 0x0F97 ],
    [ 0x0F99, 0x0FBC ], [ 0x0FC6, 0x0FC6 ], [ 0x102D, 0x1030 ],
    [ 0x1032, 0x1032 ], [ 0x1036, 0x1037 ], [ 0x1039, 0x1039 ],
    [ 0x1058, 0x1059 ], [ 0x1160, 0x11FF ], [ 0x135F, 0x135F ],
    [ 0x1712, 0x1714 ], [ 0x1732, 0x1734 ], [ 0x1752, 0x1753 ],
    [ 0x1772, 0x1773 ], [ 0x17B4, 0x17B5 ], [ 0x17B7, 0x17BD ],
    [ 0x17C6, 0x17C6 ], [ 0x17C9, 0x17D3 ], [ 0x17DD, 0x17DD ],
    [ 0x180B, 0x180D ], [ 0x18A9, 0x18A9 ], [ 0x1920, 0x1922 ],
    [ 0x1927, 0x1928 ], [ 0x1932, 0x1932 ], [ 0x1939, 0x193B ],
    [ 0x1A17, 0x1A18 ], [ 0x1B00, 0x1B03 ], [ 0x1B34, 0x1B34 ],
    [ 0x1B36, 0x1B3A ], [ 0x1B3C, 0x1B3C ], [ 0x1B42, 0x1B42 ],
    [ 0x1B6B, 0x1B73 ], [ 0x1DC0, 0x1DCA ], [ 0x1DFE, 0x1DFF ],
    [ 0x200B, 0x200F ], [ 0x202A, 0x202E ], [ 0x2060, 0x2063 ],
    [ 0x206A, 0x206F ], [ 0x20D0, 0x20EF ], [ 0x302A, 0x302F ],
    [ 0x3099, 0x309A ], [ 0xA806, 0xA806 ], [ 0xA80B, 0xA80B ],
    [ 0xA825, 0xA826 ], [ 0xFB1E, 0xFB1E ], [ 0xFE00, 0xFE0F ],
    [ 0xFE20, 0xFE23 ], [ 0xFEFF, 0xFEFF ], [ 0xFFF9, 0xFFFB ],
    [ 0x10A01, 0x10A03 ], [ 0x10A05, 0x10A06 ], [ 0x10A0C, 0x10A0F ],
    [ 0x10A38, 0x10A3A ], [ 0x10A3F, 0x10A3F ], [ 0x1D167, 0x1D169 ],
    [ 0x1D173, 0x1D182 ], [ 0x1D185, 0x1D18B ], [ 0x1D1AA, 0x1D1AD ],
    [ 0x1D242, 0x1D244 ], [ 0xE0001, 0xE0001 ], [ 0xE0020, 0xE007F ],
    [ 0xE0100, 0xE01EF ]
]

},
"contrib/wcwidth/index.js": function (module, exports, require, __filename, __dirname) {
"use strict"

var combining = require('./combining')

var DEFAULTS = {
  nul: 0,
  control: 0
}

module.exports = function wcwidth(str) {
  return wcswidth(str, DEFAULTS)
}

/*
 *  The following functions define the column width of an ISO 10646
 *  character as follows:
 *  - The null character (U+0000) has a column width of 0.
 *  - Other C0/C1 control characters and DEL will lead to a return value
 *    of -1.
 *  - Non-spacing and enclosing combining characters (general category
 *    code Mn or Me in the
 *    Unicode database) have a column width of 0.
 *  - SOFT HYPHEN (U+00AD) has a column width of 1.
 *  - Other format characters (general category code Cf in the Unicode
 *    database) and ZERO WIDTH
 *    SPACE (U+200B) have a column width of 0.
 *  - Hangul Jamo medial vowels and final consonants (U+1160-U+11FF)
 *    have a column width of 0.
 *  - Spacing characters in the East Asian Wide (W) or East Asian
 *    Full-width (F) category as
 *    defined in Unicode Technical Report #11 have a column width of 2.
 *  - All remaining characters (including all printable ISO 8859-1 and
 *    WGL4 characters, Unicode control characters, etc.) have a column
 *    width of 1.
 *  This implementation assumes that characters are encoded in ISO 10646.
*/

function wcswidth(str, opts) {
  if (typeof str !== 'string') return wcwidth(str, opts)

  var s = 0
  for (var i = 0; i < str.length; i++) {
    var n = wcwidth(str.charCodeAt(i), opts)
    if (n < 0) return -1
    s += n
  }

  return s
}

function wcwidth(ucs, opts) {
  // test for 8-bit control characters
  if (ucs === 0) return opts.nul
  if (ucs < 32 || (ucs >= 0x7f && ucs < 0xa0)) return opts.control

  // binary search in table of non-spacing characters
  if (bisearch(ucs)) return 0

  // if we arrive here, ucs is not a combining or C0/C1 control character
  return 1 +
      (ucs >= 0x1100 &&
       (ucs <= 0x115f ||                       // Hangul Jamo init. consonants
        ucs == 0x2329 || ucs == 0x232a ||
        (ucs >= 0x2e80 && ucs <= 0xa4cf &&
         ucs != 0x303f) ||                     // CJK ... Yi
        (ucs >= 0xac00 && ucs <= 0xd7a3) ||    // Hangul Syllables
        (ucs >= 0xf900 && ucs <= 0xfaff) ||    // CJK Compatibility Ideographs
        (ucs >= 0xfe10 && ucs <= 0xfe19) ||    // Vertical forms
        (ucs >= 0xfe30 && ucs <= 0xfe6f) ||    // CJK Compatibility Forms
        (ucs >= 0xff00 && ucs <= 0xff60) ||    // Fullwidth Forms
        (ucs >= 0xffe0 && ucs <= 0xffe6) ||
        (ucs >= 0x20000 && ucs <= 0x2fffd) ||
        (ucs >= 0x30000 && ucs <= 0x3fffd)));
}

function bisearch(ucs) {
  var min = 0
  var max = combining.length - 1
  var mid

  if (ucs < combining[0][0] || ucs > combining[max][1]) return false

  while (max >= min) {
    mid = Math.floor((min + max) / 2)
    if (ucs > combining[mid][1]) min = mid + 1
    else if (ucs < combining[mid][0]) max = mid - 1
    else return true
  }

  return false
}

},
"dialect_select.js": function (module, exports, require, __filename, __dirname) {
const vscode = acquireVsCodeApi();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function handle_manual_separator_change() {
    document.getElementById("separator_selector").value = document.getElementById("manual_entry_option").value;
}


function handle_apply_click() {
    let separator_selection_option = document.getElementById("separator_selector").value;
    let manual_separator_text = document.getElementById("custom_separator_input").value;
    if (!manual_separator_text) {
        if (separator_selection_option == 'comma') {
            manual_separator_text = ',';
        } else if (separator_selection_option == 'tab') {
            manual_separator_text = '\t';
        } else if (separator_selection_option == 'whitespace') {
            manual_separator_text = ' ';
        }
    }
    let policy = document.getElementById("policy_selector").value;
    let custom_comment_prefix = document.getElementById("custom_comment_prefix").value;
    vscode.postMessage({'msg_type': 'apply_dialect', 'delim': manual_separator_text, 'policy': policy, 'comment_prefix': custom_comment_prefix});
}


async function handle_message(msg_event) {
    console.log('message received at client: ' + JSON.stringify(msg_event));
    var message = msg_event.data;
    if (!message) {
        return;
    }
    let message_type = message['msg_type'];
    if (message_type == 'dialect_handshake') {
        let selected_separator = message.selected_separator;

        if (selected_separator == '\t') {
            document.getElementById("separator_selector").value = document.getElementById("tab_option").value;
        } else if (selected_separator == ' ') {
            document.getElementById("separator_selector").value = document.getElementById("whitespace_option").value;
        } else if (selected_separator) {
            document.getElementById("custom_separator_input").value = selected_separator;
            document.getElementById("separator_selector").value = document.getElementById("manual_entry_option").value;
        }

        let policy = document.getElementById("simple_option").value;
        if (selected_separator == ' ') {
            policy = document.getElementById("merging_option").value;
        } else if (selected_separator == ',' || selected_separator == ';' || !selected_separator) {
            policy = document.getElementById("rfc_option").value;
        }
        document.getElementById("policy_selector").value = policy;

        if (message.integration_test) {
            await sleep(1500);
            handle_apply_click();
        }
    }
}


function main() {
    window.addEventListener('message', handle_message);
    vscode.postMessage({'msg_type': 'dialect_handshake'});

    document.getElementById("custom_separator_input").addEventListener("input", handle_manual_separator_change);
    document.getElementById("apply_button").addEventListener("click", handle_apply_click);
}

document.addEventListener("DOMContentLoaded", function(_event) {
    main();
});

},
"dist/web/extension.js": function (module, exports, require, __filename, __dirname) {
(()=>{var __webpack_modules__={1528(e){e.exports=[[768,879],[1155,1158],[1160,1161],[1425,1469],[1471,1471],[1473,1474],[1476,1477],[1479,1479],[1536,1539],[1552,1557],[1611,1630],[1648,1648],[1750,1764],[1767,1768],[1770,1773],[1807,1807],[1809,1809],[1840,1866],[1958,1968],[2027,2035],[2305,2306],[2364,2364],[2369,2376],[2381,2381],[2385,2388],[2402,2403],[2433,2433],[2492,2492],[2497,2500],[2509,2509],[2530,2531],[2561,2562],[2620,2620],[2625,2626],[2631,2632],[2635,2637],[2672,2673],[2689,2690],[2748,2748],[2753,2757],[2759,2760],[2765,2765],[2786,2787],[2817,2817],[2876,2876],[2879,2879],[2881,2883],[2893,2893],[2902,2902],[2946,2946],[3008,3008],[3021,3021],[3134,3136],[3142,3144],[3146,3149],[3157,3158],[3260,3260],[3263,3263],[3270,3270],[3276,3277],[3298,3299],[3393,3395],[3405,3405],[3530,3530],[3538,3540],[3542,3542],[3633,3633],[3636,3642],[3655,3662],[3761,3761],[3764,3769],[3771,3772],[3784,3789],[3864,3865],[3893,3893],[3895,3895],[3897,3897],[3953,3966],[3968,3972],[3974,3975],[3984,3991],[3993,4028],[4038,4038],[4141,4144],[4146,4146],[4150,4151],[4153,4153],[4184,4185],[4448,4607],[4959,4959],[5906,5908],[5938,5940],[5970,5971],[6002,6003],[6068,6069],[6071,6077],[6086,6086],[6089,6099],[6109,6109],[6155,6157],[6313,6313],[6432,6434],[6439,6440],[6450,6450],[6457,6459],[6679,6680],[6912,6915],[6964,6964],[6966,6970],[6972,6972],[6978,6978],[7019,7027],[7616,7626],[7678,7679],[8203,8207],[8234,8238],[8288,8291],[8298,8303],[8400,8431],[12330,12335],[12441,12442],[43014,43014],[43019,43019],[43045,43046],[64286,64286],[65024,65039],[65056,65059],[65279,65279],[65529,65531],[68097,68099],[68101,68102],[68108,68111],[68152,68154],[68159,68159],[119143,119145],[119155,119170],[119173,119179],[119210,119213],[119362,119364],[917505,917505],[917536,917631],[917760,917999]]},3222(e,t,n){"use strict";var r=n(1528),i={nul:0,control:0};function o(e,t){return 0===e?t.nul:e<32||e>=127&&e<160?t.control:function(e){var t,n=0,i=r.length-1;if(e<r[0][0]||e>r[i][1])return!1;for(;i>=n;)if(t=Math.floor((n+i)/2),e>r[t][1])n=t+1;else{if(!(e<r[t][0]))return!0;i=t-1}return!1}(e)?0:1+(e>=4352&&(e<=4447||9001==e||9002==e||e>=11904&&e<=42191&&12351!=e||e>=44032&&e<=55203||e>=63744&&e<=64255||e>=65040&&e<=65049||e>=65072&&e<=65135||e>=65280&&e<=65376||e>=65504&&e<=65510||e>=131072&&e<=196605||e>=196608&&e<=262141))}e.exports=function(e){return function(e,t){if("string"!=typeof e)return o(e,t);for(var n=0,r=0;r<e.length;r++){var i=o(e.charCodeAt(r),t);if(i<0)return-1;n+=i}return n}(e,i)}},3568(e,t,n){const r=n(4285);class i extends Error{}function o(e,t=null){if(!e)throw t||(t="Assertion error"),new i(t)}class s{constructor(e,t,n,r,i,o,s,a){this.delim=e,this.policy=t,this.stop_on_warning=n,this.first_defective_line=null,this.records=r?[]:null,this.collect_records=r,this.num_records_parsed=0,this.fields_info=new Map,this.first_trailing_space_line=null,this.detect_trailing_spaces=o,this.preserve_quotes_and_whitespaces=i,this.min_num_fields_for_autodetection=s,this.trim_whitespaces=a}consume(e,t){let[n,i]=r.smart_split(e,this.delim,this.policy,this.preserve_quotes_and_whitespaces);if(i&&(null===this.first_defective_line&&(this.first_defective_line=t),this.stop_on_warning))return!1;if(this.detect_trailing_spaces&&null===this.first_trailing_space_line)for(let e of n)!e.length||" "!=e.charAt(0)&&" "!=e.charAt(e.length-1)||(this.first_trailing_space_line=t);if(this.trim_whitespaces&&(n=n.map(e=>e.trim())),!this.fields_info.has(n.length)&&(this.fields_info.set(n.length,this.num_records_parsed),-1!=this.min_num_fields_for_autodetection)){if(n.length<this.min_num_fields_for_autodetection)return!1;if(this.fields_info.size>1)return!1}return this.collect_records&&this.records.push(n),this.num_records_parsed+=1,!0}}e.exports.parse_document_records=function(e,t,n,i=null,a=!1,l=-1,u=!0,c=!1,_=!1,f=-1,p=!1){let d=e.lineCount,h=0,g=new r.MultilineRecordAggregator(i),m=new s(t,n,a,u,c,_,f,p),y=[];for(let t=0;t<d;++t){let r=e.lineAt(t).text;if(t+1>=d&&""==r){u&&y.push({record_num:m.num_records_parsed,comment_text:r});break}let o=null;if("quoted_rfc"==n){if(g.add_line(r),g.has_comment_line){h=t+1,g.reset(),u&&y.push({record_num:m.num_records_parsed,comment_text:r});continue}if(!g.has_full_record)continue;o=g.get_full_line("\n"),g.reset()}else{if(i&&r.startsWith(i)){h=t+1,u&&y.push({record_num:m.num_records_parsed,comment_text:r});continue}o=r}if(!m.consume(o,h))return[m.records,m.num_records_parsed,m.fields_info,m.first_defective_line,m.first_trailing_space_line,y];if(h=t+1,-1!==l&&m.num_records_parsed>=l)return[m.records,m.num_records_parsed,m.fields_info,m.first_defective_line,m.first_trailing_space_line,y]}return g.is_inside_multiline_record()&&(o("quoted_rfc"==n),m.consume(g.get_full_line("\n"),h)),[m.records,m.num_records_parsed,m.fields_info,m.first_defective_line,m.first_trailing_space_line,y]},e.exports.assert=o},3144(e,t,n){"use strict";var r=n(6743),i=n(1002),o=n(76),s=n(7119);e.exports=s||r.call(o,i)},2205(e,t,n){"use strict";var r=n(6743),i=n(1002),o=n(3144);e.exports=function(){return o(r,i,arguments)}},1002(e){"use strict";e.exports=Function.prototype.apply},76(e){"use strict";e.exports=Function.prototype.call},3126(e,t,n){"use strict";var r=n(6743),i=n(9675),o=n(76),s=n(3144);e.exports=function(e){if(e.length<1||"function"!=typeof e[0])throw new i("a function is required");return s(r,o,e)}},7119(e){"use strict";e.exports="undefined"!=typeof Reflect&&Reflect&&Reflect.apply},487(e,t,n){"use strict";var r=n(6897),i=n(655),o=n(3126),s=n(2205);e.exports=function(e){var t=o(arguments),n=e.length-(arguments.length-1);return r(t,1+(n>0?n:0),!0)},i?i(e.exports,"apply",{value:s}):e.exports.apply=s},6556(e,t,n){"use strict";var r=n(453),i=n(3126),o=i([r("%String.prototype.indexOf%")]);e.exports=function(e,t){var n=r(e,!!t);return"function"==typeof n&&o(e,".prototype.")>-1?i([n]):n}},41(e,t,n){"use strict";var r=n(655),i=n(8068),o=n(9675),s=n(5795);e.exports=function(e,t,n){if(!e||"object"!=typeof e&&"function"!=typeof e)throw new o("`obj` must be an object or a function`");if("string"!=typeof t&&"symbol"!=typeof t)throw new o("`property` must be a string or a symbol`");if(arguments.length>3&&"boolean"!=typeof arguments[3]&&null!==arguments[3])throw new o("`nonEnumerable`, if provided, must be a boolean or null");if(arguments.length>4&&"boolean"!=typeof arguments[4]&&null!==arguments[4])throw new o("`nonWritable`, if provided, must be a boolean or null");if(arguments.length>5&&"boolean"!=typeof arguments[5]&&null!==arguments[5])throw new o("`nonConfigurable`, if provided, must be a boolean or null");if(arguments.length>6&&"boolean"!=typeof arguments[6])throw new o("`loose`, if provided, must be a boolean");var a=arguments.length>3?arguments[3]:null,l=arguments.length>4?arguments[4]:null,u=arguments.length>5?arguments[5]:null,c=arguments.length>6&&arguments[6],_=!!s&&s(e,t);if(r)r(e,t,{configurable:null===u&&_?_.configurable:!u,enumerable:null===a&&_?_.enumerable:!a,value:n,writable:null===l&&_?_.writable:!l});else{if(!c&&(a||l||u))throw new i("This environment does not support defining a property as non-configurable, non-writable, or non-enumerable.");e[t]=n}}},7176(e,t,n){"use strict";var r,i=n(3126),o=n(5795);try{r=[].__proto__===Array.prototype}catch(e){if(!e||"object"!=typeof e||!("code"in e)||"ERR_PROTO_ACCESS"!==e.code)throw e}var s=!!r&&o&&o(Object.prototype,"__proto__"),a=Object,l=a.getPrototypeOf;e.exports=s&&"function"==typeof s.get?i([s.get]):"function"==typeof l&&function(e){return l(null==e?e:a(e))}},655(e){"use strict";var t=Object.defineProperty||!1;if(t)try{t({},"a",{value:1})}catch(e){t=!1}e.exports=t},1237(e){"use strict";e.exports=EvalError},9383(e){"use strict";e.exports=Error},9290(e){"use strict";e.exports=RangeError},9538(e){"use strict";e.exports=ReferenceError},8068(e){"use strict";e.exports=SyntaxError},9675(e){"use strict";e.exports=TypeError},5345(e){"use strict";e.exports=URIError},9612(e){"use strict";e.exports=Object},2682(e,t,n){"use strict";var r=n(9600),i=Object.prototype.toString,o=Object.prototype.hasOwnProperty;e.exports=function(e,t,n){if(!r(t))throw new TypeError("iterator must be a function");var s,a;arguments.length>=3&&(s=n),a=e,"[object Array]"===i.call(a)?function(e,t,n){for(var r=0,i=e.length;r<i;r++)o.call(e,r)&&(null==n?t(e[r],r,e):t.call(n,e[r],r,e))}(e,t,s):"string"==typeof e?function(e,t,n){for(var r=0,i=e.length;r<i;r++)null==n?t(e.charAt(r),r,e):t.call(n,e.charAt(r),r,e)}(e,t,s):function(e,t,n){for(var r in e)o.call(e,r)&&(null==n?t(e[r],r,e):t.call(n,e[r],r,e))}(e,t,s)}},9353(e){"use strict";var t=Object.prototype.toString,n=Math.max,r=function(e,t){for(var n=[],r=0;r<e.length;r+=1)n[r]=e[r];for(var i=0;i<t.length;i+=1)n[i+e.length]=t[i];return n};e.exports=function(e){var i=this;if("function"!=typeof i||"[object Function]"!==t.apply(i))throw new TypeError("Function.prototype.bind called on incompatible "+i);for(var o,s=function(e){for(var t=[],n=1,r=0;n<e.length;n+=1,r+=1)t[r]=e[n];return t}(arguments),a=n(0,i.length-s.length),l=[],u=0;u<a;u++)l[u]="$"+u;if(o=Function("binder","return function ("+function(e){for(var t="",n=0;n<e.length;n+=1)t+=e[n],n+1<e.length&&(t+=",");return t}(l)+"){ return binder.apply(this,arguments); }")(function(){if(this instanceof o){var t=i.apply(this,r(s,arguments));return Object(t)===t?t:this}return i.apply(e,r(s,arguments))}),i.prototype){var c=function(){};c.prototype=i.prototype,o.prototype=new c,c.prototype=null}return o}},6743(e,t,n){"use strict";var r=n(9353);e.exports=Function.prototype.bind||r},4233(e){"use strict";const t=function*(){}.constructor;e.exports=()=>t},453(e,t,n){"use strict";var r,i=n(9612),o=n(9383),s=n(1237),a=n(9290),l=n(9538),u=n(8068),c=n(9675),_=n(5345),f=n(1514),p=n(8968),d=n(6188),h=n(8002),g=n(5880),m=n(414),y=n(3093),b=Function,w=function(e){try{return b('"use strict"; return ('+e+").constructor;")()}catch(e){}},x=n(5795),v=n(655),E=function(){throw new c},R=x?function(){try{return E}catch(e){try{return x(arguments,"callee").get}catch(e){return E}}}():E,S=n(4039)(),A=n(3628),O=n(1064),k=n(8648),T=n(1002),q=n(76),P={},I="undefined"!=typeof Uint8Array&&A?A(Uint8Array):r,j={__proto__:null,"%AggregateError%":"undefined"==typeof AggregateError?r:AggregateError,"%Array%":Array,"%ArrayBuffer%":"undefined"==typeof ArrayBuffer?r:ArrayBuffer,"%ArrayIteratorPrototype%":S&&A?A([][Symbol.iterator]()):r,"%AsyncFromSyncIteratorPrototype%":r,"%AsyncFunction%":P,"%AsyncGenerator%":P,"%AsyncGeneratorFunction%":P,"%AsyncIteratorPrototype%":P,"%Atomics%":"undefined"==typeof Atomics?r:Atomics,"%BigInt%":"undefined"==typeof BigInt?r:BigInt,"%BigInt64Array%":"undefined"==typeof BigInt64Array?r:BigInt64Array,"%BigUint64Array%":"undefined"==typeof BigUint64Array?r:BigUint64Array,"%Boolean%":Boolean,"%DataView%":"undefined"==typeof DataView?r:DataView,"%Date%":Date,"%decodeURI%":decodeURI,"%decodeURIComponent%":decodeURIComponent,"%encodeURI%":encodeURI,"%encodeURIComponent%":encodeURIComponent,"%Error%":o,"%eval%":eval,"%EvalError%":s,"%Float16Array%":"undefined"==typeof Float16Array?r:Float16Array,"%Float32Array%":"undefined"==typeof Float32Array?r:Float32Array,"%Float64Array%":"undefined"==typeof Float64Array?r:Float64Array,"%FinalizationRegistry%":"undefined"==typeof FinalizationRegistry?r:FinalizationRegistry,"%Function%":b,"%GeneratorFunction%":P,"%Int8Array%":"undefined"==typeof Int8Array?r:Int8Array,"%Int16Array%":"undefined"==typeof Int16Array?r:Int16Array,"%Int32Array%":"undefined"==typeof Int32Array?r:Int32Array,"%isFinite%":isFinite,"%isNaN%":isNaN,"%IteratorPrototype%":S&&A?A(A([][Symbol.iterator]())):r,"%JSON%":"object"==typeof JSON?JSON:r,"%Map%":"undefined"==typeof Map?r:Map,"%MapIteratorPrototype%":"undefined"!=typeof Map&&S&&A?A((new Map)[Symbol.iterator]()):r,"%Math%":Math,"%Number%":Number,"%Object%":i,"%Object.getOwnPropertyDescriptor%":x,"%parseFloat%":parseFloat,"%parseInt%":parseInt,"%Promise%":"undefined"==typeof Promise?r:Promise,"%Proxy%":"undefined"==typeof Proxy?r:Proxy,"%RangeError%":a,"%ReferenceError%":l,"%Reflect%":"undefined"==typeof Reflect?r:Reflect,"%RegExp%":RegExp,"%Set%":"undefined"==typeof Set?r:Set,"%SetIteratorPrototype%":"undefined"!=typeof Set&&S&&A?A((new Set)[Symbol.iterator]()):r,"%SharedArrayBuffer%":"undefined"==typeof SharedArrayBuffer?r:SharedArrayBuffer,"%String%":String,"%StringIteratorPrototype%":S&&A?A(""[Symbol.iterator]()):r,"%Symbol%":S?Symbol:r,"%SyntaxError%":u,"%ThrowTypeError%":R,"%TypedArray%":I,"%TypeError%":c,"%Uint8Array%":"undefined"==typeof Uint8Array?r:Uint8Array,"%Uint8ClampedArray%":"undefined"==typeof Uint8ClampedArray?r:Uint8ClampedArray,"%Uint16Array%":"undefined"==typeof Uint16Array?r:Uint16Array,"%Uint32Array%":"undefined"==typeof Uint32Array?r:Uint32Array,"%URIError%":_,"%WeakMap%":"undefined"==typeof WeakMap?r:WeakMap,"%WeakRef%":"undefined"==typeof WeakRef?r:WeakRef,"%WeakSet%":"undefined"==typeof WeakSet?r:WeakSet,"%Function.prototype.call%":q,"%Function.prototype.apply%":T,"%Object.defineProperty%":v,"%Object.getPrototypeOf%":O,"%Math.abs%":f,"%Math.floor%":p,"%Math.max%":d,"%Math.min%":h,"%Math.pow%":g,"%Math.round%":m,"%Math.sign%":y,"%Reflect.getPrototypeOf%":k};if(A)try{null.error}catch(e){var N=A(A(e));j["%Error.prototype%"]=N}var C=function e(t){var n;if("%AsyncFunction%"===t)n=w("async function () {}");else if("%GeneratorFunction%"===t)n=w("function* () {}");else if("%AsyncGeneratorFunction%"===t)n=w("async function* () {}");else if("%AsyncGenerator%"===t){var r=e("%AsyncGeneratorFunction%");r&&(n=r.prototype)}else if("%AsyncIteratorPrototype%"===t){var i=e("%AsyncGenerator%");i&&A&&(n=A(i.prototype))}return j[t]=n,n},M={__proto__:null,"%ArrayBufferPrototype%":["ArrayBuffer","prototype"],"%ArrayPrototype%":["Array","prototype"],"%ArrayProto_entries%":["Array","prototype","entries"],"%ArrayProto_forEach%":["Array","prototype","forEach"],"%ArrayProto_keys%":["Array","prototype","keys"],"%ArrayProto_values%":["Array","prototype","values"],"%AsyncFunctionPrototype%":["AsyncFunction","prototype"],"%AsyncGenerator%":["AsyncGeneratorFunction","prototype"],"%AsyncGeneratorPrototype%":["AsyncGeneratorFunction","prototype","prototype"],"%BooleanPrototype%":["Boolean","prototype"],"%DataViewPrototype%":["DataView","prototype"],"%DatePrototype%":["Date","prototype"],"%ErrorPrototype%":["Error","prototype"],"%EvalErrorPrototype%":["EvalError","prototype"],"%Float32ArrayPrototype%":["Float32Array","prototype"],"%Float64ArrayPrototype%":["Float64Array","prototype"],"%FunctionPrototype%":["Function","prototype"],"%Generator%":["GeneratorFunction","prototype"],"%GeneratorPrototype%":["GeneratorFunction","prototype","prototype"],"%Int8ArrayPrototype%":["Int8Array","prototype"],"%Int16ArrayPrototype%":["Int16Array","prototype"],"%Int32ArrayPrototype%":["Int32Array","prototype"],"%JSONParse%":["JSON","parse"],"%JSONStringify%":["JSON","stringify"],"%MapPrototype%":["Map","prototype"],"%NumberPrototype%":["Number","prototype"],"%ObjectPrototype%":["Object","prototype"],"%ObjProto_toString%":["Object","prototype","toString"],"%ObjProto_valueOf%":["Object","prototype","valueOf"],"%PromisePrototype%":["Promise","prototype"],"%PromiseProto_then%":["Promise","prototype","then"],"%Promise_all%":["Promise","all"],"%Promise_reject%":["Promise","reject"],"%Promise_resolve%":["Promise","resolve"],"%RangeErrorPrototype%":["RangeError","prototype"],"%ReferenceErrorPrototype%":["ReferenceError","prototype"],"%RegExpPrototype%":["RegExp","prototype"],"%SetPrototype%":["Set","prototype"],"%SharedArrayBufferPrototype%":["SharedArrayBuffer","prototype"],"%StringPrototype%":["String","prototype"],"%SymbolPrototype%":["Symbol","prototype"],"%SyntaxErrorPrototype%":["SyntaxError","prototype"],"%TypedArrayPrototype%":["TypedArray","prototype"],"%TypeErrorPrototype%":["TypeError","prototype"],"%Uint8ArrayPrototype%":["Uint8Array","prototype"],"%Uint8ClampedArrayPrototype%":["Uint8ClampedArray","prototype"],"%Uint16ArrayPrototype%":["Uint16Array","prototype"],"%Uint32ArrayPrototype%":["Uint32Array","prototype"],"%URIErrorPrototype%":["URIError","prototype"],"%WeakMapPrototype%":["WeakMap","prototype"],"%WeakSetPrototype%":["WeakSet","prototype"]},L=n(6743),U=n(9957),$=L.call(q,Array.prototype.concat),B=L.call(T,Array.prototype.splice),D=L.call(q,String.prototype.replace),F=L.call(q,String.prototype.slice),W=L.call(q,RegExp.prototype.exec),J=/[^%.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|%$))/g,z=/\\(\\)?/g,Q=function(e,t){var n,r=e;if(U(M,r)&&(r="%"+(n=M[r])[0]+"%"),U(j,r)){var i=j[r];if(i===P&&(i=C(r)),void 0===i&&!t)throw new c("intrinsic "+e+" exists, but is not available. Please file an issue!");return{alias:n,name:r,value:i}}throw new u("intrinsic "+e+" does not exist!")};e.exports=function(e,t){if("string"!=typeof e||0===e.length)throw new c("intrinsic name must be a non-empty string");if(arguments.length>1&&"boolean"!=typeof t)throw new c('"allowMissing" argument must be a boolean');if(null===W(/^%?[^%]*%?$/,e))throw new u("`%` may not be present anywhere but at the beginning and end of the intrinsic name");var n=function(e){var t=F(e,0,1),n=F(e,-1);if("%"===t&&"%"!==n)throw new u("invalid intrinsic syntax, expected closing `%`");if("%"===n&&"%"!==t)throw new u("invalid intrinsic syntax, expected opening `%`");var r=[];return D(e,J,function(e,t,n,i){r[r.length]=n?D(i,z,"$1"):t||e}),r}(e),r=n.length>0?n[0]:"",i=Q("%"+r+"%",t),o=i.name,s=i.value,a=!1,l=i.alias;l&&(r=l[0],B(n,$([0,1],l)));for(var _=1,f=!0;_<n.length;_+=1){var p=n[_],d=F(p,0,1),h=F(p,-1);if(('"'===d||"'"===d||"`"===d||'"'===h||"'"===h||"`"===h)&&d!==h)throw new u("property names with quotes must have matching quotes");if("constructor"!==p&&f||(a=!0),U(j,o="%"+(r+="."+p)+"%"))s=j[o];else if(null!=s){if(!(p in s)){if(!t)throw new c("base intrinsic for "+e+" exists, but the property is not available.");return}if(x&&_+1>=n.length){var g=x(s,p);s=(f=!!g)&&"get"in g&&!("originalValue"in g.get)?g.get:s[p]}else f=U(s,p),s=s[p];f&&!a&&(j[o]=s)}}return s}},1064(e,t,n){"use strict";var r=n(9612);e.exports=r.getPrototypeOf||null},8648(e){"use strict";e.exports="undefined"!=typeof Reflect&&Reflect.getPrototypeOf||null},3628(e,t,n){"use strict";var r=n(8648),i=n(1064),o=n(7176);e.exports=r?function(e){return r(e)}:i?function(e){if(!e||"object"!=typeof e&&"function"!=typeof e)throw new TypeError("getProto: not an object");return i(e)}:o?function(e){return o(e)}:null},6549(e){"use strict";e.exports=Object.getOwnPropertyDescriptor},5795(e,t,n){"use strict";var r=n(6549);if(r)try{r([],"length")}catch(e){r=null}e.exports=r},592(e,t,n){"use strict";var r=n(655),i=function(){return!!r};i.hasArrayLengthDefineBug=function(){if(!r)return null;try{return 1!==r([],"length",{value:1}).length}catch(e){return!0}},e.exports=i},4039(e,t,n){"use strict";var r="undefined"!=typeof Symbol&&Symbol,i=n(1333);e.exports=function(){return"function"==typeof r&&"function"==typeof Symbol&&"symbol"==typeof r("foo")&&"symbol"==typeof Symbol("bar")&&i()}},1333(e){"use strict";e.exports=function(){if("function"!=typeof Symbol||"function"!=typeof Object.getOwnPropertySymbols)return!1;if("symbol"==typeof Symbol.iterator)return!0;var e={},t=Symbol("test"),n=Object(t);if("string"==typeof t)return!1;if("[object Symbol]"!==Object.prototype.toString.call(t))return!1;if("[object Symbol]"!==Object.prototype.toString.call(n))return!1;for(var r in e[t]=42,e)return!1;if("function"==typeof Object.keys&&0!==Object.keys(e).length)return!1;if("function"==typeof Object.getOwnPropertyNames&&0!==Object.getOwnPropertyNames(e).length)return!1;var i=Object.getOwnPropertySymbols(e);if(1!==i.length||i[0]!==t)return!1;if(!Object.prototype.propertyIsEnumerable.call(e,t))return!1;if("function"==typeof Object.getOwnPropertyDescriptor){var o=Object.getOwnPropertyDescriptor(e,t);if(42!==o.value||!0!==o.enumerable)return!1}return!0}},9092(e,t,n){"use strict";var r=n(1333);e.exports=function(){return r()&&!!Symbol.toStringTag}},9957(e,t,n){"use strict";var r=Function.prototype.call,i=Object.prototype.hasOwnProperty,o=n(6743);e.exports=o.call(r,i)},6698(e){"function"==typeof Object.create?e.exports=function(e,t){t&&(e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}}))}:e.exports=function(e,t){if(t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}}},7244(e,t,n){"use strict";var r=n(9092)(),i=n(6556)("Object.prototype.toString"),o=function(e){return!(r&&e&&"object"==typeof e&&Symbol.toStringTag in e)&&"[object Arguments]"===i(e)},s=function(e){return!!o(e)||null!==e&&"object"==typeof e&&"length"in e&&"number"==typeof e.length&&e.length>=0&&"[object Array]"!==i(e)&&"callee"in e&&"[object Function]"===i(e.callee)},a=function(){return o(arguments)}();o.isLegacyArguments=s,e.exports=a?o:s},9600(e){"use strict";var t,n,r=Function.prototype.toString,i="object"==typeof Reflect&&null!==Reflect&&Reflect.apply;if("function"==typeof i&&"function"==typeof Object.defineProperty)try{t=Object.defineProperty({},"length",{get:function(){throw n}}),n={},i(function(){throw 42},null,t)}catch(e){e!==n&&(i=null)}else i=null;var o=/^\s*class\b/,s=function(e){try{var t=r.call(e);return o.test(t)}catch(e){return!1}},a=function(e){try{return!s(e)&&(r.call(e),!0)}catch(e){return!1}},l=Object.prototype.toString,u="function"==typeof Symbol&&!!Symbol.toStringTag,c=!(0 in[,]),_=function(){return!1};if("object"==typeof document){var f=document.all;l.call(f)===l.call(document.all)&&(_=function(e){if((c||!e)&&(void 0===e||"object"==typeof e))try{var t=l.call(e);return("[object HTMLAllCollection]"===t||"[object HTML document.all class]"===t||"[object HTMLCollection]"===t||"[object Object]"===t)&&null==e("")}catch(e){}return!1})}e.exports=i?function(e){if(_(e))return!0;if(!e)return!1;if("function"!=typeof e&&"object"!=typeof e)return!1;try{i(e,null,t)}catch(e){if(e!==n)return!1}return!s(e)&&a(e)}:function(e){if(_(e))return!0;if(!e)return!1;if("function"!=typeof e&&"object"!=typeof e)return!1;if(u)return a(e);if(s(e))return!1;var t=l.call(e);return!("[object Function]"!==t&&"[object GeneratorFunction]"!==t&&!/^\[object HTML/.test(t))&&a(e)}},8184(e,t,n){"use strict";var r=n(6556),i=n(9721)(/^\s*(?:function)?\*/),o=n(9092)(),s=n(3628),a=r("Object.prototype.toString"),l=r("Function.prototype.toString"),u=n(4233);e.exports=function(e){if("function"!=typeof e)return!1;if(i(l(e)))return!0;if(!o)return"[object GeneratorFunction]"===a(e);if(!s)return!1;var t=u();return t&&s(e)===t.prototype}},4035(e,t,n){"use strict";var r,i=n(6556),o=n(9092)(),s=n(9957),a=n(5795);if(o){var l=i("RegExp.prototype.exec"),u={},c=function(){throw u},_={toString:c,valueOf:c};"symbol"==typeof Symbol.toPrimitive&&(_[Symbol.toPrimitive]=c),r=function(e){if(!e||"object"!=typeof e)return!1;var t=a(e,"lastIndex");if(!t||!s(t,"value"))return!1;try{l(e,_)}catch(e){return e===u}}}else{var f=i("Object.prototype.toString");r=function(e){return!(!e||"object"!=typeof e&&"function"!=typeof e)&&"[object RegExp]"===f(e)}}e.exports=r},5680(e,t,n){"use strict";var r=n(5767);e.exports=function(e){return!!r(e)}},1514(e){"use strict";e.exports=Math.abs},8968(e){"use strict";e.exports=Math.floor},4459(e){"use strict";e.exports=Number.isNaN||function(e){return e!=e}},6188(e){"use strict";e.exports=Math.max},8002(e){"use strict";e.exports=Math.min},5880(e){"use strict";e.exports=Math.pow},414(e){"use strict";e.exports=Math.round},3093(e,t,n){"use strict";var r=n(4459);e.exports=function(e){return r(e)||0===e?e:e<0?-1:1}},6578(e){"use strict";e.exports=["Float16Array","Float32Array","Float64Array","Int8Array","Int16Array","Int32Array","Uint8Array","Uint8ClampedArray","Uint16Array","Uint32Array","BigInt64Array","BigUint64Array"]},5606(e){var t,n,r=e.exports={};function i(){throw new Error("setTimeout has not been defined")}function o(){throw new Error("clearTimeout has not been defined")}function s(e){if(t===setTimeout)return setTimeout(e,0);if((t===i||!t)&&setTimeout)return t=setTimeout,setTimeout(e,0);try{return t(e,0)}catch(n){try{return t.call(null,e,0)}catch(n){return t.call(this,e,0)}}}!function(){try{t="function"==typeof setTimeout?setTimeout:i}catch(e){t=i}try{n="function"==typeof clearTimeout?clearTimeout:o}catch(e){n=o}}();var a,l=[],u=!1,c=-1;function _(){u&&a&&(u=!1,a.length?l=a.concat(l):c=-1,l.length&&f())}function f(){if(!u){var e=s(_);u=!0;for(var t=l.length;t;){for(a=l,l=[];++c<t;)a&&a[c].run();c=-1,t=l.length}a=null,u=!1,function(e){if(n===clearTimeout)return clearTimeout(e);if((n===o||!n)&&clearTimeout)return n=clearTimeout,clearTimeout(e);try{return n(e)}catch(t){try{return n.call(null,e)}catch(t){return n.call(this,e)}}}(e)}}function p(e,t){this.fun=e,this.array=t}function d(){}r.nextTick=function(e){var t=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];l.push(new p(e,t)),1!==l.length||u||s(f)},p.prototype.run=function(){this.fun.apply(null,this.array)},r.title="browser",r.browser=!0,r.env={},r.argv=[],r.version="",r.versions={},r.on=d,r.addListener=d,r.once=d,r.off=d,r.removeListener=d,r.removeAllListeners=d,r.emit=d,r.prependListener=d,r.prependOnceListener=d,r.listeners=function(e){return[]},r.binding=function(e){throw new Error("process.binding is not supported")},r.cwd=function(){return"/"},r.chdir=function(e){throw new Error("process.chdir is not supported")},r.umask=function(){return 0}},9721(e,t,n){"use strict";var r=n(6556),i=n(4035),o=r("RegExp.prototype.exec"),s=n(9675);e.exports=function(e){if(!i(e))throw new s("`regex` must be a RegExp");return function(t){return null!==o(e,t)}}},6897(e,t,n){"use strict";var r=n(453),i=n(41),o=n(592)(),s=n(5795),a=n(9675),l=r("%Math.floor%");e.exports=function(e,t){if("function"!=typeof e)throw new a("`fn` is not a function");if("number"!=typeof t||t<0||t>4294967295||l(t)!==t)throw new a("`length` must be a positive 32-bit integer");var n=arguments.length>2&&!!arguments[2],r=!0,u=!0;if("length"in e&&s){var c=s(e,"length");c&&!c.configurable&&(r=!1),c&&!c.writable&&(u=!1)}return(r||u||!n)&&(o?i(e,"length",t,!0,!0):i(e,"length",t)),e}},1135(e){e.exports=function(e){return e&&"object"==typeof e&&"function"==typeof e.copy&&"function"==typeof e.fill&&"function"==typeof e.readUInt8}},9032(e,t,n){"use strict";var r=n(7244),i=n(8184),o=n(5767),s=n(5680);function a(e){return e.call.bind(e)}var l="undefined"!=typeof BigInt,u="undefined"!=typeof Symbol,c=a(Object.prototype.toString),_=a(Number.prototype.valueOf),f=a(String.prototype.valueOf),p=a(Boolean.prototype.valueOf);if(l)var d=a(BigInt.prototype.valueOf);if(u)var h=a(Symbol.prototype.valueOf);function g(e,t){if("object"!=typeof e)return!1;try{return t(e),!0}catch(e){return!1}}function m(e){return"[object Map]"===c(e)}function y(e){return"[object Set]"===c(e)}function b(e){return"[object WeakMap]"===c(e)}function w(e){return"[object WeakSet]"===c(e)}function x(e){return"[object ArrayBuffer]"===c(e)}function v(e){return"undefined"!=typeof ArrayBuffer&&(x.working?x(e):e instanceof ArrayBuffer)}function E(e){return"[object DataView]"===c(e)}function R(e){return"undefined"!=typeof DataView&&(E.working?E(e):e instanceof DataView)}t.isArgumentsObject=r,t.isGeneratorFunction=i,t.isTypedArray=s,t.isPromise=function(e){return"undefined"!=typeof Promise&&e instanceof Promise||null!==e&&"object"==typeof e&&"function"==typeof e.then&&"function"==typeof e.catch},t.isArrayBufferView=function(e){return"undefined"!=typeof ArrayBuffer&&ArrayBuffer.isView?ArrayBuffer.isView(e):s(e)||R(e)},t.isUint8Array=function(e){return"Uint8Array"===o(e)},t.isUint8ClampedArray=function(e){return"Uint8ClampedArray"===o(e)},t.isUint16Array=function(e){return"Uint16Array"===o(e)},t.isUint32Array=function(e){return"Uint32Array"===o(e)},t.isInt8Array=function(e){return"Int8Array"===o(e)},t.isInt16Array=function(e){return"Int16Array"===o(e)},t.isInt32Array=function(e){return"Int32Array"===o(e)},t.isFloat32Array=function(e){return"Float32Array"===o(e)},t.isFloat64Array=function(e){return"Float64Array"===o(e)},t.isBigInt64Array=function(e){return"BigInt64Array"===o(e)},t.isBigUint64Array=function(e){return"BigUint64Array"===o(e)},m.working="undefined"!=typeof Map&&m(new Map),t.isMap=function(e){return"undefined"!=typeof Map&&(m.working?m(e):e instanceof Map)},y.working="undefined"!=typeof Set&&y(new Set),t.isSet=function(e){return"undefined"!=typeof Set&&(y.working?y(e):e instanceof Set)},b.working="undefined"!=typeof WeakMap&&b(new WeakMap),t.isWeakMap=function(e){return"undefined"!=typeof WeakMap&&(b.working?b(e):e instanceof WeakMap)},w.working="undefined"!=typeof WeakSet&&w(new WeakSet),t.isWeakSet=function(e){return w(e)},x.working="undefined"!=typeof ArrayBuffer&&x(new ArrayBuffer),t.isArrayBuffer=v,E.working="undefined"!=typeof ArrayBuffer&&"undefined"!=typeof DataView&&E(new DataView(new ArrayBuffer(1),0,1)),t.isDataView=R;var S="undefined"!=typeof SharedArrayBuffer?SharedArrayBuffer:void 0;function A(e){return"[object SharedArrayBuffer]"===c(e)}function O(e){return void 0!==S&&(void 0===A.working&&(A.working=A(new S)),A.working?A(e):e instanceof S)}function k(e){return g(e,_)}function T(e){return g(e,f)}function q(e){return g(e,p)}function P(e){return l&&g(e,d)}function I(e){return u&&g(e,h)}t.isSharedArrayBuffer=O,t.isAsyncFunction=function(e){return"[object AsyncFunction]"===c(e)},t.isMapIterator=function(e){return"[object Map Iterator]"===c(e)},t.isSetIterator=function(e){return"[object Set Iterator]"===c(e)},t.isGeneratorObject=function(e){return"[object Generator]"===c(e)},t.isWebAssemblyCompiledModule=function(e){return"[object WebAssembly.Module]"===c(e)},t.isNumberObject=k,t.isStringObject=T,t.isBooleanObject=q,t.isBigIntObject=P,t.isSymbolObject=I,t.isBoxedPrimitive=function(e){return k(e)||T(e)||q(e)||P(e)||I(e)},t.isAnyArrayBuffer=function(e){return"undefined"!=typeof Uint8Array&&(v(e)||O(e))},["isProxy","isExternal","isModuleNamespaceObject"].forEach(function(e){Object.defineProperty(t,e,{enumerable:!1,value:function(){throw new Error(e+" is not supported in userland")}})})},537(e,t,n){var r=n(5606),i=Object.getOwnPropertyDescriptors||function(e){for(var t=Object.keys(e),n={},r=0;r<t.length;r++)n[t[r]]=Object.getOwnPropertyDescriptor(e,t[r]);return n},o=/%[sdj%]/g;t.format=function(e){if(!b(e)){for(var t=[],n=0;n<arguments.length;n++)t.push(u(arguments[n]));return t.join(" ")}n=1;for(var r=arguments,i=r.length,s=String(e).replace(o,function(e){if("%%"===e)return"%";if(n>=i)return e;switch(e){case"%s":return String(r[n++]);case"%d":return Number(r[n++]);case"%j":try{return JSON.stringify(r[n++])}catch(e){return"[Circular]"}default:return e}}),a=r[n];n<i;a=r[++n])m(a)||!v(a)?s+=" "+a:s+=" "+u(a);return s},t.deprecate=function(e,n){if(void 0!==r&&!0===r.noDeprecation)return e;if(void 0===r)return function(){return t.deprecate(e,n).apply(this,arguments)};var i=!1;return function(){if(!i){if(r.throwDeprecation)throw new Error(n);r.traceDeprecation?console.trace(n):console.error(n),i=!0}return e.apply(this,arguments)}};var s={},a=/^$/;if(r.env.NODE_DEBUG){var l=r.env.NODE_DEBUG;l=l.replace(/[|\\{}()[\]^$+?.]/g,"\\$&").replace(/\*/g,".*").replace(/,/g,"$|^").toUpperCase(),a=new RegExp("^"+l+"$","i")}function u(e,n){var r={seen:[],stylize:_};return arguments.length>=3&&(r.depth=arguments[2]),arguments.length>=4&&(r.colors=arguments[3]),g(n)?r.showHidden=n:n&&t._extend(r,n),w(r.showHidden)&&(r.showHidden=!1),w(r.depth)&&(r.depth=2),w(r.colors)&&(r.colors=!1),w(r.customInspect)&&(r.customInspect=!0),r.colors&&(r.stylize=c),f(r,e,r.depth)}function c(e,t){var n=u.styles[t];return n?"["+u.colors[n][0]+"m"+e+"["+u.colors[n][1]+"m":e}function _(e,t){return e}function f(e,n,r){if(e.customInspect&&n&&S(n.inspect)&&n.inspect!==t.inspect&&(!n.constructor||n.constructor.prototype!==n)){var i=n.inspect(r,e);return b(i)||(i=f(e,i,r)),i}var o=function(e,t){if(w(t))return e.stylize("undefined","undefined");if(b(t)){var n="'"+JSON.stringify(t).replace(/^"|"$/g,"").replace(/'/g,"\\'").replace(/\\"/g,'"')+"'";return e.stylize(n,"string")}return y(t)?e.stylize(""+t,"number"):g(t)?e.stylize(""+t,"boolean"):m(t)?e.stylize("null","null"):void 0}(e,n);if(o)return o;var s=Object.keys(n),a=function(e){var t={};return e.forEach(function(e,n){t[e]=!0}),t}(s);if(e.showHidden&&(s=Object.getOwnPropertyNames(n)),R(n)&&(s.indexOf("message")>=0||s.indexOf("description")>=0))return p(n);if(0===s.length){if(S(n)){var l=n.name?": "+n.name:"";return e.stylize("[Function"+l+"]","special")}if(x(n))return e.stylize(RegExp.prototype.toString.call(n),"regexp");if(E(n))return e.stylize(Date.prototype.toString.call(n),"date");if(R(n))return p(n)}var u,c="",_=!1,v=["{","}"];return h(n)&&(_=!0,v=["[","]"]),S(n)&&(c=" [Function"+(n.name?": "+n.name:"")+"]"),x(n)&&(c=" "+RegExp.prototype.toString.call(n)),E(n)&&(c=" "+Date.prototype.toUTCString.call(n)),R(n)&&(c=" "+p(n)),0!==s.length||_&&0!=n.length?r<0?x(n)?e.stylize(RegExp.prototype.toString.call(n),"regexp"):e.stylize("[Object]","special"):(e.seen.push(n),u=_?function(e,t,n,r,i){for(var o=[],s=0,a=t.length;s<a;++s)T(t,String(s))?o.push(d(e,t,n,r,String(s),!0)):o.push("");return i.forEach(function(i){i.match(/^\d+$/)||o.push(d(e,t,n,r,i,!0))}),o}(e,n,r,a,s):s.map(function(t){return d(e,n,r,a,t,_)}),e.seen.pop(),function(e,t,n){return e.reduce(function(e,t){return t.indexOf("\n"),e+t.replace(/\u001b\[\d\d?m/g,"").length+1},0)>60?n[0]+(""===t?"":t+"\n ")+" "+e.join(",\n  ")+" "+n[1]:n[0]+t+" "+e.join(", ")+" "+n[1]}(u,c,v)):v[0]+c+v[1]}function p(e){return"["+Error.prototype.toString.call(e)+"]"}function d(e,t,n,r,i,o){var s,a,l;if((l=Object.getOwnPropertyDescriptor(t,i)||{value:t[i]}).get?a=l.set?e.stylize("[Getter/Setter]","special"):e.stylize("[Getter]","special"):l.set&&(a=e.stylize("[Setter]","special")),T(r,i)||(s="["+i+"]"),a||(e.seen.indexOf(l.value)<0?(a=m(n)?f(e,l.value,null):f(e,l.value,n-1)).indexOf("\n")>-1&&(a=o?a.split("\n").map(function(e){return"  "+e}).join("\n").slice(2):"\n"+a.split("\n").map(function(e){return"   "+e}).join("\n")):a=e.stylize("[Circular]","special")),w(s)){if(o&&i.match(/^\d+$/))return a;(s=JSON.stringify(""+i)).match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)?(s=s.slice(1,-1),s=e.stylize(s,"name")):(s=s.replace(/'/g,"\\'").replace(/\\"/g,'"').replace(/(^"|"$)/g,"'"),s=e.stylize(s,"string"))}return s+": "+a}function h(e){return Array.isArray(e)}function g(e){return"boolean"==typeof e}function m(e){return null===e}function y(e){return"number"==typeof e}function b(e){return"string"==typeof e}function w(e){return void 0===e}function x(e){return v(e)&&"[object RegExp]"===A(e)}function v(e){return"object"==typeof e&&null!==e}function E(e){return v(e)&&"[object Date]"===A(e)}function R(e){return v(e)&&("[object Error]"===A(e)||e instanceof Error)}function S(e){return"function"==typeof e}function A(e){return Object.prototype.toString.call(e)}function O(e){return e<10?"0"+e.toString(10):e.toString(10)}t.debuglog=function(e){if(e=e.toUpperCase(),!s[e])if(a.test(e)){var n=r.pid;s[e]=function(){var r=t.format.apply(t,arguments);console.error("%s %d: %s",e,n,r)}}else s[e]=function(){};return s[e]},t.inspect=u,u.colors={bold:[1,22],italic:[3,23],underline:[4,24],inverse:[7,27],white:[37,39],grey:[90,39],black:[30,39],blue:[34,39],cyan:[36,39],green:[32,39],magenta:[35,39],red:[31,39],yellow:[33,39]},u.styles={special:"cyan",number:"yellow",boolean:"yellow",undefined:"grey",null:"bold",string:"green",date:"magenta",regexp:"red"},t.types=n(9032),t.isArray=h,t.isBoolean=g,t.isNull=m,t.isNullOrUndefined=function(e){return null==e},t.isNumber=y,t.isString=b,t.isSymbol=function(e){return"symbol"==typeof e},t.isUndefined=w,t.isRegExp=x,t.types.isRegExp=x,t.isObject=v,t.isDate=E,t.types.isDate=E,t.isError=R,t.types.isNativeError=R,t.isFunction=S,t.isPrimitive=function(e){return null===e||"boolean"==typeof e||"number"==typeof e||"string"==typeof e||"symbol"==typeof e||void 0===e},t.isBuffer=n(1135);var k=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];function T(e,t){return Object.prototype.hasOwnProperty.call(e,t)}t.log=function(){var e,n;console.log("%s - %s",(n=[O((e=new Date).getHours()),O(e.getMinutes()),O(e.getSeconds())].join(":"),[e.getDate(),k[e.getMonth()],n].join(" ")),t.format.apply(t,arguments))},t.inherits=n(6698),t._extend=function(e,t){if(!t||!v(t))return e;for(var n=Object.keys(t),r=n.length;r--;)e[n[r]]=t[n[r]];return e};var q="undefined"!=typeof Symbol?Symbol("util.promisify.custom"):void 0;function P(e,t){if(!e){var n=new Error("Promise was rejected with a falsy value");n.reason=e,e=n}return t(e)}t.promisify=function(e){if("function"!=typeof e)throw new TypeError('The "original" argument must be of type Function');if(q&&e[q]){var t;if("function"!=typeof(t=e[q]))throw new TypeError('The "util.promisify.custom" argument must be of type Function');return Object.defineProperty(t,q,{value:t,enumerable:!1,writable:!1,configurable:!0}),t}function t(){for(var t,n,r=new Promise(function(e,r){t=e,n=r}),i=[],o=0;o<arguments.length;o++)i.push(arguments[o]);i.push(function(e,r){e?n(e):t(r)});try{e.apply(this,i)}catch(e){n(e)}return r}return Object.setPrototypeOf(t,Object.getPrototypeOf(e)),q&&Object.defineProperty(t,q,{value:t,enumerable:!1,writable:!1,configurable:!0}),Object.defineProperties(t,i(e))},t.promisify.custom=q,t.callbackify=function(e){if("function"!=typeof e)throw new TypeError('The "original" argument must be of type Function');function t(){for(var t=[],n=0;n<arguments.length;n++)t.push(arguments[n]);var i=t.pop();if("function"!=typeof i)throw new TypeError("The last argument must be of type Function");var o=this,s=function(){return i.apply(o,arguments)};e.apply(this,t).then(function(e){r.nextTick(s.bind(null,null,e))},function(e){r.nextTick(P.bind(null,e,s))})}return Object.setPrototypeOf(t,Object.getPrototypeOf(e)),Object.defineProperties(t,i(e)),t}},5767(e,t,n){"use strict";var r=n(2682),i=n(9209),o=n(487),s=n(6556),a=n(5795),l=n(3628),u=s("Object.prototype.toString"),c=n(9092)(),_="undefined"==typeof globalThis?n.g:globalThis,f=i(),p=s("String.prototype.slice"),d=s("Array.prototype.indexOf",!0)||function(e,t){for(var n=0;n<e.length;n+=1)if(e[n]===t)return n;return-1},h={__proto__:null};r(f,c&&a&&l?function(e){var t=new _[e];if(Symbol.toStringTag in t&&l){var n=l(t),r=a(n,Symbol.toStringTag);if(!r&&n){var i=l(n);r=a(i,Symbol.toStringTag)}if(r&&r.get){var s=o(r.get);h["$"+e]=s}}}:function(e){var t=new _[e],n=t.slice||t.set;if(n){var r=o(n);h["$"+e]=r}}),e.exports=function(e){if(!e||"object"!=typeof e)return!1;if(!c){var t=p(u(e),8,-1);return d(f,t)>-1?t:"Object"===t&&function(e){var t=!1;return r(h,function(n,r){if(!t)try{n(e),t=p(r,1)}catch(e){}}),t}(e)}return a?function(e){var t=!1;return r(h,function(n,r){if(!t)try{"$"+n(e)===r&&(t=p(r,1))}catch(e){}}),t}(e):null}},785(e,t,n){var r=n(5606);const i=n(2196),o=n(9175),s=n(7507),a=n(9022),l=n(6945),u=n(4285),c=n(3568),_=n(3222),f=/^([0-9]+)(\.[0-9]+)?$/,p="quoted_rfc",d="quoted";class h extends Error{}function g(e,t=null){if(!e)throw t||(t="Assertion error"),new h(t)}function m(e){return/^[\x00-\x7F]*$/.test(e)}class y{constructor(e){this.enable_double_width_alignment=e,this.can_be_numeric=!0,this.max_total_length=0,this.max_int_length=0,this.max_fractional_length=0,this.only_ascii=!!e||null,this.has_wide_chars=!e&&null}mark_non_numeric(){this.can_be_numeric=!1,this.max_int_length=0,this.max_fractional_length=0}is_numeric(){return this.max_int_length>0}reconcile(e){this.max_total_length=Math.max(this.max_total_length,e.max_total_length),this.enable_double_width_alignment&&(g(e.enable_double_width_alignment,"Unable to reconcile"),this.only_ascii=this.only_ascii&&e.only_ascii,this.has_wide_chars=this.has_wide_chars||e.has_wide_chars),e.can_be_numeric||this.mark_non_numeric(),this.can_be_numeric&&(this.max_int_length=Math.max(this.max_int_length,e.max_int_length),this.max_fractional_length=Math.max(this.max_fractional_length,e.max_fractional_length))}get_adjusted_total_length(){return Math.max(this.max_total_length,this.max_int_length+this.max_fractional_length)}get_adjusted_int_length(){return Math.max(this.max_int_length,this.max_total_length-this.max_fractional_length)}update_from_field(e,t){e.length>1&&this.mark_non_numeric();for(let n of e){if(this.max_total_length=Math.max(this.max_total_length,n.length),this.enable_double_width_alignment){this.only_ascii=this.only_ascii&&m(n);let e=this.only_ascii?n.length:_(n);this.has_wide_chars=this.has_wide_chars||e!=n.length,this.max_total_length=Math.max(this.max_total_length,e)}if(!this.can_be_numeric)continue;let e=f.exec(n);if(null===e){!t&&n.length&&this.mark_non_numeric();continue}let r=e[1].length;this.max_int_length=Math.max(this.max_int_length,r);let i=void 0===e[2]?0:e[2].length;this.max_fractional_length=Math.max(this.max_fractional_length,i)}}evaluate_align_field(e,t,n,r,i){let o=this.has_wide_chars?_(e):e.length,s=n?0:i;if(!this.is_numeric()){let e=Math.max(this.max_total_length-o,0);return[s,r?0:e]}if(t&&null===f.exec(e)){let e=Math.max(this.get_adjusted_total_length()-o,0);return[s,r?0:e]}let a=e.indexOf("."),l=-1==a?e.length:a,u=-1==a?0:e.length-a,c=Math.max(this.get_adjusted_int_length()-l,0),p=Math.max(this.max_fractional_length-u);return[c+s,r?0:p]}}function b(e,t,n,r){for(let i=0;i<e.length;i++)n.length<=i&&n.push(new y(r)),n[i].update_from_field(e[i],t)}function w(e){let t=[];for(let n=0;n<e.length;n++){let r=e[n].split("\n");r=r.map(e=>e.trim()),t.push(r)}return t}function x(e,t,n=1){let r=[];if(!e.length)return r;r.push(0);for(let i=1;i<e.length;i++){let o=e[i-1].get_adjusted_total_length(),s=r[i-1];r.push(s+o+t+n)}return g(r.length==e.length),r}function v(e,t,n,r,i,o,s,a=1){let[l,u]=n.evaluate_align_field(e,t,o,s,a);return i&&(l+=r),[l,u]}function E(e,t,n,r,i,o,s){let[a,l]=v(e,t,n,r,i,o,s);return" ".repeat(a)+e+" ".repeat(l)}function R(e){if(!e.length)return[];let t=[];for(let n=0;n<e.length;n++)for(let r=0;r<e[n].length;r++)t.length<=r&&t.push(0),t[r]=Math.max(t[r],e[n][r].length);return t}class S{constructor(e,t){this.records=e,this.comments=t,this.nr=0,this.next_comment=0}get_next(){if(this.has_comments_left()&&(!this.has_records_left()||this.comments[this.next_comment].record_num<=this.nr)){let e=[null,this.comments[this.next_comment].comment_text];return this.next_comment+=1,e}if(this.has_records_left()){let e=[this.records[this.nr],null];return this.nr+=1,e}return[null,null]}has_comments_left(){return this.next_comment<this.comments.length}has_records_left(){return this.nr<this.records.length}has_entries_left(){return this.has_comments_left()||this.has_records_left()}}function A(e){return"rbql_table_name:"+e}function O(e,t,n){var r,a="~"===(r=n).charAt(0)?s.join(i.homedir(),r.slice(1)):r;if(o.existsSync(a))return a;if(t&&!s.isAbsolute(a)&&(a=s.join(t,a),o.existsSync(a)))return a;let l=e?e.get(A(n)):null;return l&&o.existsSync(l)?l:null}class k extends Error{}class T extends a.RBQLInputIterator{constructor(e,t,n,r=!1,i=null,o="input",s="a",a=!1){super(),this.has_header=r,this.table_name=o,this.variable_prefix=s,this.NR=0,this.NL=0;let l="quoted_rfc"==n,[u,_]=[null,null];if([this.records,u,this.fields_info,this.first_defective_line,this._first_trailing_space_line,_]=c.parse_document_records(e,t,n,i,l,-1,!0,!1,!1,-1,a),l&&null!==this.first_defective_line)throw new k(`Inconsistent double quote escaping in ${this.table_name} table at record ${this.records.length}, line ${this.first_defective_line+1}`);this.first_record=this.records.length?this.records[0]:[],this.next_record_index=0}stop(){}async get_variables_map(e){let t=new Object;return a.parse_basic_variables(e,this.variable_prefix,t),a.parse_array_variables(e,this.variable_prefix,t),this.has_header&&(a.parse_attribute_variables(e,this.variable_prefix,this.first_record,"CSV header line",t),a.parse_dictionary_variables(e,this.variable_prefix,this.first_record,t)),t}async get_header(){return this.has_header?this.first_record:null}do_get_record(){if(this.next_record_index>=this.records.length)return null;let e=this.records[this.next_record_index];return this.next_record_index+=1,e}async get_record(){return 0==this.NR&&this.has_header&&this.do_get_record(),this.NR+=1,this.do_get_record()}get_warnings(){let e=[];return null!==this.first_defective_line&&e.push(`Inconsistent double quote escaping in ${this.table_name} table. E.g. at line ${this.first_defective_line+1}`),this.fields_info.size>1&&e.push(function(e,t){let[n,r,i,o]=a.sample_first_two_inconsistent_records(t),s=`Number of fields in "${e}" table is not consistent: `;return s+=`e.g. record ${n+1} -> ${r} fields, record ${i+1} -> ${o} fields`,s}(this.table_name,this.fields_info)),e}}class q extends a.RBQLOutputWriter{constructor(e,t){if(super(),this.delim=e,this.policy=t,this.header_len=null,this.null_in_output=!1,this.delim_in_simple_output=!1,this.output_lines=[],"simple"==t)this.polymorphic_join=this.simple_join;else if("quoted"==t)this.polymorphic_join=this.quoted_join;else if("quoted_rfc"==t)this.polymorphic_join=this.quoted_join_rfc;else if("monocolumn"==t)this.polymorphic_join=this.mono_join;else{if("whitespace"!=t)throw new k("Unknown output csv policy");this.polymorphic_join=this.simple_join}}set_header(e){null!==e&&(this.header_len=e.length,this.write(e))}quoted_join(e){let t=this.delim;return e.map(function(e){return u.quote_field(String(e),t)}).join(this.delim)}quoted_join_rfc(e){let t=this.delim;return e.map(function(e){return u.rfc_quote_field(String(e),t)}).join(this.delim)}mono_join(e){if(e.length>1)throw new k('Unable to use "Monocolumn" output format: some records have more than one field');return e[0]}simple_join(e){var t=e.join(this.delim);return-1!=e.join("").indexOf(this.delim)&&(this.delim_in_simple_output=!0),t}normalize_fields(e){for(var t=0;t<e.length;t++)null==e[t]?(this.null_in_output=!0,e[t]=""):Array.isArray(e[t])&&(this.normalize_fields(e[t]),e[t]=e[t].join(this.sub_array_delim))}write(e){if(null!==this.header_len&&e.length!=this.header_len)throw new k(`Inconsistent number of columns in output header and the current record: ${this.header_len} != ${e.length}`);return this.normalize_fields(e),this.output_lines.push(this.polymorphic_join(e)),!0}async finish(){}get_warnings(){let e=[];return this.null_in_output&&e.push("null values in output were replaced by empty strings"),this.delim_in_simple_output&&e.push("Some output fields contain separator"),e}}class P{constructor(){}get_iterator_by_table_id(e){throw new k("JOIN queries are currently not supported in vscode.dev web version.")}get_warnings(){return[]}}class I extends a.RBQLTableRegistry{constructor(e,t,n,r,i,o=!1,s=null,a=null){super(),this.vscode_global_state=e,this.input_file_dir=t,this.delim=n,this.policy=r,this.encoding=i,this.has_header=o,this.comment_prefix=s,this.stream=null,this.record_iterator=null,this.options=a,this.bulk_input_path=null,this.table_path=null}get_iterator_by_table_id(e){if(this.table_path=O(this.vscode_global_state,this.input_file_dir,e),null===this.table_path)throw new k(`Unable to find join table "${e}"`);return this.options&&this.options.bulk_read?this.bulk_input_path=this.table_path:this.stream=o.createReadStream(this.table_path),this.record_iterator=new l.CSVRecordIterator(this.stream,this.bulk_input_path,this.encoding,this.delim,this.policy,this.has_header,this.comment_prefix,e,"b"),this.record_iterator}get_warnings(e){this.record_iterator&&this.has_header&&e.push(`The first record in JOIN file ${s.basename(this.table_path)} was also treated as header (and skipped)`)}}function j(e,t,n,r,i,o,s){let a=[],l=[],u=o,c=0,_=0;for(let o=0;o<i.length;o++){let s=0,f=[],p=[];for(;;){let t=i[o].indexOf(r,s);if(-1==t)break;p.push(i[o].substring(s,t)),f.push(new e.Range(u,c,u,c+t-s)),u+=1,c=0,_=0,s=t+r.length}_+=i[o].length-s;let d=_;o+1<i.length&&(_+=t,n&&(d=_)),p.push(i[o].substring(s)),f.push(new e.Range(u,c,u,d)),l.push(p),a.push(f),c=_}return u!=s?null:new C(a,l,null)}function N(e,t){let[n,r]=u.split_quoted_str(e+'x"',t);return!r}class C{constructor(e,t,n){this.record_ranges=e,this.record_fields=t,this.comment_range=n}}function M(e,t,n,r){let i=Math.max(0,n.start.line-r),o=Math.min(t.lineCount-1,n.end.line+r);return new e.Range(i,n.start.character,o,n.end.character)}function L(e,t,n,r,i,o){let s=Math.max(0,o.start.line),a=Math.min(t.lineCount,o.end.line+1),l=[],c=null,_=new u.MultilineRecordAggregator(i);for(let i=s;i<a;i++){let o=t.lineAt(i).text;if(i+1==t.lineCount&&!o)break;let s=_.is_inside_multiline_record(),a=i-_.get_num_lines_in_record();_.add_line(o);let f=_.is_inside_multiline_record();if(!s&&f&&(N(o,n)||(l=[],_.reset())),_.has_comment_line){let t=new e.Range(i,0,i,o.length);l.push(new C(null,null,t)),_.reset()}else if(_.has_full_record){const t="\r\n";let o=_.get_full_line(t);_.reset();let[s,f]=u.smart_split(o,n,d,!0);if(f)null===c&&(c=i);else{let o=j(e,n.length,r,t,s,a,i);null!==o&&l.push(o)}}}return[l,c]}function U(e,t,n,r,i,o,s){let a=[],l=Math.max(0,s.start.line),c=Math.min(t.lineCount,s.end.line+1),_=null;for(let s=l;s<c;s++){let l=[],c=[],f=t.lineAt(s).text;if(s+1==t.lineCount&&!f)break;if(o&&f.startsWith(o)){let t=new e.Range(s,0,s,f.length);a.push(new C(null,null,t));continue}let[p,d]=u.smart_split(f,n,i,!0);if(d){null===_&&(_=s);continue}let h=0,g=0;for(let t=0;t<p.length;t++){g+=p[t].length;let i=g;t+1<p.length&&(g+=n.length,r&&(i=g)),c.push([p[t]]),l.push([new e.Range(s,h,s,i)]),h=g}a.push(new C(l,c,null))}return[a,_]}function $(e,t,n){if(!e.length)return null;for(var r=0,i=e[r].length+t;n>i&&r+1<e.length;)i=i+e[r+=1].length+t;return r}e.exports.make_table_name_key=A,e.exports.find_table_path=O,e.exports.read_header=async function(e,t){"latin-1"==t&&(t="binary");let r=n(7560).createInterface({input:o.createReadStream(e,{encoding:t})}),i=!1,s=null,a=null,l=new Promise(function(e,t){s=e,a=t});return r.on("line",e=>{i||(i=!0,r.close(),s(e))}),r.on("error",e=>{a(e)}),l},e.exports.rbql_query_web=async function(e,t,n,r,i,o,s,l,u=null,c=!1){let _=new P,f=new T(t,n,r,l,u,"input","a",c),p=new q(i,o);return await a.query(e,f,p,s,_,""),p.output_lines},e.exports.rbql_query_node=async function(e,t,n,u,c,_,f,p,d,h,g,m,y,b){let w=null,x=null;b.bulk_read&&n?x=n:w=null===n?r.stdin:o.createReadStream(n);let[v,E]=null===_?[r.stdout,!1]:[o.createWriteStream(_),!0];if('"'==u&&"quoted"==c)throw new k('Double quote delimiter is incompatible with "quoted" policy');if("latin-1"==d&&(d="binary"),!l.is_ascii(t)&&"binary"==d)throw new k("To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary");if(!(l.is_ascii(u)&&l.is_ascii(f)||"binary"!=d))throw new k("To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary");let R=s.join(i.homedir(),".rbql_init_source.js");""==y&&o.existsSync(R)&&(y=l.read_user_init_code(R));let S=n?s.dirname(n):null,A=new I(e,S,u,c,d,g,m,b),O=new l.CSVRecordIterator(w,x,d,u,c,g,m,"input","a",b.trim_whitespaces),T=new l.CSVWriter(v,E,d,f,p);await a.query(t,O,T,h,A,y),A.get_warnings(h)},e.exports.get_header_line=function(e,t){const n=e.lineCount;for(let r=0;r<n;++r){const n=e.lineAt(r).text;if(!t||!n.startsWith(t))return[r,n]}return[null,null]},e.exports.get_default_js_udf_content=function(){return"// This file can be used to store RBQL UDFs. Example:\n    //\n    // function foo(value) {\n    //     return 'foo ' + String(value.length);\n    // }\n    //\n    // Functions defined in this file can be used in RBQL queries e.g.\n    // SELECT foo(a1), a2 WHERE foo(a3) != 'foo 5' LIMIT 10\n    //\n    // Don't forget to save this file after editing!\n    //\n    // Write your own functions below this line:\n    ".replace(new RegExp(/^  */,"mg"),"")},e.exports.get_default_python_udf_content=function(){return"# This file can be used to store RBQL UDFs. Example:\n    #\n    # def foo(value):\n    #     return 'foo ' + str(len(value))\n    #\n    #\n    # Functions defined in this file can be used in RBQL queries e.g.\n    # SELECT foo(a1), a2 WHERE foo(a3) != 'foo 5' LIMIT 10\n    #\n    # Don't forget to save this file after editing!\n    #\n    # Write your own functions below this line:\n    ".replace(new RegExp(/^  */,"mg"),"")},e.exports.align_columns=function(e,t,n,r){let i=x(n,r.length),o=[],s=!0,a=new S(e,t);for(;a.has_entries_left();){let[e,t]=a.get_next();if(g(null===t!=(null===e)),null===e){o.push(t);continue}let l=[],u=w(e);for(let e=0;e<u.length&&!(e>=n.length);e++){let t=e+1==u.length,a=u[e];for(let u=0;u<a.length;u++){let c=u>0;c&&(o.push(l.join(r)),l=[]);let _=t||u+1<a.length,f=0==e||c,p=E(a[u],s,n[e],i[e],c,f,_);l.push(p)}}s=!1,o.push(l.join(r))}return o},e.exports.shrink_columns=function(e,t,n,r){let[i,o,s,a,l,u]=c.parse_document_records(e,t,n,r,!0,-1,!0,!0);if(null!==a)return[null,a];let _=[],f=!1,p=new S(i,u);for(;p.has_entries_left();){let[e,n]=p.get_next();if(g(null===n!=(null===e)),null===e){_.push(n);continue}let r=[];for(let n=0;n<e.length;n++){let i=e[n].split("\n");for(let e=0;e<i.length;e++){e>0&&(_.push(r.join(t)),r=[]);let n=i[e].trim();n.length!=i[e].length&&(f=!0),r.push(n)}}_.push(r.join(t))}return f?[_.join("\n"),null]:[null,null]},e.exports.calculate_column_offsets=x,e.exports.calc_column_stats=function(e,t,n,r,i){let[o,s,a,l,u,_]=c.parse_document_records(e,t,n,r,!0,-1,!0,!0);if(null!==l)return[null,l,null,null];let f=[],p=!0;for(let e of o)b(w(e),p,f,i),p=!1;return[f,null,o,_]},e.exports.calc_column_stats_for_fragment=function(e,t,n){let r=[];for(let i of e){if(null!==i.comment_range)continue;let e=i.record_ranges.length&&i.record_ranges[0].length&&i.record_ranges[0][0].start.line==t;b(i.record_fields,e,r,n)}return r},e.exports.reconcile_whole_doc_and_local_column_stats=function(e,t){let n=Math.max(e.length,t.length);for(let r=0;r<n&&!(r>=e.length);r++)r>=t.length?t.push(e[r]):t[r].reconcile(e[r])},e.exports.rfc_align_field=E,e.exports.evaluate_rfc_align_field=v,e.exports.assert=g,e.exports.get_field_by_line_position=$,e.exports.get_cursor_position_info=function(e,t,n,r,i,o){return null===r?null:r==p?function(e,t,n,r,i){let o=new e.Range(i.line,0,i.line,0);o=M(e,t,o,20);let s=L(e,t,n,!0,r,o)[0],a=null;for(let e of s)if(null!==e.comment_range)e.comment_range.contains(i)&&(a={is_comment:!0});else for(let t=0;t<e.record_ranges.length;t++)for(let n of e.record_ranges[t])n.contains(i)&&(a={column_number:t,total_columns:e.record_ranges.length,split_warning:!1});return a}(e,t,n,i,o):function(e,t,n,r,i){var o=i.line,s=i.character,a=e.lineAt(o).text;if(r&&a.startsWith(r))return{is_comment:!0};let[l,c]=u.smart_split(a,t,n,!0);var _=$(l,t.length,s+1);return null==_?null:{column_number:_,total_columns:l.length,split_warning:c}}(t,n,r,i,o)},e.exports.format_cursor_position_info=function(e,t,n,r,i){if(e.is_comment)return r?["Comment","Comment"]:[null,null];let o="Col "+(e.column_number+1),s="[Rainbow CSV] "+o;if(n&&e.column_number<t.length){let n=t[e.column_number].trim(),r=n.substr(0,i);r!=n&&(r+="..."),o+=": "+r,s+=": "+n}return e.split_warning?s+="; ERR: Inconsistent double quotes in line":t.length!=e.total_columns&&(s+=`; WARN: Inconsistent num of fields, header: ${t.length}, this line: ${e.total_columns}`),[s,o]},e.exports.parse_document_range=function(e,t,n,r,i,o,s){return i==p?L(e,t,n,r,o,s):U(e,t,n,r,i,o,s)},e.exports.parse_document_range_single_line=U,e.exports.parse_document_range_rfc=L,e.exports.sample_preview_records_from_context=function(e,t,n,r){let[i,o,s,a]=[e.input_document,e.delim,e.policy,e.comment_prefix];e.requested_start_record=Math.max(e.requested_start_record,0);let l=s==p,[u,_]=function(e,t,n,r,i,o,s,a){let l=[],u=null,_=null,[f,p,d,h]=[null,null,null,null];if(i<5*o)[l,f,p,u,d,h]=c.parse_document_records(e,t,n,r,s,i,!0,!1);else{let i=!0;if(a.has(e.fileName)&&([l,u,_]=a.get(e.fileName),e.version===_&&(i=!1)),i){let[i,o,l,u,_,f]=c.parse_document_records(e,t,n,r,s,-1,!0,!1);a.set(e.fileName,[i,u,e.version])}[l,u,_]=a.get(e.fileName)}return[l,u]}(i,o,s,a,e.requested_start_record+n,n,l,r);if(null!==_&&s==p)return void(t.preview_sampling_error=`Double quotes are not consistent in record ${u.length+1} which starts at line ${_+1}`);e.requested_start_record=Math.max(0,Math.min(e.requested_start_record,u.length-n));let f=u.slice(e.requested_start_record,e.requested_start_record+n);for(let e=0;e<f.length;e++){let t=f[e];for(let e=0;e<t.length;e++)t[e].length>250&&(t[e]=t[e].substr(0,250)+"###UI_STRING_TRIM_MARKER###")}t.preview_records=f,t.actual_start_record=e.requested_start_record},e.exports.sample_first_two_inconsistent_records=a.sample_first_two_inconsistent_records,e.exports.is_opening_rfc_line=N,e.exports.show_lint_status_bar_button=function(e,t,n,r){const i="#f44242";let o=`${n}.${r}`;if(!t.lint_results.has(o))return;var s=t.lint_results.get(o);t.lint_status_bar_button||(t.lint_status_bar_button=e.window.createStatusBarItem(e.StatusBarAlignment.Left)),t.lint_status_bar_button.text="CSVLint";let l="";if(s.is_processing)t.lint_status_bar_button.color="#A0A0A0",t.lint_status_bar_button.text="$(clock) CSVLint",l="Processing";else if(Number.isInteger(s.first_defective_line))l=`Error. Line ${s.first_defective_line+1} has formatting error: double quote chars are not consistent`,t.lint_status_bar_button.color=i,t.lint_status_bar_button.text="$(error) CSVLint";else if(s.fields_info&&s.fields_info.size>1){let[e,n,r,o]=a.sample_first_two_inconsistent_records(s.fields_info);l=`Error. Number of fields is not consistent: e.g. record ${e+1} has ${n} fields, and record ${r+1} has ${o} fields`,t.lint_status_bar_button.color=i,t.lint_status_bar_button.text="$(error) CSVLint"}else Number.isInteger(s.first_trailing_space_line)?(l=`Leading/Trailing spaces detected: e.g. at line ${s.first_trailing_space_line+1}. Run "Shrink" command to remove them`,t.lint_status_bar_button.color="#ffff28",t.lint_status_bar_button.text="$(alert) CSVLint"):(g(s.is_ok),t.lint_status_bar_button.color="#62f442",t.lint_status_bar_button.text="$(pass) CSVLint",l="OK");t.lint_status_bar_button.tooltip=l+"\nClick to recheck",t.lint_status_bar_button.command="rainbow-csv.CSVLint",t.lint_status_bar_button.show()},e.exports.get_cursor_position_if_unambiguous=function(e){let t=e.selections;if(!t||1!=t.length)return null;let n=t[0],r=n.active;return r.isEqual(n.anchor)?r:null},e.exports.RecordCommentMerger=S,e.exports.ColumnStat=y,e.exports.generate_column_edit_selections=function(e,t,n,r,i,o,s){let[a,l,u,_,f,h]=c.parse_document_records(t,n,r,i,!0,-1,!0,!0);if(null!==_)return[null,`Unable to enter column edit mode: quoting error at line ${_+1}`,null];if(a.length+h.length!=t.lineCount)return[null,"Column edit mode is not supported for files with multiline fields",null];let m=0,y=[],b=null,w=new S(a,h);for(;w.has_entries_left();){let[t,i]=w.get_next();if(g(null===i!=(null===t)),null!==t){if(s>=t.length)return[null,`Line ${m+1} doesn't have field number ${s+1}`,null];let i=t.slice(0,s).join("").length+s*n.length,a=t.slice(0,s+1).join("").length+s*n.length,l=t.join(n);b||"ce_before"!=o||r!=d&&r!=p||-1==l.substring(i-2,i+2).indexOf('"')||(b=`Be careful, cursor at line ${m+1} has a double quote is in proximity.`),b||"ce_after"!=o||r!=d&&r!=p||-1==l.substring(a-2,a+2).indexOf('"')||(b=`Be careful, cursor at line ${m+1} has a double quote is in proximity.`),b||"ce_select"!=o||i!=a||(b=`Be careful, Field ${s+1} at line ${m+1} is empty.`);let u=new e.Position(m,i),c=new e.Position(m,a);"ce_before"==o&&y.push(new e.Selection(u,u)),"ce_after"==o&&y.push(new e.Selection(c,c)),"ce_select"==o&&y.push(new e.Selection(u,c))}m+=1}return[y,null,b]},e.exports.generate_inlay_hints=function(e,t,n,r,i,o,s,a,l){g(1==s.length);let u=x(i,o,l),c=[],_=30;(_+t.end.line-t.start.line+30)*i.length>1500&&(_=5);let f=t.start.line-_,p=t.end.line+30;for(let t of r){if(null!==t.comment_range)continue;let r=t.record_ranges.length&&t.record_ranges[0].length&&t.record_ranges[0][0].start.line===n;if(t.record_fields.length!=t.record_ranges.length)break;for(let o=0;o<t.record_fields.length&&!(o>=i.length);o++){let _=o+1==t.record_fields.length,d=t.record_fields[o],h=t.record_ranges[o];if(d.length!=h.length)break;for(let t=0;t<d.length;t++){let g=h[t],m=t>0,y=_||t+1<d.length,b=0==o||m,[w,x]=v(d[t],r,i[o],u[o],m,b,y,l);if(w>0){let t="";!a||m?t+=s.repeat(w):(t="█",t+=s.repeat(w-1));let r=g.start.line;(r===n||r>=f&&r<=p)&&c.push(new e.InlayHint(g.start,t))}if(x>0){let t=s.repeat(x),r=g.end.line;(r===n||r>=f&&r<=p)&&c.push(new e.InlayHint(g.end,t))}}}}return c},e.exports.extend_range_by_margin=M,e.exports.calc_max_column_widths=R,e.exports.generate_markdown_lines=function(e){for(let t=0;t<e.length;t++)for(let n=0;n<e[t].length;n++)e[t][n]=e[t][n].replaceAll("|","\\|");let t=R(e),n=[];for(let r=0;r<e.length;r++){let i=[];for(let n=0;n<e[r].length;n++){let o=Math.max(0,t[n]-e[r][n].length),s=e[r][n]+" ".repeat(o);i.push(s)}n.push(i)}let r=n.map(e=>"| "+e.join(" | ")+" |"),i="| "+t.map(e=>"-".repeat(e)).join(" | ")+" |";return r.splice(1,0,i),r}},4285(e){let t='"((?:[^"]*"")*[^"]*)"',n=new RegExp("^"+t),r=new RegExp("^ *"+t+" *");function i(e,t,i,o,s,a){var l=!1;let u=e.substring(s),c=(o?r:n).exec(u);if(null!==c){let n=c[0].length;if(s+n==e.length||e[s+n]==t)return i?a.push(c[0]):a.push(c[1].replace(/""/g,'"')),[s+n+1,!1];l=!0}var _=e.indexOf(t,s);-1==_&&(_=e.length);var f=e.substring(s,_);return l=l||-1!=f.indexOf('"'),a.push(f),[_+1,l]}function o(e,t,n=!1){if(-1==e.indexOf('"'))return[e.split(t),!1];var r=[],o=0,s=!1;let a=" "!=t;for(;o<e.length;){var l=i(e,t,n,a,o,r);o=l[0],s=s||l[1]}return e.charAt(e.length-1)==t&&r.push(""),[r,s]}function s(e){let n=new RegExp("^ *"+t+" *$").exec(e);return null!==n?n[1].replace(/""/g,'"'):e}function a(e,t=!1){var n=t?new RegExp(" *[^ ]+ *","g"):new RegExp("[^ ]+","g");let r=[],i=null;for(;null!==(i=n.exec(e));)r.push(i[0]);if(t)for(let e=0;e<r.length-1;e++)r[e]=r[e].slice(0,-1);return r}e.exports.split_quoted_str=o,e.exports.split_whitespace_separated_str=a,e.exports.smart_split=function(e,t,n,r){return"simple"===n?[e.split(t),!1]:"whitespace"===n?[a(e,r),!1]:"monocolumn"===n?[[e],!1]:o(e,t,r)},e.exports.quote_field=function(e,t){return-1!=e.indexOf(t)||-1!=e.indexOf('"')?`"${e.replace(/"/g,'""')}"`:e},e.exports.rfc_quote_field=function(e,t){return-1!=e.indexOf(t)||-1!=e.indexOf('"')||-1!=e.indexOf("\n")||-1!=e.indexOf("\r")?`"${e.replace(/"/g,'""')}"`:e},e.exports.unquote_field=s,e.exports.unquote_fields=function(e){return e.map(s)},e.exports.split_lines=function(e){return e.split(/\r\n|\r|\n/)},e.exports.MultilineRecordAggregator=class{constructor(e,t){this.comment_prefix=e,this.comment_regex=t,this.reset()}add_line(e){if(this.has_full_record||this.has_comment_line)throw new Error("Invalid usage - record aggregator must be reset before adding new lines");if(this.comment_prefix&&0==this.rfc_line_buffer.length&&e.startsWith(this.comment_prefix))return this.has_comment_line=!0,!1;if(this.comment_regex&&0==this.rfc_line_buffer.length&&-1!=e.search(this.comment_regex))return this.has_comment_line=!0,!1;let t=e.match(/"/g),n=t&&t.length%2==1;return this.rfc_line_buffer.push(e),this.has_full_record=!n&&1==this.rfc_line_buffer.length||n&&this.rfc_line_buffer.length>1,this.has_full_record}is_inside_multiline_record(){return this.rfc_line_buffer.length&&!this.has_full_record}get_full_line(e){return this.rfc_line_buffer.join(e)}get_num_lines_in_record(){return this.rfc_line_buffer.length}reset(){this.rfc_line_buffer=[],this.has_full_record=!1,this.has_comment_line=!1}}},9022(__unused_webpack_module,exports){(function(exports){class RbqlParsingError extends Error{}class RbqlRuntimeError extends Error{}class AssertionError extends Error{}class RbqlIOHandlingError extends Error{}class InternalBadFieldError extends Error{constructor(e,...t){super(...t),this.bad_idx=e}}function assert(e,t=null){if(!e)throw t||(t="Assertion error"),new AssertionError(t)}function replace_all(e,t,n){return e.split(t).join(n)}class RBQLContext{constructor(e,t,n,r){this.query_text=e,this.input_iterator=t,this.writer=n,this.user_init_code=r,this.unnest_list=null,this.top_count=null,this.like_regex_cache=new Map,this.sort_key_expression=null,this.aggregation_stage=0,this.aggregation_key_expression=null,this.functional_aggregators=[],this.join_map_impl=null,this.join_map=null,this.lhs_join_var_expression=null,this.where_expression=null,this.select_expression=null,this.update_expressions=null,this.variables_init_code=null}}var query_context=null;const wrong_aggregation_usage_error="Usage of RBQL aggregation functions inside JavaScript expressions is not allowed, see the docs",RBQL_VERSION="0.29.0";function check_if_brackets_match(e,t){return"["==e&&"]"==t||"("==e&&")"==t||"{"==e&&"}"==t}function parse_root_bracket_level_text_spans(e){let t=[],n=0,r=[];for(let i=0;i<e.length;i++){let o=e[i];if(","==o&&0==r.length)t.push(e.substring(n,i)),n=i+1;else if(-1!=["[","{","("].indexOf(o))r.push(o);else if(-1!=["]","}",")"].indexOf(o)){if(!r.length||!check_if_brackets_match(r[r.length-1],o))throw new RbqlParsingError(`Unable to parse column headers in SELECT expression: No matching opening bracket for closing "${o}"`);r.pop()}}if(r.length)throw new RbqlParsingError(`Unable to parse column headers in SELECT expression: No matching closing bracket for opening "${r[0]}"`);return t.push(e.substring(n,e.length)),t=t.map(e=>e.trim()),t}function unquote_string(e){return!e||e.length<2?null:"'"==e[0]&&"'"==e[e.length-1]?e.substring(1,e.length-1).replace(/\\'/g,"'").replace(/\\\\/g,"\\"):'"'==e[0]&&'"'==e[e.length-1]?e.substring(1,e.length-1).replace(/\\"/g,'"').replace(/\\\\/g,"\\"):null}function column_info_from_text_span(e,t){e=e.trim();let n="__RBQL_INTERNAL_STAR",r=/^[_a-zA-Z][_a-zA-Z0-9]*$/.exec(e),i=/^([ab])\.([_a-zA-Z][_a-zA-Z0-9]*)$/.exec(e),o=/^([ab])\[([0-9]+)\]$/.exec(e),s=/^([ab])\[___RBQL_STRING_LITERAL([0-9]+)___\]$/.exec(e),a=/^(.*) (as|AS) +([a-zA-Z][a-zA-Z0-9_]*) *$/.exec(e);if(null!==a)return{table_name:null,column_index:null,column_name:null,is_star:!1,alias_name:a[3]};if(null!==r){if(e==n)return{table_name:null,column_index:null,column_name:null,is_star:!0,alias_name:null};if(e.startsWith("___RBQL_STRING_LITERAL"))return null;let t=/^([ab])([0-9]+)$/.exec(e);return null!==t?{table_name:t[1],column_index:parseInt(t[2])-1,column_name:null,is_star:!1,alias_name:null}:{table_name:null,column_index:null,column_name:e,is_star:!1,alias_name:null}}if(null!==i){let e=i[1],t=i[2];return t==n?{table_name:e,column_index:null,column_name:null,is_star:!0,alias_name:null}:{table_name:null,column_index:null,column_name:t,is_star:!1,alias_name:null}}if(null!=o)return{table_name:o[1],column_index:parseInt(o[2])-1,column_name:null,is_star:!1,alias_name:null};if(null!=s){s[1];let e=s[2];if(e<t.length){let n=unquote_string(t[e]);if(null!=n)return{table_name:null,column_index:null,column_name:n,is_star:!1,alias_name:null}}}return null}function adhoc_parse_select_expression_to_column_infos(e,t){return parse_root_bracket_level_text_spans(e).map(e=>column_info_from_text_span(e,t))}function stable_compare(e,t){for(var n=0;n<e.length;n++)if(e[n]!==t[n])return e[n]<t[n]?-1:1}function safe_get(e,t){return t<e.length?e[t]:null}function safe_join_get(e,t){if(t<e.length)return e[t];throw new InternalBadFieldError(t)}function safe_set(e,t,n){if(!(t<e.length))throw new InternalBadFieldError(t);e[t]=n}function regexp_escape(e){return e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}function like_to_regex(e){let t=0,n=0,r="";for(;n<e.length;)"_"!=e.charAt(n)&&"%"!=e.charAt(n)||(r+=regexp_escape(e.substring(t,n)),t=n+1,"_"==e.charAt(n)?r+=".":r+=".*"),n+=1;return r+=regexp_escape(e.substring(t,n)),"^"+r+"$"}function like(e,t){let n=query_context.like_regex_cache.get(t);return void 0===n&&(n=new RegExp(like_to_regex(t)),query_context.like_regex_cache.set(t,n)),n.test(e)}const LIKE=like;class RBQLAggregationToken{constructor(e,t){this.marker_id=e,this.value=t}toString(){throw new RbqlParsingError(wrong_aggregation_usage_error)}}class UnnestMarker{}function UNNEST(e){if(null!==query_context.unnest_list)throw new RbqlParsingError("Only one UNNEST is allowed per query");return query_context.unnest_list=e,new UnnestMarker}const unnest=UNNEST,Unnest=UNNEST,UNFOLD=UNNEST;function parse_number(e){let t=Number(e);if(isNaN(t))throw new RbqlRuntimeError(`Unable to convert value "${e}" to a number. MIN, MAX, SUM, AVG, MEDIAN and VARIANCE aggregate functions convert their string arguments to numeric values`);return t}class AnyValueAggregator{constructor(){this.stats=new Map}increment(e,t){void 0===this.stats.get(e)&&this.stats.set(e,t)}get_final(e){return this.stats.get(e)}}class MinAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);void 0===n?this.stats.set(e,t):this.stats.set(e,Math.min(n,t))}get_final(e){return this.stats.get(e)}}class MaxAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);void 0===n?this.stats.set(e,t):this.stats.set(e,Math.max(n,t))}get_final(e){return this.stats.get(e)}}class SumAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);void 0===n?this.stats.set(e,t):this.stats.set(e,n+t)}get_final(e){return this.stats.get(e)}}class AvgAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);if(void 0===n)this.stats.set(e,[t,1]);else{var r=n[0],i=n[1];this.stats.set(e,[r+t,i+1])}}get_final(e){var t=this.stats.get(e);return t[0]/t[1]}}class VarianceAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);if(void 0===n)this.stats.set(e,[t,t*t,1]);else{var r=n[0],i=n[1],o=n[2];this.stats.set(e,[r+t,i+t*t,o+1])}}get_final(e){var t=this.stats.get(e),n=t[0],r=t[1],i=t[2],o=n/i;return r/i-o*o}}class MedianAggregator{constructor(){this.stats=new Map}increment(e,t){t=parse_number(t);var n=this.stats.get(e);void 0===n?this.stats.set(e,[t]):n.push(t)}get_final(e){var t=this.stats.get(e);t.sort(function(e,t){return e-t});var n=Math.floor(t.length/2);return t.length%2?t[n]:(t[n-1]+t[n])/2}}class CountAggregator{constructor(){this.stats=new Map}increment(e,t){var n=this.stats.get(e);void 0===n?this.stats.set(e,1):this.stats.set(e,n+1)}get_final(e){return this.stats.get(e)}}class ArrayAggAggregator{constructor(e=null){this.post_proc=e,this.stats=new Map}increment(e,t){let n=this.stats.get(e);void 0===n?this.stats.set(e,[t]):n.push(t)}get_final(e){let t=this.stats.get(e);return null===this.post_proc?t:this.post_proc(t)}}class ConstGroupVerifier{constructor(e){this.output_index=e,this.const_values=new Map}increment(e,t){var n=this.const_values.get(e);if(void 0===n)this.const_values.set(e,t);else if(n!=t)throw new RbqlRuntimeError(`Invalid aggregate expression: non-constant values in output column ${this.output_index+1}. E.g. "${n}" and "${t}"`)}get_final(e){return this.const_values.get(e)}}function init_aggregator(e,t,n=null){query_context.aggregation_stage=1;var r=new RBQLAggregationToken(query_context.functional_aggregators.length,t);return null===n?query_context.functional_aggregators.push(new e):query_context.functional_aggregators.push(new e(n)),r}function ANY_VALUE(e){return query_context.aggregation_stage<2?init_aggregator(AnyValueAggregator,e):e}const any_value=ANY_VALUE,Any_value=ANY_VALUE;function MIN(e){return query_context.aggregation_stage<2?init_aggregator(MinAggregator,e):e}const min=MIN,Min=MIN;function MAX(e){return query_context.aggregation_stage<2?init_aggregator(MaxAggregator,e):e}const max=MAX,Max=MAX;function COUNT(e){return query_context.aggregation_stage<2?init_aggregator(CountAggregator,1):1}const count=COUNT,Count=COUNT;function SUM(e){return query_context.aggregation_stage<2?init_aggregator(SumAggregator,e):e}const sum=SUM,Sum=SUM;function AVG(e){return query_context.aggregation_stage<2?init_aggregator(AvgAggregator,e):e}const avg=AVG,Avg=AVG;function VARIANCE(e){return query_context.aggregation_stage<2?init_aggregator(VarianceAggregator,e):e}const variance=VARIANCE,Variance=VARIANCE;function MEDIAN(e){return query_context.aggregation_stage<2?init_aggregator(MedianAggregator,e):e}const median=MEDIAN,Median=MEDIAN;function ARRAY_AGG(e,t=null){return query_context.aggregation_stage<2?init_aggregator(ArrayAggAggregator,e,t):e}const array_agg=ARRAY_AGG,FOLD=ARRAY_AGG;function add_to_set(e,t){var n=e.size;return e.add(t),n!=e.size}class TopWriter{constructor(e,t){this.subwriter=e,this.NW=0,this.top_count=t}async write(e){return!(null!==this.top_count&&this.NW>=this.top_count||(await this.subwriter.write(e),this.NW+=1,0))}async finish(){await this.subwriter.finish()}}class UniqWriter{constructor(e){this.subwriter=e,this.seen=new Set}async write(e){return!add_to_set(this.seen,JSON.stringify(e))||!!await this.subwriter.write(e)}async finish(){await this.subwriter.finish()}}class UniqCountWriter{constructor(e){this.subwriter=e,this.records=new Map}async write(e){var t=JSON.stringify(e),n=this.records.get(t);return n?n[0]+=1:this.records.set(t,[1,e]),!0}async finish(){for(var[e,t]of this.records){let[e,n]=t;if(n.unshift(e),!await this.subwriter.write(n))break}await this.subwriter.finish()}}class SortedWriter{constructor(e,t){this.subwriter=e,this.reverse_sort=t,this.unsorted_entries=[]}async write(e){return this.unsorted_entries.push(e),!0}async finish(){var e=this.unsorted_entries;e.sort(stable_compare),this.reverse_sort&&e.reverse();for(var t=0;t<e.length;t++){var n=e[t];if(!await this.subwriter.write(n[n.length-1]))break}await this.subwriter.finish()}}class AggregateWriter{constructor(e){this.subwriter=e,this.aggregators=[],this.aggregation_keys=new Set}async finish(){var e=Array.from(this.aggregation_keys);e.sort();for(var t=0;t<e.length;t++){var n=e[t],r=[];for(var i of this.aggregators)r.push(i.get_final(n));if(!await this.subwriter.write(r))break}await this.subwriter.finish()}}class InnerJoiner{constructor(e){this.join_map=e}get_rhs(e){return this.join_map.get_join_records(e)}}class LeftJoiner{constructor(e){this.join_map=e,this.null_record=[[null,e.max_record_len,Array(e.max_record_len).fill(null)]]}get_rhs(e){let t=this.join_map.get_join_records(e);return 0==t.length?this.null_record:t}}class StrictLeftJoiner{constructor(e){this.join_map=e}get_rhs(e){let t=this.join_map.get_join_records(e);if(1!=t.length)throw new RbqlRuntimeError('In "STRICT LEFT JOIN" each key in A must have exactly one match in B. Bad A key: "'+e+'"');return t}}function select_except(e,t){let n=[];for(let r=0;r<e.length;r++)-1==t.indexOf(r)&&n.push(e[r]);return n}async function select_simple(e,t,n){if(null!==query_context.sort_key_expression){var r=e.concat([t,n]);if(!await query_context.writer.write(r))return!1}else if(!await query_context.writer.write(n))return!1;return!0}function select_aggregated(e,t){if(null!==e&&(e=JSON.stringify(e)),1===query_context.aggregation_stage){if(!(query_context.writer instanceof TopWriter))throw new RbqlParsingError('"ORDER BY", "UPDATE" and "DISTINCT" keywords are not allowed in aggregate queries');query_context.writer=new AggregateWriter(query_context.writer);let i=0;for(var n=0;n<t.length;n++)(r=t[n])instanceof RBQLAggregationToken?(query_context.writer.aggregators.push(query_context.functional_aggregators[r.marker_id]),query_context.writer.aggregators[query_context.writer.aggregators.length-1].increment(e,r.value),i+=1):(query_context.writer.aggregators.push(new ConstGroupVerifier(query_context.writer.aggregators.length)),query_context.writer.aggregators[query_context.writer.aggregators.length-1].increment(e,r));if(i!=query_context.functional_aggregators.length)throw new RbqlParsingError(wrong_aggregation_usage_error);query_context.aggregation_stage=2}else for(n=0;n<t.length;n++){var r=t[n];query_context.writer.aggregators[n].increment(e,r)}query_context.writer.aggregation_keys.add(e)}async function select_unnested(e,t,n){let r=n.slice(),i=n.findIndex(e=>e instanceof UnnestMarker);for(var o=0;o<query_context.unnest_list.length;o++)if(r[i]=query_context.unnest_list[o],!await select_simple(e,t,r.slice()))return!1;return!0}const PROCESS_SELECT_COMMON="\n__RBQLMP__variables_init_code\nif (__RBQLMP__where_expression) {\n    let out_fields = __RBQLMP__select_expression;\n    if (query_context.aggregation_stage > 0) {\n        let key = __RBQLMP__aggregation_key_expression;\n        select_aggregated(key, out_fields);\n    } else {\n        let sort_key = [__RBQLMP__sort_key_expression];\n        if (query_context.unnest_list !== null) {\n            if (!await select_unnested(sort_key, NR, out_fields))\n                stop_flag = true;\n        } else {\n            if (!await select_simple(sort_key, NR, out_fields))\n                stop_flag = true;\n        }\n    }\n}\n",PROCESS_SELECT_SIMPLE="\nlet star_fields = record_a;\n__CODE__\n",PROCESS_SELECT_JOIN="\nlet join_matches = query_context.join_map.get_rhs(__RBQLMP__lhs_join_var_expression);\nfor (let join_match of join_matches) {\n    let [bNR, bNF, record_b] = join_match;\n    let star_fields = record_a.concat(record_b);\n    __CODE__\n    if (stop_flag)\n        break;\n}\n",PROCESS_UPDATE_JOIN="\nlet join_matches = query_context.join_map.get_rhs(__RBQLMP__lhs_join_var_expression);\nif (join_matches.length > 1)\n    throw new RbqlRuntimeError('More than one record in UPDATE query matched a key from the input table in the join table');\nlet record_b = null;\nlet bNR = null;\nlet bNF = null;\nif (join_matches.length == 1)\n    [bNR, bNF, record_b] = join_matches[0];\nlet up_fields = record_a;\n__RBQLMP__variables_init_code\nif (join_matches.length == 1 && (__RBQLMP__where_expression)) {\n    NU += 1;\n    __RBQLMP__update_expressions\n}\nif (!await query_context.writer.write(up_fields))\n    stop_flag = true;\n",PROCESS_UPDATE_SIMPLE="\nlet up_fields = record_a;\n__RBQLMP__variables_init_code\nif (__RBQLMP__where_expression) {\n    NU += 1;\n    __RBQLMP__update_expressions\n}\nif (!await query_context.writer.write(up_fields))\n    stop_flag = true;\n",MAIN_LOOP_BODY="\n__USER_INIT_CODE__\n\nlet NU = 0;\nlet NR = 0;\n\nlet stop_flag = false;\nwhile (!stop_flag) {\n    let record_a = await query_context.input_iterator.get_record();\n    if (record_a === null)\n        break;\n    NR += 1;\n    let NF = record_a.length;\n    query_context.unnest_list = null; // TODO optimize, don't need to set this every iteration\n    try {\n        __CODE__\n    } catch (e) {\n        if (e.constructor.name === 'InternalBadFieldError') {\n            throw new RbqlRuntimeError(`No \"a${e.bad_idx + 1}\" field at record ${NR}`);\n        } else if (e.constructor.name === 'RbqlParsingError') {\n            throw(e);\n        } else {\n            throw new RbqlRuntimeError(`At record ${NR}, Details: ${e.message}`);\n        }\n    }\n}\n";function embed_expression(e,t,n){return replace_all(e,t,n)}function embed_code(e,t,n){let r=e.split("\n"),i=n.split("\n");for(let e=0;e<r.length;e++){let n=r[e].indexOf(t);if(-1==n)continue;assert(n%4==0);let o=r[e].substring(0,n);return i=i.map(e=>o+e),r.slice(0,e).concat(i).concat(r.slice(e+1)).join("\n")+"\n"}assert(!1)}function generate_main_loop_code(e){let t=null!==e.select_expression,n=null!==e.join_map,r=null===e.where_expression?"true":e.where_expression,i=null===e.aggregation_key_expression?"null":e.aggregation_key_expression,o=null===e.sort_key_expression?"null":e.sort_key_expression,s=embed_code(MAIN_LOOP_BODY,"__USER_INIT_CODE__",e.user_init_code);return t?(n?(s=embed_code(embed_code(s,"__CODE__",PROCESS_SELECT_JOIN),"__CODE__",PROCESS_SELECT_COMMON),s=embed_expression(s,"__RBQLMP__lhs_join_var_expression",e.lhs_join_var_expression)):s=embed_code(embed_code(s,"__CODE__",PROCESS_SELECT_SIMPLE),"__CODE__",PROCESS_SELECT_COMMON),s=embed_code(s,"__RBQLMP__variables_init_code",e.variables_init_code),s=embed_expression(s,"__RBQLMP__select_expression",e.select_expression),s=embed_expression(s,"__RBQLMP__where_expression",r),s=embed_expression(s,"__RBQLMP__aggregation_key_expression",i),s=embed_expression(s,"__RBQLMP__sort_key_expression",o)):(n?(s=embed_code(s,"__CODE__",PROCESS_UPDATE_JOIN),s=embed_expression(s,"__RBQLMP__lhs_join_var_expression",e.lhs_join_var_expression)):s=embed_code(s,"__CODE__",PROCESS_UPDATE_SIMPLE),s=embed_code(s,"__RBQLMP__variables_init_code",e.variables_init_code),s=embed_code(s,"__RBQLMP__update_expressions",e.update_expressions),s=embed_expression(s,"__RBQLMP__where_expression",r)),"(async () => {"+s+"})()"}async function compile_and_run(query_context){let main_loop_body=generate_main_loop_code(query_context);try{let main_loop_promise=eval(main_loop_body);await main_loop_promise}catch(e){if(e instanceof SyntaxError){let t=query_context.query_text.toLowerCase();if(-1!=t.indexOf(" having "))throw new SyntaxError(e.message+'\nRBQL doesn\'t support "HAVING" keyword');if(-1!=t.indexOf(" like "))throw new SyntaxError(e.message+"\nRBQL doesn't support \"LIKE\" operator, use like() function instead e.g. ... WHERE like(a1, 'foo%bar') ... ");if(-1!=t.indexOf(" from "))throw new SyntaxError(e.message+'\nTip: If input table is defined by the environment, RBQL query should not have "FROM" keyword');if(e&&e.message&&-1!=String(e.message).toLowerCase().indexOf("unexpected identifier")){if(-1!=t.indexOf(" and "))throw new SyntaxError(e.message+"\nDid you use 'and' keyword in your query?\nJavaScript backend doesn't support 'and' keyword, use '&&' operator instead!");if(-1!=t.indexOf(" or "))throw new SyntaxError(e.message+"\nDid you use 'or' keyword in your query?\nJavaScript backend doesn't support 'or' keyword, use '||' operator instead!")}}if(e&&e.message&&-1!=e.message.indexOf("Received an instance of RBQLAggregationToken"))throw new RbqlParsingError(wrong_aggregation_usage_error);throw e}}const GROUP_BY="GROUP BY",UPDATE="UPDATE",SELECT="SELECT",JOIN="JOIN",INNER_JOIN="INNER JOIN",LEFT_JOIN="LEFT JOIN",LEFT_OUTER_JOIN="LEFT OUTER JOIN",STRICT_LEFT_JOIN="STRICT LEFT JOIN",ORDER_BY="ORDER BY",WHERE="WHERE",LIMIT="LIMIT",EXCEPT="EXCEPT",WITH="WITH";function get_ambiguous_error_msg(e){return`Ambiguous variable name: "${e}" is present both in input and in join tables`}function get_all_matches(e,t){var n=[];let r=null;for(;null!==(r=e.exec(t));)n.push(r);return n}function str_strip(e){return e.replace(/^ +| +$/g,"")}function strip_comments(e){return(e=e.trim()).startsWith("//")?"":e}function combine_string_literals(e,t){for(var n=0;n<t.length;n++)e=replace_all(e,`___RBQL_STRING_LITERAL${n}___`,t[n]);return e}function parse_basic_variables(e,t,n){assert("a"==t||"b"==t);let r=get_all_matches(new RegExp(`(?:^|[^_a-zA-Z0-9])${t}([1-9][0-9]*)(?:$|(?=[^_a-zA-Z0-9]))`,"g"),e);for(let e=0;e<r.length;e++){let i=parseInt(r[e][1]);n[t+String(i)]={initialize:!0,index:i-1}}}function parse_array_variables(e,t,n){assert("a"==t||"b"==t);let r=get_all_matches(new RegExp(`(?:^|[^_a-zA-Z0-9])${t}\\[([1-9][0-9]*)\\]`,"g"),e);for(let e=0;e<r.length;e++){let i=parseInt(r[e][1]);n[`${t}[${i}]`]={initialize:!0,index:i-1}}}function js_string_escape_column_name(e,t){return e=(e=(e=(e=e.replace(/\\/g,"\\\\")).replace(/\n/g,"\\n")).replace(/\r/g,"\\r")).replace(/\t/g,"\\t"),"'"===t?e.replace(/'/g,"\\'"):'"'===t?e.replace(/"/g,'\\"'):(assert("`"===t),e.replace(/`/g,"\\`"))}function query_probably_has_dictionary_variable(e,t){let n=get_all_matches(new RegExp("[-a-zA-Z0-9_:;+=!.,()%^#@&* ]+","g"),t);for(let t of n)if(-1==e.indexOf(t))return!1;return!0}function parse_dictionary_variables(e,t,n,r){assert("a"===t||"b"===t);let i=new RegExp(`(?:^|[^_a-zA-Z0-9])${t}\\[`);if(-1!=e.search(i))for(let i=0;i<n.length;i++){let o=n[i];if(query_probably_has_dictionary_variable(e,o)){let e=js_string_escape_column_name(o,'"');r[`${t}["${e}"]`]={initialize:!0,index:i},e=js_string_escape_column_name(o,"'"),r[`${t}['${e}']`]={initialize:!1,index:i},e=js_string_escape_column_name(o,"`"),r[`${t}[\`${e}\`]`]={initialize:!1,index:i}}}}function parse_attribute_variables(e,t,n,r,i){assert("a"===t||"b"===t);let o=get_all_matches(new RegExp(`(?:^|[^_a-zA-Z0-9])${t}\\.([_a-zA-Z][_a-zA-Z0-9]*)`,"g"),e).map(e=>e[1]);for(let e of o){let o=n.indexOf(e);if(-1==o)throw new RbqlParsingError(`Unable to find column "${e}" in ${"a"==t?"input":"join"} ${r}`);i[`${t}.${e}`]={initialize:!0,index:o}}}function map_variables_directly(e,t,n){for(let r=0;r<t.length;r++){let i=t[r];if(null===/^[_a-zA-Z][_a-zA-Z0-9]*$/.exec(i))throw new RbqlIOHandlingError(`Unable to use column name "${i}" as RBQL/JS variable`);-1!=e.indexOf(i)&&(n[i]={initialize:!0,index:r})}}function ensure_no_ambiguous_variables(e,t,n){let r=new Set(n);for(let n of t)if(r.has(n)&&-1!=e.indexOf(n))throw new RbqlParsingError(get_ambiguous_error_msg(n))}function parse_join_expression(e){e=str_strip(e);const t="Invalid join syntax. Valid syntax: <JOIN> /path/to/B/table on a... == b... [and a... == b... [and ... ]]";let n=/^ *([^ ]+) +on +/i.exec(e);if(null===n)throw new RbqlParsingError(t);let r=n[1];e=e.substr(n[0].length);let i=[];for(var o=/^([^ =]+) *==? *([^ =]+)/,s=/^ +(and|&&) +/i;;){if(n=o.exec(e),null===n)throw new RbqlParsingError(t);if(i.push([n[1],n[2]]),!(e=e.substr(n[0].length)).length)break;if(n=s.exec(e),null===n)throw new RbqlParsingError(t);e=e.substr(n[0].length)}return[r,i]}function resolve_join_variables(e,t,n,r){let i=[],o=[];const s="Valid JOIN syntax: <JOIN> /path/to/B/table on a... == b... [and a... == b... [and ... ]]";for(let a of n){let[n,l]=a;if(n=combine_string_literals(n,r),l=combine_string_literals(l,r),e.hasOwnProperty(n)&&t.hasOwnProperty(n))throw new RbqlParsingError(get_ambiguous_error_msg(n));if(e.hasOwnProperty(l)&&t.hasOwnProperty(l))throw new RbqlParsingError(get_ambiguous_error_msg(l));e.hasOwnProperty(l)&&([n,l]=[l,n]);let[u,c]=[null,null];if(-1!=["NR","a.NR","aNR"].indexOf(n))u=-1;else{if(!e.hasOwnProperty(n))throw new RbqlParsingError(`Unable to parse JOIN expression: Input table does not have field "${n}"\n${s}`);u=e[n].index}if(-1!=["b.NR","bNR"].indexOf(l))c=-1;else{if(!t.hasOwnProperty(l))throw new RbqlParsingError(`Unable to parse JOIN expression: Join table does not have field "${l}"\n${s}`);c=t[l].index}let _=-1==u?"NR":`safe_join_get(record_a, ${u})`;o.push(c),i.push(_)}return[i,o]}function generate_common_init_code(e,t){assert("a"==t||"b"==t);let n=[];n.push(`${t} = new Object();`);let r="a"==t?"NR":"bNR",i=`${t}.NR`;return-1!=e.indexOf(i)&&n.push(`${i} = ${r};`),"a"==t&&-1!=e.indexOf("aNR")&&n.push("aNR = NR;"),n}function generate_init_statements(e,t,n,r){let i=generate_common_init_code(e,"a"),o=/^[_0-9a-zA-Z]+$/;for(const[e,n]of Object.entries(t))if(n.initialize){let t=o.exec(e)?"var ":"";i.push(`${t}${e} = safe_get(record_a, ${n.index});`)}if(n){i=i.concat(generate_common_init_code(e,"b"));for(const[e,t]of Object.entries(n))if(t.initialize){let n=o.exec(e)?"var ":"";i.push(`${n}${e} = record_b === null ? null : safe_get(record_b, ${t.index});`)}}for(let e=1;e<i.length;e++)i[e]=r+i[e];return i.join("\n")}function replace_star_count(e){return str_strip(e.replace(/(?:(?<=^)|(?<=,)) *COUNT\( *\* *\)/gi," COUNT(1)"))}function replace_star_vars(e){let t=get_all_matches(/(?:^|,) *(\*|a\.\*|b\.\*) *(?=$|,)/g,e),n=0,r="";for(let i of t){let t="]).concat("+{"*":"star_fields","a.*":"record_a","b.*":"record_b"}[i[1]]+").concat([";n<i.index&&(r+=e.substring(n,i.index)),r+=t,n=i.index+i[0].length+1}return r+=e.substring(n),r}function replace_star_vars_for_header_parsing(e){let t=get_all_matches(/(?:(?<=^)|(?<=,)) *(\*|a\.\*|b\.\*) *(?=$|,)/g,e),n=0,r="";for(let i of t){let t={"*":"__RBQL_INTERNAL_STAR","a.*":"a.__RBQL_INTERNAL_STAR","b.*":"b.__RBQL_INTERNAL_STAR"}[i[1]];n<i.index&&(r+=e.substring(n,i.index)),r+=t,n=i.index+i[0].length}return r+=e.substring(n),r}function translate_update_expression(e,t,n,r){let i=`Unable to parse "UPDATE" expression: the expression must start with assignment, but "${str_strip(e.split("=")[0])}" does not look like an assignable field name`,o=/(?:^|,) *(a[.#a-zA-Z0-9\[\]_]*) *=(?=[^=])/g,s=[],a=0;for(;;){let l=o.exec(e);if(0==s.length&&(null===l||0!=l.index))throw new RbqlParsingError(i);if(null===l){s[s.length-1]+=str_strip(e.substr(a))+");";break}s.length&&(s[s.length-1]+=str_strip(e.substring(a,l.index))+");");let u=combine_string_literals(str_strip(l[1]),n);if(!t.hasOwnProperty(u))throw new RbqlParsingError(`Unable to parse "UPDATE" expression: Unknown field name: "${u}"`);let c=t[u].index,_=s.length?r:"";s.push(`${_}safe_set(up_fields, ${c}, `),a=l.index+l[0].length}return combine_string_literals(s.join("\n"),n)}function translate_select_expression(e){let t=replace_star_count(e),n=str_strip(replace_star_vars(t.replace(/ +(AS|as) +([a-zA-Z][a-zA-Z0-9_]*) *(?=$|,)/g,""))),r=str_strip(replace_star_vars_for_header_parsing(t));if(!n.length)throw new RbqlParsingError('"SELECT" expression is empty');return[`[].concat([${n}])`,r]}function separate_string_literals(e){for(var t=/('(\\(\\\\)*'|[^'])*')|("(\\(\\\\)*"|[^"])*")|(`(\\(\\\\)*`|[^`])*`)/g,n=null,r=[],i=[],o=0;null!==(n=t.exec(e));){var s=i.length,a=n[0];i.push(a);var l=n.index;r.push(e.substring(o,l)),r.push(`___RBQL_STRING_LITERAL${s}___`),o=t.lastIndex}r.push(e.substring(o));var u=r.join("");return[u=u.replace(/\t/g," "),i]}function locate_statements(e){let t=[];t.push([STRICT_LEFT_JOIN,LEFT_OUTER_JOIN,LEFT_JOIN,INNER_JOIN,JOIN]),t.push([SELECT]),t.push([ORDER_BY]),t.push([WHERE]),t.push([UPDATE]),t.push([GROUP_BY]),t.push([LIMIT]),t.push([EXCEPT]);for(var n=[],r=0;r<t.length;r++)for(var i=0;i<t[r].length;i++){var o=t[r][i],s=get_all_matches(new RegExp("(?:^| )"+replace_all(o," "," *")+"(?= )","ig"),e);if(s.length){if(s.length>1)throw new RbqlParsingError(`More than one "${o}" statements found`);assert(1==s.length);var a=s[0],l=a[0];n.push([a.index,a.index+l.length,o]);break}}return n.sort(function(e,t){return e[0]-t[0]}),n}function separate_actions(e){e=str_strip(e);var t={};let n=/^(.*)  *[Ww][Ii][Tt][Hh] *\(([a-z]{4,20})\) *$/.exec(e);null!==n&&(e=n[1],t[WITH]=n[2]);for(var r=locate_statements(e),i=0;i<r.length;i++){var o=r[i][0],s=r[i][1],a=r[i][2],l=i+1<r.length?r[i+1][0]:e.length;assert(o<s),assert(s<=l);var u=e.substring(s,l),c={};if(-1!=[STRICT_LEFT_JOIN,LEFT_OUTER_JOIN,LEFT_JOIN,INNER_JOIN,JOIN].indexOf(a)&&(c.join_subtype=a,a=JOIN),a==UPDATE){if(0!=o)throw new RbqlParsingError("UPDATE keyword must be at the beginning of the query");u=u.replace(/^ *SET/i,"")}if(a==ORDER_BY){var _=(u=u.replace(/ ASC *$/i,"")).replace(/ DESC *$/i,"");_!=u?(u=_,c.reverse=!0):c.reverse=!1}if(a==SELECT){if(0!=o)throw new RbqlParsingError("SELECT keyword must be at the beginning of the query");let e=/^ *TOP *([0-9]+) /i.exec(u);null!==e&&(c.top=parseInt(e[1]),u=u.substr(e.index+e[0].length)),e=/^ *DISTINCT *(COUNT)? /i.exec(u),null!==e&&(c.distinct=!0,e[1]&&(c.distinct_count=!0),u=u.substr(e.index+e[0].length))}c.text=str_strip(u),t[a]=c}if(!t.hasOwnProperty(SELECT)&&!t.hasOwnProperty(UPDATE))throw new RbqlParsingError("Query must contain either SELECT or UPDATE statement");return assert(t.hasOwnProperty(SELECT)!=t.hasOwnProperty(UPDATE)),t}function find_top(e){if(e.hasOwnProperty(LIMIT)){if(null===/^[0-9]+$/.exec(e[LIMIT].text))throw new RbqlParsingError("LIMIT keyword must be followed by an integer");return parseInt(e[LIMIT].text)}var t=e[SELECT];return t&&t.hasOwnProperty("top")?t.top:null}function translate_except_expression(e,t,n,r){let i=e.split(",");i=i.map(str_strip);let o=[];for(let e of i){if(e=combine_string_literals(e,n),!t.hasOwnProperty(e))throw new RbqlParsingError(`Unknown field in EXCEPT expression: "${e}"`);o.push(t[e].index)}return o=o.sort((e,t)=>e-t),[null===r?null:select_except(r,o),`select_except(record_a, [${o.join(",")}])`]}class HashJoinMap{constructor(e,t){this.max_record_len=0,this.hash_map=new Map,this.record_iterator=e,this.nr=0,1==t.length?(this.key_index=t[0],this.key_indices=null,this.polymorphic_get_key=this.get_single_key):(this.key_index=null,this.key_indices=t,this.polymorphic_get_key=this.get_multi_key)}get_single_key(e,t){if(this.key_index>=t.length)throw new RbqlRuntimeError(`No field with index ${this.key_index+1} at record ${this.nr} in "B" table`);return-1===this.key_index?this.nr:t[this.key_index]}get_multi_key(e,t){let n=[];for(let e of this.key_indices){if(e>=t.length)throw new RbqlRuntimeError(`No field with index ${e+1} at record ${this.nr} in "B" table`);n.push(-1===e?this.nr:t[e])}return JSON.stringify(n)}async build(){for(;;){let e=await this.record_iterator.get_record();if(null===e)break;this.nr+=1;let t=e.length;this.max_record_len=Math.max(this.max_record_len,t);let n=this.polymorphic_get_key(this.nr,e),r=this.hash_map.get(n);void 0===r?this.hash_map.set(n,[[this.nr,t,e]]):r.push([this.nr,t,e])}}get_join_records(e){let t=this.hash_map.get(e);return void 0===t?[]:t}get_warnings(){return this.record_iterator.get_warnings()}}function cleanup_query(e){return e.split("\n").map(strip_comments).filter(e=>e.length).join(" ").replace(/;+$/g,"")}function remove_redundant_table_name(e){return e=str_strip(e.replace(/ +from +a(?: +|$)/gi," ")),str_strip(e.replace(/^ *update +a +set /gi,"update "))}function select_output_header(e,t,n){null===e&&assert(null===t);let r=!1,i=!1;for(let e of n)r=r||null!==e&&e.is_star,i=i||null!==e&&null!==e.alias_name;if(null===e){if(r&&i)throw new RbqlParsingError("Using both * (star) and AS alias in the same query is not allowed for input tables without header");if(!i)return null;e=[],t=[]}null===t&&(t=[]);let o=[];for(let r of n)null===r?o.push("col"+(o.length+1)):r.is_star?null===r.table_name?o=o.concat(e).concat(t):"a"===r.table_name?o=o.concat(e):"b"===r.table_name&&(o=o.concat(t)):null!==r.column_name?o.push(r.column_name):null!==r.alias_name?o.push(r.alias_name):null!==r.column_index?"a"==r.table_name&&r.column_index<e.length?o.push(e[r.column_index]):"b"==r.table_name&&r.column_index<t.length?o.push(t[r.column_index]):o.push("col"+(o.length+1)):o.push("col"+(o.length+1));return o}function sample_first_two_inconsistent_records(e){let t=Array.from(e.entries());t.sort(function(e,t){return e[1]-t[1]}),assert(t.length>1);let[n,r]=t[0],[i,o]=t[1];return[r,n,o,i]}function make_inconsistent_num_fields_warning(e,t){let[n,r,i,o]=sample_first_two_inconsistent_records(t),s=`Number of fields in "${e}" table is not consistent: `;return s+=`e.g. record ${n} -> ${r} fields, record ${i} -> ${o} fields`,s}class RBQLInputIterator{constructor(){}stop(){throw new Error("Unable to call the interface method")}async get_variables_map(e){throw new Error("Unable to call the interface method")}async get_record(){throw new Error("Unable to call the interface method")}handle_query_modifier(){}get_warnings(){return[]}async get_header(){return null}}class RBQLOutputWriter{constructor(){}async write(e){throw new Error("Unable to call the interface method")}async finish(){}get_warnings(){return[]}set_header(){}}class RBQLTableRegistry{constructor(){}get_iterator_by_table_id(e){throw new Error("Unable to call the interface method")}get_warnings(){return[]}}class TableIterator extends RBQLInputIterator{constructor(e,t=null,n=!0,r="a"){super(),this.table=e,this.column_names=t,this.normalize_column_names=n,this.variable_prefix=r,this.nr=0,this.fields_info=new Map,this.stopped=!1}stop(){this.stopped=!0}async get_variables_map(e){let t=new Object;if(parse_basic_variables(e,this.variable_prefix,t),parse_array_variables(e,this.variable_prefix,t),null!==this.column_names){if(this.table.length&&this.column_names.length!=this.table[0].length)throw new RbqlIOHandlingError("List of column names and table records have different lengths");this.normalize_column_names?(parse_dictionary_variables(e,this.variable_prefix,this.column_names,t),parse_attribute_variables(e,this.variable_prefix,this.column_names,"column names list",t)):map_variables_directly(e,this.column_names,t)}return t}async get_record(){if(this.stopped)return null;if(this.nr>=this.table.length)return null;let e=this.table[this.nr];this.nr+=1;let t=e.length;return this.fields_info.has(t)||this.fields_info.set(t,this.nr),e}get_warnings(){return this.fields_info.size>1?[make_inconsistent_num_fields_warning("input",this.fields_info)]:[]}async get_header(){return this.column_names}}class TableWriter extends RBQLOutputWriter{constructor(e){super(),this.table=e,this.header=null,this.finished=!1}async write(e){return this.table.push(e),!0}set_header(e){this.header=e}async finish(){this.finished=!0}}class TablePipe{constructor(){this.table=[],this.writer=new TableWriter(this.table),this.iterator=null}get_writer(){return this.writer}get_iterator(){if(!this.writer.finished)throw new RbqlIOHandlingError("Trying to read from non-thread-safe table pipe while not finishing writing yet");return null===this.iterator&&(this.iterator=new TableIterator(this.table,this.writer.header)),this.iterator}}class SingleTableRegistry extends RBQLTableRegistry{constructor(e,t=null,n=!0,r="b"){super(),this.table=e,this.table_id=r,this.column_names=t,this.normalize_column_names=n}get_iterator_by_table_id(e){if(e.toLowerCase()!==this.table_id)throw new RbqlIOHandlingError(`Unable to find join table: "${e}"`);return new TableIterator(this.table,this.column_names,this.normalize_column_names,"b")}}async function shallow_parse_input_query(e,t,n,r){e=cleanup_query(e);var[i,o]=separate_string_literals(e),s=separate_actions(i=remove_redundant_table_name(i));s.hasOwnProperty(WITH)&&t.handle_query_modifier(s[WITH]);var a=await t.get_variables_map(e);if(s.hasOwnProperty(ORDER_BY)&&s.hasOwnProperty(UPDATE))throw new RbqlParsingError('"ORDER BY" is not allowed in "UPDATE" queries');if(s.hasOwnProperty(GROUP_BY)){if(s.hasOwnProperty(ORDER_BY)||s.hasOwnProperty(UPDATE))throw new RbqlParsingError('"ORDER BY", "UPDATE" and "DISTINCT" keywords are not allowed in aggregate queries');r.aggregation_key_expression="["+combine_string_literals(s[GROUP_BY].text,o)+"]",r.aggregation_stage=1}let l=await t.get_header(),u=null,c=null;if(s.hasOwnProperty(JOIN)){var[_,f]=parse_join_expression(s[JOIN].text);if(null===n)throw new RbqlParsingError("JOIN operations are not supported by the application");let t=n.get_iterator_by_table_id(_);if(!t)throw new RbqlParsingError(`Unable to find join table: "${_}"`);if(s.hasOwnProperty(WITH)&&t.handle_query_modifier(s[WITH]),u=await t.get_variables_map(e),c=await t.get_header(),null===l&&null!==c)throw new RbqlIOHandlingError("Inconsistent modes: Input table doesn't have a header while the Join table has a header");if(null!==l&&null===c)throw new RbqlIOHandlingError("Inconsistent modes: Input table has a header while the Join table doesn't have a header");let[i,p]=resolve_join_variables(a,u,f,o),d={JOIN:InnerJoiner,"INNER JOIN":InnerJoiner,"LEFT JOIN":LeftJoiner,"LEFT OUTER JOIN":LeftJoiner,"STRICT LEFT JOIN":StrictLeftJoiner}[s[JOIN].join_subtype];r.lhs_join_var_expression=1==i.length?i[0]:"JSON.stringify(["+i.join(",")+"])",r.join_map_impl=new HashJoinMap(t,p),await r.join_map_impl.build(),r.join_map=new d(r.join_map_impl)}if(r.variables_init_code=combine_string_literals(generate_init_statements(i,a,u," ".repeat(4)),o),s.hasOwnProperty(WHERE)){var p=s[WHERE].text;if(/[^><!=]=[^=]/.exec(p))throw new RbqlParsingError('Assignments "=" are not allowed in "WHERE" expressions. For equality test use "==" or "==="');r.where_expression=combine_string_literals(p,o)}if(s.hasOwnProperty(UPDATE)){var d=translate_update_expression(s[UPDATE].text,a,o," ".repeat(8));r.update_expressions=combine_string_literals(d,o),r.writer.set_header(l)}if(s.hasOwnProperty(SELECT)){if(r.top_count=find_top(s),s.hasOwnProperty(EXCEPT)){if(s.hasOwnProperty(JOIN))throw new RbqlParsingError("EXCEPT and JOIN are not allowed in the same query");let[e,t]=translate_except_expression(s[EXCEPT].text,a,o,l);r.select_expression=t,r.writer.set_header(e)}else{let[e,t]=translate_select_expression(s[SELECT].text);r.select_expression=combine_string_literals(e,o);let n=select_output_header(l,c,adhoc_parse_select_expression_to_column_infos(t,o));r.writer.set_header(n)}r.writer=new TopWriter(r.writer,r.top_count),s[SELECT].hasOwnProperty("distinct_count")?r.writer=new UniqCountWriter(r.writer):s[SELECT].hasOwnProperty("distinct")&&(r.writer=new UniqWriter(r.writer))}if(s.hasOwnProperty(ORDER_BY)){r.sort_key_expression=combine_string_literals(s[ORDER_BY].text,o);let e=s[ORDER_BY].reverse;r.writer=new SortedWriter(r.writer,e)}}function split_query_to_stages(e){return e.split(/\|[>]?[ ]*(?=(?:select|update)[ ])/i)}async function staged_query(e,t,n,r,i,o){query_context=new RBQLContext(e,t,n,o),await shallow_parse_input_query(e,t,i,query_context),await compile_and_run(query_context),await query_context.writer.finish(),r.push(...t.get_warnings()),query_context.join_map_impl&&r.push(...query_context.join_map_impl.get_warnings()),r.push(...n.get_warnings())}async function query(e,t,n,r,i=null,o=""){let s=split_query_to_stages(e),a=null;for(let e=0;e<s.length;e++){let l=s[e],u=e+1<s.length?new TablePipe:null,c=null===a?t:a.get_iterator(),_=null===u?n:u.get_writer();await staged_query(l,c,_,r,i,o),a=u}}async function query_table(e,t,n,r,i=null,o=null,s=null,a=null,l=!0,u=""){l||null===o||null===s||ensure_no_ambiguous_variables(e,o,s);let c=new TableIterator(t,o,l),_=new TableWriter(n),f=null===i?null:new SingleTableRegistry(i,s,l);if(await query(e,c,_,r,f,u),null!==a&&(assert(0==a.length,"`output_column_names` param must be an empty list or null"),null!==_.header))for(let e of _.header)a.push(e)}function exception_to_error_info(e){let t={RbqlRuntimeError:"query execution",RbqlParsingError:"query parsing",SyntaxError:"JS syntax error",RbqlIOHandlingError:"IO handling"},n="unexpected";return e.constructor&&e.constructor.name&&t.hasOwnProperty(e.constructor.name)&&(n=t[e.constructor.name]),[n,e.hasOwnProperty("message")?e.message:String(e)]}exports.query=query,exports.query_table=query_table,exports.RBQLInputIterator=RBQLInputIterator,exports.RBQLOutputWriter=RBQLOutputWriter,exports.RBQLTableRegistry=RBQLTableRegistry,exports.version=RBQL_VERSION,exports.TableIterator=TableIterator,exports.TableWriter=TableWriter,exports.SingleTableRegistry=SingleTableRegistry,exports.exception_to_error_info=exception_to_error_info,exports.parse_basic_variables=parse_basic_variables,exports.parse_array_variables=parse_array_variables,exports.parse_dictionary_variables=parse_dictionary_variables,exports.parse_attribute_variables=parse_attribute_variables,exports.get_all_matches=get_all_matches,exports.strip_comments=strip_comments,exports.separate_actions=separate_actions,exports.separate_string_literals=separate_string_literals,exports.combine_string_literals=combine_string_literals,exports.parse_join_expression=parse_join_expression,exports.resolve_join_variables=resolve_join_variables,exports.translate_update_expression=translate_update_expression,exports.translate_select_expression=translate_select_expression,exports.translate_except_expression=translate_except_expression,exports.like_to_regex=like_to_regex,exports.adhoc_parse_select_expression_to_column_infos=adhoc_parse_select_expression_to_column_infos,exports.replace_star_count=replace_star_count,exports.replace_star_vars_for_header_parsing=replace_star_vars_for_header_parsing,exports.select_output_header=select_output_header,exports.sample_first_two_inconsistent_records=sample_first_two_inconsistent_records})(exports)},6945(e,t,n){var r=n(5606);const i=n(8364),o=n(9135),s=n(1820),a=n(537),l=n(9022),u=n(4285),c="Unable to decode input table as UTF-8. Use binary (latin-1) encoding instead";class _ extends Error{}class f extends Error{}function p(e,t=null){if(!e)throw t||(t="Assertion error"),new f(t)}function d(e){return/^[\x00-\x7F]*$/.test(e)}function h(e){return i.readFileSync(e,"utf-8")}function g(e,t){var n,r="~"===(n=t).charAt(0)?s.join(o.homedir(),n.slice(1)):n;if(i.existsSync(r))return r;if(e&&!s.isAbsolute(r)&&(r=s.join(e,r),i.existsSync(r)))return r;var a=function(e,t){for(var n=function(e){var t=null;try{t=i.readFileSync(e,"utf-8")}catch(e){return[]}for(var n=t.split("\n"),r=[],o=0;o<n.length;o++)if(n[o]){var s=n[o].split("\t");r.push(s)}return r}(e),r=0;r<n.length;r++)if(n[r].length&&n[r][0]==t)return n[r];return null}(s.join(o.homedir(),".rbql_table_names"),t);return a&&a.length>1&&i.existsSync(a[1])?a[1]:null}class m{constructor(){this.push_stack=[],this.pull_stack=[]}enqueue(e){this.push_stack.push(e)}dequeue(){if(!this.pull_stack.length){if(!this.push_stack.length)return null;this.pull_stack=this.push_stack,this.pull_stack.reverse(),this.push_stack=[]}return this.pull_stack.pop()}}class y extends l.RBQLInputIterator{constructor(e,t,n,r,i,o=!1,s=null,l="input",c="a",_=!1,f=null){super(),this.stream=e,this.csv_path=t,p(null===this.stream!=(null===this.csv_path)),this.encoding=n,this.delim=r,this.policy=i,this.has_header=o,this.first_record=null,this.first_record_should_be_emitted=!o,this.header_preread_complete=!1,this.table_name=l,this.variable_prefix=c,this.comment_prefix=s,this.comment_regex=f,this.trim_whitespaces=_,this.decoder=null,"utf-8"==n&&null===this.csv_path&&(this.decoder=new a.TextDecoder(n,{fatal:!0,stream:!0})),this.input_exhausted=!1,this.started=!1,this.utf8_bom_removed=!1,this.first_defective_line=null,this.fields_info=new Map,this.NR=0,this.NL=0,this.line_aggregator=new u.MultilineRecordAggregator(s,f),this.partially_decoded_line="",this.partially_decoded_line_ends_with_cr=!1,this.resolve_current_record=null,this.reject_current_record=null,this.current_exception=null,this.produced_records_queue=new m,this.process_line_polymorphic="quoted_rfc"==i?this.process_partial_rfc_record_line:this.process_record_line_simple}handle_query_modifier(e){-1!=["header","headers"].indexOf(e)&&(this.has_header=!0,this.first_record_should_be_emitted=!1),-1!=["noheader","noheaders"].indexOf(e)&&(this.has_header=!1,this.first_record_should_be_emitted=!0)}reset_external_callbacks(){this.reject_current_record=null,this.resolve_current_record=null}try_propagate_exception(){if(this.current_exception&&this.reject_current_record){let e=this.reject_current_record,t=this.current_exception;this.reset_external_callbacks(),this.current_exception=null,e(t)}}store_or_propagate_exception(e){null===this.current_exception&&(this.current_exception=e),this.try_propagate_exception()}async preread_first_record(){this.header_preread_complete||(this.first_record=await this.get_record(),this.header_preread_complete=!0,null!==this.first_record&&(this.stream&&this.stream.pause(),this.first_record=this.first_record.slice()))}async get_variables_map(e){let t=new Object;return l.parse_basic_variables(e,this.variable_prefix,t),l.parse_array_variables(e,this.variable_prefix,t),await this.preread_first_record(),this.has_header&&this.first_record&&(l.parse_attribute_variables(e,this.variable_prefix,this.first_record,"CSV header line",t),l.parse_dictionary_variables(e,this.variable_prefix,this.first_record,t)),t}async get_header(){return await this.preread_first_record(),this.has_header?this.first_record:null}try_resolve_next_record(){if(this.try_propagate_exception(),null===this.resolve_current_record)return;let e=null;if(this.first_record_should_be_emitted&&this.header_preread_complete?(this.first_record_should_be_emitted=!1,e=this.first_record):e=this.produced_records_queue.dequeue(),null===e&&!this.input_exhausted)return;let t=this.resolve_current_record;this.reset_external_callbacks(),t(e)}async get_record(){this.started||await this.start(),this.stream&&this.stream.isPaused()&&this.stream.resume();let e=this,t=new Promise(function(t,n){e.resolve_current_record=t,e.reject_current_record=n});return this.try_resolve_next_record(),t}async get_all_records(e=null){let t=[];for(;;){let n=await this.get_record();if(null===n)break;if(t.push(n),e&&t.length>=e){this.stop();break}}return t}process_record_line_simple(e){this.comment_prefix&&e.startsWith(this.comment_prefix)||this.comment_regex&&-1!=e.search(this.comment_regex)||this.process_record_line(e)}process_record_line(e){this.NR+=1;var[t,n]=u.smart_split(e,this.delim,this.policy,!1);this.trim_whitespaces&&(t=t.map(e=>e.trim())),n&&null===this.first_defective_line&&(this.first_defective_line=this.NL,"quoted_rfc"==this.policy&&this.store_or_propagate_exception(new _(`Inconsistent double quote escaping in ${this.table_name} table at record ${this.NR}, line ${this.NL}`)));let r=t.length;this.fields_info.has(r)||this.fields_info.set(r,this.NR),this.produced_records_queue.enqueue(t),this.try_resolve_next_record()}process_partial_rfc_record_line(e){this.line_aggregator.add_line(e),this.line_aggregator.has_comment_line?this.line_aggregator.reset():this.line_aggregator.has_full_record&&(this.process_record_line(this.line_aggregator.get_full_line("\n")),this.line_aggregator.reset())}process_line(e){if(this.NL+=1,1===this.NL){var t=function(e,t){return"binary"==t&&e.length>=3&&239===e.charCodeAt(0)&&187===e.charCodeAt(1)&&191===e.charCodeAt(2)?e.substring(3):"utf-8"==t&&e.length>=1&&65279===e.charCodeAt(0)?e.substring(1):e}(e,this.encoding);t!=e&&(e=t,this.utf8_bom_removed=!0)}this.process_line_polymorphic(e)}process_data_stream_chunk(e){let t=null;if(this.decoder)try{t=this.decoder.decode(e)}catch(e){return void(e instanceof TypeError?this.store_or_propagate_exception(new _(c)):this.store_or_propagate_exception(e))}else t=e.toString(this.encoding);let n=t.length&&"\n"==t[0]&&this.partially_decoded_line_ends_with_cr?1:0;this.partially_decoded_line_ends_with_cr=t.length&&"\r"==t[t.length-1];let r=u.split_lines(t);r[0]=this.partially_decoded_line+r[0],p(0==n||0==r[0].length),this.partially_decoded_line=r.pop();for(let e=n;e<r.length;e++)this.process_line(r[e])}process_data_bulk(e){let t=e.toString(this.encoding);if("utf-8"==this.encoding){let n=Buffer.from(t,"utf-8");if(0!=Buffer.compare(e,n))return void this.store_or_propagate_exception(new _(c))}let n=u.split_lines(t);n.length&&0==n[n.length-1].length&&n.pop();for(let e=0;e<n.length;e++)this.process_line(n[e]);this.line_aggregator.is_inside_multiline_record()&&this.process_record_line(this.line_aggregator.get_full_line("\n")),this.input_exhausted=!0,this.try_resolve_next_record()}process_data_stream_end(){if(this.input_exhausted=!0,this.partially_decoded_line.length){let e=this.partially_decoded_line;this.partially_decoded_line="",this.process_line(e)}this.line_aggregator.is_inside_multiline_record()&&this.process_record_line(this.line_aggregator.get_full_line("\n")),this.try_resolve_next_record()}stop(){this.stream&&this.stream.destroy()}async start(){if(!this.started){if(this.started=!0,!this.stream){let e=this;return new Promise(function(t,n){i.readFile(e.csv_path,(r,i)=>{r?n(r):(e.process_data_bulk(i),t())})})}this.stream.on("data",e=>{this.process_data_stream_chunk(e)}),this.stream.on("end",()=>{this.process_data_stream_end()})}}get_warnings(){let e=[];return null!==this.first_defective_line&&e.push(`Inconsistent double quote escaping in ${this.table_name} table. E.g. at line ${this.first_defective_line}`),this.utf8_bom_removed&&e.push(`UTF-8 Byte Order Mark (BOM) was found and skipped in ${this.table_name} table`),this.fields_info.size>1&&e.push(function(e,t){let[n,r,i,o]=l.sample_first_two_inconsistent_records(t),s=`Number of fields in "${e}" table is not consistent: `;return s+=`e.g. record ${n} -> ${r} fields, record ${i} -> ${o} fields`,s}(this.table_name,this.fields_info)),e}}class b extends l.RBQLOutputWriter{constructor(e,t,n,r,i,o="\n"){if(super(),this.stream=e,this.encoding=n,n&&this.stream.setDefaultEncoding(n),this.stream.on("error",e=>{this.store_first_error(e)}),this.delim=r,this.policy=i,this.line_separator=o,this.sub_array_delim="|"==r?";":"|",this.close_stream_on_finish=t,this.null_in_output=!1,this.delim_in_simple_output=!1,this.header_len=null,this.first_error=null,"simple"==i)this.polymorphic_join=this.simple_join;else if("quoted"==i)this.polymorphic_join=this.quoted_join;else if("quoted_rfc"==i)this.polymorphic_join=this.quoted_join_rfc;else if("monocolumn"==i)this.polymorphic_join=this.mono_join;else{if("whitespace"!=i)throw new _("Unknown output csv policy");this.polymorphic_join=this.simple_join}}store_first_error(e){null===this.first_error&&(this.first_error=e)}set_header(e){null!==e&&(this.header_len=e.length,this.write(e))}quoted_join(e){let t=this.delim;return e.map(function(e){return u.quote_field(String(e),t)}).join(this.delim)}quoted_join_rfc(e){let t=this.delim;return e.map(function(e){return u.rfc_quote_field(String(e),t)}).join(this.delim)}mono_join(e){if(e.length>1)throw new _('Unable to use "Monocolumn" output format: some records have more than one field');return e[0]}simple_join(e){var t=e.join(this.delim);return-1!=e.join("").indexOf(this.delim)&&(this.delim_in_simple_output=!0),t}normalize_fields(e){for(var t=0;t<e.length;t++)null==e[t]?(this.null_in_output=!0,e[t]=""):Array.isArray(e[t])&&(this.normalize_fields(e[t]),e[t]=e[t].join(this.sub_array_delim))}async write(e){if(null!==this.header_len&&e.length!=this.header_len)throw new _(`Inconsistent number of columns in output header and the current record: ${this.header_len} != ${e.length}`);this.normalize_fields(e),this.stream.write(this.polymorphic_join(e)),this.stream.write(this.line_separator);let t=this.first_error;return new Promise(function(e,n){null!==t?n(t):e(!0)})}_write_all(e){for(let t=0;t<e.length;t++)this.write(e[t])}async finish(){let e=this.close_stream_on_finish,t=this.stream,n=this.encoding,r=this.first_error;return new Promise(function(i,o){null!==r&&o(r),e?t.end("",n,()=>{i()}):setTimeout(()=>{i()},0)})}get_warnings(){let e=[];return this.null_in_output&&e.push("null values in output were replaced by empty strings"),this.delim_in_simple_output&&e.push("Some output fields contain separator"),e}}class w extends l.RBQLTableRegistry{constructor(e,t,n,r,i=!1,o=null,s=null){super(),this.input_file_dir=e,this.delim=t,this.policy=n,this.encoding=r,this.has_header=i,this.comment_prefix=o,this.options=s,this.active_join_files=[]}get_iterator_by_table_id(e){let t=null,n=g(this.input_file_dir,e);if(null===n)throw new _(`Unable to find join table "${e}"`);let r=null;this.options&&this.options.bulk_read?r=n:t=i.createReadStream(n);let o=!(!this.options||!this.options.trim_whitespaces),s=this.options&&this.options.hasOwnProperty("comment_regex")?this.options.comment_regex:null,a=new y(t,r,this.encoding,this.delim,this.policy,this.has_header,this.comment_prefix,e,"b",o,s);return this.active_join_files.push({table_path:n,input_stream:t,record_iterator:a}),a}get_warnings(e){if(this.has_header)for(let t of this.active_join_files)e.push(`The first record in JOIN file ${s.basename(t.table_path)} was also treated as header (and skipped)`)}}e.exports.is_ascii=d,e.exports.CSVRecordIterator=y,e.exports.CSVWriter=b,e.exports.FileSystemCSVRegistry=w,e.exports.interpret_named_csv_format=function(e){if("monocolumn"==(e=e.toLowerCase()))return["","monocolumn"];if("csv"==e)return[",","quoted"];if("tsv"==e)return["\t","simple"];throw new _(`Unknown format name: "${e}"`)},e.exports.read_user_init_code=h,e.exports.query_csv=async function(e,t,n,a,u,c,f,p,g,m=!1,x=null,v="",E=null){let R=null,S=null;E&&E.bulk_read&&t?S=t:R=null===t?r.stdin:i.createReadStream(t);let A=!(!E||!E.trim_whitespaces),O=E&&E.hasOwnProperty("comment_regex")?E.comment_regex:null,[k,T]=null===u?[r.stdout,!1]:[i.createWriteStream(u),!0];if('"'==n&&"quoted"==a)throw new _('Double quote delimiter is incompatible with "quoted" policy');if("latin-1"==p&&(p="binary"),!d(e)&&"binary"==p)throw new _("To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary");if(!(d(n)&&d(c)||"binary"!=p))throw new _("To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary");let q=s.join(o.homedir(),".rbql_init_source.js");""==v&&i.existsSync(q)&&(v=h(q));let P=t?s.dirname(t):null,I=new w(P,n,a,p,m,x,E),j=new y(R,S,p,n,a,m,x,"input","a",A,O),N=new b(k,T,p,c,f);await l.query(e,j,N,g,I,v),I.get_warnings(g)},e.exports.RecordQueue=m,e.exports.exception_to_error_info=l.exception_to_error_info},1398(e){"use strict";e.exports=require("vscode")},6510(){},9175(){},2196(){},7507(){},7560(){},8364(){},9135(){},1820(){},9209(e,t,n){"use strict";var r=n(6578),i="undefined"==typeof globalThis?n.g:globalThis;e.exports=function(){for(var e=[],t=0;t<r.length;t++)"function"==typeof i[r[t]]&&(e[e.length]=r[t]);return e}}},__webpack_module_cache__={};function __webpack_require__(e){var t=__webpack_module_cache__[e];if(void 0!==t)return t.exports;var n=__webpack_module_cache__[e]={exports:{}};return __webpack_modules__[e](n,n.exports,__webpack_require__),n.exports}__webpack_require__.g=function(){if("object"==typeof globalThis)return globalThis;try{return this||new Function("return this")()}catch(e){if("object"==typeof window)return window}}();var __webpack_exports__={};(()=>{var e=__webpack_exports__;const t=__webpack_require__(1398),n=__webpack_require__(7507),r=__webpack_require__(9175),i=__webpack_require__(2196),o=__webpack_require__(6510),s=__webpack_require__(3568),a=__webpack_require__(4285);var l=null,u=null;function c(){return null===u&&(u=__webpack_require__(785)),u}const _=void 0===i.homedir;var f=null;const p=100,d="vscode_rbql_scratch";let h=new Set,g=null,m=[],y=new Map;const b="enabled",w="disabled";let x=new Map;var v=new Map,E=new Map,R=new Set,S=null,A=null,O=null,k=null,T=null,q=null,P=null,I=new Map,j=null,N=null,C=null,M=null,L=null,U=null,$=null,B=null,D=null,F=null,W=null;let J=null,z=null,Q=null,V=null,H=null,G=null,Y=null,Z=null;const X="plaintext",K="dynamic csv",ee="quoted",te="whitespace",ne="quoted_rfc",re="simple";let ie={lint_results:new Map,lint_status_bar_button:null,dynamic_document_dialects:new Map,custom_comment_prefixes:new Map,original_language_ids:new Map,toggle_enabled_rows_backgrounds:new Map,tracked_columns:new Map,reenable_rainbow_language_infos:new Map,autodetection_stoplist:new Set,autodetection_temporarily_disabled_for_rbql:!1,dynamic_dialect_for_next_request:null,logging_enabled:!1,logging_next_context_id:1,virtual_alignment_mode:"disabled",double_width_alignment:!0,virtual_alignment_char:"middot",virtual_alignment_vertical_grid:!1,comment_prefix:""};const oe={csv:[",",ee],tsv:["\t",re],"csv (semicolon)":[";",ee],"csv (pipe)":["|",re],"csv (whitespace)":[" ",te],[K]:[null,null]},se="comment",ae=["rainbow1","rainbow2","rainbow3","rainbow4","rainbow5","rainbow6","rainbow7","rainbow8","rainbow9","rainbow10"],le=ae.concat([se]),ue=new t.SemanticTokensLegend(le);function ce(e){return e&&e.uri&&e.fileName&&function(e){return e&&e.uri&&-1!=["file","untitled","vscode-test-web"].indexOf(e.uri.scheme)}(e)}function _e(e){return ce(e)&&oe.hasOwnProperty(e.languageId)}function fe(e,t){return{delim:e,policy:t}}function pe(e){return"dynamic_dialect:"+e}async function de(e,t,n){await Re(pe(t),n),e.dynamic_document_dialects.set(t,n)}function he(e){if(ie.dynamic_document_dialects.has(e))return ie.dynamic_document_dialects.get(e);let t=Ee(pe(e),null);return t&&t.hasOwnProperty("delim")&&t.hasOwnProperty("policy")?(ie.dynamic_document_dialects.set(e,t),t):null}function ge(e){return e?e.toLowerCase():e}function me(e){for(let t in oe)if(oe.hasOwnProperty(t)&&oe[t][0]==e)return oe[t][1];return re}function ye(e,t){for(let n in oe)if(oe.hasOwnProperty(n)&&oe[n][0]==e&&oe[n][1]==t)return n;return K}let be={"rbql_client.js":null,"contrib/textarea-caret-position/index.js":null,"rbql_suggest.js":null,"rbql_logo.svg":null,"rbql_client.html":null,"dialect_select.html":null,"dialect_select.js":null,"rbql mock/rbql_mock.py":null,"rbql_core/vscode_rbql.py":null};function we(e){var n=t.window;n&&n.showErrorMessage(e)}function xe(e){return new Promise(t=>setTimeout(t,e))}async function ve(e,t){e.report({message:t}),await xe(0)}function Ee(e,t){if(C){var n=C.get(e);if(null!=n)return n}return t}async function Re(e,t){return!(!C||!e||(await C.update(e,t),0))}async function Se(e,n,r){let i=new t.Range(0,0,n.lineCount,0),o=n.validateRange(i);await e.edit(e=>e.replace(o,r))}function Ae(e){return"rbql_header_info:"+e}function Oe(e){return"rbql_with_headers:"+e}function ke(e,n,r=null){return r||(r=t.workspace.getConfiguration("rainbow_csv")),r?r.get(e):n}class Te{constructor(){this.column_to_decoration_id=new Map}is_tracked(e){return this.column_to_decoration_id.has(e)}get_tracked_columns(){return Array.from(this.column_to_decoration_id.keys())}toggle_tracking(e){if(this.column_to_decoration_id.has(e))this.column_to_decoration_id.delete(e);else{if(this.num_tracked()>=m.length)return!1;let t=Array.from(this.column_to_decoration_id.values()),n=0;for(;t.includes(n);)n+=1;this.column_to_decoration_id.set(e,n)}return!0}get_decoration_type(e){return this.column_to_decoration_id.has(e)?m[this.column_to_decoration_id.get(e)]:null}num_tracked(){return this.column_to_decoration_id.size}empty(){return 0==this.column_to_decoration_id.size}}class qe{constructor(e,t=null){this.context_name=e,this.logging_enabled=ie.logging_enabled,this.context_id=null===t?ie.logging_next_context_id:t,ie.logging_next_context_id+=1}log_doc_event(e,t=null){if(this.logging_enabled)try{let n=`CID:${this.context_id}, ${this.context_name}:${e}`;t?(n=`${n}, doc_lang:${t.languageId}`,t.uri&&(n=`${n}, doc_uri:${t.uri.toString(!0)}`)):n=`${n}, no_doc:1`,P.info(n)}catch(e){return void console.error(`Rainbow CSV: Unexpected log failure. ${this.context_name}:${this.event_name}`)}}log_simple_event(e){if(this.logging_enabled)try{let t=`CID:${this.context_id}, ${this.context_name}:${e}`;P.info(t)}catch(e){return void console.error(`Rainbow CSV: Unexpected log failure. ${this.context_name}:${this.event_name}`)}}}function Pe(e,t,n,r){let[i,o]=c().get_header_line(e,r);return o?[i,a.smart_split(o,t,n,!1)[0]]:[null,null]}function Ie(e,t,n,r){var i=e.fileName;if(i){let e=Ee(Ae(i),null);if(null!==e&&null!==e.header)return[e.header_line_num,e.header]}return Pe(e,t,n,r)}function je(e){let t=e.languageId,n=null,r=null,i="";if(i=ie.custom_comment_prefixes.has(e.fileName)?ie.custom_comment_prefixes.get(e.fileName):ie.comment_prefix,t!=K&&oe.hasOwnProperty(t))return[n,r]=oe[t],[n,r,i];let o=null;return t==K&&(o=he(e.fileName)),o?[o.delim,o.policy,i]:[null,null,null]}class Ne{constructor(){}async provideDocumentSymbols(e){let[n,r,i]=je(e);if(!r)return null;let o=Ie(e,n,r,i)[0];if(null===o||o>=e.lineCount-1)return null;let s=new t.Range(o,0,e.lineCount-1,65535);s=e.validateRange(s);let a=new t.Range(o,0,o,65535);if(!s.contains(a))return;let l=t.SymbolKind.File;return[new t.DocumentSymbol("data","",l,s,a)]}}function Ce(){let e=[];for(let t in oe)oe.hasOwnProperty(t)&&e.push({language:t});return e}function Me(e=!1){if(!ke("enable_sticky_header",!1))return void(null!==Y&&(Y.dispose(),Y=null));if(null!==Y&&e&&(Y.dispose(),Y=null),null!==Y)return;let n=new Ne;Y=t.languages.registerDocumentSymbolProvider(Ce(),n)}function Le(){null!==Z&&Z.dispose();let e=new Dt;Z=t.languages.registerInlayHintsProvider(Ce(),e)}async function Ue(e,n){if("tsv"==e){let e=Ge();e&&1!=e.options.tabSize&&(e.options.tabSize=1,n.log_doc_event("Updated editor tab size to single (1) space for this doc"))}try{let r=t.workspace.getConfiguration("editor",{languageId:e}),i=!0;"off"==r.get("inlayHints.enabled")&&(await r.update("inlayHints.enabled","on",i,!0),n.log_doc_event(`Updated inlayHints.enabled = 'on' for "${e}"`)),0!=r.get("inlayHints.maximumLength")&&(await r.update("inlayHints.maximumLength",0,i,!0),n.log_doc_event(`Updated inlayHints.maximumLength = 0 for "${e}"`)),""!=r.get("inlayHints.fontFamily")&&(await r.update("inlayHints.fontFamily","",i,!0),n.log_doc_event(`Updated inlayHints.fontFamily = '' for "${e}"`)),""!=r.get("inlayHints.fontSize")&&(await r.update("inlayHints.fontSize","",i,!0),n.log_doc_event(`Updated inlayHints.fontSize = '' for "${e}"`)),""!=r.get("inlayHints.padding")&&(await r.update("inlayHints.padding","",i,!0),n.log_doc_event(`Updated inlayHints.padding = '' for "${e}"`))}catch(e){n.log_doc_event("Failed to update inlay hints user settings: "+e)}}function $e(){let e=new $t;null!==Q&&Q.dispose();let n={language:K};Q=t.languages.registerDocumentRangeSemanticTokensProvider(n,e,ue)}function Be(e){let t=ke("highlight_rows",!1);return ie.toggle_enabled_rows_backgrounds.has(e)?ie.toggle_enabled_rows_backgrounds.get(e):t}function De(){let e=Ge();if(!e)return;var n=Ye(e);if(!n)return;let[r,i,o]=je(n);if(i==ne)return void we("Alternating row background highlighting is currently unavailable for CSVs with multiline records");let s=new qe("toggle_row_background");s.log_doc_event("starting",n);let a=!Be(n.fileName);ie.toggle_enabled_rows_backgrounds.set(n.fileName,a),a?s.log_doc_event("enabled",n):(s.log_doc_event("disabled",n),e.setDecorations(g,[])),We(),null==B&&(B=t.window.onDidChangeTextEditorSelection(qt))}function Fe(){let e=Ge();if(!e)return;var n=Ye(e);if(!n||!_e(n))return;let r=new qe("toggle_column_tracking");r.log_doc_event("starting",n);let i=c().get_cursor_position_if_unambiguous(e);if(!i)return;let[o,s,a]=je(n),l=c().get_cursor_position_info(t,n,o,s,a,i);if(!l)return;if(l.is_comment)return void t.window.showErrorMessage("Unable to track comments");let u=n.fileName,_=ie.tracked_columns.has(u)?ie.tracked_columns.get(u):new Te;if(_.is_tracked(l.column_number)){let t=_.get_decoration_type(l.column_number);e.setDecorations(t,[]),r.log_doc_event("disabling column tracking",n)}else r.log_doc_event("enabling column tracking",n);_.toggle_tracking(l.column_number)?(ie.tracked_columns.set(u,_),function(){let e=new Ut;null!==G&&G.dispose(),G=t.languages.registerDocumentRangeSemanticTokensProvider(Ce(),e,ue)}()):t.window.showErrorMessage(`Unable to track more than ${_.num_tracked()} columns`)}function We(){let e=new Lt;null!==H&&H.dispose(),H=t.languages.registerDocumentRangeSemanticTokensProvider(Ce(),e,ue)}function Je(){let e=new Bt;null!==V&&V.dispose();let n=[];for(let e in oe)oe.hasOwnProperty(e)&&e!=K&&n.push({language:e});V=t.languages.registerDocumentRangeSemanticTokensProvider(n,e,ue)}async function ze(e=null){let n=new qe("choose_dynamic_separator");n.log_doc_event("starting",i);let r=Ge();if(!r)return;var i=Ye(r);if(!ce(i))return;let o=function(e,t){if(!e||!t)return"";let n=e.selection;return n?n.start.line!=n.end.line?"":t.lineAt(n.start.line).text.substring(n.start.character,n.end.character):""}(r,i);N||(N=await Ft("dialect_select.html")),(L=t.window.createWebviewPanel("rainbow-dialect-select","Choose CSV Dialect",t.ViewColumn.Beside,{enableScripts:!0})).webview.html=Et(L,N,["dialect_select.js"]),L.webview.onDidReceiveMessage(function(r){!async function(e,n,r,i,o,s){if(r){if("dialect_handshake"==r.msg_type){let e={msg_type:"dialect_handshake",selected_separator:i};s&&s.integration_test&&(e.integration_test=!0),await n.webview.postMessage(e)}if("apply_dialect"==r.msg_type){let i=r.delim,s=r.policy,a=r.comment_prefix;if("whitespace"==s&&" "!=i)return void we("Selected policy can only be used with whitespace separator");if("double_escape"==s&&'"'==i)return void we("Double quote separator in incompatible with double quote escape policy");if(!i)return void we("Separator is empty");if(-1==[re,ne,ee,te].indexOf(s))return void we("Selected policy is empty or not supported");n.dispose(),await de(ie,e.fileName,fe(i,s)),ie.custom_comment_prefixes.set(e.fileName,a),e.languageId==K&&Ze(e)?await Qe(e,o):await t.languages.setTextDocumentLanguage(e,K)}}}(i,L,r,o,n,e)})}async function Qe(e,r){if(r.log_doc_event("start enable-rainbow-features-if-csv",e),!_e(e))return void r.log_simple_event("abort enable-rainbow-features-if-csv: non-rainbow dialect");var i=e.languageId;i==K&&null!=ie.dynamic_dialect_for_next_request&&(await de(ie,e.fileName,ie.dynamic_dialect_for_next_request),ie.dynamic_dialect_for_next_request=null);let[o,s,a]=je(e);if(!o||!s)return r.log_simple_event("abort enable-rainbow-features-if-csv: missing delim or policy"),Ve(),T||(T=t.window.createStatusBarItem(t.StatusBarAlignment.Left)),T.text="Choose Separator...",T.tooltip="Click to choose Dynamic CSV separator",T.command="rainbow-csv.RainbowSeparator",void T.show();a&&t.languages.setLanguageConfiguration(i,{comments:{lineComment:a}}),i==K&&$e(),function(e){T&&T.hide(),c().show_lint_status_bar_button(t,ie,e.fileName,e.languageId),S||(S=t.window.createStatusBarItem(t.StatusBarAlignment.Left)),S.text="Query",S.tooltip="Click to run SQL-like RBQL query",S.command="rainbow-csv.RBQL",S.show(),Ke(e.fileName),function(e){let r=v.get(ge(e));if(!r||-1!=r.indexOf(d))return;let i=n.basename(r);O||(O=t.window.createStatusBarItem(t.StatusBarAlignment.Left)),O.text="Copy Back",O.tooltip=`Copy to parent table: ${i}`,O.command="rainbow-csv.CopyBack",O.show()}(e.fileName),ke("enable_cursor_position_info",!1)&&(et(),$=t.window.onDidChangeTextEditorSelection(Tt)),Be(e.fileName)&&(B=t.window.onDidChangeTextEditorSelection(qt))}(e),"always"==ie.virtual_alignment_mode&&(await Ue(i,r),Le()),await tt(e,!1),r.log_simple_event("finish enable-rainbow-features-if-csv")}function Ve(){let e=[ie.lint_status_bar_button,S,O,A,k,T];for(let t=0;t<e.length;t++)e[t]&&e[t].hide();$&&($.dispose(),$=null),B&&(B.dispose(),B=null)}function He(e,t){t.log_doc_event("start disable-rainbow-features-if-non-csv",e),_e(e)?t.log_simple_event("abort disable-rainbow-features-if-non-csv: is rainbow dialect"):(t.log_simple_event("perform disable-rainbow-features-if-non-csv"),Ve())}function Ge(){var e=t.window;return e&&e.activeTextEditor||null}function Ye(e=null){return e||(e=Ge()),e&&e.document||null}function Ze(e){let t=Ye();return t&&t.uri&&e&&e.uri&&t.uri.toString()==e.uri.toString()}function Xe(e,t){return t==b||"always"==e&&t!=w}function Ke(e){if(A||(A=t.window.createStatusBarItem(t.StatusBarAlignment.Left)),"disabled"==ie.virtual_alignment_mode){let t=h.has(e);!function(e,t){t?(e.text="Shrink",e.tooltip="Click to shrink table - trim whitespaces from fields",e.command="rainbow-csv.Shrink"):(e.text="Align",e.tooltip="Click to align table with extra whitespaces",e.command="rainbow-csv.Align")}(A,t)}else{let t=y.get(e),n=Xe(ie.virtual_alignment_mode,t);!function(e,t){t?(e.text="Shrink",e.tooltip="Click to remove virtual alignment from this file",e.command="rainbow-csv.VirtualShrink"):(e.text="Align",e.tooltip="Click to virtually align",e.command="rainbow-csv.VirtualAlign")}(A,n)}A.show()}function et(){let e=Ge();if(!e)return!1;let n=c().get_cursor_position_if_unambiguous(e);if(!n)return!1;let r=Ye(e),[i,o,s]=je(r),a=c().get_cursor_position_info(t,r,i,o,s,n);if(!a)return!1;let l=ke("enable_tooltip_column_names",!1),u=Ie(r,i,o,s)[1];if(!u)return!1;let[_,f]=c().format_cursor_position_info(a,u,l,!1,25);return function(e,n){k||(k=t.window.createStatusBarItem(t.StatusBarAlignment.Right,1e3)),k.text=n,k.tooltip=e,k.show()}(_,f),!0}async function tt(e,n){if(e||(e=Ye()),!_e(e))return null;var r=e.fileName,i=e.languageId;let o=`${r}.${i}`;if(!n){if(ie.lint_results.has(o))return null;if(!ke("enable_auto_csv_lint",!1))return null}let[a,l,u]=je(e);if(null===l)return null;ie.lint_results.set(o,{is_processing:!0}),c().show_lint_status_bar_button(t,ie,r,i);let _=ke("csv_lint_detect_trailing_spaces",!1),[f,p,d,h,g,m]=s.parse_document_records(e,a,l,u,!0,-1,!1,!0,_),y={is_ok:null===h&&d.size<=1,first_defective_line:h,fields_info:d,first_trailing_space_line:g};return ie.lint_results.set(o,y),n&&await xe(500),c().show_lint_status_bar_button(t,ie,r,i),y}async function nt(){return await tt(null,!0)}async function rt(e){return e&&e.check_initialization_state?{initialized:null!==C,lazy_loaded:null!==u}:e&&e.check_last_rbql_report?F:e&&e.check_last_rbql_warnings?{warnings:W}:null}async function it(e){if(W=[],e&&e.length){var n=t.window;if(!n)return null;for(var r=0;r<e.length;r++)n.showWarningMessage("RBQL warning: "+e[r]);W=e}}async function ot(e,n,r,i){try{await t.window.showTextDocument(e)}catch(e){return void we("Unable to open RBQL result document")}let o=ye(n,r);o&&e.languageId!=o&&await t.languages.setTextDocumentLanguage(e,o),await it(i)}function st(e){return e&&-1!=e.indexOf(d)?d:e}async function at(e,t){let n=null;try{n=await function(e,t){return new Promise(function(n,r){let i="",s="",a=o.spawn(e,t,{windowsHide:!0});a.stdout.on("data",function(e){i+=e.toString()}),a.stderr.on("data",function(e){s+=e.toString()}),a.on("close",function(e){n({exit_code:e,stdout:i,stderr:s})}),a.on("error",function(e){r(e)})})}(e,t)}catch(e){return{error_type:"Integration",error_msg:"Something went wrong.\nMake sure you have python3 installed and added to the PATH variable in your OS.\nOr you can use RBQL with JavaScript instead - it should work out of the box\nDetails:\n"+(e?e.name+": "+e.message:""),invocation_error:1}}let r=n.stdout;if(!r||n.stderr)return{error_type:"Integration",error_msg:n.stderr||"empty error"};try{return JSON.parse(r)}catch(e){return{error_type:"Integration",error_msg:"Unable to parse JSON report"}}}async function lt(e,t,n){let r={msg_type:"rbql_report"};t&&(r.error_type=t),n&&(r.error_msg=n),F=r,await e.postMessage(r)}async function ut(){let e=Ge();if(!e)return;var t=Ye(e);if(!t)return;let[n,r,i]=je(t);if(null===r)return void we("Unable to set header line: no separator specified");let o=t.fileName;if(!o)return void we("Unable to set header line for non-file documents");let s=e.selection.start.line,l=t.lineAt(s).text,u=a.smart_split(l,n,r,!1)[0];await Re(Ae(o),{header_line_num:s,header:u}),Me(!0)}function ct(e,t,n){e&&(oe.hasOwnProperty(t)||n.set(e,t))}async function _t(){let e=Ge();if(!e)return;var n=Ye(e);if(!n)return;let r=e.selection;if(!r)return void we("Selection is empty");let i=n.lineAt(r.start.line).text.substring(r.start.character,r.end.character);ie.custom_comment_prefixes.set(n.fileName,i),i?R.delete(n.fileName):R.add(n.fileName),i&&t.languages.setLanguageConfiguration(n.languageId,{comments:{lineComment:i}}),n.languageId==K?$e():Je()}async function ft(){let e=new qe("restore_original_language"),n=Ye();if(e.log_doc_event("starting",n),!n)return;let r=n.fileName,i=X;if(ie.original_language_ids.has(r)&&(i=ie.original_language_ids.get(r)),!oe.hasOwnProperty(i)&&oe.hasOwnProperty(n.languageId)){if(r){let e={language_id:n.languageId},t=he(r);t&&(e.dynamic_dialect_info=t),ie.reenable_rainbow_language_infos.set(r,e),ie.autodetection_stoplist.add(r)}n=await t.languages.setTextDocumentLanguage(n,i),He(n,e),async function(e){await Re(pe(e),void 0),ie.dynamic_document_dialects.delete(e)}(r)}else we("Unable to restore original language")}async function pt(){var e=Ye();if(!e)return;let n=e.fileName;if(!ie.reenable_rainbow_language_infos.has(n))return void we("Unable to re-enable rainbow highlighting automatically, select filetype manually or select a new separator with cursor.");let r=ie.reenable_rainbow_language_infos.get(n);ie.autodetection_stoplist.delete(n),r.hasOwnProperty("dynamic_dialect_info")&&await de(ie,n,r.dynamic_dialect_info),ct(n,e.languageId,ie.original_language_ids),ie.reenable_rainbow_language_infos.delete(n),await t.languages.setTextDocumentLanguage(e,r.language_id)}async function dt(){if(_)return void we("This command is currently unavailable in web mode.");var e=Ye();if(!e)return;let n=e.fileName;if(!n)return void we("Unable to use this document as join table");let r=await t.window.showInputBox({prompt:"Input table name to use in RBQL JOIN expressions instead of table path",value:"b"});r&&await Re(c().make_table_name_key(r),n)}async function ht(){var e=Ye();let[n,r,i]=je(e);if(null===r)return void we("Unable to set virtual header: no separator specified");var o=e.fileName;if(!o)return void we("Unable to edit column names for non-file documents");var s=Ie(e,n,r,i)[1],l=s?function(e,t){var n=e.map(function(e){return function(e,t){return-1!=e.indexOf('"')||-1!=e.indexOf(t)?'"'+e.replace(/"/g,'""')+'"':e}(e,t)});return n.join(t)}(s,n):"",u={prompt:"Adjust column names displayed in hover tooltips. Actual header line and file content won't be affected.",value:l};let c=await t.window.showInputBox(u);if(!c)return;let _=a.smart_split(c,n,r,!1)[0];await Re(Ae(o),{header_line_num:null,header:_})}async function gt(e){let n=Ge();if(!n)return;let r=n.document;if(!r)return;let[i,o,s]=je(r);if(null===o)return;let a=c().get_cursor_position_if_unambiguous(n);if(!a)return void we("Unable to enter column edit mode: make sure that no text is selected and only one cursor is active");if(r.lineCount>=1e4)return void we("Multicursor column edit works only for files smaller than 10000 lines.");let l=c().get_cursor_position_info(t,r,i,o,s,a).column_number,[u,_,f]=c().generate_column_edit_selections(t,r,i,o,s,e,l);null===_?(f&&t.window.showWarningMessage(f),n.selections=u,await t.window.showTextDocument(r)):we(_)}async function mt(){let e=Ye();e&&(y.set(e.fileName,w),Le(),Ke(e.fileName))}async function yt(){let e=Ge(),n=Ye(e);if(!_e(n))return;let[r,i,o]=je(n);if(null===i)return;let s={location:t.ProgressLocation.Window,title:"Rainbow CSV"};await t.window.withProgress(s,async s=>{await ve(s,"Preparing");let[a,l]=c().shrink_columns(n,r,i,o);null===l?(h.delete(n.fileName),Ke(n.fileName),null!==a?(await ve(s,"Shrinking columns"),await Se(e,n,a)):t.window.showWarningMessage("No trailing whitespaces found, skipping")):we(`Unable to shrink: Inconsistent double quotes at line ${l+1}`)})}async function bt(){let e=new qe("virtual_align_table"),t=Ye();if(!_e(t))return;let[n,r,i]=je(t);if(null===r)return;let[o,s,a,l]=c().calc_column_stats(t,n,r,i,ie.double_width_alignment);null===s?(e.log_doc_event("Whole doc alignment stats were reset",t),x.set(t.fileName,o)):e.log_doc_event("Failed to reset whole doc alignment stats",t),y.set(t.fileName,b),await Ue(t.languageId,e),Le(),Ke(t.fileName)}async function wt(){let e=Ge(),n=Ye(e);if(!_e(n))return;let[r,i,o]=je(n);if(null===i)return;let s={location:t.ProgressLocation.Window,title:"Rainbow CSV"};await t.window.withProgress(s,async t=>{await ve(t,"Calculating column statistics");let[s,a,l,u]=c().calc_column_stats(n,r,i,o,ie.double_width_alignment);if(a)return void we(`Unable to align: Inconsistent double quotes at line ${a+1}`);await ve(t,"Preparing final alignment");let _=c().align_columns(l,u,s,r).join("\n");await ve(t,"Aligning columns"),await Se(e,n,_),h.add(n.fileName),Ke(n.fileName)})}async function xt(){if(_)return void we("This command is currently unavailable in web mode.");let e=Ye();if(!e)return;let n=e.fileName,r=v.get(ge(n));if(!r)return;let i=await t.workspace.openTextDocument(r),o=await t.window.showTextDocument(i);await async function(e,t){let n=e.getText(),r=Ye(t);r&&await Se(t,r,n)}(e,o)}async function vt(e,o,s=null){let u=o.msg_type;if("handshake"==u){var f={msg_type:"handshake",backend_language:Ee("rbql_backend_language","js"),encoding:Ee("rbql_encoding","utf-8")};c().sample_preview_records_from_context(q,f,p,E);let t=st(q.input_document_path);I.has(t)&&(f.last_query=I.get(t));let n=Ee("rbql_query_history",[]);f.query_history=n,f.policy=q.policy,f.with_headers=q.with_headers,f.header_for_ui=q.header_for_ui,f.is_web_ext=_,s&&(f.integration_test_language=s.rbql_backend,f.integration_test_query=s.rbql_query,f.integration_test_with_headers=s.with_headers||!1,f.integration_test_delay=s.integration_test_delay||2e3),await e.postMessage(f)}if("fetch_table_header"==u)try{let t=o.table_id,r=o.encoding,i=q.input_document_path?n.dirname(q.input_document_path):null,s=c().find_table_path(C,i,t);if(!s)return;let l=await c().read_header(s,r);if(!l)return;let[u,_]=a.smart_split(l,q.delim,q.policy,!1);_||e.postMessage({msg_type:"fetch_table_header_response",header_for_ui:u})}catch(e){console.error("Unable to get join table header: "+String(e))}if("update_query"==u){let e=o.query;if(!e)return;q.input_document_path&&I.set(st(q.input_document_path),e)}if("with_headers_change"==u&&(q.with_headers=o.with_headers,q.input_document_path&&await Re(Oe(q.input_document_path),q.with_headers)),"navigate"==u){var d=o.direction;"backward"==d?q.requested_start_record-=p:"forward"==d?q.requested_start_record+=p:"begin"==d?q.requested_start_record=0:"end"==d&&(q.requested_start_record=q.input_document.lineCount);let t={msg_type:"navigate"};c().sample_preview_records_from_context(q,t,p,E),await e.postMessage(t)}if("run"==u){let r=o.query,a=o.backend_language,u=o.encoding,f=o.output_dialect,p=o.with_headers;await async function(e){let t=Ee("rbql_query_history",[]),n=t.indexOf(e);-1!=n?t.splice(n,1):t.length>=20&&t.splice(0,1),t.push(e),await Re("rbql_query_history",t)}(r),await async function(e,r,o,s,a,u,f,p=null){let d=new qe("run-rbql-query");d.log_simple_event("start"),I.set(st(r),a);let[h,g,m]=[q.delim,q.policy,q.comment_prefix],[y,b]=[h,g];"csv"==u&&([y,b]=[",",ee]),"tsv"==u&&([y,b]=["\t",re]),q.output_delim=y,q.output_policy=b;let w=_?null:n.join(function(e){let t=ke("rbql_output_dir","TMP");return"TMP"==t?i.tmpdir():"INPUT"==t?n.dirname(e):t}(r),function(e,t){var r=n.basename(e),i=n.extname(r),o={"\t":".tsv",",":".csv"},s=".txt";o.hasOwnProperty(t)?s=o[t]:i.length>1&&(s=i);let a=r+s;return a==r&&(a+=".txt"),a}(r,y)),x=ke("rbql_strip_spaces",!0),E=p&&p.hasOwnProperty("python_cmd")?p.python_cmd:"python3";if(a.startsWith("test ")){d.log_simple_event("test mode");let t=[be["rbql mock/rbql_mock.py"],a],n=await at(E,t);return console.log(JSON.stringify(n)),n.hasOwnProperty("error_type")||n.hasOwnProperty("error_msg")?void await lt(e,n.error_type,n.error_msg):void await lt(e,null,null)}if("js"==s){d.log_simple_event("using js backend");let n=[],i=null,s=ye(y,b);try{if(_){d.log_simple_event("using web mode");let r={content:(await c().rbql_query_web(a,q.input_document,h,g,y,b,n,f,m,x)).join("\n"),language:s};s==K&&(ie.dynamic_dialect_for_next_request=fe(y,b)),ie.autodetection_temporarily_disabled_for_rbql=!0,i=await t.workspace.openTextDocument(r),await lt(e,null,null),await async function(e,n){try{await t.window.showTextDocument(e)}catch(e){return void we("Unable to open RBQL result document")}await it(n)}(i,n),ie.dynamic_dialect_for_next_request=null,ie.autodetection_temporarily_disabled_for_rbql=!1,d.log_simple_event("finished OK")}else{d.log_simple_event("using electron mode");let l={bulk_read:!0,trim_whitespaces:x};await c().rbql_query_node(C,a,r,h,g,w,y,b,o,n,f,m,"",l),v.set(ge(w),r),s==K&&(ie.dynamic_dialect_for_next_request=fe(y,b)),ie.autodetection_temporarily_disabled_for_rbql=!0,i=await t.workspace.openTextDocument(w),await lt(e,null,null),await ot(i,y,b,n),ie.dynamic_dialect_for_next_request=null,ie.autodetection_temporarily_disabled_for_rbql=!1,d.log_simple_event("finished OK")}}catch(t){ie.autodetection_temporarily_disabled_for_rbql=!1;let[n,r]=(null===l&&(l=__webpack_require__(6945)),l).exception_to_error_info(t);return d.log_simple_event("finished with error"),void await lt(e,n,r)}}else{if(d.log_simple_event("using python backend"),_)return void await lt(e,"Input error","Python backend for RBQL is not supported in web version, please use JavaScript backend.");let n=Buffer.from(a,"utf-8").toString("base64");m||(m="");let i=[be["rbql_core/vscode_rbql.py"],n,r,h,g,w,y,b,m,o];f&&i.push("--with_headers"),x&&i.push("--strip_spaces");let s=await at(E,i);if(s.hasOwnProperty("error_type")||s.hasOwnProperty("error_msg"))return d.log_simple_event("finished with error"),void await lt(e,s.error_type,s.error_msg);d.log_simple_event("finished OK"),await lt(e,null,null),ie.autodetection_stoplist.add(w),v.set(ge(w),r),ie.autodetection_temporarily_disabled_for_rbql=!0;let l=null;try{l=await t.workspace.openTextDocument(w)}finally{ie.autodetection_temporarily_disabled_for_rbql=!1}ye(y,b)==K&&(ie.dynamic_dialect_for_next_request=fe(y,b)),await ot(l,y,b,s.warnings),ie.dynamic_dialect_for_next_request=null}}(e,q.input_document_path,u,a,r,f,p,s)}if("edit_udf"==u){if(_)return void await lt(e,"Input error","UDFs are currently not supported in web version");let s=null,a="";"js"==o.backend_language?(s=n.join(i.homedir(),".rbql_init_source.js"),a=c().get_default_js_udf_content()):(s=n.join(i.homedir(),".rbql_init_source.py"),a=c().get_default_python_udf_content()),r.existsSync(s)||r.writeFileSync(s,a);let l=await t.workspace.openTextDocument(s);await t.window.showTextDocument(l)}"global_param_change"==u&&await Re(o.key,o.value)}function Et(e,n,r){for(const i of r){let r=null;r=_?be[i]:e.webview.asWebviewUri(t.Uri.file(be[i])),n=n.replace(`src="${i}"`,`src="${r}"`)}return n}async function Rt(e=null){let o=t.window;if(!o)return;let s=o.activeTextEditor;if(!s)return;let a=s.document;if(!a)return;let l=a.uri;if(!l)return;if("file"!=l.scheme&&"untitled"!=l.scheme&&!_)return;if("file"==l.scheme&&a.isDirty&&!_)return void we("Unable to run RBQL: file has unsaved changes");let u=null;if("untitled"!=l.scheme||_)u=a.fileName;else{let e=a.getText(),t=String(Math.floor(1e6*Math.random()));u=n.join(i.tmpdir(),`${d}_${t}.txt`),r.writeFileSync(u,e)}if(!u)return void we("Unable to run RBQL for this file");let[c,f,p]=je(a);null===f&&(f="monocolumn",c="monocolumn");let h=ke("rbql_with_headers_by_default",!1),g=Ee(Oe(u),h),m=Pe(a,c,f,p)[1];q={input_document:a,input_document_path:u,requested_start_record:0,delim:c,policy:f,comment_prefix:p,with_headers:g,header_for_ui:m},M=t.window.createWebviewPanel("rbql-console","RBQL Console",t.ViewColumn.Active,{enableScripts:!0}),j||(j=await Ft("rbql_client.html")),M.webview.html=Et(M,j,["contrib/textarea-caret-position/index.js","rbql_suggest.js","rbql_client.js","rbql_logo.svg"]),M.webview.onDidReceiveMessage(function(t){vt(M.webview,t,e)})}function St(e,t,n){let[r,i,o]=["csv",",",ee],s=0,a=e.getText();if(!a)return[r,i,o];for(let e of t){if(" "==e||"."==e)continue;let t=0;for(let r=0;r<n&&r<a.length;r++)a[r]==e&&(t+=1);if(t>s){let n=me(e),a=ye(e,n);[r,i,o]=[a,e,n],s=t}}return[r,i,o]}async function At(e,t,n,r,i=null){let o=new qe("autodetection",i);if(o.log_doc_event("starting...",r),n.autodetection_temporarily_disabled_for_rbql)return o.log_simple_event("abort: disabled for rbql"),[r,!1];if(!ce(r))return o.log_simple_event("abort: ineligible doc"),[r,!1];if(!ke("enable_separator_autodetection",!1,t))return o.log_simple_event("abort: disabled in config"),[r,!1];var a=r.fileName,l=r.languageId;if(n.autodetection_stoplist.has(a))return o.log_simple_event("abort: doc path in stoplist"),[r,!1];let u=(a.endsWith(".csv")||a.endsWith(".CSV"))&&"csv"==l;if(l!=X&&!u)return o.log_simple_event("abort: ineligible original language id"),[r,!1];let c=ke("autodetect_separators",[],t).map(e=>"TAB"===e?"\t":e);if(!oe.hasOwnProperty(l)&&D&&D.file_path===a&&Math.abs(Date.now()-D.timestamp)<1e3)return o.log_simple_event("abort: recent doc language switch prevention"),[r,!1];let _=n.comment_prefix||"#";o.log_simple_event("starting standard dialect autodetection...");let f=ke("autodetection_min_line_count",10,t),[p,d,h,g,m]=function(e,t,n,r){let i=[];for(let e of n){let t=me(e),n=ye(e,t);n&&t&&(i.push([n,e,t]),","!=e&&";"!=e||i.push([K,e,ne]))}let o=ke("csv_lint_detect_trailing_spaces",!1,e),[a,l,u,c,_]=[null,null,null,null,null],f=1;for(let e of i){let[n,i,p]=e,[d,h,g,m,y,b]=s.parse_document_records(t,i,p,r,!0,-1,!1,!0,o,f+1);if(null!==m||1!=g.size)continue;let w=Array.from(g.keys())[0];w>=f+1&&(f=w,_=h,[a,l,u]=[n,i,p],c=y)}return[a,l,u,c,_]}(t,r,c,_);if(p&&m>=f?n.lint_results.set(`${a}.${p}`,{is_ok:!0,first_trailing_space_line:g}):u?p||(o.log_simple_event("starting frequency-based dialect autodetection..."),[p,d,h]=St(r,c,1e4)):p=null,!p)return o.log_simple_event("abort: content-based autodetection did not detect anything"),[r,!1];if(p==K&&await de(n,a,fe(d,h)),p==l)return o.log_simple_event("abort: autodetected dialect matches the original one"),[r,!1];ct(a,l,n.original_language_ids),o.log_simple_event(`autodetection successful - switching from ${l} to ${p}`);let y=await e.languages.setTextDocumentLanguage(r,p);return o.log_doc_event("after language switch",y),[y,!0]}async function Ot(e){if(!e)return;U&&(U.dispose(),U=null);let n=new qe("handle_first_edit_for_an_empty_doc");n.log_doc_event("starting",e.document),await At(t,t.workspace.getConfiguration("rainbow_csv"),ie,e.document,n.context_id)}async function kt(e){let t=new qe("handle_editor_switch"),n=Ye(e);t.log_doc_event("editor switch",n),He(n,t),await Qe(n,t)}function Tt(e){null!==J&&clearTimeout(J),J=setTimeout(()=>{!et()&&k&&k.hide()},10)}function qt(e){null!==z&&clearTimeout(z),z=setTimeout(()=>function(){let e=Ge();e&&e.visibleRanges&&e.visibleRanges.length&&Mt(e,e.visibleRanges[0])}(),10)}async function Pt(e){let n=new qe("handle_doc_open");if(n.log_doc_event("opening doc",e),!ce(e))return void n.log_simple_event("abort: ineligible doc");if(ke("enable_separator_autodetection",!1)&&null===U&&e.isUntitled&&e.lineCount<=1)return U=t.workspace.onDidChangeTextDocument(Ot),void n.log_simple_event("creating empty doc subscription");let r=!1;[e,r]=await At(t,t.workspace.getConfiguration("rainbow_csv"),ie,e,n.context_id),n.log_doc_event(`after autodetection. filetype changed: ${r}`,e),Ze(e)&&(n.log_simple_event("active doc - enabling features"),He(e,n),await Qe(e,n)),n.log_simple_event("finishing")}async function It(e){let t=new qe("handle_doc_close");if(t.log_doc_event("closing doc",e),!_e(e))return t.log_simple_event("abort: non rainbow doc"),void(D=null);D={file_path:e.fileName,timestamp:Date.now()},Ze(e)&&(t.log_simple_event("disabling ui elements"),Ve()),t.log_simple_event("finalizing")}async function jt(e){let t=ie.logging_enabled;ie.logging_enabled=ke("enable_debug_logging",!1),ie.logging_enabled&&!t&&new qe("config change").log_simple_event("logging enabled"),Me(),ke("highlight_rows",!1)&&We(),ie.virtual_alignment_mode=ke("virtual_alignment_mode","disabled"),ie.double_width_alignment=ke("double_width_alignment",!0),ie.virtual_alignment_char=ke("virtual_alignment_char","middot"),ie.virtual_alignment_vertical_grid=ke("virtual_alignment_vertical_grid",!1),ie.comment_prefix=ke("comment_prefix","")}async function Nt(e,o){if(_)return void we("This command is currently unavailable in web mode.");var s=e.fsPath;if(!s||!r.existsSync(s))return void t.window.showErrorMessage("Invalid file");var a=1024e3,l=r.statSync(s).size;if(l<=a){t.window.showWarningMessage("Rainbow CSV: The file is not big enough, showing the full file instead. Use this preview for files larger than 1MB");let e=await t.workspace.openTextDocument(s);return void await t.window.showTextDocument(e)}let u=n.basename(s);const c=n.join(i.tmpdir(),`.rb_csv_preview.${o}.${u}`);r.open(s,"r",(e,n)=>{if(e)return console.log(e.message),void t.window.showErrorMessage("Unable to preview file");var i=Buffer.alloc(a);let s="head"==o?0:Math.max(l-a,0);r.read(n,i,0,a,s,function(e,n){if(e)return console.log(e.message),void t.window.showErrorMessage("Unable to preview file");const s=i.toString();let a=null;a="head"==o?s.substr(0,s.lastIndexOf(s.includes("\r\n")?"\r\n":"\n")):s.substr(s.indexOf("\n")+1),r.writeFileSync(c,a),t.workspace.openTextDocument(c).then(e=>t.window.showTextDocument(e))})})}function Ct(e,n){let r=t.languages.registerHoverProvider(e,{provideHover:(e,n,r)=>function(e,n,r,i){if(!ke("enable_tooltip",!1))return;let[o,s,a]=je(e),l=c().get_cursor_position_info(t,e,o,s,a,r);if(!l||i.isCancellationRequested)return null;let u=ke("enable_tooltip_column_names",!1),_=Ie(e,o,s,a)[1];if(!_)return null;let[f,p]=c().format_cursor_position_info(l,_,u,!0,25),d=new t.MarkdownString;return d.appendText(p),new t.Hover(d)}(e,0,n,r)});n.subscriptions.push(r)}function Mt(e,n){let r=e.document;if(!r||!_e(r))return;if(!Be(r.fileName))return;let[i,o,s]=je(r);if(o==ne)return;let a=-1,l=-1,u=e.selection;u&&!u.isEmpty&&(a=u.start.line,l=u.end.line);let c=Math.max(0,n.start.line-10),_=Math.min(r.lineCount,n.end.line+10),f=[];for(let e=c;e<_;e++)if(!(e>=a&&e<=l)&&e%2==1){let n=r.lineAt(e).text;f.push(new t.Range(e,0,e,n.length))}e.setDecorations(g,f)}class Lt{constructor(){}async provideDocumentRangeSemanticTokens(e,t,n){let r=Ge();return r&&Mt(r,t),null}}class Ut{constructor(){}async provideDocumentRangeSemanticTokens(e,n,r){let i=Ge();return i&&function(e,n){let r=e.document;if(!r)return;let[i,o,s]=je(r);if(!o)return;if(!ie.tracked_columns.has(r.fileName))return;let a=ie.tracked_columns.get(r.fileName);if(a.empty())return;let l=new Map;for(let e of a.get_tracked_columns())l.set(e,new Array);let u=c().extend_range_by_margin(t,r,n,50),_=c().parse_document_range(t,r,i,!0,o,s,u)[0];for(let e of _)if(null===e.comment_range)for(let t of a.get_tracked_columns())for(let n of e.record_ranges[t])l.get(t).push(n);for(let t of a.get_tracked_columns()){let n=l.get(t),r=a.get_decoration_type(t);e.setDecorations(r,n)}}(i,n),null}}class $t{constructor(){}async provideDocumentRangeSemanticTokens(e,n,r){let[i,o,s]=je(e);if(!o||e.languageId!=K)return null;let a=c().extend_range_by_margin(t,e,n,50),l=c().parse_document_range(t,e,i,!0,o,s,a)[0];const u=new t.SemanticTokensBuilder(ue);for(let e of l)if(null!==e.comment_range)u.push(e.comment_range,se);else for(let t=0;t<e.record_ranges.length;t++){let n=t%ae.length;if(0!=n)for(let r of e.record_ranges[t])u.push(r,ae[n])}return u.build()}}class Bt{constructor(){}async provideDocumentRangeSemanticTokens(e,n,r){let[i,o,s]=je(e);if(R.has(e.fileName)&&!s&&(s="#####COMMENT_PREFIX_THAT_CAN_NOT_OCCURE_IN_A_NORMAL_FILE_AND_EVEN_IF_IT_OCCURES_NOT_A_BIG_DEAL####"),!s||null===o||o==ne)return null;const a=new t.SemanticTokensBuilder(ue);let l=Math.max(0,n.start.line-50),u=Math.min(e.lineCount,n.end.line+50);for(let n=l;n<u;n++){let r=e.lineAt(n).text;r.startsWith(s)&&a.push(new t.Range(n,0,n,r.length),se)}return a.build()}}class Dt{constructor(){}async provideInlayHints(e,n,r){let i=null,o=Ge();if(!(o&&o.visibleRanges&&o.visibleRanges.length))return;i=o.visibleRanges[0];let s=y.get(e.fileName);if(!Xe(ie.virtual_alignment_mode,s))return;let[a,l,u]=je(e);if(null===l)return[];let _=c().extend_range_by_margin(t,e,i,50),f=c().parse_document_range(t,e,a,!1,l,u,_)[0],p=Ie(e,a,l,u)[0];if(null!==p&&p<_.start.line){let n=new t.Range(p,0,p,1);f=c().parse_document_range(t,e,a,!1,l,u,n)[0].concat(f)}let d=c().calc_column_stats_for_fragment(f,p,ie.double_width_alignment);x.has(e.fileName)&&(c().reconcile_whole_doc_and_local_column_stats(x.get(e.fileName),d),x.set(e.fileName,d));let h="middot"==ie.virtual_alignment_char?"·":" ";return c().generate_inlay_hints(t,i,p,f,d,a.length,h,ie.virtual_alignment_vertical_grid,0)}}async function Ft(e){if(_){let n=await async function(e,n){let r=t.Uri.joinPath(e,n),i=await t.workspace.fs.readFile(r);return(new TextDecoder).decode(i)}(f,e);return n}return r.readFileSync(be[e],"utf8")}function Wt(e,t){if(!e.record_ranges)return!1;for(let n of e.record_ranges)for(let e of n)if(e.start.line<=t&&e.end.line>=t)return!0;return!1}async function Jt(e=null){const n=t.window.activeTextEditor;if(!n)return;const r=n.document;if(!_e(r))return void we("Go to column is only available for CSV files");let[i,o,s]=je(r);if(null===o)return void we("Unable to determine dialect for this file");let a=null;if(a=e&&void 0!==e.target_column?String(e.target_column):await t.window.showInputBox({prompt:"Enter column number (1-based)",validateInput:e=>{const t=parseInt(e);return isNaN(t)||t<=0?"Please enter a positive number":null}}),!a)return;const l=parseInt(a)-1,u=n.selection.active;let _=new t.Range(u.line,0,u.line,0);_=c().extend_range_by_margin(t,r,_,50);let[f,p]=c().parse_document_range(t,r,i,!1,o,s,_),d=null;for(let e of f)if(null!==e.comment_range){if(e.comment_range.contains(u))return void we("Cannot go to column: cursor is on a comment line")}else if(Wt(e,u.line)){d=e;break}if(!d)return void we("Unable to parse the current record");const h=d.record_ranges.length;if(l>=h)return void we(`Column ${l+1} does not exist. This record has ${h} column(s).`);const g=d.record_ranges[l];if(!g||0===g.length)return void we("Unable to locate the target column");const m=g[0].start,y=new t.Selection(m,m);n.selection=y,n.revealRange(new t.Range(m,m),t.TextEditorRevealType.InCenterIfOutsideViewport)}e.activate=async function(e){C=e.globalState,_&&(f=e.extensionUri);for(let n in be)be.hasOwnProperty(n)&&(be[n]=_?t.Uri.joinPath(e.extensionUri,n):e.asAbsolutePath(n));var n=t.commands.registerCommand("rainbow-csv.CSVLint",nt),r=t.commands.registerCommand("rainbow-csv.RBQL",Rt),i=t.commands.registerCommand("rainbow-csv.SetHeaderLine",ut),o=t.commands.registerCommand("rainbow-csv.SetCommentPrefix",_t),s=t.commands.registerCommand("rainbow-csv.SetVirtualHeader",ht),a=t.commands.registerCommand("rainbow-csv.SetJoinTableName",dt),l=t.commands.registerCommand("rainbow-csv.ColumnEditBefore",async function(){await gt("ce_before")}),u=t.commands.registerCommand("rainbow-csv.ColumnEditAfter",async function(){await gt("ce_after")}),p=t.commands.registerCommand("rainbow-csv.ColumnEditSelect",async function(){await gt("ce_select")}),d=t.commands.registerCommand("rainbow-csv.RainbowSeparator",ze),h=t.commands.registerCommand("rainbow-csv.RainbowSeparatorOff",ft),y=t.commands.registerCommand("rainbow-csv.RainbowSeparatorOn",pt),b=t.commands.registerCommand("rainbow-csv.SampleHead",async function(e){await Nt(e,"head")}),w=t.commands.registerCommand("rainbow-csv.SampleTail",async function(e){await Nt(e,"tail")}),x=t.commands.registerCommand("rainbow-csv.Align",wt),v=t.commands.registerCommand("rainbow-csv.VirtualAlign",bt),E=t.commands.registerCommand("rainbow-csv.Shrink",yt),R=t.commands.registerCommand("rainbow-csv.VirtualShrink",mt),S=t.commands.registerCommand("rainbow-csv.CopyBack",xt),A=t.commands.registerCommand("rainbow-csv.ToggleRowBackground",De),O=t.commands.registerCommand("rainbow-csv.ToggleColumnTracking",Fe),k=t.commands.registerCommand("rainbow-csv.ExcelCopy",async function(){await async function(){let e=new qe("excel_copy");e.log_doc_event("starting excel_copy");try{await async function(e){let n=Ge();if(!n)return;var r=Ye(n);if(!r)return;if(!_e(r))return null;let[i,o,s]=je(r);if(null===o)return null;let a=0,l=r.lineCount,u=n.selection;u&&!u.isEmpty&&(a=u.start.line,l=u.end.line);let _=new t.Range(a,0,l,0);e.log_doc_event("sampling lines",r);let[f,p]=c().parse_document_range(t,r,i,!1,o,s,_);if(null!==p)return void we(`Unable to copy - found formatting error at line ${p+1}.`);e.log_doc_event("converting to tsv",r);let d=[];for(let e of f){let t=[];for(let n of e.record_fields){if(1!=n.length)return void we("Unable to copy fragment with multiline fields");let e=n[0];if(e.includes("\t"))return void we("Unable to copy fragment containing tabs inside some of the fields because it will interfere with the resulting table structure");t.push(e)}d.push(t.join("\t"))}let h=d.join("\n");e.log_doc_event("writing to the clipboard",r),await t.env.clipboard.writeText(h),e.log_doc_event("finishing excel_copy",r),t.window.showInformationMessage("Success: You can now Paste (Ctrl+V) into Sheets")}(e)}catch(t){e.log_doc_event(`Something went wrong: ${t}`),we("Unable to copy: Something went wrong")}}()}),T=t.commands.registerCommand("rainbow-csv.MarkdownCopy",async function(){await async function(){let e=new qe("markdown_copy");e.log_doc_event("starting markdown_copy");let n=Ge(),r=Ye(n);if(!_e(r))return;let[i,o,s]=je(r);if(null===o)return;let a=0,l=r.lineCount,u=n.selection;u&&!u.isEmpty&&(a=u.start.line,l=u.end.line);let _=new t.Range(a,0,l,0);e.log_doc_event("parsing");let[f,p]=c().parse_document_range(t,r,i,!1,o,s,_);if(null!==p)return void we(`Unable to copy - found formatting error at line ${p+1}.`);let d=[],h=null;for(let e of f){let t=[];for(let n of e.record_fields){if(1!=n.length)return void we("Unable to copy fragment with multiline fields");t.push(n[0])}if(d.push(t),null===h&&(h=t.length),h!=t.length)return void we("Unable to copy fragment with variable number of fields in records")}if(d.length<2)return void we("Unable to copy fragment as a markdown table - must have at least 2 records: header and a data row");e.log_doc_event("aligning columns");let g=c().generate_markdown_lines(d).join("\n");e.log_doc_event("writing to the clipboard",r),await t.env.clipboard.writeText(g),e.log_doc_event("finishing makdown_copy",r),t.window.showInformationMessage("Success: You can now Paste the fragment (Ctrl+V) in makdown format")}()}),q=t.commands.registerCommand("rainbow-csv.InternalTest",rt),I=t.commands.registerCommand("rainbow-csv.GoToColumn",Jt),j=t.workspace.onDidOpenTextDocument(Pt),N=t.workspace.onDidCloseTextDocument(It),M=t.workspace.onDidChangeConfiguration(jt),L=t.window.onDidChangeActiveTextEditor(kt);try{P=t.window.createOutputChannel("rainbow_csv_debug_channel",{log:!0})}catch(e){console.error("Rainbow CSV: Failed to create output log channel")}if(jt(),ke("enable_tooltip",!1))for(let t in oe)oe.hasOwnProperty(t)&&Ct(t,e);$e(),ie.comment_prefix&&Je(),e.subscriptions.push(n),e.subscriptions.push(r),e.subscriptions.push(s),e.subscriptions.push(l),e.subscriptions.push(u),e.subscriptions.push(p),e.subscriptions.push(d),e.subscriptions.push(h),e.subscriptions.push(y),e.subscriptions.push(b),e.subscriptions.push(w),e.subscriptions.push(a),e.subscriptions.push(x),e.subscriptions.push(E),e.subscriptions.push(v),e.subscriptions.push(R),e.subscriptions.push(S),e.subscriptions.push(i),e.subscriptions.push(o),e.subscriptions.push(A),e.subscriptions.push(O),e.subscriptions.push(k),e.subscriptions.push(T),e.subscriptions.push(q),e.subscriptions.push(I),e.subscriptions.push(j),e.subscriptions.push(N),e.subscriptions.push(L),e.subscriptions.push(M),g=t.window.createTextEditorDecorationType({backgroundColor:new t.ThemeColor("tab.inactiveBackground"),isWholeLine:!0}),m=function(){let e=[];return e.push(t.window.createTextEditorDecorationType({borderStyle:"solid",borderWidth:"1px",borderColor:new t.ThemeColor("rainbowtrack1")})),e.push(t.window.createTextEditorDecorationType({borderStyle:"solid",borderWidth:"1px",borderColor:new t.ThemeColor("rainbowtrack2")})),e.push(t.window.createTextEditorDecorationType({borderStyle:"solid",borderWidth:"1px",borderColor:new t.ThemeColor("rainbowtrack3")})),e}(),await xe(1e3),Pt(Ye())},e.deactivate=function(){},e.autodetect_dialect_frequency_based=St,e.try_autodetect_and_set_rainbow_filetype=At})();var __webpack_export_target__=exports;for(var __webpack_i__ in __webpack_exports__)__webpack_export_target__[__webpack_i__]=__webpack_exports__[__webpack_i__];__webpack_exports__.__esModule&&Object.defineProperty(__webpack_export_target__,"__esModule",{value:!0})})();
},
"extension.js": function (module, exports, require, __filename, __dirname) {
const vscode = require('vscode');

const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');

const fast_load_utils = require('./fast_load_utils.js');

// See DEV_README.md file for additional info.

// TODO advertise copy to excel as one of the main feature if no bugs reported.

const csv_utils = require('./rbql_core/rbql-js/csv_utils.js');

var rbql_csv = null; // Using lazy load to improve startup performance.
function ll_rbql_csv() {
    if (rbql_csv === null)
        rbql_csv = require('./rbql_core/rbql-js/rbql_csv.js');
    return rbql_csv;
}


var rainbow_utils = null; // Using lazy load to improve startup performance.
function ll_rainbow_utils() {
    if (rainbow_utils === null) {
        rainbow_utils = require('./rainbow_utils.js');
    }
    return rainbow_utils;
}

// TODO consider checking `vscode.env.appHost == 'desktop'` instead.
const is_web_ext = (os.homedir === undefined); // Runs as web extension in browser.
var web_extension_uri = null;
const preview_window_size = 100;
const scratch_buf_marker = 'vscode_rbql_scratch';
const dynamic_csv_highlight_margin = 50; // TODO make configurable

let whitespace_aligned_files = new Set();

let alternate_row_background_decoration_type = null;
let tracked_field_decoration_types = [];

// TODO consider wrapping this into a class with enable()/disable() methods. The class could also access the global virtual alignment mode.
let custom_virtual_alignment_modes = new Map(); // file_name -> VA_EXPLICITLY_ENABLED|VA_EXPLICITLY_DISABLED
const VA_EXPLICITLY_ENABLED = "enabled";
const VA_EXPLICITLY_DISABLED = "disabled";
let whole_doc_alignment_stats = new Map();

var result_set_parent_map = new Map();
var cached_table_parse_result = new Map(); // TODO store doc timestamp / size to invalidate the entry when the doc changes.
var manual_comment_prefix_stoplist = new Set();

// Although these buttons are now available as context menu actions we keep them because they are part of the extension traditions.
var rbql_status_bar_button = null;
var align_shrink_button = null;
var copy_back_button = null;
var column_info_button = null;
var dynamic_dialect_select_button = null;

var rbql_context = null;

var debug_log_output_channel = null;

var last_rbql_queries = new Map(); // Query history does not replace this structure, it is also used to store partially entered queries for preview window switch.

var client_html_template = null;
var dialect_selection_html_template = null;

// This `global_state` is persistent across VSCode restarts.
var global_state = null;

var rbql_preview_panel = null;
var dialect_panel = null;

var doc_first_edit_subscription = null;
var column_info_cursor_subscription = null;
var alt_background_cursor_subscription = null;

var last_closed_rainbow_doc_info = null;

var _unit_test_last_rbql_report = null; // For unit tests only.
var _unit_test_last_warnings = null; // For unit tests only.

let cursor_timeout_handle_for_column_info = null;
let cursor_timeout_handle_for_alt_row_background = null;

let rainbow_token_event = null;
let comment_token_event = null;
let row_background_decoration_event = null;
let column_tracking_decoration_event = null;
let sticky_header_disposable = null;
let inlay_hint_disposable = null;

const PLAINTEXT = 'plaintext';
const DYNAMIC_CSV = 'dynamic csv';

const QUOTED_POLICY = 'quoted';
const WHITESPACE_POLICY = 'whitespace';
const QUOTED_RFC_POLICY = 'quoted_rfc';
const SIMPLE_POLICY = 'simple';


let extension_context = {
    lint_results: new Map(),
    lint_status_bar_button: null,
    dynamic_document_dialects: new Map(),
    custom_comment_prefixes: new Map(), // TODO consider making custom comment prefixes records persistent.
    original_language_ids: new Map(),
    toggle_enabled_rows_backgrounds: new Map(),
    tracked_columns: new Map(),
    reenable_rainbow_language_infos: new Map(), // This only needed for "Rainbow On" functionality that reverts "Rainbow Off" effect.
    autodetection_stoplist: new Set(),
    autodetection_temporarily_disabled_for_rbql: false,
    dynamic_dialect_for_next_request: null,
    logging_enabled: false,
    logging_next_context_id: 1,
    virtual_alignment_mode: 'disabled',
    double_width_alignment: true,
    virtual_alignment_char: 'middot',
    virtual_alignment_vertical_grid: false,
    comment_prefix: '',
};

const dialect_map = {
    'csv': [',', QUOTED_POLICY],
    'tsv': ['\t', SIMPLE_POLICY],
    'csv (semicolon)': [';', QUOTED_POLICY],
    'csv (pipe)': ['|', SIMPLE_POLICY],
    'csv (whitespace)': [' ', WHITESPACE_POLICY],
    [DYNAMIC_CSV]: [null, null]
};


const COMMENT_TOKEN = 'comment';
const rainbow_token_types = ['rainbow1', 'rainbow2', 'rainbow3', 'rainbow4', 'rainbow5', 'rainbow6', 'rainbow7', 'rainbow8', 'rainbow9', 'rainbow10'];
const all_token_types = rainbow_token_types.concat([COMMENT_TOKEN]);
const tokens_legend = new vscode.SemanticTokensLegend(all_token_types);


function is_eligible_scheme(vscode_doc)  {
    // Make sure that the the doc has a valid scheme.
    // We don't want to handle virtual docs and docs created by other extensions, see https://code.visualstudio.com/api/extension-guides/virtual-documents#events-and-visibility and https://github.com/mechatroner/vscode_rainbow_csv/issues/123
    // VScode also opens pairing virtual `.git` documents for git-controlled files that we also want to skip, see https://github.com/microsoft/vscode/issues/22561.
    // "vscode-test-web" scheme is used for browser unit tests.
    return vscode_doc && vscode_doc.uri && ['file', 'untitled', 'vscode-test-web'].indexOf(vscode_doc.uri.scheme) != -1;
}


function is_eligible_doc(vscode_doc) {
    // For new untitled scratch documents `fileName` would be "Untitled-1", "Untitled-2", etc, so we won't enter this branch.
    return vscode_doc && vscode_doc.uri && vscode_doc.fileName && is_eligible_scheme(vscode_doc);
}


function is_rainbow_dialect_doc(vscode_doc) {
    return is_eligible_doc(vscode_doc) && dialect_map.hasOwnProperty(vscode_doc.languageId);
}


function make_dialect_info(delim, policy) {
    return {'delim': delim, 'policy': policy};
}


function make_dynamic_dialect_key(file_path) {
    return 'dynamic_dialect:' + file_path;
}


async function save_dynamic_info(extension_context, file_path, dialect_info) {
    await save_to_global_state(make_dynamic_dialect_key(file_path), dialect_info);
    extension_context.dynamic_document_dialects.set(file_path, dialect_info);
}


async function remove_dynamic_info(file_path) {
    await save_to_global_state(make_dynamic_dialect_key(file_path), undefined);
    extension_context.dynamic_document_dialects.delete(file_path);
}


function get_dynamic_info(file_path) {
    // Filetypes (lang modes) are not preserved across doc reopen but surprisingly preserved across VSCode restarts so we are also storing them in persistent global state.
    // Persistent dialect info has some minor drawbacks (e.g. performance also restart not completely resetting the state is an issue by itself in some scenarios) and could be reconsidered if more serious issues are found.
    if (extension_context.dynamic_document_dialects.has(file_path)) {
        return extension_context.dynamic_document_dialects.get(file_path);
    }
    // Failed to get from the session-local dynamic_document_dialects - check if we have it persistently stored from a previous session.
    let dialect_info = get_from_global_state(make_dynamic_dialect_key(file_path), null);
    if (dialect_info && dialect_info.hasOwnProperty('delim') && dialect_info.hasOwnProperty('policy')) {
        extension_context.dynamic_document_dialects.set(file_path, dialect_info);
        return dialect_info;
    }
    return null;
}


function safe_lower(src_str) {
    if (!src_str)
        return src_str;
    return src_str.toLowerCase();
}


function get_default_policy(separator) {
    // This function is most likely a temporal workaround, get rid of it when possible.
    for (let language_id in dialect_map) {
        if (!dialect_map.hasOwnProperty(language_id))
            continue;
        if (dialect_map[language_id][0] == separator)
            return dialect_map[language_id][1];
    }
    return SIMPLE_POLICY;
}


function map_dialect_to_language_id(separator, policy) {
    for (let language_id in dialect_map) {
        if (!dialect_map.hasOwnProperty(language_id))
            continue;
        if (dialect_map[language_id][0] == separator && dialect_map[language_id][1] == policy)
            return language_id;
    }
    return DYNAMIC_CSV;
}


// This structure will get properly initialized during the startup.
let absolute_path_map = {
    'rbql_client.js': null,
    'contrib/textarea-caret-position/index.js': null,
    'rbql_suggest.js': null,
    'rbql_logo.svg': null,
    'rbql_client.html': null,
    'dialect_select.html': null,
    'dialect_select.js': null,
    'rbql mock/rbql_mock.py': null,
    'rbql_core/vscode_rbql.py': null
};


function show_single_line_error(error_msg) {
    var active_window = vscode.window;
    if (!active_window)
        return;
    // Do not "await" error messages because the promise gets resolved only on error dismissal.
    active_window.showErrorMessage(error_msg);
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function report_progress(progress, status_message) {
    progress.report({message: status_message});
    // Push the current stack to the JS callback queue to allow UI update.
    await sleep(0);
}


function get_from_global_state(key, default_value) {
    // Load KV pair from the "global state" which is persistent across VSCode restarts.
    if (global_state) {
        var value = global_state.get(key);
        if (value !== null && value !== undefined)
            return value;
    }
    return default_value;
}


async function save_to_global_state(key, value) {
    // Save KV pair to the "global state" which is persistent across VSCode restarts.
    if (global_state && key) {
        await global_state.update(key, value);
        return true;
    }
    return false;
}


async function replace_doc_content(active_editor, active_doc, new_content) {
    let invalid_range = new vscode.Range(0, 0, active_doc.lineCount /* Intentionally missing the '-1' */, 0);
    let full_range = active_doc.validateRange(invalid_range);
    await active_editor.edit(edit => edit.replace(full_range, new_content));
}


function make_header_key(file_path) {
    return 'rbql_header_info:' + file_path;
}


function make_with_headers_key(file_path) {
    return 'rbql_with_headers:' + file_path;
}


function get_from_config(param_name, default_value, config=null) {
    if (!config) {
        config = vscode.workspace.getConfiguration('rainbow_csv');
    }
    return config ? config.get(param_name) : default_value;
}

class TrackedColumns {
    // TODO move to rainbow_utils.js and add unit tests
    constructor() {
        this.column_to_decoration_id = new Map();
    }

    is_tracked(column_num) {
        return this.column_to_decoration_id.has(column_num);
    }

    get_tracked_columns() {
        return Array.from(this.column_to_decoration_id.keys());
    }

    toggle_tracking(column_num) {
        if (this.column_to_decoration_id.has(column_num)) {
            this.column_to_decoration_id.delete(column_num);
        } else {
            if (this.num_tracked() >= tracked_field_decoration_types.length) {
                return false;
            }
            let existing_decoration_ids = Array.from(this.column_to_decoration_id.values());
            let new_id = 0;
            while (existing_decoration_ids.includes(new_id)) {
                new_id += 1;
            }
            this.column_to_decoration_id.set(column_num, new_id);
        }
        return true;
    }

    get_decoration_type(column_num) {
        if (!this.column_to_decoration_id.has(column_num)) {
            return null;
        }
        return tracked_field_decoration_types[this.column_to_decoration_id.get(column_num)];

    }

    num_tracked() {
        return this.column_to_decoration_id.size;
    }

    empty() {
        return this.column_to_decoration_id.size == 0;
    }

}

class StackContextLogWrapper {
    // Use class instead of pure function to avoid passing context name and checking if logging is enabled in the config in each call.
    constructor(context_name, caller_context_id=null) {
        this.context_name = context_name;
        this.logging_enabled = extension_context.logging_enabled;
        this.context_id = caller_context_id === null ? extension_context.logging_next_context_id : caller_context_id;
        extension_context.logging_next_context_id += 1;
    }

    log_doc_event(event_name, vscode_doc=null) {
        if (!this.logging_enabled)
            return;
        try {
            let full_event = `CID:${this.context_id}, ${this.context_name}:${event_name}`;
            if (vscode_doc) {
                full_event = `${full_event}, doc_lang:${vscode_doc.languageId}`;
                if (vscode_doc.uri) {
                    let str_uri = vscode_doc.uri.toString(/*skipEncoding=*/true);
                    full_event = `${full_event}, doc_uri:${str_uri}`;
                }
            } else {
                full_event = `${full_event}, no_doc:1`;
            }
            // Use "info" level because logging is flag-guarded by the extension-level setting.
            debug_log_output_channel.info(full_event);
        } catch (_error) {
            console.error(`Rainbow CSV: Unexpected log failure. ${this.context_name}:${this.event_name}`);
            return;
        }
    }

    log_simple_event(event_name) {
        if (!this.logging_enabled)
            return;
        try {
            let full_event = `CID:${this.context_id}, ${this.context_name}:${event_name}`;
            debug_log_output_channel.info(full_event);
        } catch (_error) {
            console.error(`Rainbow CSV: Unexpected log failure. ${this.context_name}:${this.event_name}`);
            return;
        }
    }
}


function get_header_from_document(document, delim, policy, comment_prefix) {
    let [header_lnum, header_text] = ll_rainbow_utils().get_header_line(document, comment_prefix);
    if (!header_text) {
        return [null, null];
    }
    return [header_lnum, csv_utils.smart_split(header_text, delim, policy, /*preserve_quotes_and_whitespaces=*/false)[0]];
}


function get_header(document, delim, policy, comment_prefix) {
    var file_path = document.fileName;
    if (file_path) {
        let header_info = get_from_global_state(make_header_key(file_path), null);
        if (header_info !== null && header_info.header !== null) {
            return [header_info.header_line_num, header_info.header];
        }
    }
    return get_header_from_document(document, delim, policy, comment_prefix);
}


function get_dialect(document) {
    let language_id = document.languageId;
    let delim = null;
    let policy = null;

    let comment_prefix = '';
    if (extension_context.custom_comment_prefixes.has(document.fileName)) {
        comment_prefix = extension_context.custom_comment_prefixes.get(document.fileName);
    } else {
        comment_prefix = extension_context.comment_prefix;
    }
    if (language_id != DYNAMIC_CSV && dialect_map.hasOwnProperty(language_id)) {
        [delim, policy] = dialect_map[language_id];
        return [delim, policy, comment_prefix];
    }
    let dialect_info = null;
    if (language_id == DYNAMIC_CSV) {
        dialect_info = get_dynamic_info(document.fileName);
    }
    if (dialect_info) {
        return [dialect_info.delim, dialect_info.policy, comment_prefix];
    }
    // The language id can be `dynamic csv` here e.g. if user just now manually selected the "Dynamic CSV" filetype.
    return [null, null, null];
}


function enable_rainbow_ui(active_doc) {
    if (dynamic_dialect_select_button) {
        dynamic_dialect_select_button.hide();
    }
    ll_rainbow_utils().show_lint_status_bar_button(vscode, extension_context, active_doc.fileName, active_doc.languageId);
    show_rbql_status_bar_button();
    show_align_shrink_button(active_doc.fileName);
    show_rbql_copy_to_source_button(active_doc.fileName);
    let cursor_position_info_enabled = get_from_config('enable_cursor_position_info', false);
    if (cursor_position_info_enabled) {
        show_column_info_button(); // This function finds active_doc internally, but the possible inconsistency is harmless.
        column_info_cursor_subscription = vscode.window.onDidChangeTextEditorSelection(handle_cursor_movement_for_column_info);
    }
    if (row_background_enabled(active_doc.fileName)) {
        alt_background_cursor_subscription = vscode.window.onDidChangeTextEditorSelection(handle_cursor_movement_for_alt_row_background);
    }
}


class StickyHeaderProvider {
    // We don't utilize typescript `implement` interface keyword, because TS doesn't seem to be exporting interfaces to JS (unlike classes).
    constructor() {
    }
    async provideDocumentSymbols(document) {
        // This can trigger multiple times for the same doc because otherwise this won't work in case of e.g. header edit.
        let [delim, policy, comment_prefix] = get_dialect(document);
        if (!policy) {
            return null;
        }
        let header_lnum = get_header(document, delim, policy, comment_prefix)[0];
        if (header_lnum === null /* - this can happen for user-provided "virtual" header */ || header_lnum >= document.lineCount - 1) {
            return null;
        }
        let full_range = new vscode.Range(header_lnum, 0, document.lineCount - 1, 65535);
        full_range = document.validateRange(full_range); // Just in case, should be always NOOP.
        let header_range = new vscode.Range(header_lnum, 0, header_lnum, 65535);
        if (!full_range.contains(header_range)) {
            return; // Should never happen.
        }
        let symbol_kind = vscode.SymbolKind.File; // It is vscode.SymbolKind.File because it shows a nice "File" icon in the upper navigational panel. Another nice option is "Class".
        let header_symbol = new vscode.DocumentSymbol('data', '', symbol_kind, full_range, header_range);
        return [header_symbol];
    }
}


function get_all_rainbow_lang_selector() {
    let document_selector = [];
    for (let language_id in dialect_map) {
        if (dialect_map.hasOwnProperty(language_id)) {
            document_selector.push({language: language_id});
        }
    }
    return document_selector;
}


function reconfigure_sticky_header_provider(force=false) {
    // Sticky header is enabled in VSCode by default already.
    // TODO consider overriding the global config option dynamically for the current language id and workspace only, but if you do this make sure that right click -> disable on the header still disables it.
    let enable_sticky_header = get_from_config('enable_sticky_header', false);
    if (!enable_sticky_header) {
        if (sticky_header_disposable !== null) {
            sticky_header_disposable.dispose();
            sticky_header_disposable = null;
        }
        return;
    }
    if (sticky_header_disposable !== null && force) {
        sticky_header_disposable.dispose();
        sticky_header_disposable = null;
    }
    if (sticky_header_disposable !== null) {
        // Sticky header provider already exists, nothing to do.
        return;
    }
    let header_symbol_provider = new StickyHeaderProvider();
    sticky_header_disposable = vscode.languages.registerDocumentSymbolProvider(get_all_rainbow_lang_selector(), header_symbol_provider);
}


function reenable_inlay_hints_provider() {
    // Dispose previous provider to refresh stale hints, including enabling them when disabled or disabling when enabled.
    if (inlay_hint_disposable !== null) {
        inlay_hint_disposable.dispose();
    }
    let inlay_hints_provider = new InlayHintProvider();
    inlay_hint_disposable = vscode.languages.registerInlayHintsProvider(get_all_rainbow_lang_selector(), inlay_hints_provider);
}


async function configure_inlay_hints_alignment(language_id, log_wrapper) {
    // We have 3 invocation contexts here:
    // 1. VA is "disabled" but the function was called via the command palette command directly.
    // 2. VA is "manual" and the function was called either by the command palette or the "Align" button (essentially the same).
    // 3. VA is "always" and the function was called on file open.
    if (language_id == 'tsv') {
        let active_editor = get_active_editor();
        if (active_editor) {
            if (active_editor.options.tabSize != 1) {
                active_editor.options.tabSize = 1;
                log_wrapper.log_doc_event(`Updated editor tab size to single (1) space for this doc`);
            }
        }
    }

    try {
        let config = vscode.workspace.getConfiguration('editor', {languageId: language_id});
        // Adjusting these settings as `configurationDefaults` in package.json doesn't work reliably, so we set it here dynamically.
        // Note that there is User and Workspace-level configs options in the File->Preferences->Settings UI - this is important when you are trying to debug the limits.
        // Adjusting these settings on the workspace level doesn't quite work because VSCode doesn't always have an active workspace, e.g. you can click [Close Workspace] from the main [File] menu to reproduce the problem. So we adjust the settings on global level instead which should always work.
        let update_global_settings = true;
        if (config.get('inlayHints.enabled') == 'off') {
            // Some users have inlay hints disabled alltogether, see https://github.com/mechatroner/vscode_rainbow_csv/issues/242.
            // So we re-enable inlay hints for the current language only since it was explicitly requested via the UI interaction.
            await config.update('inlayHints.enabled', 'on', /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
            log_wrapper.log_doc_event(`Updated inlayHints.enabled = 'on' for "${language_id}"`);
        }
        if (config.get('inlayHints.maximumLength') != 0) {
            // Worklog: The first time I tried this the solution was half-working - we wouldn't see the inlay-hiding "three dots", but the alignment was still broken in a weird way. But the problem disappeared on "restart".
            await config.update('inlayHints.maximumLength', 0, /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
            log_wrapper.log_doc_event(`Updated inlayHints.maximumLength = 0 for "${language_id}"`);
        }
        if (config.get('inlayHints.fontFamily') != '') {
            await config.update('inlayHints.fontFamily', '', /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
            log_wrapper.log_doc_event(`Updated inlayHints.fontFamily = '' for "${language_id}"`);
        }
        if (config.get('inlayHints.fontSize') != '') {
            await config.update('inlayHints.fontSize', '', /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
            log_wrapper.log_doc_event(`Updated inlayHints.fontSize = '' for "${language_id}"`);
        }
        if (config.get('inlayHints.padding') != '') {
            await config.update('inlayHints.padding', '', /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
            log_wrapper.log_doc_event(`Updated inlayHints.padding = '' for "${language_id}"`);
        }
        // It would be nice to disable word wrap for the current editor only if aligned (because tables don't wrap) and then enable word wrap again, but there is no way to do this currently.
        // Permanent disabling of wordWrap for csvs is a bad idea because in non-aligned mode it actually becomes an advantage for Rainbow non-alignment high info density paradigm.
    } catch (e) {
        log_wrapper.log_doc_event("Failed to update inlay hints user settings: " + e);
    }
}


function enable_dynamic_semantic_tokenization() {
    // Some themes can disable semantic highlighting e.g. "Tokyo Night" https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night, so we explicitly override the default setting in "configurationDefaults" section of package.json.
    // We also add all other csv dialects to "configurationDefaults":"editor.semanticHighlighting.enabled" override in order to enable comment line highlighting.
    // Conflict with some other extensions might also cause semantic highlighting to completely fail (although this could be caused by the theme issue described above), see https://github.com/mechatroner/vscode_rainbow_csv/issues/149.
    let token_provider = new RainbowTokenProvider();
    if (rainbow_token_event !== null) {
        rainbow_token_event.dispose();
    }
    let document_selector = { language: DYNAMIC_CSV }; // Use '*' to select all languages if needed.
    rainbow_token_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(document_selector, token_provider, tokens_legend);
}


function row_background_enabled(fileName) {
    let default_enabled = get_from_config('highlight_rows', false);
    return extension_context.toggle_enabled_rows_backgrounds.has(fileName) ? extension_context.toggle_enabled_rows_backgrounds.get(fileName) : default_enabled;
}


function toggle_row_background() {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    var active_doc = get_active_doc(active_editor);
    if (!active_doc)
        return;
    let [_delim, policy, _comment_prefix] = get_dialect(active_doc);
    if (policy == QUOTED_RFC_POLICY) {
        // TODO use correct parsing logic to be able to handle multiline records and correctly highlight them
        show_single_line_error("Alternating row background highlighting is currently unavailable for CSVs with multiline records");
        return;
    }
    let log_wrapper = new StackContextLogWrapper('toggle_row_background');
    log_wrapper.log_doc_event('starting', active_doc);
    let enabled_before = row_background_enabled(active_doc.fileName);
    let highlighting_enabled = !enabled_before;
    extension_context.toggle_enabled_rows_backgrounds.set(active_doc.fileName, highlighting_enabled);
    if (highlighting_enabled) {
        log_wrapper.log_doc_event('enabled', active_doc);
    } else {
        log_wrapper.log_doc_event('disabled', active_doc);
        // Use empty range array to reset the decorations.
        active_editor.setDecorations(alternate_row_background_decoration_type, []);
    }

    // Always re-register the provider to force decorations update on toggle.
    register_row_background_decorations_provider();
    if (alt_background_cursor_subscription == null) {
        alt_background_cursor_subscription = vscode.window.onDidChangeTextEditorSelection(handle_cursor_movement_for_alt_row_background);
    }
}


function register_column_tracking_decorations_provider() {
    let decorations_provider = new ColumnTrackingDecorationsProvider();
    if (column_tracking_decoration_event !== null) {
        column_tracking_decoration_event.dispose();
    }
    // There is no way to register ranged decorations provider so we register a fake ranged semantic token provider that doesn't provide any tokens.
    column_tracking_decoration_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(get_all_rainbow_lang_selector(), decorations_provider, tokens_legend);
}


function toggle_column_tracking() {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    var active_doc = get_active_doc(active_editor);
    if (!active_doc || !is_rainbow_dialect_doc(active_doc))
        return;
    let log_wrapper = new StackContextLogWrapper('toggle_column_tracking');
    log_wrapper.log_doc_event('starting', active_doc);

    let position = ll_rainbow_utils().get_cursor_position_if_unambiguous(active_editor);
    if (!position) {
        return;
    }
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    let cursor_position_info = ll_rainbow_utils().get_cursor_position_info(vscode, active_doc, delim, policy, comment_prefix, position);
    if (!cursor_position_info)
        return;
    if (cursor_position_info.is_comment) {
        vscode.window.showErrorMessage('Unable to track comments');
        return;
    }

    let fileName = active_doc.fileName;
    let trackings = extension_context.tracked_columns.has(fileName) ? extension_context.tracked_columns.get(fileName) : new TrackedColumns();
    if (trackings.is_tracked(cursor_position_info.column_number)) {
        let decoration_type = trackings.get_decoration_type(cursor_position_info.column_number);
        // Use empty range array to reset the decorations.
        active_editor.setDecorations(decoration_type, []);
        log_wrapper.log_doc_event('disabling column tracking', active_doc);
    } else {
        log_wrapper.log_doc_event('enabling column tracking', active_doc);
    }
    if (!trackings.toggle_tracking(cursor_position_info.column_number)) {
        vscode.window.showErrorMessage(`Unable to track more than ${trackings.num_tracked()} columns`);
        return;
    }
    extension_context.tracked_columns.set(fileName, trackings);
    // Always re-register the column tracking decorations provider to refresh the decorations so that toggle effect is immediately visible
    register_column_tracking_decorations_provider();
}


function register_row_background_decorations_provider() {
    let decorations_provider = new RowBackgroundDecorationsProvider();
    if (row_background_decoration_event !== null) {
        row_background_decoration_event.dispose();
    }
    // There is no way to register ranged decorations provider so we register a fake ranged semantic token provider that doesn't provide any tokens.
    row_background_decoration_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(get_all_rainbow_lang_selector(), decorations_provider, tokens_legend);
}


function register_comment_tokenization_handler() {
    let token_provider = new CommentTokenProvider();
    if (comment_token_event !== null) {
        comment_token_event.dispose();
    }
    let document_selector = [];
    for (let language_id in dialect_map) {
        if (dialect_map.hasOwnProperty(language_id) && language_id != DYNAMIC_CSV) {
            // We skip DYNAMIC_CSV here because its provider already handles comment lines.
            document_selector.push({language: language_id});
        }
    }
    comment_token_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(document_selector, token_provider, tokens_legend);
}


function get_selected_separator(active_editor, active_doc) {
    if (!active_editor || !active_doc)
        return '';
    let selection = active_editor.selection;
    if (!selection) {
        return '';
    }
    if (selection.start.line != selection.end.line) {
        return '';
    }
    let separator = active_doc.lineAt(selection.start.line).text.substring(selection.start.character, selection.end.character);
    return separator;
}


async function choose_dynamic_separator(integration_test_options=null) {
    let log_wrapper = new StackContextLogWrapper('choose_dynamic_separator');
    log_wrapper.log_doc_event('starting', active_doc);
    let active_editor = get_active_editor();
    if (!active_editor) {
        return;
    }
    var active_doc = get_active_doc(active_editor);
    if (!is_eligible_doc(active_doc)) {
        return;
    }
    let selected_separator = get_selected_separator(active_editor, active_doc);
    if (!dialect_selection_html_template) {
        dialect_selection_html_template = await load_resource_file_universal('dialect_select.html');
    }
    dialect_panel = vscode.window.createWebviewPanel('rainbow-dialect-select', 'Choose CSV Dialect', vscode.ViewColumn.Beside, {enableScripts: true});
    dialect_panel.webview.html = adjust_webview_paths(dialect_panel, dialect_selection_html_template, ['dialect_select.js']);
    dialect_panel.webview.onDidReceiveMessage(function(message) { handle_dialect_selection_message(active_doc, dialect_panel, message, selected_separator, log_wrapper, integration_test_options); });
}


function show_choose_dynamic_separator_button() {
    if (!dynamic_dialect_select_button)
        dynamic_dialect_select_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    dynamic_dialect_select_button.text = 'Choose Separator...';
    dynamic_dialect_select_button.tooltip = 'Click to choose Dynamic CSV separator';
    dynamic_dialect_select_button.command = 'rainbow-csv.RainbowSeparator';
    dynamic_dialect_select_button.show();
}


async function enable_rainbow_features_if_csv(active_doc, log_wrapper) {
    log_wrapper.log_doc_event('start enable-rainbow-features-if-csv', active_doc);
    if (!is_rainbow_dialect_doc(active_doc)) {
        log_wrapper.log_simple_event('abort enable-rainbow-features-if-csv: non-rainbow dialect');
        return;
    }
    var language_id = active_doc.languageId;
    if (language_id == DYNAMIC_CSV && extension_context.dynamic_dialect_for_next_request != null) {
        await save_dynamic_info(extension_context, active_doc.fileName, extension_context.dynamic_dialect_for_next_request);
        extension_context.dynamic_dialect_for_next_request = null;
    }
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (!delim || !policy) {
        log_wrapper.log_simple_event('abort enable-rainbow-features-if-csv: missing delim or policy');
        // Make sure UI elements are disabled except dynamic separator selection button.
        disable_ui_elements();
        show_choose_dynamic_separator_button();
        return;
    }
    if (comment_prefix) {
        // It is currently impoossible to set comment_prefix on document level, so we have to set it on language level instead.
        // This could potentially cause minor problems in very rare situations.
        // Applying 'setLanguageConfiguration' doesn't disable static configuration in language-configuration.json.
        vscode.languages.setLanguageConfiguration(language_id, { comments: { lineComment: comment_prefix } });
    }
    if (language_id == DYNAMIC_CSV) {
        // Re-enable tokenization to explicitly trigger the highlighting. Sometimes this doesn't happen automatically.
        enable_dynamic_semantic_tokenization();
    }
    enable_rainbow_ui(active_doc);
    if (extension_context.virtual_alignment_mode == 'always') {
        await configure_inlay_hints_alignment(language_id, log_wrapper);
        reenable_inlay_hints_provider();
    }
    await csv_lint(active_doc, /*is_manual_op=*/false);
    log_wrapper.log_simple_event('finish enable-rainbow-features-if-csv');
}


function disable_ui_elements() {
    let all_buttons = [extension_context.lint_status_bar_button, rbql_status_bar_button, copy_back_button, align_shrink_button, column_info_button, dynamic_dialect_select_button];
    for (let i = 0; i < all_buttons.length; i++) {
        if (all_buttons[i])
            all_buttons[i].hide();
    }
    if (column_info_cursor_subscription) {
        column_info_cursor_subscription.dispose();
        column_info_cursor_subscription = null;
    }
    if (alt_background_cursor_subscription) {
        alt_background_cursor_subscription.dispose();
        alt_background_cursor_subscription = null;
    }
}


function disable_rainbow_features_if_non_csv(active_doc, log_wrapper) {
    log_wrapper.log_doc_event('start disable-rainbow-features-if-non-csv', active_doc);
    if (is_rainbow_dialect_doc(active_doc)) {
        log_wrapper.log_simple_event('abort disable-rainbow-features-if-non-csv: is rainbow dialect');
        return;
    }
    log_wrapper.log_simple_event('perform disable-rainbow-features-if-non-csv');
    disable_ui_elements();
}


function get_active_editor() {
    var active_window = vscode.window;
    if (!active_window)
        return null;
    var active_editor = active_window.activeTextEditor;
    if (!active_editor)
        return null;
    return active_editor;
}


function get_active_doc(active_editor=null) {
    if (!active_editor)
        active_editor = get_active_editor();
    if (!active_editor)
        return null;
    var active_doc = active_editor.document;
    if (!active_doc)
        return null;
    return active_doc;
}


function is_active_doc(vscode_doc) {
    let active_doc = get_active_doc();
    return (active_doc && active_doc.uri && vscode_doc && vscode_doc.uri && active_doc.uri.toString() == vscode_doc.uri.toString());
}


function virtual_alignment_enabled(virtual_alignment_mode, custom_alignment_mode) {
    return (custom_alignment_mode == VA_EXPLICITLY_ENABLED) || (virtual_alignment_mode == "always" && custom_alignment_mode != VA_EXPLICITLY_DISABLED);
}


function config_virtual_alignment_button(align_shrink_button, is_aligned) {
    if (is_aligned) {
        align_shrink_button.text = 'Shrink';
        align_shrink_button.tooltip = 'Click to remove virtual alignment from this file';
        align_shrink_button.command = 'rainbow-csv.VirtualShrink';
    } else {
        align_shrink_button.text = 'Align';
        align_shrink_button.tooltip = 'Click to virtually align';
        align_shrink_button.command = 'rainbow-csv.VirtualAlign';
    }
}


function config_whitespace_alignment_button(align_shrink_button, is_aligned) {
    if (is_aligned) {
        align_shrink_button.text = 'Shrink';
        align_shrink_button.tooltip = 'Click to shrink table - trim whitespaces from fields';
        align_shrink_button.command = 'rainbow-csv.Shrink';
    } else {
        align_shrink_button.text = 'Align';
        align_shrink_button.tooltip = 'Click to align table with extra whitespaces';
        align_shrink_button.command = 'rainbow-csv.Align';
    }
}


function show_align_shrink_button(file_path) {
    if (!align_shrink_button)
        align_shrink_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    if (extension_context.virtual_alignment_mode == 'disabled') {
        let is_aligned = whitespace_aligned_files.has(file_path);
        config_whitespace_alignment_button(align_shrink_button, is_aligned);
    } else {
        let custom_alignment_mode = custom_virtual_alignment_modes.get(file_path);
        let is_aligned = virtual_alignment_enabled(extension_context.virtual_alignment_mode, custom_alignment_mode);
        config_virtual_alignment_button(align_shrink_button, is_aligned);
    }
    align_shrink_button.show();
}


function do_show_column_info_button(full_report, short_report) {
    if (!column_info_button)
        column_info_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    column_info_button.text = short_report;
    column_info_button.tooltip = full_report;
    column_info_button.show();
}


function make_hover(document, language_id, position, cancellation_token) {
    if (!get_from_config('enable_tooltip', false)) {
        return;
    }
    let [delim, policy, comment_prefix] = get_dialect(document);
    let cursor_position_info = ll_rainbow_utils().get_cursor_position_info(vscode, document, delim, policy, comment_prefix, position);
    if (!cursor_position_info || cancellation_token.isCancellationRequested)
        return null;
    let enable_tooltip_column_names = get_from_config('enable_tooltip_column_names', false);
    let header = get_header(document, delim, policy, comment_prefix)[1];
    if (!header) {
        return null;
    }
    let [_full_text, short_report] = ll_rainbow_utils().format_cursor_position_info(cursor_position_info, header, enable_tooltip_column_names, /*show_comments=*/true, /*max_label_length=*/25);
    let mds = new vscode.MarkdownString();
    // Using a special pseudo-language grammar trick for highlighting the hover text using the same color as the column doesn't work anymore due to https://github.com/microsoft/vscode/issues/53723.
    mds.appendText(short_report);
    return new vscode.Hover(mds);
}


function show_column_info_button() {
    let active_editor = get_active_editor();
    if (!active_editor) {
        return false;
    }
    let position = ll_rainbow_utils().get_cursor_position_if_unambiguous(active_editor);
    if (!position) {
        return false;
    }
    let active_doc = get_active_doc(active_editor);
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    let cursor_position_info = ll_rainbow_utils().get_cursor_position_info(vscode, active_doc, delim, policy, comment_prefix, position);
    if (!cursor_position_info)
        return false;
    let enable_tooltip_column_names = get_from_config('enable_tooltip_column_names', false);
    let header = get_header(active_doc, delim, policy, comment_prefix)[1];
    if (!header)
        return false;
    let [full_report, short_report] = ll_rainbow_utils().format_cursor_position_info(cursor_position_info, header, enable_tooltip_column_names, /*show_comments=*/false, /*max_label_length=*/25);
    do_show_column_info_button(full_report, short_report);
    return true;
}


function show_rbql_status_bar_button() {
    if (!rbql_status_bar_button)
        rbql_status_bar_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    rbql_status_bar_button.text = 'Query';
    rbql_status_bar_button.tooltip = 'Click to run SQL-like RBQL query';
    rbql_status_bar_button.command = 'rainbow-csv.RBQL';
    rbql_status_bar_button.show();
}


function show_rbql_copy_to_source_button(file_path) {
    let parent_table_path = result_set_parent_map.get(safe_lower(file_path));
    if (!parent_table_path || parent_table_path.indexOf(scratch_buf_marker) != -1)
        return;
    let parent_basename = path.basename(parent_table_path);
    if (!copy_back_button)
        copy_back_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    copy_back_button.text = 'Copy Back';
    copy_back_button.tooltip = `Copy to parent table: ${parent_basename}`;
    copy_back_button.command = 'rainbow-csv.CopyBack';
    copy_back_button.show();
}


async function csv_lint(active_doc, is_manual_op) {
    if (!active_doc)
        active_doc = get_active_doc();
    if (!is_rainbow_dialect_doc(active_doc)) {
        return null;
    }
    var file_path = active_doc.fileName; // For new untitled scratch documents this would be "Untitled-1", "Untitled-2", etc...
    var language_id = active_doc.languageId;
    let lint_cache_key = `${file_path}.${language_id}`;
    if (!is_manual_op) {
        if (extension_context.lint_results.has(lint_cache_key))
            return null;
        if (!get_from_config('enable_auto_csv_lint', false))
            return null;
    }
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null)
        return null;
    extension_context.lint_results.set(lint_cache_key, {is_processing: true});
    ll_rainbow_utils().show_lint_status_bar_button(vscode, extension_context, file_path, language_id); // Visual feedback.
    let detect_trailing_spaces = get_from_config('csv_lint_detect_trailing_spaces', false);
    let [_records, _num_records_parsed, fields_info, first_defective_line, first_trailing_space_line, _comments] = fast_load_utils.parse_document_records(active_doc, delim, policy, comment_prefix, /*stop_on_warning=*/true, /*max_records_to_parse=*/-1, /*collect_records=*/false, /*preserve_quotes_and_whitespaces=*/true, detect_trailing_spaces);
    let is_ok = (first_defective_line === null && fields_info.size <= 1);
    let lint_result = {'is_ok': is_ok, 'first_defective_line': first_defective_line, 'fields_info': fields_info, 'first_trailing_space_line': first_trailing_space_line};
    extension_context.lint_results.set(lint_cache_key, lint_result);
    if (is_manual_op) {
        // Need timeout here to give user enough time to notice green -> yellow -> green switch, this is a sort of visual feedback.
        await sleep(500);
    }
    ll_rainbow_utils().show_lint_status_bar_button(vscode, extension_context, file_path, language_id); // Visual feedback.
    return lint_result;
}


async function csv_lint_cmd() {
    // TODO re-run on each file save with content change.
    let lint_report_for_unit_tests = await csv_lint(null, /*is_manual_op=*/true);
    return lint_report_for_unit_tests;
}


async function run_internal_test_cmd(integration_test_options) {
    if (integration_test_options && integration_test_options.check_initialization_state) {
        // This mode is to ensure that the most basic operations do not cause rainbow csv to load extra (potentially heavy) code.
        // Vim uses the same approach with its plugin/autoload folder layout design.
        return {initialized: global_state !== null, lazy_loaded: rainbow_utils !== null};
    }
    if (integration_test_options && integration_test_options.check_last_rbql_report) {
        return _unit_test_last_rbql_report;
    }
    if (integration_test_options && integration_test_options.check_last_rbql_warnings) {
        return {'warnings': _unit_test_last_warnings};
    }
    return null;
}


async function show_warnings(warnings) {
    _unit_test_last_warnings = [];
    if (!warnings || !warnings.length)
        return;
    var active_window = vscode.window;
    if (!active_window)
        return null;
    for (var i = 0; i < warnings.length; i++) {
        // Do not "await" warning messages because the promise gets resolved only on warning dismissal.
        active_window.showWarningMessage('RBQL warning: ' + warnings[i]);
    }
    _unit_test_last_warnings = warnings;
}


async function handle_rbql_result_file_node(text_doc, delim, policy, warnings) {
    try {
        await vscode.window.showTextDocument(text_doc);
    } catch (_error) {
        show_single_line_error('Unable to open RBQL result document');
        return;
    }
    let language_id = map_dialect_to_language_id(delim, policy);
    if (language_id && text_doc.languageId != language_id) {
        // In non-web version we open a new doc without preset filetype, so we need to manually set it.
        await vscode.languages.setTextDocumentLanguage(text_doc, language_id);
    }
    await show_warnings(warnings);
}


async function handle_rbql_result_file_web(text_doc, warnings) {
    try {
        await vscode.window.showTextDocument(text_doc);
    } catch (_error) {
        show_single_line_error('Unable to open RBQL result document');
        return;
    }
    await show_warnings(warnings);
}



function command_async_wrapper(cmd, args) {
    return new Promise(function (resolve, reject) {
        let stdout_data = '';
        let stderr_data = '';
        let process = child_process.spawn(cmd, args, {'windowsHide': true});
        process.stdout.on('data', function(data) {
            stdout_data += data.toString();
        });
        process.stderr.on('data', function(data) {
            stderr_data += data.toString();
        });
        process.on('close', function (code) { // Consider replacing 'close' with 'exit'.
            resolve({'exit_code': code, 'stdout': stdout_data, 'stderr': stderr_data});
        });
        process.on('error', function (err) {
            reject(err);
        });
    });
}


function get_dst_table_name(input_path, output_delim) {
    var table_name = path.basename(input_path);
    var orig_extension = path.extname(table_name);
    var delim_ext_map = {'\t': '.tsv', ',': '.csv'};
    var dst_extension = '.txt';
    if (delim_ext_map.hasOwnProperty(output_delim)) {
        dst_extension = delim_ext_map[output_delim];
    } else if (orig_extension.length > 1) {
        dst_extension = orig_extension;
    }
    let result_table_name = table_name + dst_extension;
    if (result_table_name == table_name) { // Just being paranoid to avoid overwriting input table accidentally when output dir configured to be the same as input.
        result_table_name += '.txt';
    }
    return result_table_name;
}


function file_path_to_query_key(file_path) {
    return (file_path && file_path.indexOf(scratch_buf_marker) != -1) ? scratch_buf_marker : file_path;
}


function get_dst_table_dir(input_table_path) {
    let rbql_output_dir = get_from_config('rbql_output_dir', 'TMP');
    if (rbql_output_dir == 'TMP') {
        return os.tmpdir();
    } else if (rbql_output_dir == 'INPUT') {
        return path.dirname(input_table_path);
    } else {
        // Return custom directory. If the directory does not exist or isn't writable RBQL itself will report more or less clear error.
        return rbql_output_dir;
    }
}


async function run_python3_and_parse_output(cmd, args) {
    let execution_result = null;
    try {
        execution_result = await command_async_wrapper(cmd, args);
    } catch (error) {
        let error_details = error ? error.name + ': ' + error.message : '';
        let error_msg = 'Something went wrong.\nMake sure you have python3 installed and added to the PATH variable in your OS.\nOr you can use RBQL with JavaScript instead - it should work out of the box\nDetails:\n' + error_details;
        return {error_type: 'Integration', error_msg: error_msg, invocation_error: 1};
    }
    let json_report = execution_result.stdout;
    if (!json_report || execution_result.stderr) {
        let error_msg = execution_result.stderr || 'empty error';
        return {error_type: 'Integration', error_msg: error_msg};
    }
    try {
        return JSON.parse(json_report);
    } catch (_e) {
        return {error_type: 'Integration', error_msg: 'Unable to parse JSON report'};
    }
}


async function send_report_to_webview(webview, error_type, error_msg) {
    let report_msg = {'msg_type': 'rbql_report'};
    if (error_type)
        report_msg["error_type"] = error_type;
    if (error_msg)
        report_msg["error_msg"] = error_msg;
    _unit_test_last_rbql_report = report_msg;
    await webview.postMessage(report_msg);
}


async function run_rbql_query(webview, input_path, csv_encoding, backend_language, rbql_query, output_dialect, with_headers, integration_test_options=null) {
    // TODO refactor this function.
    let log_wrapper = new StackContextLogWrapper('run-rbql-query');
    log_wrapper.log_simple_event('start');
    last_rbql_queries.set(file_path_to_query_key(input_path), rbql_query);
    const test_marker = 'test ';

    let [input_delim, input_policy, comment_prefix] = [rbql_context.delim, rbql_context.policy, rbql_context.comment_prefix];
    let [output_delim, output_policy] = [input_delim, input_policy];
    if (output_dialect == 'csv')
        [output_delim, output_policy] = [',', QUOTED_POLICY];
    if (output_dialect == 'tsv')
        [output_delim, output_policy] = ['\t', SIMPLE_POLICY];
    rbql_context.output_delim = output_delim;
    rbql_context.output_policy = output_policy;

    let output_path = is_web_ext ? null : path.join(get_dst_table_dir(input_path), get_dst_table_name(input_path, output_delim));
    let strip_spaces_from_fields = get_from_config('rbql_strip_spaces', true);
    let python_cmd = integration_test_options && integration_test_options.hasOwnProperty('python_cmd') ? integration_test_options['python_cmd'] : 'python3';

    if (rbql_query.startsWith(test_marker)) {
        log_wrapper.log_simple_event('test mode');
        let args = [absolute_path_map['rbql mock/rbql_mock.py'], rbql_query];
        let execution_result = await run_python3_and_parse_output(python_cmd, args);
        console.log(JSON.stringify(execution_result));
        if (execution_result.hasOwnProperty('error_type') || execution_result.hasOwnProperty('error_msg')) {
            await send_report_to_webview(webview, execution_result.error_type, execution_result.error_msg);
            return;
        }
        await send_report_to_webview(webview, null, null);
        return;
    }
    if (backend_language == 'js') {
        log_wrapper.log_simple_event('using js backend');
        let warnings = [];
        let result_doc = null;
        let target_language_id = map_dialect_to_language_id(output_delim, output_policy);
        try {
            if (is_web_ext) {
                log_wrapper.log_simple_event('using web mode');
                let result_lines = await ll_rainbow_utils().rbql_query_web(rbql_query, rbql_context.input_document, input_delim, input_policy, output_delim, output_policy, warnings, with_headers, comment_prefix, strip_spaces_from_fields);
                let output_doc_cfg = {content: result_lines.join('\n'), language: target_language_id};
                if (target_language_id == DYNAMIC_CSV) {
                    extension_context.dynamic_dialect_for_next_request = make_dialect_info(output_delim, output_policy);
                }
                extension_context.autodetection_temporarily_disabled_for_rbql = true;
                result_doc = await vscode.workspace.openTextDocument(output_doc_cfg);
                await send_report_to_webview(webview, null, null);
                await handle_rbql_result_file_web(result_doc, warnings);
                extension_context.dynamic_dialect_for_next_request = null;
                extension_context.autodetection_temporarily_disabled_for_rbql = false;
                log_wrapper.log_simple_event('finished OK');
            } else {
                log_wrapper.log_simple_event('using electron mode');
                let csv_options = {'bulk_read': true, 'trim_whitespaces': strip_spaces_from_fields};
                await ll_rainbow_utils().rbql_query_node(global_state, rbql_query, input_path, input_delim, input_policy, output_path, output_delim, output_policy, csv_encoding, warnings, with_headers, comment_prefix, /*user_init_code=*/'', csv_options);
                result_set_parent_map.set(safe_lower(output_path), input_path);
                if (target_language_id == DYNAMIC_CSV) {
                    extension_context.dynamic_dialect_for_next_request = make_dialect_info(output_delim, output_policy);
                }
                extension_context.autodetection_temporarily_disabled_for_rbql = true;
                result_doc = await vscode.workspace.openTextDocument(output_path);
                await send_report_to_webview(webview, null, null);
                await handle_rbql_result_file_node(result_doc, output_delim, output_policy, warnings);
                extension_context.dynamic_dialect_for_next_request = null;
                extension_context.autodetection_temporarily_disabled_for_rbql = false;
                log_wrapper.log_simple_event('finished OK');
            }
        } catch (e) {
            extension_context.autodetection_temporarily_disabled_for_rbql = false;
            let [error_type, error_msg] = ll_rbql_csv().exception_to_error_info(e);
            log_wrapper.log_simple_event('finished with error');
            await send_report_to_webview(webview, error_type, error_msg);
            return;
        }
    } else {
        log_wrapper.log_simple_event('using python backend');
        if (is_web_ext) {
            await send_report_to_webview(webview, 'Input error', 'Python backend for RBQL is not supported in web version, please use JavaScript backend.');
            return;
        }
        let cmd_safe_query = Buffer.from(rbql_query, "utf-8").toString("base64");
        if (!comment_prefix) {
            comment_prefix = '';
        }
        let args = [absolute_path_map['rbql_core/vscode_rbql.py'], cmd_safe_query, input_path, input_delim, input_policy, output_path, output_delim, output_policy, comment_prefix, csv_encoding];
        if (with_headers)
            args.push('--with_headers');
        if (strip_spaces_from_fields)
            args.push('--strip_spaces');
        let execution_result = await run_python3_and_parse_output(python_cmd, args);
        if (execution_result.hasOwnProperty('error_type') || execution_result.hasOwnProperty('error_msg')) {
            log_wrapper.log_simple_event('finished with error');
            await send_report_to_webview(webview, execution_result.error_type, execution_result.error_msg);
            return;
        }
        log_wrapper.log_simple_event('finished OK');
        await send_report_to_webview(webview, null, null);
        extension_context.autodetection_stoplist.add(output_path);
        result_set_parent_map.set(safe_lower(output_path), input_path);
        extension_context.autodetection_temporarily_disabled_for_rbql = true;
        let output_doc = null;
        try {
            output_doc = await vscode.workspace.openTextDocument(output_path);
        } finally {
            extension_context.autodetection_temporarily_disabled_for_rbql = false;
        }
        // We need dynamic_dialect_for_next_request here because we can't open the output_doc with DYNAMIC_CSV, it will be switched on doc-ropen.
        let target_language_id = map_dialect_to_language_id(output_delim, output_policy);
        if (target_language_id == DYNAMIC_CSV) {
            extension_context.dynamic_dialect_for_next_request = make_dialect_info(output_delim, output_policy);
        }
        await handle_rbql_result_file_node(output_doc, output_delim, output_policy, execution_result.warnings);
        extension_context.dynamic_dialect_for_next_request = null;
    }
}


async function set_header_line() {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    var active_doc = get_active_doc(active_editor);
    if (!active_doc)
        return;

    let [delim, policy, _comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        show_single_line_error('Unable to set header line: no separator specified');
        return;
    }
    let file_path = active_doc.fileName;
    if (!file_path) {
        show_single_line_error('Unable to set header line for non-file documents');
        return;
    }
    let selection = active_editor.selection;
    let header_line = selection.start.line;
    let raw_header = active_doc.lineAt(header_line).text;
    let header = csv_utils.smart_split(raw_header, delim, policy, false)[0];

    // The advantage of saving the parsed list of column names is that it would stay consistent even if some lines are added/deleted before the header line (line migration).
    // The advantage of saving the line number is that it is resilient to modifications of header line itself.
    // It is also possible to verify consistency of header line and header column names and return null if they are inconsistent and return null.
    // But discarding the inconsistent header line is probably not very obvious and user-friendly way of handling this.
    // Showing the inconsistent header is probably better since these column names are only used for UI/readability and a wrong sticky line obviously hints on what happened and how to fix it, while a suddenly disappeared sticky line could be seen as a bug.
    await save_to_global_state(make_header_key(file_path), {header_line_num: header_line, header: header});
    // Re-register sticky header provider because otherwise it won't re-generate the symbols unless there were no edits to the file.
    reconfigure_sticky_header_provider(/*force=*/true);
}


function preserve_original_language_id_if_needed(file_path, original_language_id, original_language_ids) {
    if (!file_path) {
        return;
    }
    if (dialect_map.hasOwnProperty(original_language_id)) {
        // This is to prevent invalid noop "dynamic csv" -> "dynamic csv" switch without carying dialect info.
        // And to simplify state management in general by not storing any rainbow dialects.
        return;
    }
    original_language_ids.set(file_path, original_language_id);
}


async function set_comment_prefix() {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    var active_doc = get_active_doc(active_editor);
    if (!active_doc)
        return;
    let selection = active_editor.selection;
    if (!selection) {
        show_single_line_error("Selection is empty");
        return;
    }
    let comment_prefix = active_doc.lineAt(selection.start.line).text.substring(selection.start.character, selection.end.character);
    extension_context.custom_comment_prefixes.set(active_doc.fileName, comment_prefix);
    if (!comment_prefix) {
        manual_comment_prefix_stoplist.add(active_doc.fileName);
    } else {
        manual_comment_prefix_stoplist.delete(active_doc.fileName);
    }
    if (comment_prefix) {
        vscode.languages.setLanguageConfiguration(active_doc.languageId, { comments: { lineComment: comment_prefix } });
    }
    if (active_doc.languageId == DYNAMIC_CSV) {
        // Re-enable tokenization to explicitly trigger the highlighting. Sometimes this doesn't happen automatically.
        enable_dynamic_semantic_tokenization();
    } else {
        // Re-enable comment tokenization to explicitly adjust the comment highlighting (sometimes to disable it if comment prefix is set to an empty string).
        register_comment_tokenization_handler();
    }
}


async function restore_original_language() {
    let log_wrapper = new StackContextLogWrapper('restore_original_language');
    let active_doc = get_active_doc();
    log_wrapper.log_doc_event('starting', active_doc);
    if (!active_doc)
        return;
    let file_path = active_doc.fileName;
    let original_language_id = PLAINTEXT;
    if (extension_context.original_language_ids.has(file_path)) {
        original_language_id = extension_context.original_language_ids.get(file_path);
    }
    if (dialect_map.hasOwnProperty(original_language_id) || !dialect_map.hasOwnProperty(active_doc.languageId)) {
        show_single_line_error("Unable to restore original language");
        return;
    }

    if (file_path) {
        // Preserve rainbow language info, so that the user can later re-enable it for this file.
        let current_language_info = {language_id: active_doc.languageId};
        let dynamic_dialect_info = get_dynamic_info(file_path);
        if (dynamic_dialect_info) {
            current_language_info.dynamic_dialect_info = dynamic_dialect_info;
        }
        extension_context.reenable_rainbow_language_infos.set(file_path, current_language_info);
        extension_context.autodetection_stoplist.add(file_path);
    }

    active_doc = await vscode.languages.setTextDocumentLanguage(active_doc, original_language_id);
    // There is no onDidChangeActiveTextEditor even for language change so we need to explicitly disable rainbow features.
    disable_rainbow_features_if_non_csv(active_doc, log_wrapper);
    // The only reason why we might want to clean up dynamic dialect info here is to facilitate triggering dynamic_document_dialect selection UI after manual filetype switch at the later point so that the user could choose a different dynamic dialect without manual selection by cursor / commands.
    remove_dynamic_info(file_path);
}


async function reenable_rainbow_language() {
    var active_doc = get_active_doc();
    if (!active_doc)
        return;
    let file_path = active_doc.fileName;
    if (!extension_context.reenable_rainbow_language_infos.has(file_path)) {
        // Make sure we have previous rainbow dialect saved.
        show_single_line_error("Unable to re-enable rainbow highlighting automatically, select filetype manually or select a new separator with cursor.");
        return;
    }
    let rainbow_language_info = extension_context.reenable_rainbow_language_infos.get(file_path);
    // Delete from the stoplist to revert "Rainbow Off" side-effects.
    extension_context.autodetection_stoplist.delete(file_path);
    if (rainbow_language_info.hasOwnProperty('dynamic_dialect_info')) {
        await save_dynamic_info(extension_context, file_path, rainbow_language_info.dynamic_dialect_info);
    }
    // Preserve current (non-rainbow) language id to allow switching between "Rainbow Off"/"Rainbow On".
    preserve_original_language_id_if_needed(file_path, active_doc.languageId, extension_context.original_language_ids);
    extension_context.reenable_rainbow_language_infos.delete(file_path);
    await vscode.languages.setTextDocumentLanguage(active_doc, rainbow_language_info.language_id);
}


async function set_join_table_name() {
    if (is_web_ext) {
        show_single_line_error('This command is currently unavailable in web mode.');
        return;
    }
    var active_doc = get_active_doc();
    if (!active_doc)
        return;
    let file_path = active_doc.fileName;
    if (!file_path) {
        show_single_line_error('Unable to use this document as join table');
        return;
    }
    var title = "Input table name to use in RBQL JOIN expressions instead of table path";
    var input_box_props = {"prompt": title, "value": 'b'};
    let table_name = await vscode.window.showInputBox(input_box_props);
    if (!table_name)
        return; // User pressed Esc and closed the input box.
    await save_to_global_state(ll_rainbow_utils().make_table_name_key(table_name), file_path);
}


async function set_virtual_header() {
    var active_doc = get_active_doc();
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        show_single_line_error('Unable to set virtual header: no separator specified');
        return;
    }
    var file_path = active_doc.fileName;
    if (!file_path) {
        show_single_line_error('Unable to edit column names for non-file documents');
        return;
    }
    var old_header = get_header(active_doc, delim, policy, comment_prefix)[1];
    var title = "Adjust column names displayed in hover tooltips. Actual header line and file content won't be affected.";
    var old_header_str = old_header ? quoted_join(old_header, delim) : '';
    var input_box_props = {"prompt": title, "value": old_header_str};
    let raw_new_header = await vscode.window.showInputBox(input_box_props);
    if (!raw_new_header)
        return; // User pressed Esc and closed the input box.
    let new_header = csv_utils.smart_split(raw_new_header, delim, policy, false)[0];
    await save_to_global_state(make_header_key(file_path), {header_line_num: null, header: new_header});
}


async function column_edit(edit_mode) {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    let active_doc = active_editor.document;
    if (!active_doc)
        return;
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        return;
    }
    let position = ll_rainbow_utils().get_cursor_position_if_unambiguous(active_editor);
    if (!position) {
        show_single_line_error('Unable to enter column edit mode: make sure that no text is selected and only one cursor is active');
        return;
    }
    if (active_doc.lineCount >= 10000) {
        show_single_line_error('Multicursor column edit works only for files smaller than 10000 lines.');
        return;
    }
    let col_num = (ll_rainbow_utils().get_cursor_position_info(vscode, active_doc, delim, policy, comment_prefix, position)).column_number;
    let [selections, error_msg, warning_msg] = ll_rainbow_utils().generate_column_edit_selections(vscode, active_doc, delim, policy, comment_prefix, edit_mode, col_num);
    if (error_msg !== null) {
        show_single_line_error(error_msg);
        return;
    }
    if (warning_msg) {
        vscode.window.showWarningMessage(warning_msg);
    }
    active_editor.selections = selections;
    // Call showTextDocument so that the editor will gain focus and the cursors will become active and blinking. This is a critical step here!
    await vscode.window.showTextDocument(active_doc);
}


async function virtual_shrink_table() {
    let active_doc = get_active_doc();
    if (!active_doc) {
        return;
    }
    custom_virtual_alignment_modes.set(active_doc.fileName, VA_EXPLICITLY_DISABLED);
    // Call reenable_inlay_hints_provider to immediately get rid of existing inlay hints.
    reenable_inlay_hints_provider();
    show_align_shrink_button(active_doc.fileName);
}


async function whitespace_shrink_table() {
    let active_editor = get_active_editor();
    let active_doc = get_active_doc(active_editor);
    if (!is_rainbow_dialect_doc(active_doc)) {
        return;
    }
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        return;
    }
    let progress_options = {location: vscode.ProgressLocation.Window, title: 'Rainbow CSV'};
    await vscode.window.withProgress(progress_options, async (progress) => {
        await report_progress(progress, 'Preparing');
        let [shrinked_doc_text, first_failed_line] = ll_rainbow_utils().shrink_columns(active_doc, delim, policy, comment_prefix);
        if (first_failed_line !== null) {
            show_single_line_error(`Unable to shrink: Inconsistent double quotes at line ${first_failed_line + 1}`);
            return;
        }
        whitespace_aligned_files.delete(active_doc.fileName);
        show_align_shrink_button(active_doc.fileName);
        if (shrinked_doc_text === null) {
            vscode.window.showWarningMessage('No trailing whitespaces found, skipping');
            return;
        }
        await report_progress(progress, 'Shrinking columns');
        await replace_doc_content(active_editor, active_doc, shrinked_doc_text);
    });
}


async function virtual_align_table() {
    let log_wrapper = new StackContextLogWrapper('virtual_align_table');
    let active_doc = get_active_doc();
    if (!is_rainbow_dialect_doc(active_doc))
        return;
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        return;
    }
    let [whole_doc_column_stats, first_failed_line, _records, _comments] = ll_rainbow_utils().calc_column_stats(active_doc, delim, policy, comment_prefix, extension_context.double_width_alignment);
    if (first_failed_line === null) {
        log_wrapper.log_doc_event('Whole doc alignment stats were reset', active_doc);
        whole_doc_alignment_stats.set(active_doc.fileName, whole_doc_column_stats);
    } else {
        log_wrapper.log_doc_event('Failed to reset whole doc alignment stats', active_doc);
    }
    // If there is a parsing error, just don't set whole-doc stats in that case the aligner would use local stats, still better than nothing.
    custom_virtual_alignment_modes.set(active_doc.fileName, VA_EXPLICITLY_ENABLED);

    // Make sure the alignment is enabled - this is needed if it is disabled but was just called manually from the command palette.
    await configure_inlay_hints_alignment(active_doc.languageId, log_wrapper);
    reenable_inlay_hints_provider();
    show_align_shrink_button(active_doc.fileName);
}


async function content_modifying_align_table() {
    let active_editor = get_active_editor();
    let active_doc = get_active_doc(active_editor);
    if (!is_rainbow_dialect_doc(active_doc))
        return;
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        return;
    }
    let progress_options = {location: vscode.ProgressLocation.Window, title: 'Rainbow CSV'};
    await vscode.window.withProgress(progress_options, async (progress) => {
        await report_progress(progress, 'Calculating column statistics');
        let [column_stats, first_failed_line, records, comments] = ll_rainbow_utils().calc_column_stats(active_doc, delim, policy, comment_prefix, extension_context.double_width_alignment);
        if (first_failed_line) {
            show_single_line_error(`Unable to align: Inconsistent double quotes at line ${first_failed_line + 1}`);
            return;
        }
        await report_progress(progress, 'Preparing final alignment');
        let aligned_lines = ll_rainbow_utils().align_columns(records, comments, column_stats, delim);
        let aligned_doc_text = aligned_lines.join('\n');

        await report_progress(progress, 'Aligning columns');
        await replace_doc_content(active_editor, active_doc, aligned_doc_text);
        whitespace_aligned_files.add(active_doc.fileName);
        show_align_shrink_button(active_doc.fileName);
    });
}


async function do_copy_back(query_result_doc, active_editor) {
    let data = query_result_doc.getText();
    let active_doc = get_active_doc(active_editor);
    if (!active_doc)
        return;
    await replace_doc_content(active_editor, active_doc, data);
}


async function copy_back() {
    if (is_web_ext) {
        show_single_line_error('This command is currently unavailable in web mode.');
        return;
    }
    let result_doc = get_active_doc();
    if (!result_doc)
        return;
    let file_path = result_doc.fileName;
    let parent_table_path = result_set_parent_map.get(safe_lower(file_path));
    if (!parent_table_path)
        return;
    let parent_doc = await vscode.workspace.openTextDocument(parent_table_path);
    let parent_editor = await vscode.window.showTextDocument(parent_doc);
    await do_copy_back(result_doc, parent_editor);
}


async function update_query_history(query) {
    let history_list = get_from_global_state('rbql_query_history', []);
    let old_index = history_list.indexOf(query);
    if (old_index != -1) {
        history_list.splice(old_index, 1);
    } else if (history_list.length >= 20) {
        history_list.splice(0, 1);
    }
    history_list.push(query);
    await save_to_global_state('rbql_query_history', history_list);
}


async function handle_dialect_selection_message(origin_doc, dialect_webview_panel, message, selected_separator, log_wrapper, integration_test_options) {
    if (!message) {
        return;
    }
    if (message.msg_type == 'dialect_handshake') {
        let init_msg = {'msg_type': 'dialect_handshake', 'selected_separator': selected_separator};
        if (integration_test_options && integration_test_options.integration_test) {
            init_msg['integration_test'] = true;
        }
        await dialect_webview_panel.webview.postMessage(init_msg);
    }

    if (message.msg_type == 'apply_dialect') {
        let delim = message.delim;
        let policy = message.policy;
        let comment_prefix = message.comment_prefix;
        if (policy == 'whitespace' && delim != ' ') {
            show_single_line_error("Selected policy can only be used with whitespace separator");
            return;
        }
        if (policy == 'double_escape' && delim == '"') {
            show_single_line_error("Double quote separator in incompatible with double quote escape policy");
            return;
        }
        if (!delim) {
            show_single_line_error("Separator is empty");
            return;
        }
        if ([SIMPLE_POLICY, QUOTED_RFC_POLICY, QUOTED_POLICY, WHITESPACE_POLICY].indexOf(policy) == -1) {
            show_single_line_error("Selected policy is empty or not supported");
            return;
        }
        // Dispose/close the webview so that the origin_doc becomes active and rainbow features can be applied immediately.
        dialect_webview_panel.dispose();

        await save_dynamic_info(extension_context, origin_doc.fileName, make_dialect_info(delim, policy));
        extension_context.custom_comment_prefixes.set(origin_doc.fileName, comment_prefix);
        if (origin_doc.languageId == DYNAMIC_CSV && is_active_doc(origin_doc)) {
            // Filetype was already "dynamic csv", just re-highlight the file properly.
            await enable_rainbow_features_if_csv(origin_doc, log_wrapper);
        } else {
            await vscode.languages.setTextDocumentLanguage(origin_doc, DYNAMIC_CSV);
        }
    }
}


async function handle_rbql_client_message(webview, message, integration_test_options=null) {
    let message_type = message['msg_type'];

    if (message_type == 'handshake') {
        var backend_language = get_from_global_state('rbql_backend_language', 'js');
        var encoding = get_from_global_state('rbql_encoding', 'utf-8');
        var init_msg = {'msg_type': 'handshake', 'backend_language': backend_language, 'encoding': encoding};
        ll_rainbow_utils().sample_preview_records_from_context(rbql_context, init_msg, preview_window_size, cached_table_parse_result);
        let path_key = file_path_to_query_key(rbql_context.input_document_path);
        if (last_rbql_queries.has(path_key))
            init_msg['last_query'] = last_rbql_queries.get(path_key);
        let history_list = get_from_global_state('rbql_query_history', []);
        init_msg['query_history'] = history_list;
        init_msg['policy'] = rbql_context.policy;
        init_msg['with_headers'] = rbql_context.with_headers;
        init_msg['header_for_ui'] = rbql_context.header_for_ui;
        init_msg['is_web_ext'] = is_web_ext;
        if (integration_test_options) {
            init_msg['integration_test_language'] = integration_test_options.rbql_backend;
            init_msg['integration_test_query'] = integration_test_options.rbql_query;
            init_msg['integration_test_with_headers'] = integration_test_options.with_headers || false;
            init_msg['integration_test_delay'] = integration_test_options.integration_test_delay || 2000;
        }
        await webview.postMessage(init_msg);
    }

    if (message_type == 'fetch_table_header') {
        try {
            let table_id = message['table_id'];
            let encoding = message['encoding'];

            let input_table_dir = rbql_context.input_document_path ? path.dirname(rbql_context.input_document_path) : null;
            let table_path = ll_rainbow_utils().find_table_path(global_state, input_table_dir, table_id);
            if (!table_path)
                return;
            let header_line = await ll_rainbow_utils().read_header(table_path, encoding);
            if (!header_line) {
                return;
            }
            let [fields, warning] = csv_utils.smart_split(header_line, rbql_context.delim, rbql_context.policy, false);
            if (!warning) {
                webview.postMessage({'msg_type': 'fetch_table_header_response', 'header_for_ui': fields});
            }
        } catch (e) {
            console.error('Unable to get join table header: ' + String(e));
        }
    }

    if (message_type == 'update_query') {
        let rbql_query = message['query'];
        if (!rbql_query)
            return;
        if (rbql_context.input_document_path)
            last_rbql_queries.set(file_path_to_query_key(rbql_context.input_document_path), rbql_query);
    }

    if (message_type == 'with_headers_change') {
        rbql_context.with_headers = message['with_headers'];
        if (rbql_context.input_document_path)
            await save_to_global_state(make_with_headers_key(rbql_context.input_document_path), rbql_context.with_headers);
    }

    if (message_type == 'navigate') {
        var navig_direction = message['direction'];
        if (navig_direction == 'backward') {
            rbql_context.requested_start_record -= preview_window_size;
        } else if (navig_direction == 'forward') {
            rbql_context.requested_start_record += preview_window_size;
        } else if (navig_direction == 'begin') {
            rbql_context.requested_start_record = 0;
        } else if (navig_direction == 'end') {
            rbql_context.requested_start_record = rbql_context.input_document.lineCount; // This is just max possible value which is incorrect and will be adjusted later.
        }
        let protocol_message = {'msg_type': 'navigate'};
        ll_rainbow_utils().sample_preview_records_from_context(rbql_context, protocol_message, preview_window_size, cached_table_parse_result);
        await webview.postMessage(protocol_message);
    }

    if (message_type == 'run') {
        let rbql_query = message['query'];
        let backend_language = message['backend_language'];
        let encoding = message['encoding'];
        let output_dialect = message['output_dialect'];
        let with_headers = message['with_headers'];
        await update_query_history(rbql_query);
        await run_rbql_query(webview, rbql_context.input_document_path, encoding, backend_language, rbql_query, output_dialect, with_headers, integration_test_options);
    }

    if (message_type == 'edit_udf') {
        if (is_web_ext) {
            await send_report_to_webview(webview, 'Input error', 'UDFs are currently not supported in web version');
            return;
        }
        let backend_language = message['backend_language'];
        let udf_file_path = null;
        let default_content = '';
        if (backend_language == 'js') {
            udf_file_path = path.join(os.homedir(), '.rbql_init_source.js');
            default_content = ll_rainbow_utils().get_default_js_udf_content();
        } else {
            udf_file_path = path.join(os.homedir(), '.rbql_init_source.py');
            default_content = ll_rainbow_utils().get_default_python_udf_content();
        }
        if (!fs.existsSync(udf_file_path)) {
            fs.writeFileSync(udf_file_path, default_content);
        }
        let udf_doc = await vscode.workspace.openTextDocument(udf_file_path);
        await vscode.window.showTextDocument(udf_doc);
    }

    if (message_type == 'global_param_change') {
        await save_to_global_state(message['key'], message['value']);
    }
}


function adjust_webview_paths(preview_panel, client_html, paths_list) {
    for (const local_path of paths_list) {
        let adjusted_webview_url = null;
        if (is_web_ext) {
            adjusted_webview_url = absolute_path_map[local_path];
        } else {
            adjusted_webview_url = preview_panel.webview.asWebviewUri(vscode.Uri.file(absolute_path_map[local_path]));
        }
        client_html = client_html.replace(`src="${local_path}"`, `src="${adjusted_webview_url}"`);
    }
    return client_html;
}


async function edit_rbql(integration_test_options=null) {
    let active_window = vscode.window;
    if (!active_window)
        return;
    let active_editor = active_window.activeTextEditor;
    if (!active_editor)
        return;
    let active_doc = active_editor.document;
    if (!active_doc)
        return;
    let orig_uri = active_doc.uri;
    if (!orig_uri)
        return;
    // For web orig_uri.scheme can have other valid values e.g. `vscode-test-web` when testing the browser integration.
    if (orig_uri.scheme != 'file' && orig_uri.scheme != 'untitled' && !is_web_ext)
        return;
    if (orig_uri.scheme == 'file' && active_doc.isDirty && !is_web_ext) {
        show_single_line_error("Unable to run RBQL: file has unsaved changes");
        return;
    }
    let input_path = null;
    if (orig_uri.scheme == 'untitled' && !is_web_ext) {
        // Scheme 'untitled' means that the document is a scratch buffer that hasn't been saved yet, see https://code.visualstudio.com/api/references/document-selector
        let data = active_doc.getText();
        let rnd_suffix = String(Math.floor(Math.random() * 1000000));
        input_path = path.join(os.tmpdir(), `${scratch_buf_marker}_${rnd_suffix}.txt`);
        // TODO consider adding username to the input_path and using chmod 600 on it.
        fs.writeFileSync(input_path, data);
    } else {
        input_path = active_doc.fileName;
    }

    if (!input_path) {
        show_single_line_error("Unable to run RBQL for this file");
        return;
    }

    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        policy = 'monocolumn';
        delim = 'monocolumn';
    }
    let with_headers_by_default = get_from_config('rbql_with_headers_by_default', false);
    let with_headers = get_from_global_state(make_with_headers_key(input_path), with_headers_by_default);
    // TODO Find a way to use `get_header()` instead.
    let header_for_ui = get_header_from_document(active_doc, delim, policy, comment_prefix)[1];
    rbql_context = {
        "input_document": active_doc,
        "input_document_path": input_path,
        "requested_start_record": 0,
        "delim": delim,
        "policy": policy,
        "comment_prefix": comment_prefix,
        "with_headers": with_headers,
        "header_for_ui": header_for_ui
    };

    rbql_preview_panel = vscode.window.createWebviewPanel('rbql-console', 'RBQL Console', vscode.ViewColumn.Active, {enableScripts: true});
    if (!client_html_template) {
        client_html_template = await load_resource_file_universal('rbql_client.html');
    }
    rbql_preview_panel.webview.html = adjust_webview_paths(rbql_preview_panel, client_html_template, ['contrib/textarea-caret-position/index.js', 'rbql_suggest.js', 'rbql_client.js', 'rbql_logo.svg']);
    rbql_preview_panel.webview.onDidReceiveMessage(function(message) { handle_rbql_client_message(rbql_preview_panel.webview, message, integration_test_options); });
}


function autodetect_dialect(config, active_doc, candidate_separators, comment_prefix) {
    let candidate_dialects = [];
    for (let separator of candidate_separators) {
        let policy = get_default_policy(separator);
        let dialect_id = map_dialect_to_language_id(separator, policy);
        if (!dialect_id || !policy)
            continue;
        candidate_dialects.push([dialect_id, separator, policy]);
        if (separator == ',' || separator == ';') {
            candidate_dialects.push([DYNAMIC_CSV, separator, QUOTED_RFC_POLICY]);
        }
    }
    let detect_trailing_spaces = get_from_config('csv_lint_detect_trailing_spaces', false, config);
    let [best_dialect, best_separator, best_policy, best_dialect_first_trailing_space_line, best_num_records_parsed] = [null, null, null, null, null];
    let best_dialect_num_columns = 1;
    for (let candidate_dialect of candidate_dialects) {
        let [dialect_id, separator, policy] = candidate_dialect;
        let [_records, num_records_parsed, fields_info, first_defective_line, first_trailing_space_line, _comments] = fast_load_utils.parse_document_records(active_doc, separator, policy, comment_prefix, /*stop_on_warning=*/true, /*max_records_to_parse=*/-1, /*collect_records=*/false, /*preserve_quotes_and_whitespaces=*/true, detect_trailing_spaces, /*min_num_fields_for_autodetection=*/best_dialect_num_columns + 1);
        if (first_defective_line !== null || fields_info.size != 1)
            continue;
        let num_columns = Array.from(fields_info.keys())[0];
        if (num_columns >= best_dialect_num_columns + 1) {
            best_dialect_num_columns = num_columns;
            best_num_records_parsed = num_records_parsed;
            [best_dialect, best_separator, best_policy] = [dialect_id, separator, policy];
            best_dialect_first_trailing_space_line = first_trailing_space_line;
        }
    }
    return [best_dialect, best_separator, best_policy, best_dialect_first_trailing_space_line, best_num_records_parsed];
}


function autodetect_dialect_frequency_based(active_doc, candidate_separators, max_num_chars_to_test) {
    let [best_dialect, best_separator, best_policy] = ['csv', ',', QUOTED_POLICY];
    let best_dialect_frequency = 0;
    let data = active_doc.getText();
    if (!data)
        return [best_dialect, best_separator, best_policy];
    for (let separator of candidate_separators) {
        if (separator == ' ' || separator == '.')
            continue; // Whitespace and dot have advantage over other separators in this algorithm, so we just skip them.
        let frequency = 0;
        for (let j = 0; j < max_num_chars_to_test && j < data.length; j++) {
            if (data[j] == separator)
                frequency += 1;
        }
        if (frequency > best_dialect_frequency) {
            let policy = get_default_policy(separator);
            let dialect_id = map_dialect_to_language_id(separator, policy);
            [best_dialect, best_separator, best_policy] = [dialect_id, separator, policy];
            best_dialect_frequency = frequency;
        }
    }
    return [best_dialect, best_separator, best_policy];
}


async function try_autodetect_and_set_rainbow_filetype(vscode, config, extension_context, active_doc, logging_context_id=null) {
    // VSCode to some extent is capable of "remembering" doc id in the previous invocation, at least when used in debug mode.

    // VSCode may (and will?) forget documentId of a document "A" if document "B" is opened in the tab where "A" was (double VS single click in file browser panel).
    // see https://code.visualstudio.com/docs/getstarted/userinterface#_preview-mode
    let log_wrapper = new StackContextLogWrapper('autodetection', logging_context_id);
    log_wrapper.log_doc_event('starting...', active_doc);
    if (extension_context.autodetection_temporarily_disabled_for_rbql) {
        log_wrapper.log_simple_event('abort: disabled for rbql');
        return [active_doc, false];
    }
    if (!is_eligible_doc(active_doc)) {
        log_wrapper.log_simple_event('abort: ineligible doc');
        return [active_doc, false];
    }
    if (!get_from_config('enable_separator_autodetection', false, config)) {
        log_wrapper.log_simple_event('abort: disabled in config');
        return [active_doc, false];
    }
    var file_path = active_doc.fileName;
    var original_language_id = active_doc.languageId;
    if (extension_context.autodetection_stoplist.has(file_path)) {
        log_wrapper.log_simple_event('abort: doc path in stoplist');
        return [active_doc, false];
    }
    // The check below also prevents double autodetection from handle_doc_open fork in the new_doc with adjusted language id.
    let is_default_csv = (file_path.endsWith('.csv') || file_path.endsWith('.CSV')) && original_language_id == 'csv';
    if (original_language_id != PLAINTEXT && !is_default_csv) {
        log_wrapper.log_simple_event('abort: ineligible original language id');
        return [active_doc, false];
    }

    let candidate_separators = get_from_config('autodetect_separators', [], config).map((s) => s === 'TAB' ? '\t' : s);
    if (!dialect_map.hasOwnProperty(original_language_id) &&
        last_closed_rainbow_doc_info &&
        last_closed_rainbow_doc_info.file_path === file_path &&
        Math.abs(Date.now() - last_closed_rainbow_doc_info.timestamp) < 1000) {
        // The same file was recently closed with rainbow dialect and re-opened as another filetype, most likely manual language switch, do not autodetect.
        // Do not add to autodetection_stoplist because it goes against VSCode approach to discard all language mode state on reopen.
        // Also adding to autodetection_stoplist would make "curious doc reopening" problem worse.
        // Do not initialize "Rainbow ON" because either it was already enabled or user goes through the native UI and therefore showing Rainbow ON is not idiomatic/consistent/relevant.
        log_wrapper.log_simple_event('abort: recent doc language switch prevention');
        return [active_doc, false];
    }

    let comment_prefix_for_autodetection = extension_context.comment_prefix || '#'; // Assume '#' as a comment prefix for autodetection purposes only.
    log_wrapper.log_simple_event('starting standard dialect autodetection...');
    let min_num_lines = get_from_config('autodetection_min_line_count', 10, config);
    let [rainbow_csv_language_id, delim, policy, first_trailing_space_line, num_records_parsed] = autodetect_dialect(config, active_doc, candidate_separators, comment_prefix_for_autodetection);
    if (rainbow_csv_language_id && num_records_parsed >= min_num_lines) {
        // Add the file to lint results to avoid re-parsing it with CSV Lint later.
        extension_context.lint_results.set(`${file_path}.${rainbow_csv_language_id}`, {'is_ok': true, 'first_trailing_space_line': first_trailing_space_line});
    } else if (is_default_csv) {
        // Smart autodetection method has failed, but we need to choose a separator because this is a csv file. Let's just find the most popular one within the first N characters.
        if (!rainbow_csv_language_id) {
            log_wrapper.log_simple_event('starting frequency-based dialect autodetection...');
            [rainbow_csv_language_id, delim, policy] = autodetect_dialect_frequency_based(active_doc, candidate_separators, /*max_num_chars_to_test=*/10000);
        }
    } else {
        // Either rainbow_csv_language_id already null or not enough records parsed.
        rainbow_csv_language_id = null;
    }
    if (!rainbow_csv_language_id) {
        log_wrapper.log_simple_event('abort: content-based autodetection did not detect anything');
        return [active_doc, false];
    }
    // Comment prefix used here is global/default so we don't store it in custom comment prefix list.
    if (rainbow_csv_language_id == DYNAMIC_CSV) {
        await save_dynamic_info(extension_context, file_path, make_dialect_info(delim, policy));
    }
    if (rainbow_csv_language_id == original_language_id) {
        log_wrapper.log_simple_event('abort: autodetected dialect matches the original one');
        return [active_doc, false];
    }

    // We can't add the doc path to autodetection_stoplist here (for autodetect-once semantic)
    // because the doc could be in preview mode and VSCode won't remember language_id so we might need to autodetect it again later.

    preserve_original_language_id_if_needed(file_path, original_language_id, extension_context.original_language_ids);
    log_wrapper.log_simple_event(`autodetection successful - switching from ${original_language_id} to ${rainbow_csv_language_id}`);
    let new_doc = await vscode.languages.setTextDocumentLanguage(active_doc, rainbow_csv_language_id);
    log_wrapper.log_doc_event('after language switch', new_doc);
    return [new_doc, true];
}


async function handle_first_edit_for_an_empty_doc(change_event) {
    if (!change_event)
        return;
    if (doc_first_edit_subscription) {
        doc_first_edit_subscription.dispose();
        doc_first_edit_subscription = null;
    }
    let log_wrapper = new StackContextLogWrapper('handle_first_edit_for_an_empty_doc');
    log_wrapper.log_doc_event('starting', change_event.document);
    await try_autodetect_and_set_rainbow_filetype(vscode, vscode.workspace.getConfiguration('rainbow_csv'), extension_context, change_event.document, log_wrapper.context_id);
}


async function handle_editor_switch(editor) {
    let log_wrapper = new StackContextLogWrapper('handle_editor_switch');
    // This event is not triggered when language mode is changed.
    // We need this handler to hide and show UI elements when user switches between the doc tabs.
    // When the file is larger than 50MB, editor and active_doc are null/undefined.
    let active_doc = get_active_doc(editor);
    log_wrapper.log_doc_event('editor switch', active_doc);
    // When switching between the open non-preview doc tabs the doc open/close events are (typically) not triggered for the actual files (exception is "curious doc reopening" problem, see DEV_README.md)
    // but open and close events could (and will) be triggered for some virtual files e.g. paired files with .git scheme.
    disable_rainbow_features_if_non_csv(active_doc, log_wrapper);
    await enable_rainbow_features_if_csv(active_doc, log_wrapper); // No-op if non-csv.
}


function do_handle_cursor_movement_for_column_info() {
    if (!show_column_info_button() && column_info_button) {
        column_info_button.hide();
    }
}


function handle_cursor_movement_for_column_info(_cursor_event) {
    if (cursor_timeout_handle_for_column_info !== null) {
        clearTimeout(cursor_timeout_handle_for_column_info);
    }
    // We need timeout delay here to deduplicate/debounce events from multiple consecutive movements, see https://stackoverflow.com/a/49050990/2898283.
    cursor_timeout_handle_for_column_info = setTimeout(() => do_handle_cursor_movement_for_column_info(), 10);
}


function do_handle_cursor_movement_for_row_background() {
    let active_editor = get_active_editor();
    if (active_editor && active_editor.visibleRanges && active_editor.visibleRanges.length) {
        provide_row_background_decorations(active_editor, active_editor.visibleRanges[0]);
    }
}


function handle_cursor_movement_for_alt_row_background(_cursor_event) {
    if (cursor_timeout_handle_for_alt_row_background !== null) {
        clearTimeout(cursor_timeout_handle_for_alt_row_background);
    }
    // We need timeout delay here to deduplicate/debounce events from multiple consecutive movements, see https://stackoverflow.com/a/49050990/2898283.
    cursor_timeout_handle_for_alt_row_background = setTimeout(() => do_handle_cursor_movement_for_row_background(), 10);
}


async function handle_doc_open(new_doc) {
    // The onDidOpenTextDocument handler will trigger for already "opened" docs too if they are re-opened in the same tab. Example
    // Document "A" opens in tab1 -> triggers onDidOpenTextDocument
    // Document "B" opens in tab1 -> triggers onDidOpenTextDocument  (this could happen if user clicks on document "B" in the left file browser panel)
    // Document "A" opens in tab1 -> triggers onDidOpenTextDocument again! The previous languageId is reset.
    // In other words if user opens a different document in the same tab (single click VS double click in the file browser panel) it may trigger the current document closing and opening of a new doc.
    // This behavior is called Preview Mode, see https://vscode.one/new-tab-vscode/ and https://code.visualstudio.com/docs/getstarted/userinterface#_preview-mode

    let log_wrapper = new StackContextLogWrapper('handle_doc_open');
    log_wrapper.log_doc_event('opening doc', new_doc);

    if (!is_eligible_doc(new_doc)) {
        log_wrapper.log_simple_event('abort: ineligible doc');
        return;
    }

    // Register a handler for copy-pasting CSV-formated data into an empty doc. Empty docs have lineCount equal 1.
    if (get_from_config('enable_separator_autodetection', false) && doc_first_edit_subscription === null && new_doc.isUntitled && new_doc.lineCount <= 1) {
        doc_first_edit_subscription = vscode.workspace.onDidChangeTextDocument(handle_first_edit_for_an_empty_doc);
        log_wrapper.log_simple_event('creating empty doc subscription');
        return;
    }
    let filetype_changed = false;
    [new_doc, filetype_changed] = await try_autodetect_and_set_rainbow_filetype(vscode, vscode.workspace.getConfiguration('rainbow_csv'), extension_context, new_doc, log_wrapper.context_id);

    // If autodetection was successful we are essentially forking this handler for the new doc and the code below will be executed twice: here and in the handle_doc_open for the `new_doc`.
    // There is still some benefit for not having and additional check to prevent this double execution: disable/enable ui calls are idempotent and the code is more robust/reliable this way.
    log_wrapper.log_doc_event(`after autodetection. filetype changed: ${filetype_changed}`, new_doc);
    // There might be some redundancy between this code and onDidChangeActiveTextEditor handler, but this actually desired as long as methods are idempotent.
    // It is much better to do the same thing twice (if it is idempotent) to ensure the required behavior than rely on assumptions about external VSCode mechanisms (aka Defensive Programming).
    if (is_active_doc(new_doc)) {
        log_wrapper.log_simple_event('active doc - enabling features');
        disable_rainbow_features_if_non_csv(new_doc, log_wrapper); // We need this to handle manual switch from csv to txt, this would immediately remove UI elements, that would stay otherwise.
        await enable_rainbow_features_if_csv(new_doc, log_wrapper); // No-op if non-csv.
    }
    log_wrapper.log_simple_event('finishing');
}


async function handle_doc_close(doc_to_close) {
    // NOTE: Closing of doc A (csv) followed by opening of the same doc A (non-csv) can also be caused by the "curious doc reopening" problem, see DEV_README.md.

    // This is a workaround hack to prevent repeated autodetection on csv -> txt language switch.
    // In that case a csv file will be closed and shortly after a txt file with the same path will be opened, so we don't want to apply autodetection to it.
    // This will also trigger when virtual docs (e.g. `.git` pairs) are closed, but it is probably fine to reset last_closed_rainbow_doc_info in that case.
    let log_wrapper = new StackContextLogWrapper('handle_doc_close');
    log_wrapper.log_doc_event('closing doc', doc_to_close);
    if (!is_rainbow_dialect_doc(doc_to_close)) {
        log_wrapper.log_simple_event('abort: non rainbow doc');
        last_closed_rainbow_doc_info = null;
        return;
    }

    last_closed_rainbow_doc_info = {file_path: doc_to_close.fileName, timestamp: Date.now()};

    if (is_active_doc(doc_to_close)) {
        log_wrapper.log_simple_event('disabling ui elements');
        // In order to disable elements we need to check that the closed rainbow doc is in fact active doc to avoid removing UI when a non-focused CSV or non-csv file is being closed.
        // Inactive CSV closing can happen in the background if user closes with "x" top-right corner button another inactive tab with another CSV file.
        disable_ui_elements();
    }
    log_wrapper.log_simple_event('finalizing');
}


async function restart_extension_config(_config_change_event) {
    // Here `_config_change_event` allows to check if a specific configuration was affected but another way to do this is just to compare before and after values.
    let logging_enabled_before = extension_context.logging_enabled;
    extension_context.logging_enabled = get_from_config('enable_debug_logging', false);
    if (extension_context.logging_enabled && !logging_enabled_before) {
        let log_wrapper = new StackContextLogWrapper('config change');
        log_wrapper.log_simple_event('logging enabled');
    }
    reconfigure_sticky_header_provider();
    if (get_from_config('highlight_rows', false)) {
        register_row_background_decorations_provider();
    }
    extension_context.virtual_alignment_mode = get_from_config('virtual_alignment_mode', 'disabled');
    extension_context.double_width_alignment = get_from_config('double_width_alignment', true);
    extension_context.virtual_alignment_char = get_from_config('virtual_alignment_char', 'middot');
    extension_context.virtual_alignment_vertical_grid = get_from_config('virtual_alignment_vertical_grid', false);
    extension_context.comment_prefix = get_from_config('comment_prefix', '');
}


function quote_field(field, delim) {
    if (field.indexOf('"') != -1 || field.indexOf(delim) != -1) {
        return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
}


function quoted_join(fields, delim) {
    var quoted_fields = fields.map(function(val) { return quote_field(val, delim); });
    return quoted_fields.join(delim);
}


async function make_preview(uri, preview_mode) {
    if (is_web_ext) {
        show_single_line_error('This command is currently unavailable in web mode.');
        return;
    }
    var file_path = uri.fsPath;
    if (!file_path || !fs.existsSync(file_path)) {
        vscode.window.showErrorMessage('Invalid file');
        return;
    }

    var size_limit = 1024000; // ~1MB
    var file_size_in_bytes = fs.statSync(file_path)['size'];
    if (file_size_in_bytes <= size_limit) {
        vscode.window.showWarningMessage('Rainbow CSV: The file is not big enough, showing the full file instead. Use this preview for files larger than 1MB');
        let full_orig_doc = await vscode.workspace.openTextDocument(file_path);
        await vscode.window.showTextDocument(full_orig_doc);
        return;
    }

    let file_basename = path.basename(file_path);
    const out_path = path.join(os.tmpdir(), `.rb_csv_preview.${preview_mode}.${file_basename}`);

    fs.open(file_path, 'r', (err, fd) => {
        if (err) {
            console.log(err.message);
            vscode.window.showErrorMessage('Unable to preview file');
            return;
        }

        var buffer = Buffer.alloc(size_limit);
        let read_begin_pos = preview_mode == 'head' ? 0 : Math.max(file_size_in_bytes - size_limit, 0);
        fs.read(fd, buffer, 0, size_limit, read_begin_pos, function(err, _num) {
            if (err) {
                console.log(err.message);
                vscode.window.showErrorMessage('Unable to preview file');
                return;
            }

            const buffer_str = buffer.toString();
            // TODO handle old mac '\r' line endings - still used by Mac version of Excel.
            let content = null;
            if (preview_mode == 'head') {
                content = buffer_str.substr(0, buffer_str.lastIndexOf(buffer_str.includes('\r\n') ? '\r\n' : '\n'));
            } else {
                content = buffer_str.substr(buffer_str.indexOf('\n') + 1);
            }
            fs.writeFileSync(out_path, content);
            vscode.workspace.openTextDocument(out_path).then(doc => vscode.window.showTextDocument(doc));
        });
    });
}


function register_csv_hover_info_provider(language_id, context) {
    let hover_provider = vscode.languages.registerHoverProvider(language_id, {
        provideHover(document, position, token) {
            return make_hover(document, language_id, position, token);
        }
    });
    context.subscriptions.push(hover_provider);
}


function provide_tracked_column_decorations(active_editor, range) {
    let document = active_editor.document;
    if (!document) {
        return;
    }
    let [delim, policy, comment_prefix] = get_dialect(document);
    if (!policy) {
        return;
    }
    if (!extension_context.tracked_columns.has(document.fileName)) {
        return;
    }
    let tracked_columns = extension_context.tracked_columns.get(document.fileName);
    if (tracked_columns.empty()) {
        return;
    }
    let tracked_column_ranges = new Map();
    for (let column_num of tracked_columns.get_tracked_columns()) {
        tracked_column_ranges.set(column_num, new Array());
    }

    let parsing_range = ll_rainbow_utils().extend_range_by_margin(vscode, document, range, 50);
    let row_infos = ll_rainbow_utils().parse_document_range(vscode, document, delim, /*include_delim_length_in_ranges=*/true, policy, comment_prefix, parsing_range)[0];
    for (let row_info of row_infos) {
        if (row_info.comment_range !== null) {
            continue;
        } else {
            for (let column_num of tracked_columns.get_tracked_columns()) {
                for (let record_range of row_info.record_ranges[column_num]) {
                    // One logical field can map to multiple tokens if it spans multiple lines because VSCode doesn't support multiline tokens.
                    tracked_column_ranges.get(column_num).push(record_range);
                }
            }
        }
    }

    for (let column_num of tracked_columns.get_tracked_columns()) {
        let current_column_ranges = tracked_column_ranges.get(column_num);
        let tracked_decoration_type = tracked_columns.get_decoration_type(column_num);
        active_editor.setDecorations(tracked_decoration_type, current_column_ranges);
    }
}


function provide_row_background_decorations(active_editor, range) {
    let document = active_editor.document;
    if (!document || !is_rainbow_dialect_doc(document)) {
        return;
    }
    if (!row_background_enabled(document.fileName)) {
        return;
    }
    let [_delim, policy, _comment_prefix] = get_dialect(document);
    if (policy == QUOTED_RFC_POLICY) {
        // TODO handle rfc records here, do actual parsing
        // Currently this early return is needed here too because this provider can trigger for rfc dialects when background decorations are enabled by default.
        return;
    }
    let selection_start_line = -1;
    let selection_end_line = -1;
    let selection = active_editor.selection;
    if (selection && !selection.isEmpty) {
        selection_start_line = selection.start.line;
        selection_end_line = selection.end.line;
    }
    let decorations_margin = 10;
    let begin_line = Math.max(0, range.start.line - decorations_margin);
    let end_line = Math.min(document.lineCount, range.end.line + decorations_margin);
    let alternating_row_ranges = [];
    for (let lnum = begin_line; lnum < end_line; lnum++) {
        if (lnum >= selection_start_line && lnum <= selection_end_line) {
            continue;
        }
        if (lnum % 2 == 1) {
            let line_text = document.lineAt(lnum).text;
            alternating_row_ranges.push(new vscode.Range(lnum, 0, lnum, line_text.length));
        }
    }
    active_editor.setDecorations(alternate_row_background_decoration_type, alternating_row_ranges);
}


class RowBackgroundDecorationsProvider {
    constructor() {
    }
    async provideDocumentRangeSemanticTokens(_document, range, _token) {
        // This is a "fake" semantic tokens provider which actually provides decorations instead of semantic tokens.
        // TODO Consider using onDidChangeTextEditorVisibleRanges event instead when its behavior is fixed, see: https://github.com/microsoft/vscode/issues/154977
        let active_editor = get_active_editor();
        if (active_editor) {
            provide_row_background_decorations(active_editor, range);
        }
        return null;
    }
}


class ColumnTrackingDecorationsProvider {
    constructor() {
    }
    async provideDocumentRangeSemanticTokens(_document, range, _token) {
        // This is a "fake" semantic tokens provider which actually provides decorations instead of semantic tokens.
        // TODO Consider using onDidChangeTextEditorVisibleRanges event instead when its behavior is fixed, see: https://github.com/microsoft/vscode/issues/154977
        let active_editor = get_active_editor();
        if (active_editor) {
            provide_tracked_column_decorations(active_editor, range);
        }
        return null;
    }
}


class RainbowTokenProvider {
    // We don't utilize typescript `implement` interface keyword, because TS doesn't seem to be exporting interfaces to JS (unlike classes).
    constructor() {
    }
    async provideDocumentRangeSemanticTokens(document, range, _token) {
        let [delim, policy, comment_prefix] = get_dialect(document);
        if (!policy || document.languageId != DYNAMIC_CSV) {
            return null;
        }

        let parsing_range = ll_rainbow_utils().extend_range_by_margin(vscode, document, range, 50);
        let row_infos = ll_rainbow_utils().parse_document_range(vscode, document, delim, /*include_delim_length_in_ranges=*/true, policy, comment_prefix, parsing_range)[0];
        // Create a new builder to clear the previous tokens.
        const builder = new vscode.SemanticTokensBuilder(tokens_legend);
        for (let row_info of row_infos) {
            if (row_info.comment_range !== null) {
                builder.push(row_info.comment_range, COMMENT_TOKEN);
            } else {
                for (let col_num = 0; col_num < row_info.record_ranges.length; col_num++) {
                    let token_id = col_num % rainbow_token_types.length;
                    if (token_id == 0) {
                        // Do not highlight the first `rainbow1` group altogether, since it has the default color anyway.
                        // Dynamic highlighting with undefined syntax like `rainbow1` is a little glitchy e.g. in case when re-tokenization occurs these undefined groups may fail to override the previous defined groups.
                        // Another benefit is that by reducing the number of groups we are speeding things up a little.
                        continue;
                    }
                    for (let record_range of row_info.record_ranges[col_num]) {
                        // One logical field can map to multiple tokens if it spans multiple lines because VSCode doesn't support multiline tokens.
                        builder.push(record_range, rainbow_token_types[token_id]);
                    }
                }
            }
        }
        return builder.build();
    }
}


class CommentTokenProvider {
    constructor() {
    }
    async provideDocumentRangeSemanticTokens(doc, range, _token) {
        let [_delim, policy, comment_prefix] = get_dialect(doc);
        if (manual_comment_prefix_stoplist.has(doc.fileName) && !comment_prefix) {
            // We can't use empty comment prefix (and early return) - in that case the previous highlighting would not go away due to a VSCode quirk, need to make an empty build instead to make sure that all previously highlighted lines were cleared. We also can't create an empty builder and early return it because in that case we won't highlight dynamic csv columns (highlighting would disappear)
            comment_prefix = '#####COMMENT_PREFIX_THAT_CAN_NOT_OCCURE_IN_A_NORMAL_FILE_AND_EVEN_IF_IT_OCCURES_NOT_A_BIG_DEAL####';
        }
        if (!comment_prefix || policy === null || policy == QUOTED_RFC_POLICY) {
            return null; // Sanity check: with QUOTED_RFC_POLICY we should be using a different tokenizer which also handles comments.
        }
        // Create a new builder to clear the previous tokens.
        const builder = new vscode.SemanticTokensBuilder(tokens_legend);
        let begin_line = Math.max(0, range.start.line - dynamic_csv_highlight_margin);
        let end_line = Math.min(doc.lineCount, range.end.line + dynamic_csv_highlight_margin);
        for (let lnum = begin_line; lnum < end_line; lnum++) {
            let line_text = doc.lineAt(lnum).text;
            if (line_text.startsWith(comment_prefix)) {
                builder.push(new vscode.Range(lnum, 0, lnum, line_text.length), COMMENT_TOKEN);
            }
        }
        return builder.build();
    }
}


class InlayHintProvider {
    constructor() {
    }
    async provideInlayHints(document, _range, _cancellation_token) {
        // Inlay hints should work really fast and in sync mode so we don't need to handle `_cancellation_token`.
        let visible_range = null;
        let active_editor = get_active_editor();
        if (active_editor && active_editor.visibleRanges && active_editor.visibleRanges.length) {
            // For some reason the `range` method variable can contain much bigger range than the actual visible range (probably a bug).
            // This bug coupled with an apparently existing undocumented limit on total length of inlay hints across multiple lines prevents some of the bottom visible lines from being aligned.
            // Some additional background: https://github.com/mechatroner/vscode_rainbow_csv/issues/205.
            visible_range = active_editor.visibleRanges[0];
        } else {
            return;
        }
        let custom_alignment_mode = custom_virtual_alignment_modes.get(document.fileName);
        if (!virtual_alignment_enabled(extension_context.virtual_alignment_mode, custom_alignment_mode)) {
            return;
        }
        let [delim, policy, comment_prefix] = get_dialect(document);
        if (policy === null) {
            return [];
        }
        let parsing_range = ll_rainbow_utils().extend_range_by_margin(vscode, document, visible_range, 50);
        let row_infos = ll_rainbow_utils().parse_document_range(vscode, document, delim, /*include_delim_length_in_ranges=*/false, policy, comment_prefix, parsing_range)[0];
        let header_lnum = get_header(document, delim, policy, comment_prefix)[0];
        // It is possible for `header_lnum` to be null if the header is virtual.
        if (header_lnum !== null && header_lnum < parsing_range.start.line) { // We don't check if header is after the range because it is a very weird corner case which doesn't matter for the purpose of virtual alignment anyway and requires additional testing.
            let header_range = new vscode.Range(header_lnum, 0, header_lnum, 1);
            let header_row_infos = ll_rainbow_utils().parse_document_range(vscode, document, delim, /*include_delim_length_in_ranges=*/false, policy, comment_prefix, header_range)[0];
            row_infos = header_row_infos.concat(row_infos);
        }

        let all_columns_stats = ll_rainbow_utils().calc_column_stats_for_fragment(row_infos, header_lnum, extension_context.double_width_alignment);
        if (whole_doc_alignment_stats.has(document.fileName)) {
            ll_rainbow_utils().reconcile_whole_doc_and_local_column_stats(whole_doc_alignment_stats.get(document.fileName), all_columns_stats);
            // Save updated whole-doc stats.
            whole_doc_alignment_stats.set(document.fileName, all_columns_stats);
        }
        let alignment_char = extension_context.virtual_alignment_char == 'middot' ? '\u00b7' : ' ';
        let post_delim_readability_gap_length = 0; // There is a limit on total number of inlay hints spans which is 1500, so we avoid creating too many hints, and there are other benefits, see below:
        // * Zero-length spans are confusing and make cursor movements jump so the fewer we have them the better as long as the columns are still aligned.
        // * Better performance with fewer inlay hints
        let visible_range_hints = ll_rainbow_utils().generate_inlay_hints(vscode, visible_range, header_lnum, row_infos, all_columns_stats, delim.length, alignment_char, extension_context.virtual_alignment_vertical_grid, post_delim_readability_gap_length);
        return visible_range_hints;
    }
}


async function load_resource_file_for_web(extension_uri, resource_path) {
    let resource_uri = vscode.Uri.joinPath(extension_uri, resource_path);
    let bytes = await vscode.workspace.fs.readFile(resource_uri);
    // Using TextDecoder because it should work fine in web extension.
    return new TextDecoder().decode(bytes);
}


async function load_resource_file_universal(resource_path) {
    if (is_web_ext) {
        let resource_data = await load_resource_file_for_web(web_extension_uri, resource_path);
        return resource_data;
    }
    return fs.readFileSync(absolute_path_map[resource_path], "utf8");
}


function generate_tracked_field_decoration_types() {
    let result = [];
    result.push(vscode.window.createTextEditorDecorationType({borderStyle: 'solid', borderWidth: '1px', borderColor: new vscode.ThemeColor('rainbowtrack1')}));
    result.push(vscode.window.createTextEditorDecorationType({borderStyle: 'solid', borderWidth: '1px', borderColor: new vscode.ThemeColor('rainbowtrack2')}));
    result.push(vscode.window.createTextEditorDecorationType({borderStyle: 'solid', borderWidth: '1px', borderColor: new vscode.ThemeColor('rainbowtrack3')}));
    return result;
}


async function do_excel_copy(log_wrapper) {
    let active_editor = get_active_editor();
    if (!active_editor)
        return;
    var active_doc = get_active_doc(active_editor);
    if (!active_doc)
        return;
    if (!is_rainbow_dialect_doc(active_doc)) {
        return null;
    }
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null)
        return null;
    let selection_start_line = 0;
    let selection_end_line = active_doc.lineCount;
    let selection = active_editor.selection;
    if (selection && !selection.isEmpty) {
        selection_start_line = selection.start.line;
        selection_end_line = selection.end.line;
    }
    let conversion_range = new vscode.Range(selection_start_line, 0, selection_end_line, /*ignored_column=*/0);
    log_wrapper.log_doc_event('sampling lines', active_doc);
    let [row_infos, first_defective_line] = ll_rainbow_utils().parse_document_range(vscode, active_doc, delim, /*include_delim_length_in_ranges=*/false, policy, comment_prefix, conversion_range);
    if (first_defective_line !== null) {
        show_single_line_error(`Unable to copy - found formatting error at line ${first_defective_line + 1}.`);
        return;
    }
    log_wrapper.log_doc_event('converting to tsv', active_doc);
    let tsv_lines = [];
    for (let row_info of row_infos) {
        let fields = [];
        for (let field_segments of row_info.record_fields) {
            if (field_segments.length != 1) {
                show_single_line_error('Unable to copy fragment with multiline fields');
                return;
            }
            let field_for_copy = field_segments[0];
            if (field_for_copy.includes('\t')) {
                show_single_line_error('Unable to copy fragment containing tabs inside some of the fields because it will interfere with the resulting table structure');
                return;
            }
            fields.push(field_for_copy);
        }
        tsv_lines.push(fields.join('\t'));
    }
    let tsv_content = tsv_lines.join('\n');
    log_wrapper.log_doc_event('writing to the clipboard', active_doc);
    await vscode.env.clipboard.writeText(tsv_content);
    log_wrapper.log_doc_event('finishing excel_copy', active_doc);
    vscode.window.showInformationMessage('Success: You can now Paste (Ctrl+V) into Sheets');
}


async function excel_copy() {
    let log_wrapper = new StackContextLogWrapper('excel_copy');
    log_wrapper.log_doc_event('starting excel_copy');
    try {
        await do_excel_copy(log_wrapper);
    } catch (error) {
        log_wrapper.log_doc_event(`Something went wrong: ${error}`);
        show_single_line_error('Unable to copy: Something went wrong');
    }
}


async function markdown_copy() {
    let log_wrapper = new StackContextLogWrapper('markdown_copy');
    log_wrapper.log_doc_event('starting markdown_copy');
    let active_editor = get_active_editor();
    let active_doc = get_active_doc(active_editor);
    if (!is_rainbow_dialect_doc(active_doc))
        return;
    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        return;
    }

    let selection_start_line = 0;
    let selection_end_line = active_doc.lineCount;
    let selection = active_editor.selection;
    if (selection && !selection.isEmpty) {
        selection_start_line = selection.start.line;
        selection_end_line = selection.end.line;
    }
    let conversion_range = new vscode.Range(selection_start_line, 0, selection_end_line, /*ignored_column=*/0);
    log_wrapper.log_doc_event('parsing');
    let [row_infos, first_defective_line] = ll_rainbow_utils().parse_document_range(vscode, active_doc, delim, /*include_delim_length_in_ranges=*/false, policy, comment_prefix, conversion_range);
    if (first_defective_line !== null) {
        // TODO Consider not stopping on warning.
        show_single_line_error(`Unable to copy - found formatting error at line ${first_defective_line + 1}.`);
        return;
    }
    // Here row_infos also includes the fields themselves so all good so far.
    let records = [];
    let num_columns = null;
    for (let row_info of row_infos) {
        let fields = [];
        for (let field_segments of row_info.record_fields) {
            if (field_segments.length != 1) {
                // TODO Consider optionally joining multiline fragments with `<br>` or another established separator.
                show_single_line_error('Unable to copy fragment with multiline fields');
                return;
            }
            fields.push(field_segments[0]);
        }
        records.push(fields);
        if (num_columns === null) {
            num_columns = fields.length;
        }
        if (num_columns != fields.length) {
            show_single_line_error('Unable to copy fragment with variable number of fields in records');
            return;
        }
    }
    if (records.length < 2) {
        show_single_line_error('Unable to copy fragment as a markdown table - must have at least 2 records: header and a data row');
        return;
    }
    // It might seem cool to explicitly include the first (header) record if it is not part of the selected fragment, but
    // one issue with this that in case if the header has different num of fields than the selected fragment it would prevent markdown export and including the header conditionally would be very confusing.
    // Use and adhoc alignment algorithm, because the one that we use for CSV alignment can't create an aligned header separator withouth a hack.
    // Another reason is that double_width and numeric alignment features are excessive and could even potentially confuse some markdown parsers.
    log_wrapper.log_doc_event('aligning columns');
    let markdown_lines = ll_rainbow_utils().generate_markdown_lines(records);
    let aligned_doc_text = markdown_lines.join('\n');
    log_wrapper.log_doc_event('writing to the clipboard', active_doc);
    await vscode.env.clipboard.writeText(aligned_doc_text);
    log_wrapper.log_doc_event('finishing makdown_copy', active_doc);
    vscode.window.showInformationMessage('Success: You can now Paste the fragment (Ctrl+V) in makdown format');
}


function is_line_in_record_ranges(row_info, line_num) {
    if (!row_info.record_ranges) {
        return false;
    }
    for (let field_ranges of row_info.record_ranges) {
        for (let field_range of field_ranges) {
            if (field_range.start.line <= line_num && field_range.end.line >= line_num) {
                return true;
            }
        }
    }
    return false;
}


async function go_to_column(integration_test_options=null) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const active_doc = editor.document;
    if (!is_rainbow_dialect_doc(active_doc)) {
        show_single_line_error('Go to column is only available for CSV files');
        return;
    }

    let [delim, policy, comment_prefix] = get_dialect(active_doc);
    if (policy === null) {
        show_single_line_error('Unable to determine dialect for this file');
        return;
    }

    let column_number_str = null;
    if (integration_test_options && integration_test_options.target_column !== undefined) {
        column_number_str = String(integration_test_options.target_column);
    } else {
        column_number_str = await vscode.window.showInputBox({
            prompt: 'Enter column number (1-based)',
            validateInput: text => {
                const num = parseInt(text);
                return (isNaN(num) || num <= 0) ? 'Please enter a positive number' : null;
            }
        });
    }

    if (!column_number_str) {
        return;
    } 

    const target_column = parseInt(column_number_str) - 1; // Convert to 0-based index
    const current_position = editor.selection.active;

    // Parse the document range around the current cursor position to handle multiline fields
    let range = new vscode.Range(current_position.line, 0, current_position.line, 0);
    range = ll_rainbow_utils().extend_range_by_margin(vscode, active_doc, range, 50);
    let [row_infos, _first_defective_line] = ll_rainbow_utils().parse_document_range(vscode, active_doc, delim, /*include_delim_length_in_ranges=*/false, policy, comment_prefix, range);

    // Find the row that contains our current cursor position
    let target_row_info = null;
    for (let row_info of row_infos) {
        if (row_info.comment_range !== null) {
            if (row_info.comment_range.contains(current_position)) {
                show_single_line_error('Cannot go to column: cursor is on a comment line');
                return;
            }
        } else if (is_line_in_record_ranges(row_info, current_position.line)) {
            target_row_info = row_info;
            break;
        }
    }

    if (!target_row_info) {
        show_single_line_error('Unable to parse the current record');
        return;
    }

    const num_columns = target_row_info.record_ranges.length;
    if (target_column >= num_columns) {
        show_single_line_error(`Column ${target_column + 1} does not exist. This record has ${num_columns} column(s).`);
        return;
    }

    // Get the start position of the target column (first range of the field)
    const target_field_ranges = target_row_info.record_ranges[target_column];
    if (!target_field_ranges || target_field_ranges.length === 0) {
        show_single_line_error('Unable to locate the target column');
        return;
    }

    const target_position = target_field_ranges[0].start;
    const new_selection = new vscode.Selection(target_position, target_position);
    editor.selection = new_selection;
    editor.revealRange(new vscode.Range(target_position, target_position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}


async function activate(context) {
    // TODO consider storing `context` itself in a global variable.
    global_state = context.globalState;

    if (is_web_ext) {
        web_extension_uri = context.extensionUri;
    }

    for (let local_path in absolute_path_map) {
        if (absolute_path_map.hasOwnProperty(local_path)) {
            if (is_web_ext) {
                absolute_path_map[local_path] = vscode.Uri.joinPath(context.extensionUri, local_path);
            } else {
                absolute_path_map[local_path] = context.asAbsolutePath(local_path);
            }
        }
    }

    var lint_cmd = vscode.commands.registerCommand('rainbow-csv.CSVLint', csv_lint_cmd);
    var rbql_cmd = vscode.commands.registerCommand('rainbow-csv.RBQL', edit_rbql);
    var set_header_line_cmd = vscode.commands.registerCommand('rainbow-csv.SetHeaderLine', set_header_line);
    var set_comment_prefix_cmd = vscode.commands.registerCommand('rainbow-csv.SetCommentPrefix', set_comment_prefix);
    var edit_column_names_cmd = vscode.commands.registerCommand('rainbow-csv.SetVirtualHeader', set_virtual_header);
    var set_join_table_name_cmd = vscode.commands.registerCommand('rainbow-csv.SetJoinTableName', set_join_table_name); // WEB_DISABLED
    var column_edit_before_cmd = vscode.commands.registerCommand('rainbow-csv.ColumnEditBefore', async function() { await column_edit('ce_before'); });
    var column_edit_after_cmd = vscode.commands.registerCommand('rainbow-csv.ColumnEditAfter', async function() { await column_edit('ce_after'); });
    var column_edit_select_cmd = vscode.commands.registerCommand('rainbow-csv.ColumnEditSelect', async function() { await column_edit('ce_select'); });
    var set_separator_cmd = vscode.commands.registerCommand('rainbow-csv.RainbowSeparator', choose_dynamic_separator);
    var rainbow_off_cmd = vscode.commands.registerCommand('rainbow-csv.RainbowSeparatorOff', restore_original_language);
    var rainbow_on_cmd = vscode.commands.registerCommand('rainbow-csv.RainbowSeparatorOn', reenable_rainbow_language);
    var sample_head_cmd = vscode.commands.registerCommand('rainbow-csv.SampleHead', async function(uri) { await make_preview(uri, 'head'); }); // WEB_DISABLED
    var sample_tail_cmd = vscode.commands.registerCommand('rainbow-csv.SampleTail', async function(uri) { await make_preview(uri, 'tail'); }); // WEB_DISABLED
    var align_cmd = vscode.commands.registerCommand('rainbow-csv.Align', content_modifying_align_table);
    var virtual_align_cmd = vscode.commands.registerCommand('rainbow-csv.VirtualAlign', virtual_align_table);
    var shrink_cmd = vscode.commands.registerCommand('rainbow-csv.Shrink', whitespace_shrink_table);
    var virtual_shrink_cmd = vscode.commands.registerCommand('rainbow-csv.VirtualShrink', virtual_shrink_table);
    var copy_back_cmd = vscode.commands.registerCommand('rainbow-csv.CopyBack', copy_back); // WEB_DISABLED
    var toggle_row_background_cmd = vscode.commands.registerCommand('rainbow-csv.ToggleRowBackground', toggle_row_background);
    var toggle_column_tracking_cmd = vscode.commands.registerCommand('rainbow-csv.ToggleColumnTracking', toggle_column_tracking);
    var excel_copy_cmd = vscode.commands.registerCommand('rainbow-csv.ExcelCopy', async function() { await excel_copy(); });
    var markdown_copy_cmd = vscode.commands.registerCommand('rainbow-csv.MarkdownCopy', async function() { await markdown_copy(); });
    var internal_test_cmd = vscode.commands.registerCommand('rainbow-csv.InternalTest', run_internal_test_cmd);
    var go_to_column_cmd = vscode.commands.registerCommand('rainbow-csv.GoToColumn', go_to_column);

    // INFO: vscode.workspace and vscode.window lifetime are likely guaranteed to cover the extension lifetime (period between activate() and deactivate()) but I haven't found a confirmation yet.
    var doc_open_event = vscode.workspace.onDidOpenTextDocument(handle_doc_open);
    var doc_close_event = vscode.workspace.onDidCloseTextDocument(handle_doc_close);
    var config_change_event = vscode.workspace.onDidChangeConfiguration(restart_extension_config);

    var switch_event = vscode.window.onDidChangeActiveTextEditor(handle_editor_switch);
    try {
        debug_log_output_channel = vscode.window.createOutputChannel('rainbow_csv_debug_channel', {log: true});
    } catch (_error) {
        console.error('Rainbow CSV: Failed to create output log channel');
    }

    restart_extension_config();

    if (get_from_config('enable_tooltip', false)) {
        for (let language_id in dialect_map) {
            if (dialect_map.hasOwnProperty(language_id)) {
                register_csv_hover_info_provider(language_id, context);
            }
        }
    }

    enable_dynamic_semantic_tokenization();
    if (extension_context.comment_prefix) {
        register_comment_tokenization_handler();
    }

    // The only purpose to add the entries to context.subscriptions is to guarantee their disposal during extension deactivation
    context.subscriptions.push(lint_cmd);
    context.subscriptions.push(rbql_cmd);
    context.subscriptions.push(edit_column_names_cmd);
    context.subscriptions.push(column_edit_before_cmd);
    context.subscriptions.push(column_edit_after_cmd);
    context.subscriptions.push(column_edit_select_cmd);
    context.subscriptions.push(set_separator_cmd);
    context.subscriptions.push(rainbow_off_cmd);
    context.subscriptions.push(rainbow_on_cmd);
    context.subscriptions.push(sample_head_cmd);
    context.subscriptions.push(sample_tail_cmd);
    context.subscriptions.push(set_join_table_name_cmd);
    context.subscriptions.push(align_cmd);
    context.subscriptions.push(shrink_cmd);
    context.subscriptions.push(virtual_align_cmd);
    context.subscriptions.push(virtual_shrink_cmd);
    context.subscriptions.push(copy_back_cmd);
    context.subscriptions.push(set_header_line_cmd);
    context.subscriptions.push(set_comment_prefix_cmd);
    context.subscriptions.push(toggle_row_background_cmd);
    context.subscriptions.push(toggle_column_tracking_cmd);
    context.subscriptions.push(excel_copy_cmd);
    context.subscriptions.push(markdown_copy_cmd);
    context.subscriptions.push(internal_test_cmd);
    context.subscriptions.push(go_to_column_cmd);

    context.subscriptions.push(doc_open_event);
    context.subscriptions.push(doc_close_event);
    context.subscriptions.push(switch_event);
    context.subscriptions.push(config_change_event);

    // TODO consider making the background color customizable in settings, use "color" contribution point to achieve this, although there seem to be no way to actually conveniently customize it.
    alternate_row_background_decoration_type = vscode.window.createTextEditorDecorationType({backgroundColor: new vscode.ThemeColor('tab.inactiveBackground'), isWholeLine: true});
    tracked_field_decoration_types = generate_tracked_field_decoration_types();

    // Need this because "onDidOpenTextDocument()" doesn't get called for the first open document.
    // Another issue is when dev debug logging mode is enabled, the first document would be "Log" because it is printing something and gets VSCode focus.
    await sleep(1000);
    let active_doc = get_active_doc();
    handle_doc_open(active_doc);
}


function deactivate() {
    // This method is called when extension is deactivated.
}


exports.activate = activate;
exports.deactivate = deactivate;

// Exports just for unit tests:
exports.autodetect_dialect_frequency_based = autodetect_dialect_frequency_based;
exports.try_autodetect_and_set_rainbow_filetype = try_autodetect_and_set_rainbow_filetype;

},
"fast_load_utils.js": function (module, exports, require, __filename, __dirname) {
// This file stores only functionality that is required for idle operation of Rainbow CSV i.e. autodetection only.
// We want to avoid loading/parsing a lot of JS code in cases where we don't have any CSV files to work with.

const csv_utils = require('./rbql_core/rbql-js/csv_utils.js');

class AssertionError extends Error {}

function assert(condition, message=null) {
    if (!condition) {
        if (!message) {
            message = 'Assertion error';
        }
        throw new AssertionError(message);
    }
}

class RecordTextConsumer {
    // The only purpose of this class is to avoid code duplication when dealing with leftover lines in line_aggregator (the second `consume` call).
    constructor(delim, policy, stop_on_warning, collect_records, preserve_quotes_and_whitespaces, detect_trailing_spaces, min_num_fields_for_autodetection, trim_whitespaces) {
        this.delim = delim;
        this.policy = policy;
        this.stop_on_warning = stop_on_warning;
        this.first_defective_line = null;
        this.records = collect_records ? [] : null;
        this.collect_records = collect_records;
        this.num_records_parsed = 0;
        this.fields_info = new Map();
        this.first_trailing_space_line = null;
        this.detect_trailing_spaces = detect_trailing_spaces;
        this.preserve_quotes_and_whitespaces = preserve_quotes_and_whitespaces;
        this.min_num_fields_for_autodetection = min_num_fields_for_autodetection;
        this.trim_whitespaces = trim_whitespaces;
    }

    consume(record_text, record_start_line) {
        let [record, warning] = csv_utils.smart_split(record_text, this.delim, this.policy, this.preserve_quotes_and_whitespaces);
        if (warning) {
            if (this.first_defective_line === null) {
                this.first_defective_line = record_start_line;
            }
            if (this.stop_on_warning)
                return /*can_continue=*/false;
        }
        if (this.detect_trailing_spaces && this.first_trailing_space_line === null) {
            for (let field of record) {
                if (field.length && (field.charAt(0) == ' ' || field.charAt(field.length - 1) == ' ')) {
                    this.first_trailing_space_line = record_start_line;
                }
            }
        }
        if (this.trim_whitespaces) {
            record = record.map((v) => v.trim());
        }
        if (!this.fields_info.has(record.length)) {
            this.fields_info.set(record.length, this.num_records_parsed);
            if (this.min_num_fields_for_autodetection != -1) {
                // Autodetection mode: stop on inconsistent records length and when there is not enough columns (typically less than 2 i.e. 1).
                if (record.length < this.min_num_fields_for_autodetection)
                    return /*can_continue=*/false;
                if (this.fields_info.size > 1)
                    return /*can_continue=*/false;
            }
        }
        if (this.collect_records) {
            this.records.push(record);
        }
        this.num_records_parsed += 1;
        return /*can_continue=*/true;
    }
}


function parse_document_records(document, delim, policy, comment_prefix=null, stop_on_warning=false, max_records_to_parse=-1, collect_records=true, preserve_quotes_and_whitespaces=false, detect_trailing_spaces=false, min_num_fields_for_autodetection=-1, trim_whitespaces=false) {
    // TODO consider switching to a single row_info array format that would have (comment, record_ranges and the record itself) - this would make it more compatible with the incremental parsing functions.
    let num_lines = document.lineCount;
    let record_start_line = 0;
    let line_aggregator = new csv_utils.MultilineRecordAggregator(comment_prefix);
    let consumer = new RecordTextConsumer(delim, policy, stop_on_warning, collect_records, preserve_quotes_and_whitespaces, detect_trailing_spaces, min_num_fields_for_autodetection, trim_whitespaces);
    let comments = []; // An ordered list of {record_no, comment_text} tuples which can be merged with the records later.

    for (let lnum = 0; lnum < num_lines; ++lnum) {
        let line_text = document.lineAt(lnum).text;
        if (lnum + 1 >= num_lines && line_text == "") {
            if (collect_records) {
                // Treat the last empty line as a comment - this is to prevent align/shrink functions from removing it.
                comments.push({record_num: consumer.num_records_parsed, comment_text: line_text});
            }
            break; // Skip the last empty line.
        }
        let record_text = null;
        if (policy == 'quoted_rfc') {
            line_aggregator.add_line(line_text);
            if (line_aggregator.has_comment_line) {
                record_start_line = lnum + 1;
                line_aggregator.reset();
                if (collect_records) {
                    comments.push({record_num: consumer.num_records_parsed, comment_text: line_text});
                }
                continue;
            } else if (line_aggregator.has_full_record) {
                record_text = line_aggregator.get_full_line('\n');
                line_aggregator.reset();
            } else {
                continue;
            }
        } else {
            if (comment_prefix && line_text.startsWith(comment_prefix)) {
                record_start_line = lnum + 1;
                if (collect_records) {
                    comments.push({record_num: consumer.num_records_parsed, comment_text: line_text});
                }
                continue;
            } else {
                record_text = line_text;
            }
        }
        if (!consumer.consume(record_text, record_start_line)) {
            return [consumer.records, consumer.num_records_parsed, consumer.fields_info, consumer.first_defective_line, consumer.first_trailing_space_line, comments];
        }
        record_start_line = lnum + 1;
        if (max_records_to_parse !== -1 && consumer.num_records_parsed >= max_records_to_parse) {
            return [consumer.records, consumer.num_records_parsed, consumer.fields_info, consumer.first_defective_line, consumer.first_trailing_space_line, comments];
        }
    }

    if (line_aggregator.is_inside_multiline_record()) {
        assert(policy == 'quoted_rfc');
        consumer.consume(line_aggregator.get_full_line('\n'), record_start_line);
    }
    return [consumer.records, consumer.num_records_parsed, consumer.fields_info, consumer.first_defective_line, consumer.first_trailing_space_line, comments];
}


module.exports.parse_document_records = parse_document_records;
module.exports.assert = assert;

},
"language-configuration.json": function (module) { module.exports = {
  "autoClosingPairs": [
    ["\"", "\""]
  ],
  "surroundingPairs": [
    ["\"", "\""]
  ]
}
; },
"package.json": function (module) { module.exports = {
    "name": "rainbow-csv",
    "displayName": "Rainbow CSV",
    "description": "Highlight CSV and TSV files, Run SQL-like queries",
    "version": "3.24.1",
    "publisher": "mechatroner",
    "license": "MIT",
    "icon": "rainbow_csv_logo.png",
    "engines": {
        "vscode": "^1.95.0"
    },
    "keywords": [
        "csv",
        "tsv",
        "highlight"
    ],
    "categories": [
        "Data Science",
        "Other",
        "Programming Languages"
    ],
    "activationEvents": [
        "onLanguage:csv",
        "onLanguage:tsv",
        "onLanguage:csv (semicolon)",
        "onLanguage:csv (pipe)",
        "onLanguage:csv (whitespace)",
        "onLanguage:dynamic csv",
        "onLanguage:plaintext",
        "onCommand:rainbow-csv.RBQL",
        "onCommand:rainbow-csv.RainbowSeparator",
        "onCommand:rainbow-csv.SampleHead",
        "onCommand:rainbow-csv.SampleTail"
    ],
    "main": "./extension",
    "browser": "./dist/web/extension.js",
    "contributes": {
        "colors": [
            {
                "id": "rainbowtrack1",
                "description": "Color for column tracking one.",
                "defaults": {
                    "dark": "#ff0000",
                    "light": "#ff0000",
                    "highContrast": "#ff0000",
                    "highContrastLight": "#ff0000"
                }
            },
            {
                "id": "rainbowtrack2",
                "description": "Color for column tracking two.",
                "defaults": {
                    "dark": "#00ff00",
                    "light": "#00ff00",
                    "highContrast": "#00ff00",
                    "highContrastLight": "#00ff00"
                }
            },
            {
                "id": "rainbowtrack3",
                "description": "Color for column tracking three.",
                "defaults": {
                    "dark": "#0000ff",
                    "light": "#0000ff",
                    "highContrast": "#0000ff",
                    "highContrastLight": "#0000ff"
                }
            }
        ],
        "configuration": {
            "type": "object",
            "title": "Rainbow CSV",
            "properties": {
                "rainbow_csv.enable_sticky_header": {
                    "type": "boolean",
                    "default": true,
                    "order": 1,
                    "description": "Enable sticky header line at the top."
                },
                "rainbow_csv.enable_separator_autodetection": {
                    "type": "boolean",
                    "default": true,
                    "order": 2,
                    "description": "Enable automatic content based separator autodetection."
                },
                "rainbow_csv.autodetect_separators": {
                    "type": "array",
                    "default": [
                        "TAB",
                        ",",
                        ";",
                        "|"
                    ],
                    "description": "Enable automatic content-based separator autodetection for the specified list of separators (multicharacter separators are supported).",
                    "order": 3,
                    "items": {
                        "type": "string",
                        "description": "Separator"
                    }
                },
                "rainbow_csv.autodetection_min_line_count": {
                    "type": "number",
                    "default": 10,
                    "order": 4,
                    "description": "Minimum number of non-comment lines in file for content-based autodetection."
                },
                "rainbow_csv.highlight_rows": {
                    "type": "boolean",
                    "default": false,
                    "order": 5,
                    "description": "Highlight rows with alternate background colors by default."
                },
                "rainbow_csv.virtual_alignment_mode": {
                    "type": "string",
                    "enum": ["disabled", "manual", "always"],
                    "enumDescriptions": ["Disabled. Align only when \"VirtualAlign\" command is executed", "Align when \"Align\" Status Bar button is clicked", "Automatically align all files"],
                    "order": 6,
                    "default": "disabled",
                    "description": "Virtual alignment based on VSCode inlay hints that doesn't change underlying file content."
                },
                "rainbow_csv.virtual_alignment_char": {
                    "type": "string",
                    "enum": ["middot", "space"],
                    "enumDescriptions": ["Middle dot", "Whitespace"],
                    "order": 7,
                    "default": "middot",
                    "description": "Virtual alignment character."
                },
                "rainbow_csv.virtual_alignment_vertical_grid": {
                    "type": "boolean",
                    "default": false,
                    "order": 8,
                    "description": "Show vertical grid in virtual alignment mode."
                },
                "rainbow_csv.enable_tooltip": {
                    "type": "boolean",
                    "default": true,
                    "order": 9,
                    "description": "Enable column-info tooltip on hover."
                },
                "rainbow_csv.enable_tooltip_column_names": {
                    "type": "boolean",
                    "default": true,
                    "order": 10,
                    "description": "Show column names in tooltip."
                },
                "rainbow_csv.enable_cursor_position_info": {
                    "type": "boolean",
                    "default": true,
                    "order": 11,
                    "description": "Keyboard input text cursor: show info about the cursor CSV column in the status bar."
                },
                "rainbow_csv.double_width_alignment": {
                    "type": "boolean",
                    "default": true,
                    "order": 12,
                    "description": "If enabled treat double width unicode chars e.g. Chinese or Japanese chars as double wide when aligning."
                },
                "rainbow_csv.enable_auto_csv_lint": {
                    "type": "boolean",
                    "default": true,
                    "order": 13,
                    "description": "Automatically run linter for every CSV file."
                },
                "rainbow_csv.csv_lint_detect_trailing_spaces": {
                    "type": "boolean",
                    "default": false,
                    "order": 14,
                    "description": "CSV Lint: detect leading and trailing whitespaces in fields and show warning."
                },
                "rainbow_csv.comment_prefix": {
                    "type": "string",
                    "default": "",
                    "order": 15,
                    "description": "Comment lines prefix, e.g. \"#\". Set to empty string to disable."
                },
                "rainbow_csv.rbql_output_dir": {
                    "type": "string",
                    "default": "TMP",
                    "order": 16,
                    "description": "Output directory for RBQL result sets, can be `TMP`, `INPUT` or a custom absolute path. `TMP` - output in system tmp dir(default), `INPUT` - output in the same dir as input file, otherwise use provided path as the output directory e.g. `/path/to/custom/dir`."
                },
                "rainbow_csv.rbql_with_headers_by_default": {
                    "type": "boolean",
                    "default": false,
                    "order": 17,
                    "description": "RBQL treats the first line as header by default."
                },
                "rainbow_csv.rbql_strip_spaces": {
                    "type": "boolean",
                    "default": true,
                    "order": 18,
                    "description": "RBQL strips (trims) leading and trailing spaces from each field as a preprocessig step."
                },
                "rainbow_csv.enable_context_menu_head": {
                    "type": "boolean",
                    "default": false,
                    "order": 19,
                    "description": "Enable \"Preview CSV head\" option in File Explorer context menu for all files."
                },
                "rainbow_csv.enable_context_menu_tail": {
                    "type": "boolean",
                    "default": false,
                    "order": 20,
                    "description": "Enable \"Preview CSV tail\" option in File Explorer context menu for all files."
                },
                "rainbow_csv.enable_debug_logging": {
                    "type": "boolean",
                    "default": false,
                    "order": 21,
                    "description": "Dev Mode: Enable Debug Logging. Run command [Developer: Show Logs...] -> [rainbow_csv_debug_channel] to see the output."
                }
            }
        },
        "submenus": [
              {
                    "id": "rainbow_csv.submenu",
                    "label": "Rainbow CSV"
              }
        ],
        "menus": {
            "editor/context": [
                {
                    "submenu": "rainbow_csv.submenu"
                }
            ],
            "rainbow_csv.submenu": [
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.GoToColumn",
                    "group": "common@7"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.SetHeaderLine",
                    "group": "common@7"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.SetCommentPrefix",
                    "group": "common@6"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|plaintext|^[ct]sv/",
                    "command": "rainbow-csv.RainbowSeparator",
                    "group": "common@5"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.RBQL",
                    "group": "common@4"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ToggleRowBackground",
                    "group": "common@3"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ToggleColumnTracking",
                    "group": "common@2"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /plaintext/",
                    "command": "rainbow-csv.RainbowSeparatorOn",
                    "group": "common@1"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ExcelCopy",
                    "group": "datacopy@1"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.MarkdownCopy",
                    "group": "datacopy@2"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.Align",
                    "group": "regular_align@1"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.Shrink",
                    "group": "regular_align@2"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.VirtualAlign",
                    "group": "virtual_align@1"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.VirtualShrink",
                    "group": "virtual_align@2"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ColumnEditSelect",
                    "group": "wgroup@1"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ColumnEditBefore",
                    "group": "wgroup@2"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.ColumnEditAfter",
                    "group": "wgroup@3"
                },
                {
                    "when": "editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/",
                    "command": "rainbow-csv.RainbowSeparatorOff",
                    "group": "xgroup@1"
                }
            ],
            "explorer/context": [
                {
                    "command": "rainbow-csv.SampleHead",
                    "when": "config.rainbow_csv.enable_context_menu_head || resourceLangId =~ /plaintext|^[ct]sv/",
                    "group": "rainbow_csv"
                },
                {
                    "command": "rainbow-csv.SampleTail",
                    "when": "config.rainbow_csv.enable_context_menu_tail",
                    "group": "rainbow_csv"
                }
            ]
        },
        "languages": [
            {
                "id": "csv",
                "aliases": [
                    "CSV",
                    "csv"
                ],
                "extensions": [
                    ".csv"
                ],
                "configuration": "./language-configuration.json"
            },
            {
                "id": "tsv",
                "aliases": [
                    "TSV",
                    "tsv"
                ],
                "extensions": [
                    ".tsv",
                    ".tab"
                ],
                "configuration": "./language-configuration.json"
            },
            {
                "id": "csv (pipe)",
                "aliases": [
                    "CSV (pipe)",
                    "csv (pipe)"
                ],
                "extensions": [],
                "configuration": "./language-configuration.json"
            },
            {
                "id": "csv (whitespace)",
                "aliases": [
                    "CSV (whitespace)",
                    "csv (whitespace)"
                ],
                "extensions": [],
                "configuration": "./language-configuration.json"
            },
            {
                "id": "csv (semicolon)",
                "aliases": [
                    "CSV (semicolon)",
                    "csv (semicolon)"
                ],
                "extensions": [],
                "configuration": "./language-configuration.json"
            },
            {
                "id": "dynamic csv",
                "aliases": [
                    "Dynamic CSV",
                    "dynamic csv"
                ],
                "extensions": [],
                "configuration": "./language-configuration.json"
            }
        ],
        "commands": [
            {
                "command": "rainbow-csv.CSVLint",
                "category": "Rainbow CSV",
                "title": "CSV Lint"
            },
            {
                "command": "rainbow-csv.SetVirtualHeader",
                "category": "Rainbow CSV",
                "title": "Set virtual header"
            },
            {
                "command": "rainbow-csv.SetHeaderLine",
                "category": "Rainbow CSV",
                "title": "Set header line"
            },
            {
                "command": "rainbow-csv.SetCommentPrefix",
                "category": "Rainbow CSV",
                "title": "Set selection as comment prefix"
            },
            {
                "command": "rainbow-csv.RBQL",
                "category": "Rainbow CSV",
                "title": "RBQL Query"
            },
            {
                "command": "rainbow-csv.SetJoinTableName",
                "category": "Rainbow CSV",
                "title": "Set join table name for RBQL"
            },
            {
                "command": "rainbow-csv.ColumnEditBefore",
                "category": "Rainbow CSV",
                "title": "Column edit - Before"
            },
            {
                "command": "rainbow-csv.ColumnEditAfter",
                "category": "Rainbow CSV",
                "title": "Column edit - After"
            },
            {
                "command": "rainbow-csv.ColumnEditSelect",
                "category": "Rainbow CSV",
                "title": "Column edit - Selection"
            },
            {
                "command": "rainbow-csv.RainbowSeparator",
                "category": "Rainbow CSV",
                "title": "Set rainbow separator"
            },
            {
                "command": "rainbow-csv.ToggleColumnTracking",
                "category": "Rainbow CSV",
                "title": "Toggle Column Tracking"
            },
            {
                "command": "rainbow-csv.ExcelCopy",
                "category": "Rainbow CSV",
                "title": "Copy for Excel / Sheets export"
            },
            {
                "command": "rainbow-csv.MarkdownCopy",
                "category": "Rainbow CSV",
                "title": "Copy in Markdown table format"
            },
            {
                "command": "rainbow-csv.RainbowSeparatorOff",
                "category": "Rainbow CSV",
                "title": "Disable Rainbow CSV"
            },
            {
                "command": "rainbow-csv.RainbowSeparatorOn",
                "category": "Rainbow CSV",
                "title": "Re-enable Rainbow CSV"
            },
            {
                "command": "rainbow-csv.ToggleRowBackground",
                "category": "Rainbow CSV",
                "title": "Toggle Alternating Row Background"
            },
            {
                "command": "rainbow-csv.Align",
                "category": "Rainbow CSV",
                "title": "Align CSV Columns with whitespaces"
            },
            {
                "command": "rainbow-csv.Shrink",
                "category": "Rainbow CSV",
                "title": "Shrink CSV table - trim whitespaces"
            },
            {
                "command": "rainbow-csv.VirtualAlign",
                "category": "Rainbow CSV",
                "title": "Virtual Align CSV Columns"
            },
            {
                "command": "rainbow-csv.VirtualShrink",
                "category": "Rainbow CSV",
                "title": "Undo Virtual Align"
            },
            {
                "command": "rainbow-csv.CopyBack",
                "category": "Rainbow CSV",
                "title": "CopyBack"
            },
            {
                "command": "rainbow-csv.SampleHead",
                "title": "Preview big CSV: head"
            },
            {
                "command": "rainbow-csv.SampleTail",
                "title": "Preview big CSV: tail"
            },
            {
                "command": "rainbow-csv.GoToColumn",
                "category": "Rainbow CSV",
                "title": "Go to column"
            }
        ],
        "semanticTokenScopes": [
          {
            "language": "dynamic csv",
            "scopes": {
              "rainbow1": ["rainbow1"],
              "rainbow2": ["keyword.rainbow2"],
              "rainbow3": ["entity.name.function.rainbow3"],
              "rainbow4": ["comment.rainbow4"],
              "rainbow5": ["string.rainbow5"],
              "rainbow6": ["variable.parameter.rainbow6"],
              "rainbow7": ["constant.numeric.rainbow7"],
              "rainbow8": ["entity.name.type.rainbow8"],
              "rainbow9": ["markup.bold.rainbow9"],
              "rainbow10": ["invalid.rainbow10"],
              "comment": ["comment"]
            }
          }
        ],
        "configurationDefaults": {
          "[dynamic csv][csv][tsv][csv (semicolon)][csv (pipe)][csv (whitespace)]": {
            "editor.semanticHighlighting.enabled": true
          }
        },
        "grammars": [
            {
                "language": "csv",
                "scopeName": "text.csv",
                "path": "./syntaxes/csv.tmLanguage.json"
            },
            {
                "language": "tsv",
                "scopeName": "text.tsv",
                "path": "./syntaxes/tsv.tmLanguage.json"
            },
            {
                "language": "csv (pipe)",
                "scopeName": "text.psv",
                "path": "./syntaxes/pipe_simple.tmLanguage.json"
            },
            {
                "language": "csv (whitespace)",
                "scopeName": "text.wspcsv",
                "path": "./syntaxes/wspcsv.tmLanguage.json"
            },
            {
                "language": "csv (semicolon)",
                "scopeName": "text.scsv",
                "path": "./syntaxes/scsv.tmLanguage.json"
            },
            {
                "language": "dynamic csv",
                "scopeName": "text.dynamiccsv",
                "path": "./syntaxes/dynamic_csv.tmLanguage.json"
            }
        ]
    },
    "capabilities": {
        "hoverProvider": "true"
    },
    "scripts": {
        "vscode:prepublish": "npm run package-web",
        "compile-web": "webpack",
        "lint": "eslint rainbow_utils.js fast_load_utils.js extension.js test/runTest.js && eslint -c .eslintrc_browser.json rainbow_utils.js rbql_client.js dialect_select.js",
        "watch-web": "webpack --watch",
        "package-web": "webpack --mode production --devtool hidden-source-map",
        "start-web-server": "vscode-test-web --version stable --browser=none --extensionDevelopmentPath=. test",
        "test-in-browser": "vscode-test-web --version stable --browser=chromium --extensionDevelopmentPath=. --extensionTestsPath=dist/web/test/suite/index.js test",
        "test": "node ./test/runTest.js",
        "unit-test-only": "node ./test/suite/run_unit_tests.js"
    },
    "devDependencies": {
        "@types/vscode": "^1.95.0",
        "@vscode/test-web": "^0.0.64",
        "@vscode/test-electron": "^2.4.1",
        "webpack": "^5.96.1",
        "webpack-cli": "^5.1.4",
        "assert": "^2.1.0",
        "process": "^0.11.10",
        "globals": "^15.12.0",
        "eslint": "^9.15.0"
    },
    "repository": {
        "type": "git",
        "url": "https://github.com/mechatroner/vscode_rainbow_csv"
    }
}
; },
"rainbow_utils.js": function (module, exports, require, __filename, __dirname) {
const os = require('os');
const fs = require('fs');
const path = require('path');

const rbql = require('./rbql_core/rbql-js/rbql.js');
const rbql_csv = require('./rbql_core/rbql-js/rbql_csv.js');
const csv_utils = require('./rbql_core/rbql-js/csv_utils.js');

const fast_load_utils = require('./fast_load_utils.js');

const wcwidth = require('./contrib/wcwidth/index.js');

// TODO Allow the number regex to end with dot e.g. 12. or 1245. without the fractional part.
// Otherwise as soon as someone start typing a fractional part it immediately renders the whole column as non-number for live CSV editing.
const number_regex = /^([0-9]+)(\.[0-9]+)?$/;

// Copypasted from extension.js
const QUOTED_RFC_POLICY = 'quoted_rfc';
const QUOTED_POLICY = 'quoted';
const max_preview_field_length = 250;


class AssertionError extends Error {}

function assert(condition, message=null) {
    if (!condition) {
        if (!message) {
            message = 'Assertion error';
        }
        throw new AssertionError(message);
    }
}


function get_default_js_udf_content() {
    let default_content = `// This file can be used to store RBQL UDFs. Example:
    //
    // function foo(value) {
    //     return 'foo ' + String(value.length);
    // }
    //
    // Functions defined in this file can be used in RBQL queries e.g.
    // SELECT foo(a1), a2 WHERE foo(a3) != 'foo 5' LIMIT 10
    //
    // Don't forget to save this file after editing!
    //
    // Write your own functions below this line:
    `.replace(new RegExp(/^  */, 'mg'), '');
    return default_content;
}


function get_default_python_udf_content() {
    let default_content = `# This file can be used to store RBQL UDFs. Example:
    #
    # def foo(value):
    #     return 'foo ' + str(len(value))
    #
    #
    # Functions defined in this file can be used in RBQL queries e.g.
    # SELECT foo(a1), a2 WHERE foo(a3) != 'foo 5' LIMIT 10
    #
    # Don't forget to save this file after editing!
    #
    # Write your own functions below this line:
    `.replace(new RegExp(/^  */, 'mg'), '');
    return default_content;
}


function get_cursor_position_if_unambiguous(active_editor) {
    let selections = active_editor.selections;
    if (!selections || selections.length != 1) {
        // Support only single-cursor, multicursor is ambiguous.
        return null;
    }
    let selection = selections[0];
    let position = selection.active;
    if (!position.isEqual(selection.anchor)) {
        // Selections are ambiguous.
        return null;
    }
    return position;
}


function is_ascii(src_str) {
    return /^[\x00-\x7F]*$/.test(src_str);
}


class ColumnStat {
    constructor(enable_double_width_alignment) {
        this.enable_double_width_alignment = enable_double_width_alignment;
        this.can_be_numeric = true;
        this.max_total_length = 0;
        this.max_int_length = 0;
        this.max_fractional_length = 0;
        this.only_ascii = enable_double_width_alignment ? true : null;
        this.has_wide_chars = enable_double_width_alignment ? false : null;
    }

    mark_non_numeric() {
        this.can_be_numeric = false;
        this.max_int_length = 0;
        this.max_fractional_length = 0;
    }

    is_numeric() {
        return this.max_int_length > 0;
    }

    reconcile(rhs) {
        this.max_total_length = Math.max(this.max_total_length, rhs.max_total_length);
        if (this.enable_double_width_alignment) {
            assert(rhs.enable_double_width_alignment, "Unable to reconcile");
            this.only_ascii = this.only_ascii && rhs.only_ascii;
            this.has_wide_chars = this.has_wide_chars || rhs.has_wide_chars;
        }
        if (!rhs.can_be_numeric) {
            this.mark_non_numeric();
        }
        if (!this.can_be_numeric) {
            return;
        }
        this.max_int_length = Math.max(this.max_int_length, rhs.max_int_length);
        this.max_fractional_length = Math.max(this.max_fractional_length, rhs.max_fractional_length);
    }

    get_adjusted_total_length() {
        // The sum of integer and float parts can be bigger than the max width, e.g. here:
        // value
        // 0.12
        // 1234
        return Math.max(this.max_total_length, this.max_int_length + this.max_fractional_length);
    }

    get_adjusted_int_length() {
        // This is needed when the header is wider than numeric components and/or their sum.
        return Math.max(this.max_int_length, this.max_total_length - this.max_fractional_length);
    }

    update_from_field(multiline_field_segments, is_first_record) {
        if (multiline_field_segments.length > 1) {
            // We don't allow multiline fields to be numeric for simplicity.
            this.mark_non_numeric();
        }
        for (let field_segment of multiline_field_segments) {
            this.max_total_length = Math.max(this.max_total_length, field_segment.length);
            if (this.enable_double_width_alignment) {
                this.only_ascii = this.only_ascii && is_ascii(field_segment);
                let visual_field_length = this.only_ascii ? field_segment.length : wcwidth(field_segment);
                this.has_wide_chars = this.has_wide_chars || visual_field_length != field_segment.length;
                this.max_total_length = Math.max(this.max_total_length, visual_field_length);
            }
            if (!this.can_be_numeric) {
                continue;
            }
            // TODO improve number_regex and subsequent logic to work with numeric fields with leading/trailing spaces for virtual alignment.
            let match_result = number_regex.exec(field_segment);
            if (match_result === null) {
                if (!is_first_record && field_segment.length) { // Checking field_length here allows numeric columns to have some of the fields empty.
                    // We only mark the column as non-numeric if we know that this is not a header line.
                    this.mark_non_numeric();
                }
                continue;
            }
            let cur_integer_part_length = match_result[1].length;
            this.max_int_length = Math.max(this.max_int_length, cur_integer_part_length);
            let cur_fractional_part_length = match_result[2] === undefined ? 0 : match_result[2].length;
            this.max_fractional_length = Math.max(this.max_fractional_length, cur_fractional_part_length);
        }
    }

    evaluate_align_field(field, is_first_record, is_first_in_line, is_last_in_line, post_delim_readability_gap_length) {
        // Align field, use Math.max() to avoid negative delta_length which can happen theorethically due to async doc edit.
        let visual_field_length = this.has_wide_chars ? wcwidth(field) : field.length;
        let readability_gap = is_first_in_line ? 0 : post_delim_readability_gap_length;
        if (!this.is_numeric()) {
            let delta_length = Math.max(this.max_total_length - visual_field_length, 0);
            let trailing_length = is_last_in_line ? 0 : delta_length;
            return [readability_gap, trailing_length];
        }
        if (is_first_record) {
            if (number_regex.exec(field) === null) {
                // The line must be a header - align it using max_width rule.
                let delta_length = Math.max(this.get_adjusted_total_length() - visual_field_length, 0);
                let trailing_length = is_last_in_line ? 0 : delta_length;
                return [readability_gap, trailing_length];
            }
        }
        let dot_pos = field.indexOf('.');
        let cur_integer_part_length = dot_pos == -1 ? field.length : dot_pos;
        // Here `cur_fractional_part_length` includes the leading dot too.
        let cur_fractional_part_length = dot_pos == -1 ? 0 : field.length - dot_pos;
        let integer_delta_length = Math.max(this.get_adjusted_int_length() - cur_integer_part_length, 0);
        let fractional_delta_length = Math.max(this.max_fractional_length - cur_fractional_part_length);
        let trailing_length = is_last_in_line ? 0 : fractional_delta_length;
        return [integer_delta_length + readability_gap, trailing_length];
    }

}


function update_column_stats_from_record(record_fields, is_first_record, all_columns_stats, enable_double_width_alignment) {
    for (let fnum = 0; fnum < record_fields.length; fnum++) {
        if (all_columns_stats.length <= fnum) {
            all_columns_stats.push(new ColumnStat(enable_double_width_alignment));
        }
        all_columns_stats[fnum].update_from_field(record_fields[fnum], is_first_record);
    }
}


function get_trimmed_rfc_record_fields_from_record(record) {
    let record_fields = [];
    for (let fnum = 0; fnum < record.length; fnum++) {
        let field_segments = record[fnum].split('\n');
        field_segments = field_segments.map(v => v.trim());
        record_fields.push(field_segments);
    }
    return record_fields;
}


function calculate_column_offsets(column_stats, delim_length, post_delim_readability_gap_length=1) {
    let result = [];
    if (!column_stats.length) {
        return result;
    }
    result.push(0);
    for (let i = 1; i < column_stats.length; i++) {
        let previous_length = column_stats[i - 1].get_adjusted_total_length();
        let previous_offset = result[i - 1];
        result.push(previous_offset + previous_length + delim_length + post_delim_readability_gap_length);
    }
    assert(result.length == column_stats.length);
    return result;
}


function calc_column_stats(active_doc, delim, policy, comment_prefix, enable_double_width_alignment) {
    let [records, _num_records_parsed, _fields_info, first_defective_line, _first_trailing_space_line, comments] = fast_load_utils.parse_document_records(active_doc, delim, policy, comment_prefix, /*stop_on_warning=*/true, /*max_records_to_parse=*/-1, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/true);
    if (first_defective_line !== null) {
        return [null, first_defective_line, null, null];
    }
    let all_columns_stats = [];
    let is_first_record = true;
    for (let record of records) {
        // TODO for optimization we can actually return a new array of record_fields to avoid doing the same thing again in align.
        let record_fields = get_trimmed_rfc_record_fields_from_record(record);
        update_column_stats_from_record(record_fields, is_first_record, all_columns_stats, enable_double_width_alignment);
        is_first_record = false;
    }
    return [all_columns_stats, null, records, comments];
}


function calc_column_stats_for_fragment(row_infos, header_lnum, enable_double_width_alignment) {
    // Note: `row_infos` can contain non-consecutive fragments of the document e.g. header and view range below.
    let all_columns_stats = [];
    for (let row_info of row_infos) {
        if (row_info.comment_range !== null) {
            continue;
        }
        let is_assumed_header_record = row_info.record_ranges.length && row_info.record_ranges[0].length && row_info.record_ranges[0][0].start.line == header_lnum;
        update_column_stats_from_record(row_info.record_fields, is_assumed_header_record, all_columns_stats, enable_double_width_alignment);
    }
    return all_columns_stats;
}


function reconcile_whole_doc_and_local_column_stats(whole_doc_column_stats, local_column_stats) {
    let max_num_fields = Math.max(whole_doc_column_stats.length, local_column_stats.length);
    for (let i = 0; i < max_num_fields; i++) {
        if (i >= whole_doc_column_stats.length) {
            break;
        }
        if (i >= local_column_stats.length) {
            local_column_stats.push(whole_doc_column_stats[i]);
            continue;
        }
        local_column_stats[i].reconcile(whole_doc_column_stats[i]);
    }
}


function evaluate_rfc_align_field(field, is_first_record, column_stat, column_offset, is_field_segment, is_first_in_line, is_last_in_line, post_delim_readability_gap_length=1) {
    let [num_before, num_after] = column_stat.evaluate_align_field(field, is_first_record, is_first_in_line, is_last_in_line, post_delim_readability_gap_length);
    if (is_field_segment) {
        num_before += column_offset;
    }
    return [num_before, num_after];
}


function rfc_align_field(field, is_first_record, column_stat, column_offset, is_field_segment, is_first_in_line, is_last_in_line) {
    let [num_before, num_after] = evaluate_rfc_align_field(field, is_first_record, column_stat, column_offset,  is_field_segment, is_first_in_line, is_last_in_line);
    return ' '.repeat(num_before) + field + ' '.repeat(num_after);
}


function calc_max_column_widths(records) {
    if (!records.length) {
        return [];
    }
    let column_widths = [];
    for (let row = 0; row < records.length; row++) {
        for (let col = 0; col < records[row].length; col++) {
            if (column_widths.length <= col) {
                column_widths.push(0);
            }
            column_widths[col] = Math.max(column_widths[col], records[row][col].length);
        }
    }
    return column_widths;
}


function generate_markdown_lines(records) {
    for (let row = 0; row < records.length; row++) {
        for (let col = 0; col < records[row].length; col++) {
            // Escape pipe char.
            records[row][col] = records[row][col].replaceAll('|', '\\|');
        }
    }
    let max_column_widths = calc_max_column_widths(records);
    let markdown_table_cells = [];
    for (let row = 0; row < records.length; row++) {
        let markdown_row_cells = [];
        for (let col = 0; col < records[row].length; col++) {
            // Here we ensure that `delta_length` is positive just in case: the substraction result can't become negative.
            let delta_length = Math.max(0, max_column_widths[col] - records[row][col].length);
            let aligned_cell = records[row][col] + ' '.repeat(delta_length);
            markdown_row_cells.push(aligned_cell);
        }
        markdown_table_cells.push(markdown_row_cells);
    }
    let markdown_lines = markdown_table_cells.map(v => '| ' + v.join(' | ') + ' |');
    let header_separator_line = '| ' + (max_column_widths.map(v => '-'.repeat(v))).join(' | ') + ' |';
    markdown_lines.splice(1, 0, header_separator_line);
    return markdown_lines;
}


class RecordCommentMerger {
    constructor(records, comments) {
        this.records = records;
        this.comments = comments;
        this.nr = 0;
        this.next_comment = 0;
    }

    get_next() {
        // Returns tuple (record, comment).
        if (this.has_comments_left() && (!this.has_records_left() || this.comments[this.next_comment].record_num <= this.nr)) {
            let result = [null, this.comments[this.next_comment].comment_text];
            this.next_comment += 1;
            return result;
        }
        if (this.has_records_left()) {
            let result = [this.records[this.nr], null];
            this.nr += 1;
            return result;
        }
        return [null, null];
    }

    has_comments_left() {
        return this.next_comment < this.comments.length;
    }

    has_records_left() {
        return this.nr < this.records.length;
    }

    has_entries_left() {
        return this.has_comments_left() || this.has_records_left();
    }
}


function generate_inlay_hints(vscode, visible_range, header_lnum, table_ranges, all_columns_stats, delim_length, alignment_char, enable_vertical_grid, post_delim_readability_gap_length) {
    // NOTE: `table_ranges` can contain non-consecutive fragments of the document e.g. header and view range below.
    assert(alignment_char.length == 1);
    let column_offsets = calculate_column_offsets(all_columns_stats, delim_length, post_delim_readability_gap_length);
    let inlay_hints = [];
    // Setting hint display margin too high could prevent lower hint labels from diplaying. There is a non-configurable VSCode limit apparently, see also https://github.com/mechatroner/vscode_rainbow_csv/issues/205
    // We set higher limit below because it is the bottom lines that would be non-aligned due to the max inlay hint limit reached. Actually we might not need the bottom limit at all.
    // Plus the more typical scroll direction is from top to bottom.
    let leading_aligned_margin = 30;
    let trailing_aligned_margin = 30;
    let vscode_max_num_inline_hints = 1500;
    if ((leading_aligned_margin + visible_range.end.line - visible_range.start.line + trailing_aligned_margin) * all_columns_stats.length > vscode_max_num_inline_hints) {
        leading_aligned_margin = 5;
    }
    let hint_display_start_line = visible_range.start.line - leading_aligned_margin;
    let hint_display_end_line = visible_range.end.line + trailing_aligned_margin;
    for (let row_info of table_ranges) {
        if (row_info.comment_range !== null) {
            continue;
        }
        let is_assumed_header_record = row_info.record_ranges.length && row_info.record_ranges[0].length && row_info.record_ranges[0][0].start.line === header_lnum;
        if (row_info.record_fields.length != row_info.record_ranges.length) {
            break; // Should never happen.
        }
        for (let fnum = 0; fnum < row_info.record_fields.length; fnum++) {
            if (fnum >= all_columns_stats.length) {
                break; // Should never happen.
            }
            let is_last_field = fnum + 1 == row_info.record_fields.length;
            let field_segments = row_info.record_fields[fnum];
            let field_segments_ranges = row_info.record_ranges[fnum];
            if (field_segments.length != field_segments_ranges.length) {
                break; // Should never happen.
            }
            for (let i = 0; i < field_segments.length; i++) {
                let field_segment_range = field_segments_ranges[i];
                let is_field_segment = i > 0;
                let is_last_in_line = is_last_field || i + 1 < field_segments.length;
                let is_first_in_line = (fnum == 0) || is_field_segment;
                let [num_before, num_after] = evaluate_rfc_align_field(field_segments[i], is_assumed_header_record, all_columns_stats[fnum], column_offsets[fnum], is_field_segment, is_first_in_line, is_last_in_line, post_delim_readability_gap_length);
                if (num_before > 0) {
                    let hint_label = '';
                    if (!enable_vertical_grid || is_field_segment) {
                        hint_label += alignment_char.repeat(num_before);
                    } else {
                        // TODO find a way to "draw" vertical grid by extending hints for multiline rfc fields. Add a screenshot to README when implemented.
                        hint_label = '\u2588';
                        hint_label += alignment_char.repeat(num_before - 1);
                    }
                    let hint_line = field_segment_range.start.line;
                    if ((hint_line === header_lnum) || (hint_line >= hint_display_start_line && hint_line <= hint_display_end_line)) {
                        inlay_hints.push(new vscode.InlayHint(field_segment_range.start, hint_label));
                    }
                }
                if (num_after > 0) {
                    let hint_label = alignment_char.repeat(num_after);
                    let hint_line = field_segment_range.end.line;
                    if ((hint_line === header_lnum) || (hint_line >= hint_display_start_line && hint_line <= hint_display_end_line)) {
                        inlay_hints.push(new vscode.InlayHint(field_segment_range.end, hint_label));
                    }
                }
            }
        }
    }
    return inlay_hints;
}


function align_columns(records, comments, column_stats, delim) {
    // Unlike shrink_columns, here we don't compute `has_edit` flag because it is
    // 1: Algorithmically complicated (especially for multiline fields) and we also can't just compare fields lengths like in shrink.
    // 2: The alignment procedure is opinionated and "Already aligned" report has little value.
    // Because of this in case of executing "Align" command consecutively N times one would have to run undo N times too.
    // Here records do not contain delim and column_stats were calculated without taking the delim length into account.
    let column_offsets = calculate_column_offsets(column_stats, delim.length);
    let result_lines = [];
    let is_first_record = true;
    let merger = new RecordCommentMerger(records, comments);
    while (merger.has_entries_left()) {
        let [record, comment] = merger.get_next();
        assert((comment === null) != (record === null));
        if (record === null) {
            result_lines.push(comment);
            continue;
        }
        let aligned_fields = [];
        let record_fields = get_trimmed_rfc_record_fields_from_record(record);
        for (let fnum = 0; fnum < record_fields.length; fnum++) {
            if (fnum >= column_stats.length) // Safeguard against async doc edit, should never happen.
                break;
            let is_last_field = fnum + 1 == record_fields.length;
            let field_segments = record_fields[fnum];
            for (let i = 0; i < field_segments.length; i++) {
                let is_field_segment = i > 0;
                if (is_field_segment) {
                    result_lines.push(aligned_fields.join(delim));
                    aligned_fields = [];
                }
                let is_last_in_line = is_last_field || i + 1 < field_segments.length;
                let is_first_in_line = (fnum == 0) || is_field_segment;
                let aligned_field = rfc_align_field(field_segments[i], is_first_record, column_stats[fnum], column_offsets[fnum], is_field_segment, is_first_in_line, is_last_in_line);
                aligned_fields.push(aligned_field);
            }
        }
        is_first_record = false;
        result_lines.push(aligned_fields.join(delim));
    }
    return result_lines;
}


function shrink_columns(active_doc, delim, policy, comment_prefix) {
    let [records, _num_records_parsed, _fields_info, first_defective_line, _first_trailing_space_line, comments] = fast_load_utils.parse_document_records(active_doc, delim, policy, comment_prefix, /*stop_on_warning=*/true, /*max_records_to_parse=*/-1, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/true);
    if (first_defective_line !== null) {
        return [null, first_defective_line];
    }
    let result_lines = [];
    let has_edit = false;
    let merger = new RecordCommentMerger(records, comments);
    while (merger.has_entries_left()) {
        let [record, comment] = merger.get_next();
        assert((comment === null) != (record === null));
        if (record === null) {
            result_lines.push(comment);
            continue;
        }
        let aligned_fields = [];
        for (let fnum = 0; fnum < record.length; fnum++) {
            let field = record[fnum];
            let field_lines = field.split('\n');
            for (let i = 0; i < field_lines.length; i++) {
                if (i > 0) {
                    result_lines.push(aligned_fields.join(delim));
                    aligned_fields = [];
                }
                let aligned_field = field_lines[i].trim();
                if (aligned_field.length != field_lines[i].length) {
                    // Unlike in align function here we can just compare resulting length to decide if change has occured.
                    has_edit = true;
                }
                aligned_fields.push(aligned_field);
            }
        }
        result_lines.push(aligned_fields.join(delim));
    }
    if (!has_edit)
        return [null, null];
    return [result_lines.join('\n'), null];
}


function make_table_name_key(file_path) {
    return 'rbql_table_name:' + file_path;
}


function expanduser(filepath) {
    if (filepath.charAt(0) === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}


function find_table_path(vscode_global_state, main_table_dir, table_id) {
    // If table_id is a relative path it could be relative either to the current directory or to the main table dir.
    var candidate_path = expanduser(table_id);
    if (fs.existsSync(candidate_path)) {
        return candidate_path;
    }
    if (main_table_dir && !path.isAbsolute(candidate_path)) {
        candidate_path = path.join(main_table_dir, candidate_path);
        if (fs.existsSync(candidate_path)) {
            return candidate_path;
        }
    }
    let table_path = vscode_global_state ? vscode_global_state.get(make_table_name_key(table_id)) : null;
    if (table_path && fs.existsSync(table_path)) {
        return table_path;
    }
    return null;
}


async function read_header(table_path, encoding) {
    if (encoding == 'latin-1')
        encoding = 'binary';
    let readline = require('readline');
    let input_reader = readline.createInterface({ input: fs.createReadStream(table_path, {encoding: encoding}) });
    let closed = false;
    let promise_resolve = null;
    let promise_reject = null;
    let output_promise = new Promise(function(resolve, reject) {
        promise_resolve = resolve;
        promise_reject = reject;
    });
    input_reader.on('line', line => {
        if (!closed) {
            closed = true;
            input_reader.close();
            promise_resolve(line);
        }
    });
    input_reader.on('error', error => {
        promise_reject(error);
    });
    return output_promise;
}


function get_header_line(document, comment_prefix) {
    const num_lines = document.lineCount;
    for (let lnum = 0; lnum < num_lines; ++lnum) {
        const line_text = document.lineAt(lnum).text;
        if (!comment_prefix || !line_text.startsWith(comment_prefix)) {
            return [lnum, line_text];
        }
    }
    return [null, null];
}


function make_inconsistent_num_fields_warning(table_name, inconsistent_records_info) {
    let [record_num_1, num_fields_1, record_num_2, num_fields_2] = rbql.sample_first_two_inconsistent_records(inconsistent_records_info);
    let warn_msg = `Number of fields in "${table_name}" table is not consistent: `;
    warn_msg += `e.g. record ${record_num_1 + 1} -> ${num_fields_1} fields, record ${record_num_2 + 1} -> ${num_fields_2} fields`;
    return warn_msg;
}


class RbqlIOHandlingError extends Error {}

class VSCodeRecordIterator extends rbql.RBQLInputIterator {
    constructor(document, delim, policy, has_header=false, comment_prefix=null, table_name='input', variable_prefix='a', trim_whitespaces=false) {
        // We could have done a hack here actually: convert the document to stream/buffer and then use the standard reader.
        super();
        this.has_header = has_header;
        this.table_name = table_name;
        this.variable_prefix = variable_prefix;
        this.NR = 0; // Record number.
        this.NL = 0; // Line number (NL != NR when the CSV file has comments or multiline fields).
        let fail_on_warning = policy == 'quoted_rfc';
        let [_num_records_parsed, _comments] = [null, null];
        [this.records, _num_records_parsed, this.fields_info, this.first_defective_line, this._first_trailing_space_line, _comments] = fast_load_utils.parse_document_records(document, delim, policy, comment_prefix, fail_on_warning, /*max_records_to_parse=*/-1, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/false, /*detect_trailing_spaces=*/false, /*min_num_fields_for_autodetection=*/-1, trim_whitespaces);
        if (fail_on_warning && this.first_defective_line !== null) {
            throw new RbqlIOHandlingError(`Inconsistent double quote escaping in ${this.table_name} table at record ${this.records.length}, line ${this.first_defective_line + 1}`);
        }
        this.first_record = this.records.length ? this.records[0] : [];
        this.next_record_index = 0;
    }

    stop() {
    }

    async get_variables_map(query_text) {
        let variable_map = new Object();
        rbql.parse_basic_variables(query_text, this.variable_prefix, variable_map);
        rbql.parse_array_variables(query_text, this.variable_prefix, variable_map);
        if (this.has_header) {
            rbql.parse_attribute_variables(query_text, this.variable_prefix, this.first_record, 'CSV header line', variable_map);
            rbql.parse_dictionary_variables(query_text, this.variable_prefix, this.first_record, variable_map);
        }
        return variable_map;
    }

    async get_header() {
        return this.has_header ? this.first_record : null;
    }

    do_get_record() {
        if (this.next_record_index >= this.records.length) {
            return null;
        }
        let record = this.records[this.next_record_index];
        this.next_record_index += 1;
        return record;
    }

    async get_record() {
        if (this.NR == 0 && this.has_header) {
            this.do_get_record(); // Skip the header record.
        }
        this.NR += 1;
        let record = this.do_get_record();
        return record;
    }

    get_warnings() {
        let result = [];
        if (this.first_defective_line !== null)
            result.push(`Inconsistent double quote escaping in ${this.table_name} table. E.g. at line ${this.first_defective_line + 1}`);
        if (this.fields_info.size > 1)
            result.push(make_inconsistent_num_fields_warning(this.table_name, this.fields_info));
        return result;
    }
}


class VSCodeWriter extends rbql.RBQLOutputWriter {
    constructor(delim, policy) {
        super();
        this.delim = delim;
        this.policy = policy;
        this.header_len = null;
        this.null_in_output = false;
        this.delim_in_simple_output = false;
        this.output_lines = [];

        if (policy == 'simple') {
            this.polymorphic_join = this.simple_join;
        } else if (policy == 'quoted') {
            this.polymorphic_join = this.quoted_join;
        } else if (policy == 'quoted_rfc') {
            this.polymorphic_join = this.quoted_join_rfc;
        } else if (policy == 'monocolumn') {
            this.polymorphic_join = this.mono_join;
        } else if (policy == 'whitespace') {
            this.polymorphic_join = this.simple_join;
        } else {
            throw new RbqlIOHandlingError('Unknown output csv policy');
        }
    }

    set_header(header) {
        if (header !== null) {
            this.header_len = header.length;
            this.write(header);
        }
    }

    quoted_join(fields) {
        let delim = this.delim;
        var quoted_fields = fields.map(function(v) { return csv_utils.quote_field(String(v), delim); });
        return quoted_fields.join(this.delim);
    };


    quoted_join_rfc(fields) {
        let delim = this.delim;
        var quoted_fields = fields.map(function(v) { return csv_utils.rfc_quote_field(String(v), delim); });
        return quoted_fields.join(this.delim);
    };


    mono_join(fields) {
        if (fields.length > 1) {
            throw new RbqlIOHandlingError('Unable to use "Monocolumn" output format: some records have more than one field');
        }
        return fields[0];
    };


    simple_join(fields) {
        var res = fields.join(this.delim);
        if (fields.join('').indexOf(this.delim) != -1) {
            this.delim_in_simple_output = true;
        }
        return res;
    };


    normalize_fields(out_fields) {
        for (var i = 0; i < out_fields.length; i++) {
            if (out_fields[i] == null) {
                this.null_in_output = true;
                out_fields[i] = '';
            } else if (Array.isArray(out_fields[i])) {
                this.normalize_fields(out_fields[i]);
                out_fields[i] = out_fields[i].join(this.sub_array_delim);
            }
        }
    };


    write(fields) {
        if (this.header_len !== null && fields.length != this.header_len)
            throw new RbqlIOHandlingError(`Inconsistent number of columns in output header and the current record: ${this.header_len} != ${fields.length}`);
        this.normalize_fields(fields);
        this.output_lines.push(this.polymorphic_join(fields));
        return true;
    };

    async finish() {
    }

    get_warnings() {
        let result = [];
        if (this.null_in_output)
            result.push('null values in output were replaced by empty strings');
        if (this.delim_in_simple_output)
            result.push('Some output fields contain separator');
        return result;
    };
}

class VSCodeTableRegistry {
    constructor(){}

    get_iterator_by_table_id(_table_id) {
        throw new RbqlIOHandlingError("JOIN queries are currently not supported in vscode.dev web version.");
    }

    get_warnings() {
        return [];
    };
}

async function rbql_query_web(query_text, input_document, input_delim, input_policy, output_delim, output_policy, output_warnings, with_headers, comment_prefix=null, trim_whitespaces=false) {
    let user_init_code = ''; // TODO find a way to have init code.
    let join_tables_registry = new VSCodeTableRegistry(); // TODO find a way to have join registry.
    let input_iterator = new VSCodeRecordIterator(input_document, input_delim, input_policy, with_headers, comment_prefix, /*table_name=*/'input', /*variable_prefix=*/'a', trim_whitespaces);
    let output_writer = new VSCodeWriter(output_delim, output_policy);
    await rbql.query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code);
    return output_writer.output_lines;
}


class VSCodeFileSystemCSVRegistry extends rbql.RBQLTableRegistry {
    constructor(vscode_global_state, input_file_dir, delim, policy, encoding, has_header=false, comment_prefix=null, options=null) {
        super();
        this.vscode_global_state = vscode_global_state;
        this.input_file_dir = input_file_dir;
        this.delim = delim;
        this.policy = policy;
        this.encoding = encoding;
        this.has_header = has_header;
        this.comment_prefix = comment_prefix;
        this.stream = null;
        this.record_iterator = null;

        this.options = options;
        this.bulk_input_path = null;
        this.table_path = null;
    }

    get_iterator_by_table_id(table_id) {
        this.table_path = find_table_path(this.vscode_global_state, this.input_file_dir, table_id);
        if (this.table_path === null) {
            throw new RbqlIOHandlingError(`Unable to find join table "${table_id}"`);
        }
        if (this.options && this.options['bulk_read']) {
            this.bulk_input_path = this.table_path;
        } else {
            this.stream = fs.createReadStream(this.table_path);
        }
        this.record_iterator = new rbql_csv.CSVRecordIterator(this.stream, this.bulk_input_path, this.encoding, this.delim, this.policy, this.has_header, this.comment_prefix, table_id, 'b');
        return this.record_iterator;
    };

    get_warnings(output_warnings) {
        if (this.record_iterator && this.has_header) {
            output_warnings.push(`The first record in JOIN file ${path.basename(this.table_path)} was also treated as header (and skipped)`);
        }
    }
}


async function rbql_query_node(vscode_global_state, query_text, input_path, input_delim, input_policy, output_path, output_delim, output_policy, csv_encoding, output_warnings, with_headers, comment_prefix, user_init_code, options) {
    let input_stream = null;
    let bulk_input_path = null;
    if (options['bulk_read'] && input_path) {
        bulk_input_path = input_path;
    } else {
        input_stream = input_path === null ? process.stdin : fs.createReadStream(input_path);
    }
    let [output_stream, close_output_on_finish] = output_path === null ? [process.stdout, false] : [fs.createWriteStream(output_path), true];
    if (input_delim == '"' && input_policy == 'quoted')
        throw new RbqlIOHandlingError('Double quote delimiter is incompatible with "quoted" policy');
    if (csv_encoding == 'latin-1')
        csv_encoding = 'binary';
    if (!rbql_csv.is_ascii(query_text) && csv_encoding == 'binary')
        throw new RbqlIOHandlingError('To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary');
    if ((!rbql_csv.is_ascii(input_delim) || !rbql_csv.is_ascii(output_delim)) && csv_encoding == 'binary')
        throw new RbqlIOHandlingError('To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary');

    let default_init_source_path = path.join(os.homedir(), '.rbql_init_source.js');
    if (user_init_code == '' && fs.existsSync(default_init_source_path)) {
        user_init_code = rbql_csv.read_user_init_code(default_init_source_path);
    }
    let input_file_dir = input_path ? path.dirname(input_path) : null;
    let join_tables_registry = new VSCodeFileSystemCSVRegistry(vscode_global_state, input_file_dir, input_delim, input_policy, csv_encoding, with_headers, comment_prefix, options);
    let input_iterator = new rbql_csv.CSVRecordIterator(input_stream, bulk_input_path, csv_encoding, input_delim, input_policy, with_headers, comment_prefix, 'input', 'a', options['trim_whitespaces']);
    let output_writer = new rbql_csv.CSVWriter(output_stream, close_output_on_finish, csv_encoding, output_delim, output_policy);

    await rbql.query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code);
    join_tables_registry.get_warnings(output_warnings);
}


function make_multiline_row_info(vscode, delim_length, include_delim_length_in_ranges, newline_marker, fields, start_line, expected_end_line_for_control) {
    // Semantic ranges in VSCode can't span multiple lines, so we use this workaround.
    let record_ranges = [];
    let record_fields = [];
    let lnum_current = start_line;
    let pos_in_editor_line = 0;
    let next_pos_in_editor_line = 0;
    for (let i = 0; i < fields.length; i++) {
        let pos_in_multiline_field = 0;
        // Group tokens belonging to the same logical field.
        let multiline_field_singleline_ranges = [];
        let multiline_field_singleline_components = [];
        while (true) {
            let newline_marker_pos = fields[i].indexOf(newline_marker, pos_in_multiline_field);
            if (newline_marker_pos == -1)
                break;
            multiline_field_singleline_components.push(fields[i].substring(pos_in_multiline_field, newline_marker_pos));
            multiline_field_singleline_ranges.push(new vscode.Range(lnum_current, pos_in_editor_line, lnum_current, pos_in_editor_line + newline_marker_pos - pos_in_multiline_field));
            lnum_current += 1;
            pos_in_editor_line = 0;
            next_pos_in_editor_line = 0;
            pos_in_multiline_field = newline_marker_pos + newline_marker.length;
        }
        next_pos_in_editor_line += fields[i].length - pos_in_multiline_field;
        let current_range_end = next_pos_in_editor_line;
        if (i + 1 < fields.length) {
            next_pos_in_editor_line += delim_length;
            if (include_delim_length_in_ranges) {
                current_range_end = next_pos_in_editor_line;
            }
        }
        // Note that `multiline_field_singleline_components` NEVER include the delim, while `multiline_field_singleline_ranges` COULD include the delim.
        multiline_field_singleline_components.push(fields[i].substring(pos_in_multiline_field));
        multiline_field_singleline_ranges.push(new vscode.Range(lnum_current, pos_in_editor_line, lnum_current, current_range_end));
        record_fields.push(multiline_field_singleline_components);
        record_ranges.push(multiline_field_singleline_ranges);
        // From semantic tokenization perspective the end of token doesn't include the last character of vscode.Range i.e. it treats the range as [) interval, unlike the Range.contains() function which treats ranges as [] intervals.
        pos_in_editor_line = next_pos_in_editor_line;
    }
    if (lnum_current != expected_end_line_for_control) {
        return null;
    }
    return new RowInfo(record_ranges, record_fields, /*comment_prefix=*/null);
}


function is_opening_rfc_line(line_text, delim) {
    // The line is oppening if by adding a character (to avoid accidental double double quote) and single double quote at the end we can make it parsable without warning!
    // Some lines can be simultaneously opening and closing, e.g. `",a1,a2` or `a1,a2,"`
    let [_record, warning] = csv_utils.split_quoted_str(line_text + 'x"', delim);
    return !warning;
}


class RowInfo {
    // TODO consider adding parsing_error_range.
    constructor(record_ranges, record_fields, comment_range) {
        this.record_ranges = record_ranges;
        this.record_fields = record_fields;
        this.comment_range = comment_range;
    }
}


function extend_range_by_margin(vscode, doc, range, margin) {
    let begin_line = Math.max(0, range.start.line - margin);
    let end_line_inclusive = Math.min(doc.lineCount - 1, range.end.line + margin);
    return new vscode.Range(begin_line, range.start.character, end_line_inclusive, range.end.character);
}


function parse_document_range_rfc(vscode, doc, delim, include_delim_length_in_ranges, comment_prefix, range) {
    let begin_line = Math.max(0, range.start.line);
    let end_line = Math.min(doc.lineCount, range.end.line + 1);
    let table_ranges = [];
    let first_defective_line = null;
    let line_aggregator = new csv_utils.MultilineRecordAggregator(comment_prefix);
    // The first or the second line in range with an odd number of double quotes is a start line, after finding it we can use the standard parsing algorithm.
    for (let lnum = begin_line; lnum < end_line; lnum++) {
        let line_text = doc.lineAt(lnum).text;
        if (lnum + 1 == doc.lineCount && !line_text)
            break;
        let inside_multiline_record_before = line_aggregator.is_inside_multiline_record();
        let start_line = lnum - line_aggregator.get_num_lines_in_record();
        line_aggregator.add_line(line_text);
        let inside_multiline_record_after = line_aggregator.is_inside_multiline_record();
        if (!inside_multiline_record_before && inside_multiline_record_after) {
            // Must be an odd-num line, check if this is an openning line - otherwise reset ranges.
            if (!is_opening_rfc_line(line_text, delim)) {
                table_ranges = [];
                line_aggregator.reset();
            }
        }
        if (line_aggregator.has_comment_line) {
            let comment_range = new vscode.Range(lnum, 0, lnum, line_text.length);
            table_ranges.push(new RowInfo(/*record_ranges=*/null, /*record_fields=*/null, comment_range));
            line_aggregator.reset();
        } else if (line_aggregator.has_full_record) {
            const newline_marker = '\r\n'; // Use '\r\n' here to guarantee that this sequence is not present anywhere in the lines themselves. We also compare expected_end_line_for_control at the end.
            let combined_line = line_aggregator.get_full_line(newline_marker);
            line_aggregator.reset();
            let [fields, warning] = csv_utils.smart_split(combined_line, delim, QUOTED_POLICY, /*preserve_quotes_and_whitespaces=*/true);
            if (warning) {
                if (first_defective_line === null) {
                    first_defective_line = lnum;
                }
            } else {
                let row_info = make_multiline_row_info(vscode, delim.length, include_delim_length_in_ranges, newline_marker, fields, start_line, /*expected_end_line_for_control=*/lnum);
                if (row_info !== null) {
                    // If row_info is null it means that `expected_end_line_for_control` doesn't match and something went very wrong with the newline_marker join workaround.
                    table_ranges.push(row_info);
                }
            }
        }
    }
    return [table_ranges, first_defective_line];
}


function parse_document_range_single_line(vscode, doc, delim, include_delim_length_in_ranges, policy, comment_prefix, range) {
    let table_ranges = [];
    let begin_line = Math.max(0, range.start.line);
    let end_line = Math.min(doc.lineCount, range.end.line + 1);
    let first_defective_line = null;
    for (let lnum = begin_line; lnum < end_line; lnum++) {
        let record_ranges = [];
        let record_fields = [];
        let line_text = doc.lineAt(lnum).text;
        if (lnum + 1 == doc.lineCount && !line_text)
            break;
        if (comment_prefix && line_text.startsWith(comment_prefix)) {
            let comment_range = new vscode.Range(lnum, 0, lnum, line_text.length);
            table_ranges.push(new RowInfo(/*record_ranges=*/null, /*record_fields=*/null, comment_range));
            continue;
        }
        let [fields, warning] = csv_utils.smart_split(line_text, delim, policy, /*preserve_quotes_and_whitespaces=*/true);
        if (warning) {
            if (first_defective_line === null) {
                first_defective_line = lnum;
            }
            continue;
        }
        let cpos = 0;
        let next_cpos = 0;
        for (let i = 0; i < fields.length; i++) {
            next_cpos += fields[i].length;
            let current_range_end = next_cpos;
            if (i + 1 < fields.length) {
                next_cpos += delim.length;
                if (include_delim_length_in_ranges) {
                    current_range_end = next_cpos;
                }
            }
            // Note that `record_fields` NEVER include the delim, while `record_ranges` COULD include the delim.
            record_fields.push([fields[i]]);
            record_ranges.push([new vscode.Range(lnum, cpos, lnum, current_range_end)]);
            // From semantic tokenization perspective the end of token doesn't include the last character of vscode.Range i.e. it treats the range as [) interval, unlike the Range.contains() function which treats ranges as [] intervals.
            cpos = next_cpos;
        }
        table_ranges.push(new RowInfo(record_ranges, record_fields, /*comment_range=*/null));
    }
    return [table_ranges, first_defective_line];
}


function parse_document_range(vscode, doc, delim, include_delim_length_in_ranges, policy, comment_prefix, range) {
    // A single field can contain multiple ranges if it spans multiple lines.
    // A generic example for an rfc file:
    // [
    //     record_ranges: [[field_1_range_1, field_1_range_2, ... ,field_1_range_n], ... [field_n_range_1]]
    //     ...
    //     record_ranges: [[field_1_range_1], ..., [field_n_range_1]]
    // ]
    // There is no warning returned because on parsing failure it would just return a partial range.
    if (policy == QUOTED_RFC_POLICY) {
        return parse_document_range_rfc(vscode, doc, delim, include_delim_length_in_ranges, comment_prefix, range);
    } else {
        return parse_document_range_single_line(vscode, doc, delim, include_delim_length_in_ranges, policy, comment_prefix, range);
    }
}


function get_field_by_line_position(fields, delim_length, query_pos) {
    if (!fields.length)
        return null;
    var col_num = 0;
    var cpos = fields[col_num].length + delim_length;
    while (query_pos > cpos && col_num + 1 < fields.length) {
        col_num += 1;
        cpos = cpos + fields[col_num].length + delim_length;
    }
    return col_num;
}


function get_cursor_position_info_rfc(vscode, document, delim, comment_prefix, position) {
    let range = new vscode.Range(position.line, 0, position.line, 0);
    range = extend_range_by_margin(vscode, document, range, 20);
    let table_ranges = parse_document_range_rfc(vscode, document, delim, /*include_delim_length_in_ranges=*/true, comment_prefix, range)[0];
    let last_found_position_info = null; // Use last found instead of first found because cursor position at the border can belong to two ranges simultaneously.
    for (let row_info of table_ranges) {
        if (row_info.comment_range !== null) {
            if (row_info.comment_range.contains(position)) {
                last_found_position_info = {is_comment: true};
            }
        } else {
            for (let col_num = 0; col_num < row_info.record_ranges.length; col_num++) {
                // One logical field can map to multiple ranges if it spans multiple lines.
                for (let record_range of row_info.record_ranges[col_num]) {
                    if (record_range.contains(position)) {
                        last_found_position_info = {column_number: col_num, total_columns: row_info.record_ranges.length, split_warning: false};
                    }
                }
            }
        }
    }
    return last_found_position_info;
}


function get_cursor_position_info_standard(document, delim, policy, comment_prefix, position) {
    var lnum = position.line;
    var cnum = position.character;
    var line = document.lineAt(lnum).text;

    if (comment_prefix && line.startsWith(comment_prefix))
        return {is_comment: true};

    let [entries, warning] = csv_utils.smart_split(line, delim, policy, true);
    var col_num = get_field_by_line_position(entries, delim.length, cnum + 1);
    if (col_num == null)
        return null;
    return {column_number: col_num, total_columns: entries.length, split_warning: warning};
}


function get_cursor_position_info(vscode, document, delim, policy, comment_prefix, position) {
    if (policy === null)
        return null;
    if (policy == QUOTED_RFC_POLICY) {
        return get_cursor_position_info_rfc(vscode, document, delim, comment_prefix, position);
    } else {
        return get_cursor_position_info_standard(document, delim, policy, comment_prefix, position);
    }
}


function format_cursor_position_info(cursor_position_info, header, show_column_names, show_comments, max_label_length) {
    if (cursor_position_info.is_comment) {
        if (show_comments) {
            return ['Comment', 'Comment'];
        } else {
            return [null, null];
        }
    }
    let short_report = 'Col ' + (cursor_position_info.column_number + 1);
    let full_report = '[Rainbow CSV] ' + short_report;
    if (show_column_names && cursor_position_info.column_number < header.length) {
        let column_label = header[cursor_position_info.column_number].trim();
        let short_column_label = column_label.substr(0, max_label_length);
        if (short_column_label != column_label)
            short_column_label = short_column_label + '...';
        short_report += ': ' + short_column_label;
        full_report += ': ' + column_label;
    }
    if (cursor_position_info.split_warning) {
        full_report += '; ERR: Inconsistent double quotes in line';
    } else if (header.length != cursor_position_info.total_columns) {
        full_report += `; WARN: Inconsistent num of fields, header: ${header.length}, this line: ${cursor_position_info.total_columns}`;
    }
    return [full_report, short_report];
}


function sample_records(document, delim, policy, comment_prefix, end_record, preview_window_size, stop_on_warning, cached_table_parse_result) {
    let records = [];
    let first_failed_line = null;
    let vscode_doc_version = null;
    let [_num_records_parsed, _fields_info, _first_trailing_space_line, _comments] = [null, null, null, null];
    // Here `preview_window_size` is typically 100.
    if (end_record < preview_window_size * 5) {
        // Re-sample the records. Re-sampling top records is fast and it ensures that all manual changes are mirrored into RBQL console.
        [records, _num_records_parsed, _fields_info, first_failed_line, _first_trailing_space_line, _comments] = fast_load_utils.parse_document_records(document, delim, policy, comment_prefix, stop_on_warning, /*max_records_to_parse=*/end_record, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/false);
    } else {
        let need_full_doc_parse = true;
        if (cached_table_parse_result.has(document.fileName)) {
            [records, first_failed_line, vscode_doc_version] = cached_table_parse_result.get(document.fileName);
            if (document.version === vscode_doc_version) {
                need_full_doc_parse = false;
            }
        }
        if (need_full_doc_parse) {
            let [records, _num_records_parsed, _fields_info, first_failed_line, _first_trailing_space_line, _comments] = fast_load_utils.parse_document_records(document, delim, policy, comment_prefix, stop_on_warning, /*max_records_to_parse=*/-1, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/false);
            cached_table_parse_result.set(document.fileName, [records, first_failed_line, document.version]);
        }
        [records, first_failed_line, vscode_doc_version] = cached_table_parse_result.get(document.fileName);
    }
    return [records, first_failed_line];
}


function sample_preview_records_from_context(rbql_context, dst_message, preview_window_size, cached_table_parse_result) {
    let [document, delim, policy, comment_prefix] = [rbql_context.input_document, rbql_context.delim, rbql_context.policy, rbql_context.comment_prefix];
    rbql_context.requested_start_record = Math.max(rbql_context.requested_start_record, 0);
    let stop_on_warning = policy == QUOTED_RFC_POLICY;
    let [records, first_failed_line] = sample_records(document, delim, policy, comment_prefix, rbql_context.requested_start_record + preview_window_size, preview_window_size, stop_on_warning, cached_table_parse_result);;
    if (first_failed_line !== null && policy == QUOTED_RFC_POLICY) {
        dst_message.preview_sampling_error = `Double quotes are not consistent in record ${records.length + 1} which starts at line ${first_failed_line + 1}`;
        return;
    }
    rbql_context.requested_start_record = Math.max(0, Math.min(rbql_context.requested_start_record, records.length - preview_window_size));
    let preview_records = records.slice(rbql_context.requested_start_record, rbql_context.requested_start_record + preview_window_size);

    // Here we trim excessively long fields. The only benefit of doing is here instead of UI layer is to minimize the ammount of traffic that we send to UI - the total message size is limited.
    for (let r = 0; r < preview_records.length; r++) {
        let cur_record = preview_records[r];
        for (let c = 0; c < cur_record.length; c++) {
            if (cur_record[c].length > max_preview_field_length) {
                cur_record[c] = cur_record[c].substr(0, max_preview_field_length) + '###UI_STRING_TRIM_MARKER###';
            }
        }
    }
    dst_message.preview_records = preview_records;
    dst_message.actual_start_record = rbql_context.requested_start_record;
}

function show_lint_status_bar_button(vscode, extension_context, file_path, language_id) {

    const COLOR_PROCESSING = '#A0A0A0';
    const COLOR_ERROR      = '#f44242';
    const COLOR_WARNING    = '#ffff28';
    const COLOR_OK         = '#62f442';

    let lint_cache_key = `${file_path}.${language_id}`;

    if (!extension_context.lint_results.has(lint_cache_key)){
      return;
    }

    var lint_report = extension_context.lint_results.get(lint_cache_key);

    if (!extension_context.lint_status_bar_button){
      extension_context.lint_status_bar_button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    }

    extension_context.lint_status_bar_button.text = 'CSVLint';
    let lint_report_msg = '';
    if (lint_report.is_processing) {

        extension_context.lint_status_bar_button.color = COLOR_PROCESSING;
        extension_context.lint_status_bar_button.text = '$(clock) CSVLint';
        lint_report_msg = 'Processing';

    } else if (Number.isInteger(lint_report.first_defective_line)) {

        lint_report_msg = `Error. Line ${lint_report.first_defective_line + 1} has formatting error: double quote chars are not consistent`;
        extension_context.lint_status_bar_button.color = COLOR_ERROR;
        extension_context.lint_status_bar_button.text = '$(error) CSVLint';

    } else if (lint_report.fields_info && lint_report.fields_info.size > 1) {

        let [record_num_1, num_fields_1, record_num_2, num_fields_2] = rbql.sample_first_two_inconsistent_records(lint_report.fields_info);
        lint_report_msg = `Error. Number of fields is not consistent: e.g. record ${record_num_1 + 1} has ${num_fields_1} fields, and record ${record_num_2 + 1} has ${num_fields_2} fields`;
        extension_context.lint_status_bar_button.color = COLOR_ERROR;
        extension_context.lint_status_bar_button.text = '$(error) CSVLint';

    } else if (Number.isInteger(lint_report.first_trailing_space_line)) {

        lint_report_msg = `Leading/Trailing spaces detected: e.g. at line ${lint_report.first_trailing_space_line + 1}. Run "Shrink" command to remove them`;
        extension_context.lint_status_bar_button.color = COLOR_WARNING;
        extension_context.lint_status_bar_button.text = '$(alert) CSVLint';
    } else {
        assert(lint_report.is_ok);
        extension_context.lint_status_bar_button.color = COLOR_OK;
        extension_context.lint_status_bar_button.text = '$(pass) CSVLint';
        lint_report_msg = 'OK';
    }
    extension_context.lint_status_bar_button.tooltip = lint_report_msg + '\nClick to recheck';
    extension_context.lint_status_bar_button.command = 'rainbow-csv.CSVLint';
    extension_context.lint_status_bar_button.show();
}


function generate_column_edit_selections(vscode, active_doc, delim, policy, comment_prefix, edit_mode, col_num) {
    let [records, _num_records_parsed, _fields_info, first_defective_line, _first_trailing_space_line, comments] = fast_load_utils.parse_document_records(active_doc, delim, policy, comment_prefix, /*stop_on_warning=*/true, /*max_records_to_parse=*/-1, /*collect_records=*/true, /*preserve_quotes_and_whitespaces=*/true);
    if (first_defective_line !== null) {
        return [null, `Unable to enter column edit mode: quoting error at line ${first_defective_line + 1}`, null];
    }
    if (records.length + comments.length != active_doc.lineCount) {
        // It is possible to support editing of non-multiline columns in such files, but for simplicity we won't do this.
        return [null, 'Column edit mode is not supported for files with multiline fields', null];
    }
    let lnum = 0;
    let selections = [];
    let warning_msg = null;
    let merger = new RecordCommentMerger(records, comments);
    while (merger.has_entries_left()) {
        let [record, comment] = merger.get_next();
        assert((comment === null) != (record === null));
        if (record !== null) {
            if (col_num >= record.length) {
                return [null, `Line ${lnum + 1} doesn't have field number ${col_num + 1}`, null];
            }
            let char_pos_before = record.slice(0, col_num).join('').length + col_num * delim.length;
            let char_pos_after = record.slice(0, col_num + 1).join('').length + col_num * delim.length;
            let line_text = record.join(delim);
            if (!warning_msg && edit_mode == 'ce_before' && (policy == QUOTED_POLICY || policy == QUOTED_RFC_POLICY) && line_text.substring(char_pos_before - 2, char_pos_before + 2).indexOf('"') != -1) {
                warning_msg = `Be careful, cursor at line ${lnum + 1} has a double quote is in proximity.`;
            }
            if (!warning_msg && edit_mode == 'ce_after' && (policy == QUOTED_POLICY || policy == QUOTED_RFC_POLICY) && line_text.substring(char_pos_after - 2, char_pos_after + 2).indexOf('"') != -1) {
                warning_msg = `Be careful, cursor at line ${lnum + 1} has a double quote is in proximity.`;
            }
            if (!warning_msg && edit_mode == 'ce_select' && char_pos_before == char_pos_after) {
                warning_msg = `Be careful, Field ${col_num + 1} at line ${lnum + 1} is empty.`;
            }
            let position_before = new vscode.Position(lnum, char_pos_before);
            let position_after = new vscode.Position(lnum, char_pos_after);
            if (edit_mode == 'ce_before') {
                selections.push(new vscode.Selection(position_before, position_before));
            }
            if (edit_mode == 'ce_after') {
                selections.push(new vscode.Selection(position_after, position_after));
            }
            if (edit_mode == 'ce_select') {
                selections.push(new vscode.Selection(position_before, position_after));
            }
        }
        lnum += 1;
    }
    return [selections, null, warning_msg];
}


module.exports.make_table_name_key = make_table_name_key;
module.exports.find_table_path = find_table_path;
module.exports.read_header = read_header;
module.exports.rbql_query_web = rbql_query_web;
module.exports.rbql_query_node = rbql_query_node;
module.exports.get_header_line = get_header_line;
module.exports.get_default_js_udf_content = get_default_js_udf_content;
module.exports.get_default_python_udf_content = get_default_python_udf_content;
module.exports.align_columns = align_columns;
module.exports.shrink_columns = shrink_columns;
module.exports.calculate_column_offsets = calculate_column_offsets;
module.exports.calc_column_stats = calc_column_stats;
module.exports.calc_column_stats_for_fragment = calc_column_stats_for_fragment;
module.exports.reconcile_whole_doc_and_local_column_stats = reconcile_whole_doc_and_local_column_stats;
module.exports.rfc_align_field = rfc_align_field;
module.exports.evaluate_rfc_align_field = evaluate_rfc_align_field;
module.exports.assert = assert;
module.exports.get_field_by_line_position = get_field_by_line_position;
module.exports.get_cursor_position_info = get_cursor_position_info;
module.exports.format_cursor_position_info = format_cursor_position_info;
module.exports.parse_document_range = parse_document_range;
module.exports.parse_document_range_single_line = parse_document_range_single_line;
module.exports.parse_document_range_rfc = parse_document_range_rfc; // Only for unit tests.
module.exports.sample_preview_records_from_context = sample_preview_records_from_context;
module.exports.sample_first_two_inconsistent_records = rbql.sample_first_two_inconsistent_records;
module.exports.is_opening_rfc_line = is_opening_rfc_line; // Only for unit tests.
module.exports.show_lint_status_bar_button = show_lint_status_bar_button;
module.exports.get_cursor_position_if_unambiguous = get_cursor_position_if_unambiguous;
module.exports.RecordCommentMerger = RecordCommentMerger;
module.exports.ColumnStat = ColumnStat;
module.exports.generate_column_edit_selections = generate_column_edit_selections;
module.exports.generate_inlay_hints = generate_inlay_hints;
module.exports.extend_range_by_margin = extend_range_by_margin;
module.exports.calc_max_column_widths = calc_max_column_widths; // Only for unit tests.
module.exports.generate_markdown_lines = generate_markdown_lines;

},
"rbql_client.js": function (module, exports, require, __filename, __dirname) {
var rbql_running = false;

var handshake_completed = false;

var query_history = [];

const vscode = acquireVsCodeApi();

var global_css_style = null;

var last_preview_message = null;

var adjust_join_table_header_callback = null;

var global_header = null;

var is_web_ext = null;

function report_backend_language_change() {
    let backend_language = document.getElementById('select_backend_language').value;
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_backend_language', 'value': backend_language});
    assign_backend_lang_selection_title();
}


function report_encoding_change() {
    let encoding = document.getElementById('select_encoding').value;
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_encoding', 'value': encoding});
}


function remove_children(root_node) {
    while (root_node.firstChild) {
        root_node.removeChild(root_node.firstChild);
    }
}


function get_max_num_columns(records, with_headers) {
    let max_num_columns = 0;
    for (let r = 0; r < records.length; r++) {
        max_num_columns = Math.max(max_num_columns, records[r].length);
    }
    if (with_headers && global_header && global_header.length)
        max_num_columns = Math.max(max_num_columns, global_header.length);
    return max_num_columns;
}


function add_header_cell_with_text(cell_text, dst_row_elem) {
    let cell = document.createElement('th');
    cell.textContent = cell_text;
    dst_row_elem.appendChild(cell);
}


function add_header_row(max_num_columns, with_headers, table) {
    let row_elem = document.createElement('tr');
    add_header_cell_with_text('NR', row_elem);
    let named_header_vars = [];
    if (with_headers && global_header && global_header.length) {
        named_header_vars = rbql_suggest.convert_header_to_rbql_variables(global_header, 'a');
    }
    for (let i = 0; i < max_num_columns; i++) {
        let cell_text = `a${i + 1}`;
        if (i < named_header_vars.length) {
            let var_column = named_header_vars[i].dot_var ? named_header_vars[i].dot_var : named_header_vars[i].single_q_var;
            cell_text += '\r\n' + var_column;
        }
        add_header_cell_with_text(cell_text, row_elem);
    }
    table.appendChild(row_elem);
}


function make_data_cell(cell_text) {
    let cell = document.createElement('td');
    const trim_marker = '###UI_STRING_TRIM_MARKER###';
    let add_ellipsis = false;
    if (cell_text.endsWith(trim_marker)) {
        cell_text = cell_text.substr(0, cell_text.length - trim_marker.length);
        add_ellipsis = true;
    }
    let field_rfc_lines = cell_text.split('\n');
    for (let i = 0; i < field_rfc_lines.length; i++) {
        let span = document.createElement('span');
        span.textContent = field_rfc_lines[i];
        cell.appendChild(span);
        if (i + 1 < field_rfc_lines.length) {
            let newline_span = document.createElement('span');
            newline_span.textContent = '\\n';
            newline_span.style.color = global_css_style.getPropertyValue('--vscode-editorWarning-foreground');
            newline_span.title = 'new line';
            cell.appendChild(newline_span);
        }
    }
    if (add_ellipsis) {
        let ellipsis_span = document.createElement('span');
        ellipsis_span.style.color = global_css_style.getPropertyValue('--vscode-editorWarning-foreground');
        ellipsis_span.textContent = ' ...';
        ellipsis_span.title = 'value too long to display';
        cell.appendChild(ellipsis_span);
    }
    return cell;
}


function make_nr_cell(cell_text) {
    let nr_cell = document.createElement('td');
    nr_cell.textContent = cell_text;
    return nr_cell;
}


function make_preview_table() {
    if (!last_preview_message)
        return;
    let records = last_preview_message.preview_records;
    let actual_start_record = last_preview_message.actual_start_record;
    let preview_error = last_preview_message.preview_sampling_error;

    var table = document.getElementById('preview_table');
    remove_children(table);
    if (preview_error) {
        let row = document.createElement('tr');
        table.appendChild(row);
        let span = document.createElement('span');
        span.style.color = global_css_style.getPropertyValue('--vscode-inputValidation-errorForeground');
        span.textContent = 'Unable to display preview table and run RBQL query:';
        row.appendChild(span);
        row.appendChild(document.createElement('br'));
        span = document.createElement('span');
        span.style.color = global_css_style.getPropertyValue('--vscode-inputValidation-errorForeground');
        span.textContent = preview_error;
        row.appendChild(span);
        return;
    }

    let with_headers = document.getElementById('with_headers').checked;
    let max_num_columns = get_max_num_columns(records, with_headers);
    add_header_row(max_num_columns, with_headers, table);
    for (var r = 0; r < records.length; r++) {
        let row = document.createElement('tr');
        let NR = r + actual_start_record + 1;
        if (with_headers) {
            NR -= 1;
            if (NR == 0)
                continue;
        }
        row.appendChild(make_nr_cell(String(NR)));
        for (var nf = 0; nf < records[r].length; nf++) {
            row.appendChild(make_data_cell(records[r][nf]));
        }
        table.appendChild(row);
    }
}


function navigate_preview(direction) {
    vscode.postMessage({'msg_type': 'navigate', 'direction': direction});
}


function preview_backward() {
    navigate_preview('backward');
}


function preview_forward() {
    navigate_preview('forward');
}


function preview_begin() {
    navigate_preview('begin');
}


function preview_end() {
    navigate_preview('end');
}


function apply_suggest_callback(query) {
    vscode.postMessage({'msg_type': 'update_query', 'query': query});
}


function fetch_join_header_callback(join_table_id, adjust_join_table_headers) {
    adjust_join_table_header_callback = adjust_join_table_headers;
    let encoding = document.getElementById('select_encoding').value;
    vscode.postMessage({'msg_type': 'fetch_table_header', 'table_id': join_table_id, 'encoding': encoding});
}


function process_with_headers_change() {
    let with_headers = document.getElementById('with_headers').checked;
    vscode.postMessage({'msg_type': 'with_headers_change', 'with_headers': with_headers}); // We need to send it to remember preview state
    let header = with_headers ? global_header : null;
    rbql_suggest.initialize_suggest('rbql_input', 'query_suggest', 'history_button', apply_suggest_callback, header, fetch_join_header_callback);
    make_preview_table();
}


function show_error(error_type, error_msg) {
    error_msg = error_msg.replace('\r?\n', '\r\n');
    document.getElementById('error_message_header').textContent = 'Error type: "' + error_type + '"';
    document.getElementById('error_message_details').textContent = error_msg;
    document.getElementById('rbql_error_message').style.display = 'block';
    document.getElementById('ack_error').focus();
}


function hide_error_msg() {
    document.getElementById('rbql_error_message').style.display = 'none';
    document.getElementById("rbql_input").focus();
}


function toggle_help_msg() {
    let document_bg_color = global_css_style.getPropertyValue('--vscode-notifications-background');
    let rbql_help_element = document.getElementById('rbql_help');
    var style_before = rbql_help_element.style.display;
    var new_style = style_before == 'block' ? 'none' : 'block';
    if (new_style == 'block')
        rbql_help_element.style.backgroundColor = document_bg_color;
    rbql_help_element.style.display = new_style;
    document.getElementById('close_help').style.display = new_style;
}


function register_history_callback(button_element, query) {
    button_element.addEventListener("click", () => { document.getElementById('rbql_input').value = query; });
}


function toggle_history() {
    let query_history_block = document.getElementById('query_history');
    var style_before = query_history_block.style.display;
    var new_style = style_before == 'block' ? 'none' : 'block';
    if (new_style == 'block') {
        document.getElementById('toggle_history_btn').textContent = '\u25BC';
    } else {
        document.getElementById('toggle_history_btn').textContent = '\u25B2';
    }
    let history_entries_block = document.getElementById('history_entries');
    remove_children(history_entries_block);
    for (let nr = 0; nr < query_history.length; nr++) {
        let entry_button = document.createElement('button');
        entry_button.className = 'history_button';
        entry_button.textContent = query_history[nr];
        register_history_callback(entry_button, query_history[nr]);
        history_entries_block.appendChild(entry_button);
    }
    query_history_block.style.display = new_style;
    let calculated_height = query_history_block.offsetHeight;
    let text_input_coordinates = document.getElementById('rbql_input').getBoundingClientRect();
    query_history_block.style.left = text_input_coordinates.left + 'px';
    query_history_block.style.top = (text_input_coordinates.top - calculated_height) + 'px';
}


function clear_history() {
    query_history = [];
    toggle_history();
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_query_history', 'value': []});
}


function start_rbql() {
    var rbql_text = document.getElementById('rbql_input').value;
    if (!rbql_text || rbql_running)
        return;
    rbql_running = true;
    document.getElementById('rbql_run_btn').textContent = "\u231B";
    let backend_language = document.getElementById('select_backend_language').value;
    let output_format = document.getElementById('select_output_format').value;
    let encoding = document.getElementById('select_encoding').value;
    let with_headers = document.getElementById('with_headers').checked;
    vscode.postMessage({'msg_type': 'run', 'query': rbql_text, 'backend_language': backend_language, 'output_dialect': output_format, 'encoding': encoding, 'with_headers': with_headers});
}


function handle_message(msg_event) {
    var message = msg_event.data;
    console.log('message received at client: ' + JSON.stringify(msg_event));
    let message_type = message['msg_type'];

    if (message_type == 'handshake') {
        if (handshake_completed)
            return;
        handshake_completed = true;
        if (message.hasOwnProperty('last_query')) {
            document.getElementById('rbql_input').value = message['last_query'];
        }
        if (message.hasOwnProperty('query_history')) {
            query_history = message['query_history'];
        }
        global_header = message['header_for_ui'];
        is_web_ext = message['is_web_ext'];
        let with_headers = message['with_headers'];
        let header = with_headers ? global_header : null;
        rbql_suggest.initialize_suggest('rbql_input', 'query_suggest', 'history_button', apply_suggest_callback, header, fetch_join_header_callback);
        last_preview_message = message;
        document.getElementById("select_backend_language").value = message['backend_language'];
        assign_backend_lang_selection_title();
        document.getElementById("select_encoding").value = message['encoding'];
        document.getElementById("with_headers").checked = with_headers;
        make_preview_table();

        let integration_test_query = message['integration_test_query'];
        let integration_test_language = message['integration_test_language'];
        let integration_test_delay = message.hasOwnProperty('integration_test_delay') ? message.integration_test_delay : 2000;
        if (integration_test_query && integration_test_language) {
            if (message['integration_test_with_headers']) {
                document.getElementById("with_headers").checked = true;
            } else {
                document.getElementById("with_headers").checked = false;
            }
            process_with_headers_change();
            document.getElementById("select_backend_language").value = integration_test_language;
            assign_backend_lang_selection_title();
            document.getElementById('rbql_input').value = integration_test_query;
            setTimeout(function() {
                start_rbql();
            }, integration_test_delay);
        }
    }

    if (message_type == 'fetch_table_header_response') {
        if (adjust_join_table_header_callback && message['header_for_ui']) {
            adjust_join_table_header_callback(message['header_for_ui']);
        }
    }

    if (message_type == 'navigate' || message_type == 'resample') {
        last_preview_message = message;
        make_preview_table();
    }

    if (message_type == 'rbql_report') {
        rbql_running = false;
        if (message.hasOwnProperty('error_type') || message.hasOwnProperty('error_msg')) {
            let error_type = message.hasOwnProperty('error_type') ? message['error_type'] : 'Unexpected';
            let error_msg = message.hasOwnProperty('error_msg') ? message['error_msg'] : 'Unknown Error';
            show_error(error_type, error_msg);
        }
        document.getElementById('rbql_run_btn').textContent = "Run";
    }
}


function is_printable_key_code(keycode) {
    // Taken from here: https://stackoverflow.com/a/12467610/2898283
    return (keycode > 47 && keycode < 58) || keycode == 32 || (keycode > 64 && keycode < 91) || (keycode > 185 && keycode < 193) || (keycode > 218 && keycode < 223);
}


function handle_input_keyup(event) {
    rbql_suggest.handle_input_keyup(event);
    if (is_printable_key_code(event.keyCode) || event.keyCode == 8 /* Bakspace */) {
        let current_query = document.getElementById('rbql_input').value;
        vscode.postMessage({'msg_type': 'update_query', 'query': current_query});
    }
}


function handle_input_keydown(event) {
    if (event.keyCode == 13 && rbql_suggest.active_suggest_idx === null) {
        start_rbql();
    } else {
        rbql_suggest.handle_input_keydown(event);
    }
}


function assign_backend_lang_selection_title() {
    let select_backend_element = document.getElementById('select_backend_language');
    let backend_language = select_backend_element.value;
    if (backend_language == 'js') {
        select_backend_element.title = 'Allows to use JS expressions such as: `Math.sqrt(a1)`, `a2.substring(1, 5)`, `a3.toUpperCase()`, etc';
    } else {
        select_backend_element.title = 'Allows to use Python expressions such as: `math.sqrt(float(a1))`, `a2[1:5]`, `a3.upper()`, etc';
    }
}


function handle_udf_edit() {
    let backend_language = document.getElementById('select_backend_language').value;
    vscode.postMessage({'msg_type': 'edit_udf', 'backend_language': backend_language});
}


function main() {
    global_css_style = getComputedStyle(document.body);
    assign_backend_lang_selection_title();

    window.addEventListener('message', handle_message);
    vscode.postMessage({'msg_type': 'handshake'});

    document.getElementById("rbql_run_btn").addEventListener("click", start_rbql);
    document.getElementById("select_backend_language").addEventListener("change", report_backend_language_change);
    document.getElementById("select_encoding").addEventListener("change", report_encoding_change);
    document.getElementById("with_headers").addEventListener("click", process_with_headers_change);
    document.getElementById("ack_error").addEventListener("click", hide_error_msg);
    document.getElementById("help_btn").addEventListener("click", toggle_help_msg);
    document.getElementById("close_help").addEventListener("click", toggle_help_msg);
    document.getElementById("toggle_history_btn").addEventListener("click", toggle_history);
    document.getElementById("clear_history_btn").addEventListener("click", clear_history);
    document.getElementById("go_begin").addEventListener("click", preview_begin);
    document.getElementById("go_backward").addEventListener("click", preview_backward);
    document.getElementById("go_forward").addEventListener("click", preview_forward);
    document.getElementById("go_end").addEventListener("click", preview_end);
    document.getElementById("rbql_input").addEventListener("keyup", handle_input_keyup);
    document.getElementById("rbql_input").addEventListener("keydown", handle_input_keydown);
    document.getElementById("udf_button").addEventListener("click", handle_udf_edit);
    document.getElementById("rbql_input").focus();
}


document.addEventListener("DOMContentLoaded", function(_event) {
    main();
});

},
"rbql_core/rbql-js/.eslintrc.json": function (module) { module.exports = {
    "env": {
        "browser": false,
        "commonjs": true,
        "es6": true,
        "node": true
    },
    "parserOptions": {
        "ecmaFeatures": {
            "jsx": true
        },
        "sourceType": "module",
        "ecmaVersion": 2018
    },
    "rules": {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "semi": [2, "always"],
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "no-trailing-spaces": "error",
        "valid-typeof": "warn"
    }
}
; },
"rbql_core/rbql-js/cli_parser.js": function (module, exports, require, __filename, __dirname) {
function die(error_msg) {
    console.error('Error: ' + error_msg);
    process.exit(1);
}


function normalize_cli_key(cli_key) {
    return cli_key.replace(/^-*/, '');
}


function show_help(scheme, description, epilog) {
    if (description)
        console.log(description);
    console.log('Options:');
    for (var k in scheme) {
        if (scheme[k].hasOwnProperty('hidden')) {
            continue;
        }
        let metavar = '';
        if (scheme[k].hasOwnProperty('metavar'))
            metavar = ' ' + scheme[k]['metavar'];
        console.log('  ' + k + metavar);
        if (scheme[k].hasOwnProperty('default')) {
            console.log('      Default: "' + scheme[k]['default'] + '"');
        }
        console.log('      ' + scheme[k]['help']);
        console.log();
    }
    if (epilog)
        console.log(epilog);
}


function parse_cmd_args(cmd_args, scheme, description=null, epilog=null) {
    var result = {};
    for (var arg_key in scheme) {
        var arg_info = scheme[arg_key];
        if (arg_info.hasOwnProperty('default'))
            result[normalize_cli_key(arg_key)] = arg_info['default'];
        if (arg_info.hasOwnProperty('boolean'))
            result[normalize_cli_key(arg_key)] = false;
    }
    cmd_args = cmd_args.slice(2);
    var i = 0;
    while(i < cmd_args.length) {
        var arg_key = cmd_args[i];
        if (arg_key == '--help' || arg_key == '-h') {
            show_help(scheme, description, epilog);
            process.exit(0);
        }
        i += 1;
        if (!scheme.hasOwnProperty(arg_key)) {
            die(`unknown argument: ${arg_key}`);
        }
        var arg_info = scheme[arg_key];
        var normalized_key = normalize_cli_key(arg_key);
        if (arg_info['boolean']) {
            result[normalized_key] = true;
            continue;
        }
        if (i >= cmd_args.length) {
            die(`no CLI value for key: ${arg_key}`);
        }
        var arg_value = cmd_args[i];
        i += 1;
        result[normalized_key] = arg_value;
    }
    return result;
}



module.exports.parse_cmd_args = parse_cmd_args;

},
"rbql_core/rbql-js/cli_rbql.js": function (module, exports, require, __filename, __dirname) {

const fs = require('fs');
const readline = require('readline');

const rbql = require('./rbql.js');
const rbql_csv = require('./rbql_csv.js');
const csv_utils = require('./csv_utils.js');
const cli_parser = require('./cli_parser.js');

let out_format_names = ['csv', 'tsv', 'monocolumn', 'input'];

var error_format = 'hr';
var interactive_mode = false;


// TODO implement colored output like in Python version
// TODO implement query history like in Python version. "readline" modules allows to do that, see "completer" parameter.
// TODO switch to built-in node util parseArgs module (added in 2022)

// FIXME test readline on Win: disable interactive mode?

// FIXME handle broken pipe error and add tests. See Python version.


class RbqlParsingError extends Error {}
class GenericError extends Error {}


function show_error_plain_text(error_type, error_msg) {
    if (interactive_mode) {
        console.log(`\x1b[31;1mError [${error_type}]:\x1b[0m ${error_msg}`);
    } else {
        console.error(`Error [${error_type}]: ${error_msg}`);
    }
}


function report_error_json(error_type, error_msg) {
    let report = new Object();
    report.error_type = error_type;
    report.error = error_msg;
    process.stderr.write(JSON.stringify(report));
}


function show_exception(e) {
    let [error_type, error_msg] = rbql.exception_to_error_info(e);
    if (error_format == 'hr') {
        show_error_plain_text(error_type, error_msg);
    } else {
        report_error_json(error_type, error_msg);
    }
}


function show_warning(msg) {
    if (interactive_mode) {
        console.log('\x1b[33;1mWarning:\x1b[0m ' + msg);
    } else {
        console.error('Warning: ' + msg);
    }
}


function normalize_delim(delim) {
    if (delim == 'TAB')
        return '\t';
    if (delim == '\\t')
        return '\t';
    return delim;
}


function get_default(src, key, default_val) {
    return src.hasOwnProperty(key) ? src[key] : default_val;
}


async function read_user_query(user_input_reader) {
    let finish_promise = new Promise(function(resolve, reject) {
        user_input_reader.question('Input SQL-like RBQL query and press Enter:\n> ', (query) => {
            resolve(query);
        });
    });
    let query = await finish_promise;
    return query;
}


function get_default_policy(delim) {
    if ([';', ','].indexOf(delim) != -1) {
        return 'quoted';
    } else if (delim == ' ') {
        return 'whitespace';
    } else {
        return 'simple';
    }
}


function is_delimited_table(sampled_lines, delim, policy) {
    if (sampled_lines.length < 10)
        return false;
    let num_fields = null;
    for (var i = 0; i < sampled_lines.length; i++) {
        let [fields, warning] = csv_utils.smart_split(sampled_lines[i], delim, policy, true);
        if (warning)
            return false;
        if (num_fields === null)
            num_fields = fields.length;
        if (num_fields < 2 || num_fields != fields.length)
            return false;
    }
    return true;
}


async function sample_lines(table_path) {
    let finish_promise = new Promise(function(resolve, reject) {
        let input_reader = readline.createInterface({ input: fs.createReadStream(table_path) });
        let sampled_lines = [];
        input_reader.on('line', line => {
            if (sampled_lines.length < 10) {
                sampled_lines.push(line);
            } else {
                input_reader.close();
            }
        });
        input_reader.on('close', () => { resolve(sampled_lines); });
    });
    let sampled_lines = await finish_promise;
    return sampled_lines;
}


async function sample_records(table_path, encoding, delim, policy, comment_prefix, trim_whitespaces, comment_regex) {
    let table_stream = fs.createReadStream(table_path);
    let sampling_iterator = new rbql_csv.CSVRecordIterator(table_stream, null, encoding, delim, policy, /*has_header=*/false, comment_prefix, 'input', 'a', trim_whitespaces, comment_regex);
    let sampled_records = await sampling_iterator.get_all_records(10);
    let warnings = sampling_iterator.get_warnings();
    return [sampled_records, warnings];
}


async function autodetect_delim_policy(table_path) {
    let sampled_lines = await sample_lines(table_path);
    let autodetection_dialects = [['\t', 'simple'], [',', 'quoted'], [';', 'quoted'], ['|', 'simple']];
    for (var i = 0; i < autodetection_dialects.length; i++) {
        let [delim, policy] = autodetection_dialects[i];
        if (is_delimited_table(sampled_lines, delim, policy))
            return [delim, policy];
    }
    if (table_path.endsWith('.csv'))
        return [',', 'quoted'];
    if (table_path.endsWith('.tsv'))
        return ['\t', 'simple'];
    return [null, null];
}


function print_colorized(records, delim, show_column_names, with_headers) {
    let reset_color_code = '\x1b[0m';
    let color_codes = ['\x1b[0m', '\x1b[31m', '\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m', '\x1b[36m', '\x1b[31;1m', '\x1b[32;1m', '\x1b[33;1m'];
    for (let r = 0; r < records.length; r++) {
        let out_fields = [];
        for (let c = 0; c < records[r].length; c++) {
            let color_code = color_codes[c % color_codes.length];
            let field = records[r][c];
            let colored_field = (!show_column_names || (with_headers && r == 0)) ? color_code + field : `${color_code}a${c + 1}:${field}`;
            out_fields.push(colored_field);
        }
        let out_line = out_fields.join(delim) + reset_color_code;
        console.log(out_line);
    }
}


async function handle_query_success(warnings, output_path, encoding, delim, policy) {
    if (error_format == 'hr') {
        if (warnings !== null) {
            for (let i = 0; i < warnings.length; i++) {
                show_warning(warnings[i]);
            }
        }
        if (interactive_mode) {
            let [records, _warnings] = await sample_records(output_path, encoding, delim, policy, /*comment_prefix=*/null, /*trim_whitespaces=*/false, /*comment_regex=*/null);
            console.log('\nOutput table preview:');
            console.log('====================================');
            print_colorized(records, delim, false, false);
            console.log('====================================');
            console.log('Success! Result table was saved to: ' + output_path);
        }
    } else {
        if (warnings !== null && warnings.length) {
            var warnings_report = JSON.stringify({'warnings': warnings});
            process.stderr.write(warnings_report);
        }
    }
}


async function run_with_js(args) {
    var delim = normalize_delim(args['delim']);
    var policy = args['policy'] ? args['policy'] : get_default_policy(delim);
    var query = args['query'];
    if (!query)
        throw new RbqlParsingError('RBQL query is empty');
    var input_path = get_default(args, 'input', null);
    var output_path = get_default(args, 'output', null);
    var csv_encoding = args['encoding'];
    var with_headers = args['with-headers'];
    var comment_prefix = args['comment-prefix'];
    var comment_regex = args['comment-regex'];
    var trim_whitespaces = args['trim-spaces'];
    var output_delim = get_default(args, 'out-delim', null);
    var output_policy = get_default(args, 'out-policy', null);
    let init_source_file = get_default(args, 'init-source-file', null);
    let output_format = args['out-format'];
    if (output_delim === null) {
        [output_delim, output_policy] = output_format == 'input' ? [delim, policy] : rbql_csv.interpret_named_csv_format(output_format);
    }

    let user_init_code = '';
    if (init_source_file !== null)
        user_init_code = rbql_csv.read_user_init_code(init_source_file);
    try {
        let warnings = [];
        // Do not use bulk_read mode here because:
        // * Bulk read can't handle large file since node unable to read the whole file into a string, see https://github.com/mechatroner/rainbow_csv/issues/19
        // * In case of stdin read we would have to use the util.TextDecoder anyway
        // * binary/latin-1 do not require the decoder anyway
        // * This is CLI so no way we are in the Electron environment which can't use the TextDecoder
        // * Streaming mode works a little faster (since we don't need to do the manual validation)
        // TODO check if the current node installation doesn't have ICU enabled (which is typicaly provided by Node.js by default, see https://nodejs.org/api/intl.html) and report a user-friendly error with an option to use latin-1 encoding or switch the interpreter
        await rbql_csv.query_csv(query, input_path, delim, policy, output_path, output_delim, output_policy, csv_encoding, warnings, with_headers, comment_prefix, user_init_code, {'trim_whitespaces': trim_whitespaces, 'comment_regex': comment_regex});
        await handle_query_success(warnings, output_path, csv_encoding, output_delim, output_policy);
        return true;
    } catch (e) {
        if (!interactive_mode)
            throw e;
        show_exception(e);
        return false;
    }
}


function get_default_output_path(input_path, delim) {
    let well_known_extensions = {',': '.csv', '\t': '.tsv'};
    if (well_known_extensions.hasOwnProperty(delim))
        return input_path + well_known_extensions[delim];
    return input_path + '.txt';
}


async function show_preview(input_path, encoding, delim, policy, with_headers, comment_prefix, trim_whitespaces, comment_regex) {
    let [records, warnings] = await sample_records(input_path, encoding, delim, policy, comment_prefix, trim_whitespaces, comment_regex);
    console.log('Input table preview:');
    console.log('====================================');
    print_colorized(records, delim, true, with_headers);
    console.log('====================================\n');
    for (let warning of warnings) {
        show_warning(warning);
    }
}


async function run_interactive_loop(args) {
    let input_path = get_default(args, 'input', null);
    if (!input_path)
        throw new GenericError('Input file must be provided in interactive mode. You can use stdin input only in non-interactive mode');
    if (error_format != 'hr')
        throw new GenericError('Only default "hr" error format is supported in interactive mode');


    let delim = get_default(args, 'delim', null);
    let policy = null;
    if (delim !== null) {
        delim = normalize_delim(delim);
        policy = args['policy'] ? args['policy'] : get_default_policy(delim);
    } else {
        [delim, policy] = await autodetect_delim_policy(input_path);
        if (!delim)
            throw new GenericError('Unable to autodetect table delimiter. Provide column separator explicitly with "--delim" option');
    }
    await show_preview(input_path, args['encoding'], delim, policy, args['with-headers'], args['comment-prefix'], args['trim-spaces'], args['comment-regex']);
    args.delim = delim;
    args.policy = policy;
    if (!args.output) {
        args.output = get_default_output_path(input_path, delim);
        show_warning('Output path was not provided. Result set will be saved as: ' + args.output);
    }

    let user_input_reader = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        while (true) {
            let query = await read_user_query(user_input_reader);
            args.query = query;
            let success = await run_with_js(args);
            if (success)
                break;
        }
    } finally {
        user_input_reader.close();
    }
}


let tool_description = `rbql-js

Run RBQL queries against CSV files and data streams

rbql-js supports two modes: non-interactive (with "--query" option) and interactive (without "--query" option)
Interactive mode shows source table preview which makes query editing much easier. Usage example:
  $ rbql-js --input input.csv
Non-interactive mode supports source tables in stdin. Usage example:
  $ rbql-js --query "select a1, a2 order by a1" --delim , < input.csv
`;

let epilog = `
Description of the available CSV split policies:
  * "simple" - RBQL uses simple split() function and doesn't perform special handling of double quote characters
  * "quoted" - Separator can be escaped inside double-quoted fields. Double quotes inside double-quoted fields must be doubled
  * "quoted_rfc" - Same as "quoted", but also allows newlines inside double-quoted fields, see RFC-4180: https://tools.ietf.org/html/rfc4180
  * "whitespace" - Works only with whitespace separator, multiple consecutive whitespaces are treated as a single whitespace
  * "monocolumn" - RBQL doesn't perform any split at all, each line is a single-element record, i.e. only "a1" and "NR" are available
`;


async function do_main(args) {

    if (args['version']) {
        console.log(rbql.version);
        process.exit(0);
    }

    if (args.hasOwnProperty('policy') && args['policy'] === 'monocolumn')
        args['delim'] = '';

    if (args.hasOwnProperty('policy') && !args.hasOwnProperty('delim'))
        throw new GenericError('Using "--policy" without "--delim" is not allowed');

    if (args.encoding == 'latin-1')
        args.encoding = 'binary';

    error_format = args['error-format'];

    if (args.hasOwnProperty('query')) {
        interactive_mode = false;
        if (!args.hasOwnProperty('delim')) {
            throw new GenericError('Separator must be provided with "--delim" option in non-interactive mode');
        }
        await run_with_js(args);
    } else {
        interactive_mode = true;
        if (error_format == 'json') {
            throw new GenericError('json error format is not compatible with interactive mode');
        }
        await run_interactive_loop(args);
    }
}


function main() {
    var scheme = {
        '--input': {'help': 'Read csv table from FILE instead of stdin. Required in interactive mode', 'metavar': 'FILE'},
        '--query': {'help': 'Query string in rbql. Run in interactive mode if empty', 'metavar': 'QUERY'},
        '--output': {'help': 'Write output table to FILE instead of stdout', 'metavar': 'FILE'},
        '--delim': {'help': 'Delimiter character or multicharacter string, e.g. "," or "###". Can be autodetected in interactive mode', 'metavar': 'DELIM'},
        '--policy': {'help': 'Split policy, see the explanation below. Supported values: "simple", "quoted", "quoted_rfc", "whitespace", "monocolumn". Can be autodetected in interactive mode', 'metavar': 'POLICY'},
        '--with-headers': {'boolean': true, 'help': 'Indicates that input (and join) table has header'},
        '--comment-prefix': {'help': 'Ignore lines in input and join tables that start with the comment PREFIX, e.g. "#"', 'metavar': 'PREFIX'},
        '--comment-regex': {'help': 'Ignore lines in input and join tables that contain the comment REGEX.', 'metavar': 'REGEX'},
        '--encoding': {'default': 'utf-8', 'help': 'Manually set csv encoding', 'metavar': 'ENCODING'},
        '--trim-spaces': {'boolean': true, 'help': 'Trim leading and trailing spaces from fields'},
        '--out-format': {'default': 'input', 'help': 'Output format. Supported values: ' + out_format_names.map(v => `"${v}"`).join(', '), 'metavar': 'FORMAT'},
        '--out-delim': {'help': 'Output delim. Use with "out-policy". Overrides out-format', 'metavar': 'DELIM'},
        '--out-policy': {'help': 'Output policy. Use with "out-delim". Overrides out-format', 'metavar': 'POLICY'},
        '--error-format': {'default': 'hr', 'help': 'Errors and warnings format. [hr|json]', 'hidden': true},
        '--version': {'boolean': true, 'help': 'Print RBQL version and exit'},
        '--init-source-file': {'help': 'Path to init source file to use instead of ~/.rbql_init_source.js', 'hidden': true}
    };
    let args = cli_parser.parse_cmd_args(process.argv, scheme, tool_description, epilog);
    do_main(args).then(() => {}).catch(error_info => { show_exception(error_info); process.exit(1); });
}


if (require.main === module) {
    main();
}



},
"rbql_core/rbql-js/csv_utils.js": function (module, exports, require, __filename, __dirname) {
let field_regular_expression = '"((?:[^"]*"")*[^"]*)"';
let field_rgx = new RegExp('^' + field_regular_expression);
let field_rgx_external_whitespaces = new RegExp('^ *' + field_regular_expression + ' *');


// TODO consider making this file (and rbql.js) both node and browser compatible: https://caolan.org/posts/writing_for_node_and_the_browser.html


function split_lines(text) {
    return text.split(/\r\n|\r|\n/);
}


function extract_next_field(src, dlm, preserve_quotes_and_whitespaces, allow_external_whitespaces, cidx, result) {
    var warning = false;
    let src_cur = src.substring(cidx);
    let rgx = allow_external_whitespaces ? field_rgx_external_whitespaces : field_rgx;
    let match_obj = rgx.exec(src_cur);
    if (match_obj !== null) {
        let match_end = match_obj[0].length;
        if (cidx + match_end == src.length || src[cidx + match_end] == dlm) {
            if (preserve_quotes_and_whitespaces) {
                result.push(match_obj[0]);
            } else {
                result.push(match_obj[1].replace(/""/g, '"'));
            }
            return [cidx + match_end + 1, false];
        }
        warning = true;
    }
    var uidx = src.indexOf(dlm, cidx);
    if (uidx == -1)
        uidx = src.length;
    var field = src.substring(cidx, uidx);
    warning = warning || field.indexOf('"') != -1;
    result.push(field);
    return [uidx + 1, warning];
}


function split_quoted_str(src, dlm, preserve_quotes_and_whitespaces=false) {
    // This function is newline-agnostic i.e. it can also split records with multiline fields.
    if (src.indexOf('"') == -1) // Optimization for most common case
        return [src.split(dlm), false];
    var result = [];
    var cidx = 0;
    var warning = false;
    let allow_external_whitespaces = dlm != ' ';
    while (cidx < src.length) {
        var extraction_report = extract_next_field(src, dlm, preserve_quotes_and_whitespaces, allow_external_whitespaces, cidx, result);
        cidx = extraction_report[0];
        warning = warning || extraction_report[1];
    }
    if (src.charAt(src.length - 1) == dlm)
        result.push('');
    return [result, warning];
}


function quote_field(src, delim) {
    if (src.indexOf(delim) != -1 || src.indexOf('"') != -1) {
        var escaped = src.replace(/"/g, '""');
        return `"${escaped}"`;
    }
    return src;
}


function rfc_quote_field(src, delim) {
    if (src.indexOf(delim) != -1 || src.indexOf('"') != -1 || src.indexOf('\n') != -1 || src.indexOf('\r') != -1) {
        var escaped = src.replace(/"/g, '""');
        return `"${escaped}"`;
    }
    return src;
}


function unquote_field(field) {
    let rgx = new RegExp('^' + ' *' + field_regular_expression + ' *$');
    let match_obj = rgx.exec(field);
    if (match_obj !== null) {
        return match_obj[1].replace(/""/g, '"');
    }
    return field;
}


function unquote_fields(fields) {
    return fields.map(unquote_field);
}


function split_whitespace_separated_str(src, preserve_whitespaces=false) {
    var rgxp = preserve_whitespaces ? new RegExp(' *[^ ]+ *', 'g') : new RegExp('[^ ]+', 'g');
    let result = [];
    let match_obj = null;
    while((match_obj = rgxp.exec(src)) !== null) {
        result.push(match_obj[0]);
    }
    if (preserve_whitespaces) {
        for (let i = 0; i < result.length - 1; i++) {
            result[i] = result[i].slice(0, -1);
        }
    }
    return result;
}


function smart_split(src, dlm, policy, preserve_quotes_and_whitespaces) {
    if (policy === 'simple')
        return [src.split(dlm), false];
    if (policy === 'whitespace')
        return [split_whitespace_separated_str(src, preserve_quotes_and_whitespaces), false];
    if (policy === 'monocolumn')
        return [[src], false];
    return split_quoted_str(src, dlm, preserve_quotes_and_whitespaces);
}


class MultilineRecordAggregator {
    constructor(comment_prefix, comment_regex) {
        this.comment_prefix = comment_prefix;
        this.comment_regex = comment_regex;
        this.reset();
    }
    add_line(line_text) {
        if (this.has_full_record || this.has_comment_line) {
            throw new Error('Invalid usage - record aggregator must be reset before adding new lines');
        }
        if (this.comment_prefix && this.rfc_line_buffer.length == 0 && line_text.startsWith(this.comment_prefix)) {
            this.has_comment_line = true;
            return false;
        }
        if (this.comment_regex && this.rfc_line_buffer.length == 0 && line_text.search(this.comment_regex) != -1) {
            this.has_comment_line = true;
            return false;
        }
        let match_list = line_text.match(/"/g);
        let has_unbalanced_double_quote = match_list && match_list.length % 2 == 1;
        this.rfc_line_buffer.push(line_text);
        this.has_full_record = (!has_unbalanced_double_quote && this.rfc_line_buffer.length == 1) || (has_unbalanced_double_quote && this.rfc_line_buffer.length > 1);
        return this.has_full_record;
    }
    is_inside_multiline_record() {
        return this.rfc_line_buffer.length && !this.has_full_record;
    }
    get_full_line(line_separator) {
        return this.rfc_line_buffer.join(line_separator);
    }
    get_num_lines_in_record() {
        return this.rfc_line_buffer.length;
    }
    reset() {
        this.rfc_line_buffer = [];
        this.has_full_record = false;
        this.has_comment_line = false;
    }
}


module.exports.split_quoted_str = split_quoted_str;
module.exports.split_whitespace_separated_str = split_whitespace_separated_str;
module.exports.smart_split = smart_split;
module.exports.quote_field = quote_field;
module.exports.rfc_quote_field = rfc_quote_field;
module.exports.unquote_field = unquote_field;
module.exports.unquote_fields = unquote_fields;
module.exports.split_lines = split_lines;
module.exports.MultilineRecordAggregator = MultilineRecordAggregator;

},
"rbql_core/rbql-js/rbql.js": function (module, exports, require, __filename, __dirname) {
(function(exports){
// The magic line above is to make the module both browser and Node compatible, see https://stackoverflow.com/questions/3225251/how-can-i-share-code-between-node-js-and-the-browser

// This module works with records only. It is CSV-agnostic.
// Do not add CSV-related logic or variables/functions/objects like "delim", "separator" etc


class RbqlParsingError extends Error {}
class RbqlRuntimeError extends Error {}
class AssertionError extends Error {}
class RbqlIOHandlingError extends Error {}


class InternalBadFieldError extends Error {
    constructor(bad_idx, ...params) {
        super(...params);
        this.bad_idx = bad_idx;
    }
}


function assert(condition, message=null) {
    if (!condition) {
        if (!message) {
            message = 'Assertion error';
        }
        throw new AssertionError(message);
    }
}


function replace_all(src, search, replacement) {
    return src.split(search).join(replacement);
}


class RBQLContext {
    constructor(query_text, input_iterator, output_writer, user_init_code) {
        this.query_text = query_text;
        this.input_iterator = input_iterator;
        this.writer = output_writer;
        this.user_init_code = user_init_code;

        this.unnest_list = null;
        this.top_count = null;

        this.like_regex_cache = new Map();

        this.sort_key_expression = null;

        this.aggregation_stage = 0;
        this.aggregation_key_expression = null;
        this.functional_aggregators = [];

        this.join_map_impl = null;
        this.join_map = null;
        this.lhs_join_var_expression = null;

        this.where_expression = null;

        this.select_expression = null;

        this.update_expressions = null;

        this.variables_init_code = null;
    }
}

var query_context = null; // Needs to be global for MIN(), MAX(), etc functions. TODO find a way to make it local.


const wrong_aggregation_usage_error = 'Usage of RBQL aggregation functions inside JavaScript expressions is not allowed, see the docs';
const RBQL_VERSION = '0.29.0';


function check_if_brackets_match(opening_bracket, closing_bracket) {
    return (opening_bracket == '[' && closing_bracket == ']') || (opening_bracket == '(' && closing_bracket == ')') || (opening_bracket == '{' && closing_bracket == '}');
}


function parse_root_bracket_level_text_spans(select_expression) {
    let text_spans = []; // parts of text separated by commas at the root parenthesis level
    let last_pos = 0;
    let bracket_stack = [];
    for (let i = 0; i < select_expression.length; i++) {
        let cur_char = select_expression[i];
        if (cur_char == ',' && bracket_stack.length == 0) {
            text_spans.push(select_expression.substring(last_pos, i));
            last_pos = i + 1;
        } else if (['[', '{', '('].indexOf(cur_char) != -1) {
            bracket_stack.push(cur_char);
        } else if ([']', '}', ')'].indexOf(cur_char) != -1) {
            if (bracket_stack.length && check_if_brackets_match(bracket_stack[bracket_stack.length - 1], cur_char)) {
                bracket_stack.pop();
            } else {
                throw new RbqlParsingError(`Unable to parse column headers in SELECT expression: No matching opening bracket for closing "${cur_char}"`);
            }
        }
    }
    if (bracket_stack.length) {
        throw new RbqlParsingError(`Unable to parse column headers in SELECT expression: No matching closing bracket for opening "${bracket_stack[0]}"`);
    }
    text_spans.push(select_expression.substring(last_pos, select_expression.length));
    text_spans = text_spans.map(span => span.trim());
    return text_spans;
}


function unquote_string(quoted_str) {
    // It's possible to use eval here to unqoute the quoted_column_name, but it would be a little barbaric, let's do it manually instead
    if (!quoted_str || quoted_str.length < 2)
        return null;
    if (quoted_str[0] == "'" && quoted_str[quoted_str.length - 1] == "'") {
        return quoted_str.substring(1, quoted_str.length - 1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } else if (quoted_str[0] == '"' && quoted_str[quoted_str.length - 1] == '"') {
        return quoted_str.substring(1, quoted_str.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
        return null;
    }
}


function column_info_from_text_span(text_span, string_literals) {
    // This function is a rough equivalent of "column_info_from_node()" function in python version of RBQL
    text_span = text_span.trim();
    let rbql_star_marker = '__RBQL_INTERNAL_STAR';
    let simple_var_match = /^[_a-zA-Z][_a-zA-Z0-9]*$/.exec(text_span);
    let attribute_match = /^([ab])\.([_a-zA-Z][_a-zA-Z0-9]*)$/.exec(text_span);
    let subscript_int_match = /^([ab])\[([0-9]+)\]$/.exec(text_span);
    let subscript_str_match = /^([ab])\[___RBQL_STRING_LITERAL([0-9]+)___\]$/.exec(text_span);
    let as_alias_match = /^(.*) (as|AS) +([a-zA-Z][a-zA-Z0-9_]*) *$/.exec(text_span);
    if (as_alias_match !== null) {
        return {table_name: null, column_index: null, column_name: null, is_star: false, alias_name: as_alias_match[3]};
    }
    if (simple_var_match !== null) {
        if (text_span == rbql_star_marker)
            return {table_name: null, column_index: null, column_name: null, is_star: true, alias_name: null};
        if (text_span.startsWith('___RBQL_STRING_LITERAL'))
            return null;
        let match = /^([ab])([0-9]+)$/.exec(text_span);
        if (match !== null) {
            return {table_name: match[1], column_index: parseInt(match[2]) - 1, column_name: null, is_star: false, alias_name: null};
        }
        // Some examples for this branch: NR, NF
        return {table_name: null, column_index: null, column_name: text_span, is_star: false, alias_name: null};
    } else if (attribute_match !== null) {
        let table_name = attribute_match[1];
        let column_name = attribute_match[2];
        if (column_name == rbql_star_marker) {
            return {table_name: table_name, column_index: null, column_name: null, is_star: true, alias_name: null};
        }
        return {table_name: null, column_index: null, column_name: column_name, is_star: false, alias_name: null};
    } else if (subscript_int_match != null) {
        let table_name = subscript_int_match[1];
        let column_index = parseInt(subscript_int_match[2]) - 1;
        return {table_name: table_name, column_index: column_index, column_name: null, is_star: false, alias_name: null};
    } else if (subscript_str_match != null) {
        let table_name = subscript_str_match[1];
        let replaced_string_literal_id = subscript_str_match[2];
        if (replaced_string_literal_id < string_literals.length) {
            let quoted_column_name = string_literals[replaced_string_literal_id];
            let unquoted_column_name = unquote_string(quoted_column_name);
            if (unquoted_column_name !== null && unquoted_column_name !== undefined) {
                return {table_name: null, column_index: null, column_name: unquoted_column_name, is_star: false, alias_name: null};
            }
        }
    }
    return null;
}


function adhoc_parse_select_expression_to_column_infos(select_expression, string_literals) {
    // It is acceptable for the algorithm to provide null column name when it could be theorethically possible to deduce the name.
    // I.e. this algorithm guarantees precision but doesn't guarantee completeness in all theorethically possible queries.
    // Although the algorithm should be complete in all practical scenarios, i.e. it should be hard to come up with the query that doesn't produce complete set of column names.
    // The null column name just means that the output column will be named as col{i}, so the failure to detect the proper column name can be tolerated.
    // Specifically this function guarantees the following:
    // 1. The number of column_infos is correct and will match the number of fields in each record in the output - otherwise the exception should be thrown
    // 2. If column_info at pos j is not null, it is guaranteed to correctly represent that column name in the output
    let text_spans = parse_root_bracket_level_text_spans(select_expression);
    let column_infos = text_spans.map(ts => column_info_from_text_span(ts, string_literals));
    return column_infos;
}


function stable_compare(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return a[i] < b[i] ? -1 : 1;
    }
}


function safe_get(record, idx) {
    return idx < record.length ? record[idx] : null;
}


function safe_join_get(record, idx) {
    if (idx < record.length) {
        return record[idx];
    }
    throw new InternalBadFieldError(idx);
}


function safe_set(record, idx, value) {
    if (idx < record.length) {
        record[idx] = value;
    } else {
        throw new InternalBadFieldError(idx);
    }
}


function regexp_escape(text) {
    // From here: https://stackoverflow.com/a/6969486/2898283
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');  // $& means the whole matched text
}


function like_to_regex(pattern) {
    let p = 0;
    let i = 0;
    let converted = '';
    while (i < pattern.length) {
        if (pattern.charAt(i) == '_' || pattern.charAt(i) == '%') {
            converted += regexp_escape(pattern.substring(p, i));
            p = i + 1;
            if (pattern.charAt(i) == '_') {
                converted += '.';
            } else {
                converted += '.*';
            }
        }
        i += 1;
    }
    converted += regexp_escape(pattern.substring(p, i));
    return '^' + converted + '$';
}


function like(text, pattern) {
    let matcher = query_context.like_regex_cache.get(pattern);
    if (matcher === undefined) {
        matcher = new RegExp(like_to_regex(pattern));
        query_context.like_regex_cache.set(pattern, matcher);
    }
    return matcher.test(text);
}
const LIKE = like;


class RBQLAggregationToken {
    constructor(marker_id, value) {
        this.marker_id = marker_id;
        this.value = value;
    }

    toString() {
        throw new RbqlParsingError(wrong_aggregation_usage_error);
    }
}


class UnnestMarker {}


function UNNEST(vals) {
    if (query_context.unnest_list !== null) {
        // Technically we can support multiple UNNEST's but the implementation/algorithm is more complex and just doesn't worth it
        throw new RbqlParsingError('Only one UNNEST is allowed per query');
    }
    query_context.unnest_list = vals;
    return new UnnestMarker();
}
const unnest = UNNEST;
const Unnest = UNNEST;
const UNFOLD = UNNEST; // "UNFOLD" is deprecated, just for backward compatibility


function parse_number(val) {
    // We can do a more pedantic number test like `/^ *-{0,1}[0-9]+\.{0,1}[0-9]* *$/.test(val)`, but  user will probably use just Number(val) or parseInt/parseFloat
    let result = Number(val);
    if (isNaN(result)) {
        throw new RbqlRuntimeError(`Unable to convert value "${val}" to a number. MIN, MAX, SUM, AVG, MEDIAN and VARIANCE aggregate functions convert their string arguments to numeric values`);
    }
    return result;
}


class AnyValueAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, val);
        }
    }

    get_final(key) {
        return this.stats.get(key);
    }
}


class MinAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, val);
        } else {
            this.stats.set(key, Math.min(cur_aggr, val));
        }
    }

    get_final(key) {
        return this.stats.get(key);
    }
}


class MaxAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, val);
        } else {
            this.stats.set(key, Math.max(cur_aggr, val));
        }
    }

    get_final(key) {
        return this.stats.get(key);
    }
}


class SumAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, val);
        } else {
            this.stats.set(key, cur_aggr + val);
        }
    }

    get_final(key) {
        return this.stats.get(key);
    }
}


class AvgAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, [val, 1]);
        } else {
            var cur_sum = cur_aggr[0];
            var cur_cnt = cur_aggr[1];
            this.stats.set(key, [cur_sum + val, cur_cnt + 1]);
        }
    }

    get_final(key) {
        var cur_aggr = this.stats.get(key);
        var cur_sum = cur_aggr[0];
        var cur_cnt = cur_aggr[1];
        var avg = cur_sum / cur_cnt;
        return avg;
    }
}


class VarianceAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, [val, val * val, 1]);
        } else {
            var cur_sum = cur_aggr[0];
            var cur_sum_sq = cur_aggr[1];
            var cur_cnt = cur_aggr[2];
            this.stats.set(key, [cur_sum + val, cur_sum_sq + val * val, cur_cnt + 1]);
        }
    }

    get_final(key) {
        var cur_aggr = this.stats.get(key);
        var cur_sum = cur_aggr[0];
        var cur_sum_sq = cur_aggr[1];
        var cur_cnt = cur_aggr[2];
        var avg_val = cur_sum / cur_cnt;
        var variance = cur_sum_sq / cur_cnt - avg_val * avg_val;
        return variance;
    }
}


class MedianAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        val = parse_number(val);
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, [val]);
        } else {
            cur_aggr.push(val);
        }
    }

    get_final(key) {
        var cur_aggr = this.stats.get(key);
        cur_aggr.sort(function(a, b) { return a - b; });
        var m = Math.floor(cur_aggr.length / 2);
        if (cur_aggr.length % 2) {
            return cur_aggr[m];
        } else {
            return (cur_aggr[m - 1] + cur_aggr[m]) / 2.0;
        }
    }
}


class CountAggregator {
    constructor() {
        this.stats = new Map();
    }

    increment(key, val) {
        var cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, 1);
        } else {
            this.stats.set(key, cur_aggr + 1);
        }
    }

    get_final(key) {
        return this.stats.get(key);
    }
}


class ArrayAggAggregator {
    constructor(post_proc=null) {
        this.post_proc = post_proc;
        this.stats = new Map();
    }

    increment(key, val) {
        let cur_aggr = this.stats.get(key);
        if (cur_aggr === undefined) {
            this.stats.set(key, [val]);
        } else {
            cur_aggr.push(val);
        }
    }

    get_final(key) {
        let cur_aggr = this.stats.get(key);
        if (this.post_proc === null)
            return cur_aggr;
        return this.post_proc(cur_aggr);
    }
}


class ConstGroupVerifier {
    constructor(output_index) {
        this.output_index = output_index;
        this.const_values = new Map();
    }

    increment(key, value) {
        var old_value = this.const_values.get(key);
        if (old_value === undefined) {
            this.const_values.set(key, value);
        } else if (old_value != value) {
            throw new RbqlRuntimeError(`Invalid aggregate expression: non-constant values in output column ${this.output_index + 1}. E.g. "${old_value}" and "${value}"`);
        }
    }

    get_final(key) {
        return this.const_values.get(key);
    }
}


function init_aggregator(generator_name, val, post_proc=null) {
    query_context.aggregation_stage = 1;
    var res = new RBQLAggregationToken(query_context.functional_aggregators.length, val);
    if (post_proc === null) {
        query_context.functional_aggregators.push(new generator_name());
    } else {
        query_context.functional_aggregators.push(new generator_name(post_proc));
    }
    return res;
}

function ANY_VALUE(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(AnyValueAggregator, val) : val;
}
const any_value = ANY_VALUE;
const Any_value = ANY_VALUE;

function MIN(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(MinAggregator, val) : val;
}
const min = MIN;
const Min = MIN;

function MAX(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(MaxAggregator, val) : val;
}
const max = MAX;
const Max = MAX;

function COUNT(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(CountAggregator, 1) : 1;
}
const count = COUNT;
const Count = COUNT;

function SUM(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(SumAggregator, val) : val;
}
const sum = SUM;
const Sum = SUM;

function AVG(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(AvgAggregator, val) : val;
}
const avg = AVG;
const Avg = AVG;

function VARIANCE(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(VarianceAggregator, val) : val;
}
const variance = VARIANCE;
const Variance = VARIANCE;

function MEDIAN(val) {
    return query_context.aggregation_stage < 2 ? init_aggregator(MedianAggregator, val) : val;
}
const median = MEDIAN;
const Median = MEDIAN;

function ARRAY_AGG(val, post_proc=null) {
    return query_context.aggregation_stage < 2 ? init_aggregator(ArrayAggAggregator, val, post_proc) : val;
}
const array_agg = ARRAY_AGG;
const FOLD = ARRAY_AGG; // "FOLD" is deprecated, just for backward compatibility


function add_to_set(dst_set, value) {
    var len_before = dst_set.size;
    dst_set.add(value);
    return len_before != dst_set.size;
}


class TopWriter {
    constructor(subwriter, top_count) {
        this.subwriter = subwriter;
        this.NW = 0;
        this.top_count = top_count;
    }

    async write(record) {
        if (this.top_count !== null && this.NW >= this.top_count)
            return false;
        await this.subwriter.write(record);
        this.NW += 1;
        return true;
    }

    async finish() {
        await this.subwriter.finish();
    }
}


class UniqWriter {
    constructor(subwriter) {
        this.subwriter = subwriter;
        this.seen = new Set();
    }

    async write(record) {
        if (!add_to_set(this.seen, JSON.stringify(record)))
            return true;
        if (!await this.subwriter.write(record))
            return false;
        return true;
    }

    async finish() {
        await this.subwriter.finish();
    }
}


class UniqCountWriter {
    constructor(subwriter) {
        this.subwriter = subwriter;
        this.records = new Map();
    }

    async write(record) {
        var key = JSON.stringify(record);
        var old_val = this.records.get(key);
        if (old_val) {
            old_val[0] += 1;
        } else {
            this.records.set(key, [1, record]);
        }
        return true;
    }

    async finish() {
        for (var [key, value] of this.records) {
            let [count, record] = value;
            record.unshift(count);
            if (!await this.subwriter.write(record))
                break;
        }
        await this.subwriter.finish();
    }
}


class SortedWriter {
    constructor(subwriter, reverse_sort) {
        this.subwriter = subwriter;
        this.reverse_sort = reverse_sort;
        this.unsorted_entries = [];
    }

    async write(stable_entry) {
        this.unsorted_entries.push(stable_entry);
        return true;
    }

    async finish() {
        var unsorted_entries = this.unsorted_entries;
        unsorted_entries.sort(stable_compare);
        if (this.reverse_sort)
            unsorted_entries.reverse();
        for (var i = 0; i < unsorted_entries.length; i++) {
            var entry = unsorted_entries[i];
            if (!await this.subwriter.write(entry[entry.length - 1]))
                break;
        }
        await this.subwriter.finish();
    }
}


class AggregateWriter {
    constructor(subwriter) {
        this.subwriter = subwriter;
        this.aggregators = [];
        this.aggregation_keys = new Set();
    }

    async finish() {
        var all_keys = Array.from(this.aggregation_keys);
        all_keys.sort();
        for (var i = 0; i < all_keys.length; i++) {
            var key = all_keys[i];
            var out_fields = [];
            for (var ag of this.aggregators) {
                out_fields.push(ag.get_final(key));
            }
            if (!await this.subwriter.write(out_fields))
                break;
        }
        await this.subwriter.finish();
    }
}


class InnerJoiner {
    constructor(join_map) {
        this.join_map = join_map;
    }

    get_rhs(lhs_key) {
        return this.join_map.get_join_records(lhs_key);
    }
}


class LeftJoiner {
    constructor(join_map) {
        this.join_map = join_map;
        this.null_record = [[null, join_map.max_record_len, Array(join_map.max_record_len).fill(null)]];
    }

    get_rhs(lhs_key) {
        let result = this.join_map.get_join_records(lhs_key);
        if (result.length == 0) {
            return this.null_record;
        }
        return result;
    }
}


class StrictLeftJoiner {
    constructor(join_map) {
        this.join_map = join_map;
    }

    get_rhs(lhs_key) {
        let result = this.join_map.get_join_records(lhs_key);
        if (result.length != 1) {
            throw new RbqlRuntimeError('In "STRICT LEFT JOIN" each key in A must have exactly one match in B. Bad A key: "' + lhs_key + '"');
        }
        return result;
    }
}


function select_except(src, except_fields) {
    let result = [];
    for (let i = 0; i < src.length; i++) {
        if (except_fields.indexOf(i) == -1)
            result.push(src[i]);
    }
    return result;
}


async function select_simple(sort_key, NR, out_fields) {
    if (query_context.sort_key_expression !== null) {
        var sort_entry = sort_key.concat([NR, out_fields]);
        if (!await query_context.writer.write(sort_entry))
            return false;
    } else {
        if (!await query_context.writer.write(out_fields))
            return false;
    }
    return true;
}


function select_aggregated(key, transparent_values) {
    if (key !== null) {
        key = JSON.stringify(key);
    }
    if (query_context.aggregation_stage === 1) {
        if (!(query_context.writer instanceof TopWriter)) {
            throw new RbqlParsingError('"ORDER BY", "UPDATE" and "DISTINCT" keywords are not allowed in aggregate queries');
        }
        query_context.writer = new AggregateWriter(query_context.writer);
        let num_aggregators_found = 0;
        for (var i = 0; i < transparent_values.length; i++) {
            var trans_value = transparent_values[i];
            if (trans_value instanceof RBQLAggregationToken) {
                query_context.writer.aggregators.push(query_context.functional_aggregators[trans_value.marker_id]);
                query_context.writer.aggregators[query_context.writer.aggregators.length - 1].increment(key, trans_value.value);
                num_aggregators_found += 1;
            } else {
                query_context.writer.aggregators.push(new ConstGroupVerifier(query_context.writer.aggregators.length));
                query_context.writer.aggregators[query_context.writer.aggregators.length - 1].increment(key, trans_value);
            }
        }
        if (num_aggregators_found != query_context.functional_aggregators.length) {
            throw new RbqlParsingError(wrong_aggregation_usage_error);
        }
        query_context.aggregation_stage = 2;
    } else {
        for (var i = 0; i < transparent_values.length; i++) {
            var trans_value = transparent_values[i];
            query_context.writer.aggregators[i].increment(key, trans_value);
        }
    }
    query_context.writer.aggregation_keys.add(key);
}


async function select_unnested(sort_key, NR, folded_fields) {
    let out_fields = folded_fields.slice();
    let unnest_pos = folded_fields.findIndex(val => val instanceof UnnestMarker);
    for (var i = 0; i < query_context.unnest_list.length; i++) {
        out_fields[unnest_pos] = query_context.unnest_list[i];
        if (!await select_simple(sort_key, NR, out_fields.slice()))
            return false;
    }
    return true;
}


const PROCESS_SELECT_COMMON = `
__RBQLMP__variables_init_code
if (__RBQLMP__where_expression) {
    let out_fields = __RBQLMP__select_expression;
    if (query_context.aggregation_stage > 0) {
        let key = __RBQLMP__aggregation_key_expression;
        select_aggregated(key, out_fields);
    } else {
        let sort_key = [__RBQLMP__sort_key_expression];
        if (query_context.unnest_list !== null) {
            if (!await select_unnested(sort_key, NR, out_fields))
                stop_flag = true;
        } else {
            if (!await select_simple(sort_key, NR, out_fields))
                stop_flag = true;
        }
    }
}
`;


const PROCESS_SELECT_SIMPLE = `
let star_fields = record_a;
__CODE__
`;


const PROCESS_SELECT_JOIN = `
let join_matches = query_context.join_map.get_rhs(__RBQLMP__lhs_join_var_expression);
for (let join_match of join_matches) {
    let [bNR, bNF, record_b] = join_match;
    let star_fields = record_a.concat(record_b);
    __CODE__
    if (stop_flag)
        break;
}
`;


const PROCESS_UPDATE_JOIN = `
let join_matches = query_context.join_map.get_rhs(__RBQLMP__lhs_join_var_expression);
if (join_matches.length > 1)
    throw new RbqlRuntimeError('More than one record in UPDATE query matched a key from the input table in the join table');
let record_b = null;
let bNR = null;
let bNF = null;
if (join_matches.length == 1)
    [bNR, bNF, record_b] = join_matches[0];
let up_fields = record_a;
__RBQLMP__variables_init_code
if (join_matches.length == 1 && (__RBQLMP__where_expression)) {
    NU += 1;
    __RBQLMP__update_expressions
}
if (!await query_context.writer.write(up_fields))
    stop_flag = true;
`;


const PROCESS_UPDATE_SIMPLE = `
let up_fields = record_a;
__RBQLMP__variables_init_code
if (__RBQLMP__where_expression) {
    NU += 1;
    __RBQLMP__update_expressions
}
if (!await query_context.writer.write(up_fields))
    stop_flag = true;
`;


const MAIN_LOOP_BODY = `
__USER_INIT_CODE__

let NU = 0;
let NR = 0;

let stop_flag = false;
while (!stop_flag) {
    let record_a = await query_context.input_iterator.get_record();
    if (record_a === null)
        break;
    NR += 1;
    let NF = record_a.length;
    query_context.unnest_list = null; // TODO optimize, don't need to set this every iteration
    try {
        __CODE__
    } catch (e) {
        if (e.constructor.name === 'InternalBadFieldError') {
            throw new RbqlRuntimeError(\`No "a\${e.bad_idx + 1}" field at record \${NR}\`);
        } else if (e.constructor.name === 'RbqlParsingError') {
            throw(e);
        } else {
            throw new RbqlRuntimeError(\`At record \${NR}, Details: \${e.message}\`);
        }
    }
}
`;


function embed_expression(parent_code, child_placeholder, child_expression) {
    return replace_all(parent_code, child_placeholder, child_expression);
}


function embed_code(parent_code, child_placeholder, child_code) {
    let parent_lines = parent_code.split('\n');
    let child_lines = child_code.split('\n');
    for (let i = 0; i < parent_lines.length; i++) {
        let pos = parent_lines[i].indexOf(child_placeholder);
        if (pos == -1)
            continue;
        assert(pos % 4 == 0);
        let placeholder_indentation = parent_lines[i].substring(0, pos);
        child_lines = child_lines.map(l => placeholder_indentation + l);
        let result_lines = parent_lines.slice(0, i).concat(child_lines).concat(parent_lines.slice(i + 1));
        return result_lines.join('\n') + '\n';
    }
    assert(false);
}


function generate_main_loop_code(query_context) {
    let is_select_query = query_context.select_expression !== null;
    let is_join_query = query_context.join_map !== null;
    let where_expression = query_context.where_expression === null ? 'true' : query_context.where_expression;
    let aggregation_key_expression = query_context.aggregation_key_expression === null ? 'null' : query_context.aggregation_key_expression;
    let sort_key_expression = query_context.sort_key_expression === null ? 'null' : query_context.sort_key_expression;
    let js_code = embed_code(MAIN_LOOP_BODY, '__USER_INIT_CODE__', query_context.user_init_code);
    if (is_select_query) {
        if (is_join_query) {
            js_code = embed_code(embed_code(js_code, '__CODE__', PROCESS_SELECT_JOIN), '__CODE__', PROCESS_SELECT_COMMON);
            js_code = embed_expression(js_code, '__RBQLMP__lhs_join_var_expression', query_context.lhs_join_var_expression);
        } else {
            js_code = embed_code(embed_code(js_code, '__CODE__', PROCESS_SELECT_SIMPLE), '__CODE__', PROCESS_SELECT_COMMON);
        }
        js_code = embed_code(js_code, '__RBQLMP__variables_init_code', query_context.variables_init_code);
        js_code = embed_expression(js_code, '__RBQLMP__select_expression', query_context.select_expression);
        js_code = embed_expression(js_code, '__RBQLMP__where_expression', where_expression);
        js_code = embed_expression(js_code, '__RBQLMP__aggregation_key_expression', aggregation_key_expression);
        js_code = embed_expression(js_code, '__RBQLMP__sort_key_expression', sort_key_expression);
    } else {
        if (is_join_query) {
            js_code = embed_code(js_code, '__CODE__', PROCESS_UPDATE_JOIN);
            js_code = embed_expression(js_code, '__RBQLMP__lhs_join_var_expression', query_context.lhs_join_var_expression);
        } else {
            js_code = embed_code(js_code, '__CODE__', PROCESS_UPDATE_SIMPLE);
        }
        js_code = embed_code(js_code, '__RBQLMP__variables_init_code', query_context.variables_init_code);
        js_code = embed_code(js_code, '__RBQLMP__update_expressions', query_context.update_expressions);
        js_code = embed_expression(js_code, '__RBQLMP__where_expression', where_expression);
    }
    return "(async () => {" + js_code + "})()";
}


async function compile_and_run(query_context) {
    let main_loop_body = generate_main_loop_code(query_context);
    try {
        let main_loop_promise = eval(main_loop_body);
        await main_loop_promise;
    } catch (e) {
        if (e instanceof SyntaxError) {
            // SyntaxError's from eval() function do not contain detailed explanation of what has caused the syntax error, so to guess what was wrong we can only use the original query
            // v8 issue to fix eval: https://bugs.chromium.org/p/v8/issues/detail?id=2589
            let lower_case_query = query_context.query_text.toLowerCase();
            if (lower_case_query.indexOf(' having ') != -1)
                throw new SyntaxError(e.message + "\nRBQL doesn't support \"HAVING\" keyword");
            if (lower_case_query.indexOf(' like ') != -1)
                throw new SyntaxError(e.message + "\nRBQL doesn't support \"LIKE\" operator, use like() function instead e.g. ... WHERE like(a1, 'foo%bar') ... "); // UT JSON
            if (lower_case_query.indexOf(' from ') != -1)
                throw new SyntaxError(e.message + "\nTip: If input table is defined by the environment, RBQL query should not have \"FROM\" keyword"); // UT JSON
            if (e && e.message && String(e.message).toLowerCase().indexOf('unexpected identifier') != -1) {
                if (lower_case_query.indexOf(' and ') != -1)
                    throw new SyntaxError(e.message + "\nDid you use 'and' keyword in your query?\nJavaScript backend doesn't support 'and' keyword, use '&&' operator instead!");
                if (lower_case_query.indexOf(' or ') != -1)
                    throw new SyntaxError(e.message + "\nDid you use 'or' keyword in your query?\nJavaScript backend doesn't support 'or' keyword, use '||' operator instead!");
            }
        }
        if (e && e.message && e.message.indexOf('Received an instance of RBQLAggregationToken') != -1)
            throw new RbqlParsingError(wrong_aggregation_usage_error);
        throw e;
    }
}


const GROUP_BY = 'GROUP BY';
const UPDATE = 'UPDATE';
const SELECT = 'SELECT';
const JOIN = 'JOIN';
const INNER_JOIN = 'INNER JOIN';
const LEFT_JOIN = 'LEFT JOIN';
const LEFT_OUTER_JOIN = 'LEFT OUTER JOIN';
const STRICT_LEFT_JOIN = 'STRICT LEFT JOIN';
const ORDER_BY = 'ORDER BY';
const WHERE = 'WHERE';
const LIMIT = 'LIMIT';
const EXCEPT = 'EXCEPT';
const WITH = 'WITH';


function get_ambiguous_error_msg(variable_name) {
    return `Ambiguous variable name: "${variable_name}" is present both in input and in join tables`;
}


function get_all_matches(regexp, text) {
    var result = [];
    let match_obj = null;
    while((match_obj = regexp.exec(text)) !== null) {
        result.push(match_obj);
    }
    return result;
}


function str_strip(src) {
    return src.replace(/^ +| +$/g, '');
}


function strip_comments(cline) {
    cline = cline.trim();
    if (cline.startsWith('//'))
        return '';
    return cline;
}


function combine_string_literals(backend_expression, string_literals) {
    for (var i = 0; i < string_literals.length; i++) {
        backend_expression = replace_all(backend_expression, `___RBQL_STRING_LITERAL${i}___`, string_literals[i]);
    }
    return backend_expression;
}


function parse_basic_variables(query_text, prefix, dst_variables_map) {
    assert(prefix == 'a' || prefix == 'b');
    let rgx = new RegExp(`(?:^|[^_a-zA-Z0-9])${prefix}([1-9][0-9]*)(?:$|(?=[^_a-zA-Z0-9]))`, 'g');
    let matches = get_all_matches(rgx, query_text);
    for (let i = 0; i < matches.length; i++) {
        let field_num = parseInt(matches[i][1]);
        dst_variables_map[prefix + String(field_num)] = {initialize: true, index: field_num - 1};
    }
}


function parse_array_variables(query_text, prefix, dst_variables_map) {
    assert(prefix == 'a' || prefix == 'b');
    let rgx = new RegExp(`(?:^|[^_a-zA-Z0-9])${prefix}\\[([1-9][0-9]*)\\]`, 'g');
    let matches = get_all_matches(rgx, query_text);
    for (let i = 0; i < matches.length; i++) {
        let field_num = parseInt(matches[i][1]);
        dst_variables_map[`${prefix}[${field_num}]`] = {initialize: true, index: field_num - 1};
    }
}


function js_string_escape_column_name(column_name, quote_char) {
    column_name = column_name.replace(/\\/g, '\\\\');
    column_name = column_name.replace(/\n/g, '\\n');
    column_name = column_name.replace(/\r/g, '\\r');
    column_name = column_name.replace(/\t/g, '\\t');
    if (quote_char === "'")
        return column_name.replace(/'/g, "\\'");
    if (quote_char === '"')
        return column_name.replace(/"/g, '\\"');
    assert(quote_char === "`");
    return column_name.replace(/`/g, "\\`");
}


function query_probably_has_dictionary_variable(query_text, column_name) {
    let rgx = new RegExp('[-a-zA-Z0-9_:;+=!.,()%^#@&* ]+', 'g');
    let continuous_name_segments = get_all_matches(rgx, column_name);
    for (let continuous_segment of continuous_name_segments) {
        if (query_text.indexOf(continuous_segment) == -1)
            return false;
    }
    return true;
}


function parse_dictionary_variables(query_text, prefix, column_names, dst_variables_map) {
    // The purpose of this algorithm is to minimize number of variables in varibale_map to improve performance, ideally it should be only variables from the query

    // FIXME to prevent typos in attribute names either use query-based variable parsing which can properly handle back-tick strings or wrap "a" and "b" variables with ES6 Proxies https://stackoverflow.com/a/25658975/2898283
    assert(prefix === 'a' || prefix === 'b');
    let dict_test_rgx = new RegExp(`(?:^|[^_a-zA-Z0-9])${prefix}\\[`);
    if (query_text.search(dict_test_rgx) == -1)
        return;
    for (let i = 0; i < column_names.length; i++) {
        let column_name = column_names[i];
        if (query_probably_has_dictionary_variable(query_text, column_name)) {
            let escaped_column_name = js_string_escape_column_name(column_name, '"');
            dst_variables_map[`${prefix}["${escaped_column_name}"]`] = {initialize: true, index: i};
            escaped_column_name = js_string_escape_column_name(column_name, "'");
            dst_variables_map[`${prefix}['${escaped_column_name}']`] = {initialize: false, index: i};
            escaped_column_name = js_string_escape_column_name(column_name, "`");
            dst_variables_map[`${prefix}[\`${escaped_column_name}\`]`] = {initialize: false, index: i};
        }
    }
}


function parse_attribute_variables(query_text, prefix, column_names, column_names_source, dst_variables_map) {
    // The purpose of this algorithm is to minimize number of variables in varibale_map to improve performance, ideally it should be only variables from the query

    assert(prefix === 'a' || prefix === 'b');
    let rgx = new RegExp(`(?:^|[^_a-zA-Z0-9])${prefix}\\.([_a-zA-Z][_a-zA-Z0-9]*)`, 'g');
    let matches = get_all_matches(rgx, query_text);
    let column_names_from_query = matches.map(v => v[1]);
    for (let column_name of column_names_from_query) {
        let zero_based_idx = column_names.indexOf(column_name);
        if (zero_based_idx != -1) {
            dst_variables_map[`${prefix}.${column_name}`] = {initialize: true, index: zero_based_idx};
        } else {
            throw new RbqlParsingError(`Unable to find column "${column_name}" in ${prefix == 'a' ? 'input' : 'join'} ${column_names_source}`);
        }
    }
}


function map_variables_directly(query_text, column_names, dst_variables_map) {
    for (let i = 0; i < column_names.length; i++) {
        let column_name = column_names[i];
        if ( /^[_a-zA-Z][_a-zA-Z0-9]*$/.exec(column_name) === null)
            throw new RbqlIOHandlingError(`Unable to use column name "${column_name}" as RBQL/JS variable`);
        if (query_text.indexOf(column_name) != -1)
            dst_variables_map[column_name] = {initialize: true, index: i};
    }
}


function ensure_no_ambiguous_variables(query_text, input_column_names, join_column_names) {
    let join_column_names_set = new Set(join_column_names);
    for (let column_name of input_column_names) {
        if (join_column_names_set.has(column_name) && query_text.indexOf(column_name) != -1) // False positive is tolerable here
            throw new RbqlParsingError(get_ambiguous_error_msg(column_name));
    }
}


function parse_join_expression(src) {
    src = str_strip(src);
    const invalid_join_syntax_error = 'Invalid join syntax. Valid syntax: <JOIN> /path/to/B/table on a... == b... [and a... == b... [and ... ]]';
    let rgx = /^ *([^ ]+) +on +/i;
    let match = rgx.exec(src);
    if (match === null)
        throw new RbqlParsingError(invalid_join_syntax_error);
    let table_id = match[1];
    src = src.substr(match[0].length);

    let variable_pairs = [];
    var pair_rgx = /^([^ =]+) *==? *([^ =]+)/;
    var and_rgx = /^ +(and|&&) +/i;
    while (true) {
        match = pair_rgx.exec(src);
        if (match === null)
            throw new RbqlParsingError(invalid_join_syntax_error);
        variable_pairs.push([match[1], match[2]]);
        src = src.substr(match[0].length);
        if (!src.length)
            break;
        match = and_rgx.exec(src);
        if (match === null)
            throw new RbqlParsingError(invalid_join_syntax_error);
        src = src.substr(match[0].length);
    }
    return [table_id, variable_pairs];
}


function resolve_join_variables(input_variables_map, join_variables_map, variable_pairs, string_literals) {
    let lhs_variables = [];
    let rhs_indices = [];
    const valid_join_syntax_msg = 'Valid JOIN syntax: <JOIN> /path/to/B/table on a... == b... [and a... == b... [and ... ]]';
    for (let variable_pair of variable_pairs) {
        let [join_var_1, join_var_2] = variable_pair;
        join_var_1 = combine_string_literals(join_var_1, string_literals);
        join_var_2 = combine_string_literals(join_var_2, string_literals);
        if (input_variables_map.hasOwnProperty(join_var_1) && join_variables_map.hasOwnProperty(join_var_1))
            throw new RbqlParsingError(get_ambiguous_error_msg(join_var_1));
        if (input_variables_map.hasOwnProperty(join_var_2) && join_variables_map.hasOwnProperty(join_var_2))
            throw new RbqlParsingError(get_ambiguous_error_msg(join_var_2));
        if (input_variables_map.hasOwnProperty(join_var_2))
            [join_var_1, join_var_2] = [join_var_2, join_var_1];

        let [lhs_key_index, rhs_key_index] = [null, null];
        if (['NR', 'a.NR', 'aNR'].indexOf(join_var_1) != -1) {
            lhs_key_index = -1;
        } else if (input_variables_map.hasOwnProperty(join_var_1)) {
            lhs_key_index = input_variables_map[join_var_1].index;
        } else {
            throw new RbqlParsingError(`Unable to parse JOIN expression: Input table does not have field "${join_var_1}"\n${valid_join_syntax_msg}`);
        }

        if (['b.NR', 'bNR'].indexOf(join_var_2) != -1) {
            rhs_key_index = -1;
        } else if (join_variables_map.hasOwnProperty(join_var_2)) {
            rhs_key_index = join_variables_map[join_var_2].index;
        } else {
            throw new RbqlParsingError(`Unable to parse JOIN expression: Join table does not have field "${join_var_2}"\n${valid_join_syntax_msg}`);
        }

        let lhs_join_var_expression = lhs_key_index == -1 ? 'NR' : `safe_join_get(record_a, ${lhs_key_index})`;
        rhs_indices.push(rhs_key_index);
        lhs_variables.push(lhs_join_var_expression);
    }
    return [lhs_variables, rhs_indices];
}


function generate_common_init_code(query_text, variable_prefix) {
    assert(variable_prefix == 'a' || variable_prefix == 'b');
    let result = [];
    result.push(`${variable_prefix} = new Object();`);
    let base_var = variable_prefix == 'a' ? 'NR' : 'bNR';
    let attr_var = `${variable_prefix}.NR`;
    if (query_text.indexOf(attr_var) != -1)
        result.push(`${attr_var} = ${base_var};`);
    if (variable_prefix == 'a' && query_text.indexOf('aNR') != -1)
        result.push('aNR = NR;');
    return result;
}


function generate_init_statements(query_text, variables_map, join_variables_map, indent) {
    let code_lines = generate_common_init_code(query_text, 'a');
    let simple_var_name_rgx = /^[_0-9a-zA-Z]+$/;
    for (const [variable_name, var_info] of Object.entries(variables_map)) {
        if (var_info.initialize) {
            let variable_declaration_keyword = simple_var_name_rgx.exec(variable_name) ? 'var ' : '';
            code_lines.push(`${variable_declaration_keyword}${variable_name} = safe_get(record_a, ${var_info.index});`);
        }
    }
    if (join_variables_map) {
        code_lines = code_lines.concat(generate_common_init_code(query_text, 'b'));
        for (const [variable_name, var_info] of Object.entries(join_variables_map)) {
            if (var_info.initialize) {
                let variable_declaration_keyword = simple_var_name_rgx.exec(variable_name) ? 'var ' : '';
                code_lines.push(`${variable_declaration_keyword}${variable_name} = record_b === null ? null : safe_get(record_b, ${var_info.index});`);
            }
        }
    }
    for (let i = 1; i < code_lines.length; i++) {
        code_lines[i] = indent + code_lines[i];
    }
    return code_lines.join('\n');
}


function replace_star_count(aggregate_expression) {
    var rgx = /(?:(?<=^)|(?<=,)) *COUNT\( *\* *\)/ig;
    var result = aggregate_expression.replace(rgx, ' COUNT(1)');
    return str_strip(result);
}


function replace_star_vars(rbql_expression) {
    let star_rgx = /(?:^|,) *(\*|a\.\*|b\.\*) *(?=$|,)/g;
    let matches = get_all_matches(star_rgx, rbql_expression);
    let last_pos = 0;
    let result = '';
    for (let match of matches) {
        let star_expression = match[1];
        let replacement_expression = ']).concat(' + {'*': 'star_fields', 'a.*': 'record_a', 'b.*': 'record_b'}[star_expression] + ').concat([';
        if (last_pos < match.index)
            result += rbql_expression.substring(last_pos, match.index);
        result += replacement_expression;
        last_pos = match.index + match[0].length + 1; // Adding one to skip the lookahead comma
    }
    result += rbql_expression.substring(last_pos);
    return result;
}


function replace_star_vars_for_header_parsing(rbql_expression) {
    let star_rgx = /(?:(?<=^)|(?<=,)) *(\*|a\.\*|b\.\*) *(?=$|,)/g;
    let matches = get_all_matches(star_rgx, rbql_expression);
    let last_pos = 0;
    let result = '';
    for (let match of matches) {
        let star_expression = match[1];
        let replacement_expression = {'*': '__RBQL_INTERNAL_STAR', 'a.*': 'a.__RBQL_INTERNAL_STAR', 'b.*': 'b.__RBQL_INTERNAL_STAR'}[star_expression];
        if (last_pos < match.index)
            result += rbql_expression.substring(last_pos, match.index);
        result += replacement_expression;
        last_pos = match.index + match[0].length;
    }
    result += rbql_expression.substring(last_pos);
    return result;
}


function translate_update_expression(update_expression, input_variables_map, string_literals, indent) {
    let first_assignment = str_strip(update_expression.split('=')[0]);
    let first_assignment_error = `Unable to parse "UPDATE" expression: the expression must start with assignment, but "${first_assignment}" does not look like an assignable field name`;

    let assignment_looking_rgx = /(?:^|,) *(a[.#a-zA-Z0-9\[\]_]*) *=(?=[^=])/g;
    let update_expressions = [];
    let pos = 0;
    while (true) {
        let match = assignment_looking_rgx.exec(update_expression);
        if (update_expressions.length == 0 && (match === null || match.index != 0)) {
            throw new RbqlParsingError(first_assignment_error);
        }
        if (match === null) {
            update_expressions[update_expressions.length - 1] += str_strip(update_expression.substr(pos)) + ');';
            break;
        }
        if (update_expressions.length)
            update_expressions[update_expressions.length - 1] += str_strip(update_expression.substring(pos, match.index)) + ');';
        let dst_var_name = combine_string_literals(str_strip(match[1]), string_literals);
        if (!input_variables_map.hasOwnProperty(dst_var_name))
            throw new RbqlParsingError(`Unable to parse "UPDATE" expression: Unknown field name: "${dst_var_name}"`);
        let var_index = input_variables_map[dst_var_name].index;
        let current_indent = update_expressions.length ? indent : '';
        update_expressions.push(`${current_indent}safe_set(up_fields, ${var_index}, `);
        pos = match.index + match[0].length;
    }
    return combine_string_literals(update_expressions.join('\n'), string_literals);
}


function translate_select_expression(select_expression) {
    let as_alias_replacement_regexp = / +(AS|as) +([a-zA-Z][a-zA-Z0-9_]*) *(?=$|,)/g;
    let expression_without_counting_stars = replace_star_count(select_expression);
    let expression_without_as_column_alias = expression_without_counting_stars.replace(as_alias_replacement_regexp, '');
    let translated = str_strip(replace_star_vars(expression_without_as_column_alias));
    let translated_for_header = str_strip(replace_star_vars_for_header_parsing(expression_without_counting_stars));
    if (!translated.length)
        throw new RbqlParsingError('"SELECT" expression is empty');
    return [`[].concat([${translated}])`, translated_for_header];
}


function separate_string_literals(rbql_expression) {
    // The regex consists of 3 almost identicall parts, the only difference is quote type
    var rgx = /('(\\(\\\\)*'|[^'])*')|("(\\(\\\\)*"|[^"])*")|(`(\\(\\\\)*`|[^`])*`)/g;
    var match_obj = null;
    var format_parts = [];
    var string_literals = [];
    var idx_before = 0;
    while((match_obj = rgx.exec(rbql_expression)) !== null) {
        var literal_id = string_literals.length;
        var string_literal = match_obj[0];
        string_literals.push(string_literal);
        var start_index = match_obj.index;
        format_parts.push(rbql_expression.substring(idx_before, start_index));
        format_parts.push(`___RBQL_STRING_LITERAL${literal_id}___`);
        idx_before = rgx.lastIndex;
    }
    format_parts.push(rbql_expression.substring(idx_before));
    var format_expression = format_parts.join('');
    format_expression = format_expression.replace(/\t/g, ' ');
    return [format_expression, string_literals];
}


function locate_statements(rbql_expression) {
    let statement_groups = [];
    statement_groups.push([STRICT_LEFT_JOIN, LEFT_OUTER_JOIN, LEFT_JOIN, INNER_JOIN, JOIN]);
    statement_groups.push([SELECT]);
    statement_groups.push([ORDER_BY]);
    statement_groups.push([WHERE]);
    statement_groups.push([UPDATE]);
    statement_groups.push([GROUP_BY]);
    statement_groups.push([LIMIT]);
    statement_groups.push([EXCEPT]);
    var result = [];
    for (var ig = 0; ig < statement_groups.length; ig++) {
        for (var is = 0; is < statement_groups[ig].length; is++) {
            var statement = statement_groups[ig][is];
            var rgxp = new RegExp('(?:^| )' + replace_all(statement, ' ', ' *') + '(?= )', 'ig');
            var matches = get_all_matches(rgxp, rbql_expression);
            if (!matches.length)
                continue;
            if (matches.length > 1)
                throw new RbqlParsingError(`More than one "${statement}" statements found`);
            assert(matches.length == 1);
            var match = matches[0];
            var match_str = match[0];
            result.push([match.index, match.index + match_str.length, statement]);
            break; // Break to avoid matching a sub-statement from the same group e.g. "INNER JOIN" -> "JOIN"
        }
    }
    result.sort(function(a, b) { return a[0] - b[0]; });
    return result;
}


function separate_actions(rbql_expression) {
    rbql_expression = str_strip(rbql_expression);
    var result = {};
    let with_match = /^(.*)  *[Ww][Ii][Tt][Hh] *\(([a-z]{4,20})\) *$/.exec(rbql_expression);
    if (with_match !== null) {
        rbql_expression = with_match[1];
        result[WITH] = with_match[2];
    }
    var ordered_statements = locate_statements(rbql_expression);
    for (var i = 0; i < ordered_statements.length; i++) {
        var statement_start = ordered_statements[i][0];
        var span_start = ordered_statements[i][1];
        var statement = ordered_statements[i][2];
        var span_end = i + 1 < ordered_statements.length ? ordered_statements[i + 1][0] : rbql_expression.length;
        assert(statement_start < span_start);
        assert(span_start <= span_end);
        var span = rbql_expression.substring(span_start, span_end);
        var statement_params = {};
        if ([STRICT_LEFT_JOIN, LEFT_OUTER_JOIN, LEFT_JOIN, INNER_JOIN, JOIN].indexOf(statement) != -1) {
            statement_params['join_subtype'] = statement;
            statement = JOIN;
        }

        if (statement == UPDATE) {
            if (statement_start != 0)
                throw new RbqlParsingError('UPDATE keyword must be at the beginning of the query');
            span = span.replace(/^ *SET/i, '');
        }

        if (statement == ORDER_BY) {
            span = span.replace(/ ASC *$/i, '');
            var new_span = span.replace(/ DESC *$/i, '');
            if (new_span != span) {
                span = new_span;
                statement_params['reverse'] = true;
            } else {
                statement_params['reverse'] = false;
            }
        }

        if (statement == SELECT) {
            if (statement_start != 0)
                throw new RbqlParsingError('SELECT keyword must be at the beginning of the query');
            let match = /^ *TOP *([0-9]+) /i.exec(span);
            if (match !== null) {
                statement_params['top'] = parseInt(match[1]);
                span = span.substr(match.index + match[0].length);
            }
            match = /^ *DISTINCT *(COUNT)? /i.exec(span);
            if (match !== null) {
                statement_params['distinct'] = true;
                if (match[1]) {
                    statement_params['distinct_count'] = true;
                }
                span = span.substr(match.index + match[0].length);
            }
        }
        statement_params['text'] = str_strip(span);
        result[statement] = statement_params;
    }
    if (!result.hasOwnProperty(SELECT) && !result.hasOwnProperty(UPDATE)) {
        throw new RbqlParsingError('Query must contain either SELECT or UPDATE statement');
    }
    assert(result.hasOwnProperty(SELECT) != result.hasOwnProperty(UPDATE));
    return result;
}


function find_top(rb_actions) {
    if (rb_actions.hasOwnProperty(LIMIT)) {
        var rgx = /^[0-9]+$/;
        if (rgx.exec(rb_actions[LIMIT]['text']) === null) {
            throw new RbqlParsingError('LIMIT keyword must be followed by an integer');
        }
        var result = parseInt(rb_actions[LIMIT]['text']);
        return result;
    }
    var select_action = rb_actions[SELECT];
    if (select_action && select_action.hasOwnProperty('top')) {
        return select_action['top'];
    }
    return null;
}


function translate_except_expression(except_expression, input_variables_map, string_literals, input_header) {
    let skip_vars = except_expression.split(',');
    skip_vars = skip_vars.map(str_strip);
    let skip_indices = [];
    for (let var_name of skip_vars) {
        var_name = combine_string_literals(var_name, string_literals);
        if (!input_variables_map.hasOwnProperty(var_name))
            throw new RbqlParsingError(`Unknown field in EXCEPT expression: "${var_name}"`);
        skip_indices.push(input_variables_map[var_name].index);
    }
    skip_indices = skip_indices.sort((a, b) => a - b);
    let output_header = input_header === null ? null : select_except(input_header, skip_indices);
    let indices_str = skip_indices.join(',');
    return [output_header, `select_except(record_a, [${indices_str}])`];
}


class HashJoinMap {
    constructor(record_iterator, key_indices) {
        this.max_record_len = 0;
        this.hash_map = new Map();
        this.record_iterator = record_iterator;
        this.nr = 0;
        if (key_indices.length == 1) {
            this.key_index = key_indices[0];
            this.key_indices = null;
            this.polymorphic_get_key = this.get_single_key;
        } else {
            this.key_index = null;
            this.key_indices = key_indices;
            this.polymorphic_get_key = this.get_multi_key;
        }
    }

    get_single_key(nr, fields) {
        if (this.key_index >= fields.length)
            throw new RbqlRuntimeError(`No field with index ${this.key_index + 1} at record ${this.nr} in "B" table`);
        return this.key_index === -1 ? this.nr : fields[this.key_index];
    };

    get_multi_key(nr, fields) {
        let result = [];
        for (let ki of this.key_indices) {
            if (ki >= fields.length)
                throw new RbqlRuntimeError(`No field with index ${ki + 1} at record ${this.nr} in "B" table`);
            result.push(ki === -1 ? this.nr : fields[ki]);
        }
        return JSON.stringify(result);
    };

    async build() {
        while (true) {
            let fields = await this.record_iterator.get_record();
            if (fields === null)
                break;
            this.nr += 1;
            let nf = fields.length;
            this.max_record_len = Math.max(this.max_record_len, nf);
            let key = this.polymorphic_get_key(this.nr, fields);
            let key_records = this.hash_map.get(key);
            if (key_records === undefined) {
                this.hash_map.set(key, [[this.nr, nf, fields]]);
            } else {
                key_records.push([this.nr, nf, fields]);
            }
        }
    };

    get_join_records(key) {
        let result = this.hash_map.get(key);
        if (result === undefined)
            return [];
        return result;
    };

    get_warnings() {
        return this.record_iterator.get_warnings();
    };
}


function cleanup_query(query_text) {
    return query_text.split('\n').map(strip_comments).filter(line => line.length).join(' ').replace(/;+$/g, '');
}


function remove_redundant_table_name(query_text) {
    query_text = str_strip(query_text.replace(/ +from +a(?: +|$)/gi, ' '));
    query_text = str_strip(query_text.replace(/^ *update +a +set /gi, 'update '));
    return query_text;
}


function select_output_header(input_header, join_header, query_column_infos) {
    if (input_header === null) {
        assert(join_header === null);
    }
    let query_has_star = false;
    let query_has_column_alias = false;
    for (let qci of query_column_infos) {
        query_has_star = query_has_star || (qci !== null && qci.is_star);
        query_has_column_alias = query_has_column_alias || (qci !== null && qci.alias_name !== null);
    }
    if (input_header === null) {
        if (query_has_star && query_has_column_alias) {
            throw new RbqlParsingError('Using both * (star) and AS alias in the same query is not allowed for input tables without header');
        }
        if (!query_has_column_alias) {
            // Input table has no header and query has no aliases therefore the output table will be without header.
            return null;
        }
        input_header = [];
        join_header = [];
    }
    if (join_header === null) {
        // This means there is no JOIN table.
        join_header = [];
    }
    let output_header = [];
    for (let qci of query_column_infos) {
        // TODO refactor this and python version: extract this code into a function instead to always return something
        if (qci === null) {
            output_header.push('col' + (output_header.length + 1));
        } else if (qci.is_star) {
            if (qci.table_name === null) {
                output_header = output_header.concat(input_header).concat(join_header);
            } else if (qci.table_name === 'a') {
                output_header = output_header.concat(input_header);
            } else if (qci.table_name === 'b') {
                output_header = output_header.concat(join_header);
            }
        } else if (qci.column_name !== null) {
            output_header.push(qci.column_name);
        } else if (qci.alias_name !== null) {
            output_header.push(qci.alias_name);
        } else if (qci.column_index !== null) {
            if (qci.table_name == 'a' && qci.column_index < input_header.length) {
                output_header.push(input_header[qci.column_index]);
            } else if (qci.table_name == 'b' && qci.column_index < join_header.length) {
                output_header.push(join_header[qci.column_index]);
            } else {
                output_header.push('col' + (output_header.length + 1));
            }
        } else { // Should never happen
            output_header.push('col' + (output_header.length + 1));
        }
    }
    return output_header;
}


function sample_first_two_inconsistent_records(inconsistent_records_info) {
    let entries = Array.from(inconsistent_records_info.entries());
    entries.sort(function(a, b) { return a[1] - b[1]; });
    assert(entries.length > 1);
    let [num_fields_1, record_num_1] = entries[0];
    let [num_fields_2, record_num_2] = entries[1];
    return [record_num_1, num_fields_1, record_num_2, num_fields_2];
}


function make_inconsistent_num_fields_warning(table_name, inconsistent_records_info) {
    let [record_num_1, num_fields_1, record_num_2, num_fields_2] = sample_first_two_inconsistent_records(inconsistent_records_info);
    let warn_msg = `Number of fields in "${table_name}" table is not consistent: `;
    warn_msg += `e.g. record ${record_num_1} -> ${num_fields_1} fields, record ${record_num_2} -> ${num_fields_2} fields`;
    return warn_msg;
}


class RBQLInputIterator {
    constructor(){}
    stop() {
        throw new Error("Unable to call the interface method");
    }
    async get_variables_map(query_text) {
        throw new Error("Unable to call the interface method");
    }
    async get_record() {
        throw new Error("Unable to call the interface method");
    }
    handle_query_modifier() {
        return; // Reimplement if you need to handle a boolean query modifier that can be used like this: `SELECT * WITH (modifiername)`
    }
    get_warnings() {
        return []; // Reimplement if your class can produce warnings
    }
    async get_header() {
        return null; // Reimplement if your class can provide input header
    }
}


class RBQLOutputWriter {
    constructor(){}

    async write(fields) {
        throw new Error("Unable to call the interface method");
    }

    async finish() {
        // Reimplement if your class needs to do something on finish e.g. cleanup
    };

    get_warnings() {
        return []; // Reimplement if your class can produce warnings
    };

    set_header() {
        return; // Reimplement if your class can handle output headers in a meaningful way
    }
}


class RBQLTableRegistry {
    constructor(){}

    get_iterator_by_table_id(table_id) {
        throw new Error("Unable to call the interface method");
    }

    get_warnings() {
        return []; // Reimplement if your class can produce warnings
    };
}


class TableIterator extends RBQLInputIterator {
    constructor(table, column_names=null, normalize_column_names=true, variable_prefix='a') {
        super();
        this.table = table;
        this.column_names = column_names;
        this.normalize_column_names = normalize_column_names;
        this.variable_prefix = variable_prefix;
        this.nr = 0;
        this.fields_info = new Map();
        this.stopped = false;
    }


    stop() {
        this.stopped = true;
    };


    async get_variables_map(query_text) {
        let variable_map = new Object();
        parse_basic_variables(query_text, this.variable_prefix, variable_map);
        parse_array_variables(query_text, this.variable_prefix, variable_map);
        if (this.column_names !== null) {
            if (this.table.length && this.column_names.length != this.table[0].length)
                throw new RbqlIOHandlingError('List of column names and table records have different lengths');
            if (this.normalize_column_names) {
                parse_dictionary_variables(query_text, this.variable_prefix, this.column_names, variable_map);
                parse_attribute_variables(query_text, this.variable_prefix, this.column_names, 'column names list', variable_map);
            } else {
                map_variables_directly(query_text, this.column_names, variable_map);
            }
        }
        return variable_map;
    };


    async get_record() {
        if (this.stopped)
            return null;
        if (this.nr >= this.table.length)
            return null;
        let record = this.table[this.nr];
        this.nr += 1;
        let num_fields = record.length;
        if (!this.fields_info.has(num_fields))
            this.fields_info.set(num_fields, this.nr);
        return record;
    };

    get_warnings() {
        if (this.fields_info.size > 1)
            return [make_inconsistent_num_fields_warning('input', this.fields_info)];
        return [];
    };

    async get_header() {
        return this.column_names;
    }
}


class TableWriter extends RBQLOutputWriter {
    constructor(external_table) {
        super();
        this.table = external_table;
        this.header = null;
        this.finished = false;
    }

    async write(fields) {
        this.table.push(fields);
        return true;
    };

    set_header(header) {
        this.header = header;
    }

    async finish() {
        this.finished = true;
    }
}


class TablePipe {
    constructor() {
        this.table = [];
        this.writer = new TableWriter(this.table);
        this.iterator = null;
    }

    get_writer() {
        return this.writer;
    }

    get_iterator() {
        if (!this.writer.finished) {
            throw new RbqlIOHandlingError("Trying to read from non-thread-safe table pipe while not finishing writing yet");
        }
        if (this.iterator === null) {
            this.iterator = new TableIterator(this.table, this.writer.header);
        }
        return this.iterator;
    }
}


class SingleTableRegistry extends RBQLTableRegistry {
    constructor(table, column_names=null, normalize_column_names=true, table_id='b') {
        super();
        this.table = table;
        this.table_id = table_id;
        this.column_names = column_names;
        this.normalize_column_names = normalize_column_names;
    }

    get_iterator_by_table_id(table_id) {
        if (table_id.toLowerCase() !== this.table_id)
            throw new RbqlIOHandlingError(`Unable to find join table: "${table_id}"`);
        return new TableIterator(this.table, this.column_names, this.normalize_column_names, 'b');
    };
}


async function shallow_parse_input_query(query_text, input_iterator, join_tables_registry, query_context) {
    query_text = cleanup_query(query_text);
    var [format_expression, string_literals] = separate_string_literals(query_text);
    format_expression = remove_redundant_table_name(format_expression);

    var rb_actions = separate_actions(format_expression);
    if (rb_actions.hasOwnProperty(WITH)) {
        input_iterator.handle_query_modifier(rb_actions[WITH]);
    }
    var input_variables_map = await input_iterator.get_variables_map(query_text);

    if (rb_actions.hasOwnProperty(ORDER_BY) && rb_actions.hasOwnProperty(UPDATE))
        throw new RbqlParsingError('"ORDER BY" is not allowed in "UPDATE" queries');

    if (rb_actions.hasOwnProperty(GROUP_BY)) {
        if (rb_actions.hasOwnProperty(ORDER_BY) || rb_actions.hasOwnProperty(UPDATE))
            throw new RbqlParsingError('"ORDER BY", "UPDATE" and "DISTINCT" keywords are not allowed in aggregate queries');
        query_context.aggregation_key_expression = '[' + combine_string_literals(rb_actions[GROUP_BY]['text'], string_literals) + ']';
        query_context.aggregation_stage = 1;
    }


    let input_header = await input_iterator.get_header();
    let join_variables_map = null;
    let join_header = null;
    if (rb_actions.hasOwnProperty(JOIN)) {
        var [rhs_table_id, variable_pairs] = parse_join_expression(rb_actions[JOIN]['text']);
        if (join_tables_registry === null)
            throw new RbqlParsingError('JOIN operations are not supported by the application');
        let join_record_iterator = join_tables_registry.get_iterator_by_table_id(rhs_table_id);
        if (!join_record_iterator)
            throw new RbqlParsingError(`Unable to find join table: "${rhs_table_id}"`);
        if (rb_actions.hasOwnProperty(WITH)) {
            join_record_iterator.handle_query_modifier(rb_actions[WITH]);
        }
        join_variables_map = await join_record_iterator.get_variables_map(query_text);
        join_header = await join_record_iterator.get_header();
        if (input_header === null && join_header !== null) {
            throw new RbqlIOHandlingError('Inconsistent modes: Input table doesn\'t have a header while the Join table has a header');
        }
        if (input_header !== null && join_header === null) {
            throw new RbqlIOHandlingError('Inconsistent modes: Input table has a header while the Join table doesn\'t have a header');
        }
        let [lhs_variables, rhs_indices] = resolve_join_variables(input_variables_map, join_variables_map, variable_pairs, string_literals);
        let sql_join_type = {'JOIN': InnerJoiner, 'INNER JOIN': InnerJoiner, 'LEFT JOIN': LeftJoiner, 'LEFT OUTER JOIN': LeftJoiner, 'STRICT LEFT JOIN': StrictLeftJoiner}[rb_actions[JOIN]['join_subtype']];
        query_context.lhs_join_var_expression = lhs_variables.length == 1 ? lhs_variables[0] : 'JSON.stringify([' + lhs_variables.join(',') + '])';
        query_context.join_map_impl = new HashJoinMap(join_record_iterator, rhs_indices);
        await query_context.join_map_impl.build();
        query_context.join_map = new sql_join_type(query_context.join_map_impl);
    }

    query_context.variables_init_code = combine_string_literals(generate_init_statements(format_expression, input_variables_map, join_variables_map, ' '.repeat(4)), string_literals);

    if (rb_actions.hasOwnProperty(WHERE)) {
        var where_expression = rb_actions[WHERE]['text'];
        if (/[^><!=]=[^=]/.exec(where_expression))
            throw new RbqlParsingError('Assignments "=" are not allowed in "WHERE" expressions. For equality test use "==" or "==="');
        query_context.where_expression = combine_string_literals(where_expression, string_literals);
    }

    if (rb_actions.hasOwnProperty(UPDATE)) {
        var update_expression = translate_update_expression(rb_actions[UPDATE]['text'], input_variables_map, string_literals, ' '.repeat(8));
        query_context.update_expressions = combine_string_literals(update_expression, string_literals);
        query_context.writer.set_header(input_header);
    }

    if (rb_actions.hasOwnProperty(SELECT)) {
        query_context.top_count = find_top(rb_actions);
        if (rb_actions.hasOwnProperty(EXCEPT)) {
            if (rb_actions.hasOwnProperty(JOIN)) {
                throw new RbqlParsingError('EXCEPT and JOIN are not allowed in the same query');
            }
            let [output_header, select_expression] = translate_except_expression(rb_actions[EXCEPT]['text'], input_variables_map, string_literals, input_header);
            query_context.select_expression = select_expression;
            query_context.writer.set_header(output_header);
        } else {
            let [select_expression, select_expression_for_header] = translate_select_expression(rb_actions[SELECT]['text']);
            query_context.select_expression = combine_string_literals(select_expression, string_literals);
            let column_infos = adhoc_parse_select_expression_to_column_infos(select_expression_for_header, string_literals);
            let output_header = select_output_header(input_header, join_header, column_infos);
            query_context.writer.set_header(output_header);
        }

        query_context.writer = new TopWriter(query_context.writer, query_context.top_count);
        if (rb_actions[SELECT].hasOwnProperty('distinct_count')) {
            query_context.writer = new UniqCountWriter(query_context.writer);
        } else if (rb_actions[SELECT].hasOwnProperty('distinct')) {
            query_context.writer = new UniqWriter(query_context.writer);
        }
    }

    if (rb_actions.hasOwnProperty(ORDER_BY)) {
        query_context.sort_key_expression = combine_string_literals(rb_actions[ORDER_BY]['text'], string_literals);
        let reverse_sort = rb_actions[ORDER_BY]['reverse'];
        query_context.writer = new SortedWriter(query_context.writer, reverse_sort);
    }
}


function split_query_to_stages(query_text) {
    return query_text.split(/\|[>]?[ ]*(?=(?:select|update)[ ])/i);
}


async function staged_query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code) {
    query_context = new RBQLContext(query_text, input_iterator, output_writer, user_init_code);
    await shallow_parse_input_query(query_text, input_iterator, join_tables_registry, query_context);
    await compile_and_run(query_context);
    await query_context.writer.finish();
    output_warnings.push(...input_iterator.get_warnings());
    if (query_context.join_map_impl)
        output_warnings.push(...query_context.join_map_impl.get_warnings());
    output_warnings.push(...output_writer.get_warnings());
}


async function query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry=null, user_init_code='') {
    let query_stages = split_query_to_stages(query_text);
    let previous_pipe = null;
    for (let i = 0; i < query_stages.length; i++) {
        let query_stage_text = query_stages[i];
        let output_pipe = i + 1 < query_stages.length ? new TablePipe() : null;
        let stage_iterator = previous_pipe === null ? input_iterator : previous_pipe.get_iterator();
        let stage_writer = output_pipe === null ? output_writer : output_pipe.get_writer();
        await staged_query(query_stage_text, stage_iterator, stage_writer, output_warnings, join_tables_registry, user_init_code);
        previous_pipe = output_pipe;
    }
}


async function query_table(query_text, input_table, output_table, output_warnings, join_table=null, input_column_names=null, join_column_names=null, output_column_names=null, normalize_column_names=true, user_init_code='') {
    if (!normalize_column_names && input_column_names !== null && join_column_names !== null)
        ensure_no_ambiguous_variables(query_text, input_column_names, join_column_names);
    let input_iterator = new TableIterator(input_table, input_column_names, normalize_column_names);
    let output_writer = new TableWriter(output_table);
    let join_tables_registry = join_table === null ? null : new SingleTableRegistry(join_table, join_column_names, normalize_column_names);
    await query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code);
    if (output_column_names !== null) {
        assert(output_column_names.length == 0, '`output_column_names` param must be an empty list or null');
        if (output_writer.header !== null) {
            for (let column_name of output_writer.header) {
                output_column_names.push(column_name);
            }
        }
    }
}


function exception_to_error_info(e) {
    let exceptions_type_map = {
        'RbqlRuntimeError': 'query execution',
        'RbqlParsingError': 'query parsing',
        'SyntaxError': 'JS syntax error',
        'RbqlIOHandlingError': 'IO handling'
    };
    let error_type = 'unexpected';
    if (e.constructor && e.constructor.name && exceptions_type_map.hasOwnProperty(e.constructor.name)) {
        error_type = exceptions_type_map[e.constructor.name];
    }
    let error_msg = e.hasOwnProperty('message') ? e.message : String(e);
    return [error_type, error_msg];
}


exports.query = query;
exports.query_table = query_table;
exports.RBQLInputIterator = RBQLInputIterator;
exports.RBQLOutputWriter = RBQLOutputWriter;
exports.RBQLTableRegistry = RBQLTableRegistry;

exports.version = RBQL_VERSION;
exports.TableIterator = TableIterator;
exports.TableWriter = TableWriter;
exports.SingleTableRegistry = SingleTableRegistry;
exports.exception_to_error_info = exception_to_error_info;


// The functions below are exported just for unit tests, they are not part of the rbql API
// TODO exports through the special unit_test proxy e.g. exports.unit_test.parse_basic_variables = parse_basic_variables;
exports.parse_basic_variables = parse_basic_variables;
exports.parse_array_variables = parse_array_variables;
exports.parse_dictionary_variables = parse_dictionary_variables;
exports.parse_attribute_variables = parse_attribute_variables;
exports.get_all_matches = get_all_matches;
exports.strip_comments = strip_comments;
exports.separate_actions = separate_actions;
exports.separate_string_literals = separate_string_literals;
exports.combine_string_literals = combine_string_literals;
exports.parse_join_expression = parse_join_expression;
exports.resolve_join_variables = resolve_join_variables;
exports.translate_update_expression = translate_update_expression;
exports.translate_select_expression = translate_select_expression;
exports.translate_except_expression = translate_except_expression;
exports.like_to_regex = like_to_regex;
exports.adhoc_parse_select_expression_to_column_infos = adhoc_parse_select_expression_to_column_infos;
exports.replace_star_count = replace_star_count;
exports.replace_star_vars_for_header_parsing = replace_star_vars_for_header_parsing;
exports.select_output_header = select_output_header;
exports.sample_first_two_inconsistent_records = sample_first_two_inconsistent_records;

}(typeof exports === 'undefined' ? this.rbql = {} : exports));

},
"rbql_core/rbql-js/rbql_csv.js": function (module, exports, require, __filename, __dirname) {
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const rbql = require('./rbql.js');
const csv_utils = require('./csv_utils.js');


const utf_decoding_error = 'Unable to decode input table as UTF-8. Use binary (latin-1) encoding instead';


class RbqlIOHandlingError extends Error {}
class AssertionError extends Error {}


// TODO performance improvement: replace smart_split() with polymorphic_split()


function assert(condition, message=null) {
    if (!condition) {
        if (!message) {
            message = 'Assertion error';
        }
        throw new AssertionError(message);
    }
}


function interpret_named_csv_format(format_name) {
    format_name = format_name.toLowerCase();
    if (format_name == 'monocolumn')
        return ['', 'monocolumn'];
    if (format_name == 'csv')
        return [',', 'quoted'];
    if (format_name == 'tsv')
        return ['\t', 'simple'];
    throw new RbqlIOHandlingError(`Unknown format name: "${format_name}"`);
}



function is_ascii(str) {
    return /^[\x00-\x7F]*$/.test(str);
}


function read_user_init_code(rbql_init_source_path) {
    return fs.readFileSync(rbql_init_source_path, 'utf-8');
}


function remove_utf8_bom(line, assumed_source_encoding) {
    if (assumed_source_encoding == 'binary' && line.length >= 3 && line.charCodeAt(0) === 0xEF && line.charCodeAt(1) === 0xBB && line.charCodeAt(2) === 0xBF) {
        return line.substring(3);
    }
    if (assumed_source_encoding == 'utf-8' && line.length >= 1 && line.charCodeAt(0) === 0xFEFF) {
        return line.substring(1);
    }
    return line;
}


function make_inconsistent_num_fields_warning(table_name, inconsistent_records_info) {
    let [record_num_1, num_fields_1, record_num_2, num_fields_2] = rbql.sample_first_two_inconsistent_records(inconsistent_records_info);
    let warn_msg = `Number of fields in "${table_name}" table is not consistent: `;
    warn_msg += `e.g. record ${record_num_1} -> ${num_fields_1} fields, record ${record_num_2} -> ${num_fields_2} fields`;
    return warn_msg;
}


function expanduser(filepath) {
    if (filepath.charAt(0) === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}


function try_read_index(index_path) {
    var content = null;
    try {
        content = fs.readFileSync(index_path, 'utf-8');
    } catch (e) {
        return [];
    }
    var lines = content.split('\n');
    var records = [];
    for (var i = 0; i < lines.length; i++) {
        if (!lines[i])
            continue;
        var record = lines[i].split('\t');
        records.push(record);
    }
    return records;
}


function get_index_record(index_path, key) {
    var records = try_read_index(index_path);
    for (var i = 0; i < records.length; i++) {
        if (records[i].length && records[i][0] == key) {
            return records[i];
        }
    }
    return null;
}


function find_table_path(main_table_dir, table_id) {
    // If table_id is a relative path it could be relative either to the current directory or to the main table dir.
    var candidate_path = expanduser(table_id);
    if (fs.existsSync(candidate_path)) {
        return candidate_path;
    }
    if (main_table_dir && !path.isAbsolute(candidate_path)) {
        candidate_path = path.join(main_table_dir, candidate_path);
        if (fs.existsSync(candidate_path)) {
            return candidate_path;
        }
    }
    let table_names_settings_path = path.join(os.homedir(), '.rbql_table_names');
    var name_record = get_index_record(table_names_settings_path, table_id);
    if (name_record && name_record.length > 1 && fs.existsSync(name_record[1])) {
        return name_record[1];
    }
    return null;
}


class RecordQueue {
    // TODO compare performance with a linked list
    constructor() {
        this.push_stack = [];
        this.pull_stack = [];
    }

    enqueue(record) {
        this.push_stack.push(record);
    }

    dequeue() {
        if (!this.pull_stack.length) {
            if (!this.push_stack.length)
                return null;
            this.pull_stack = this.push_stack;
            this.pull_stack.reverse();
            this.push_stack = [];
        }
        return this.pull_stack.pop();
    }
}


class CSVRecordIterator extends rbql.RBQLInputIterator {
    // CSVRecordIterator implements a typical async producer-consumer model with an internal buffer:
    // get_record() - consumer
    // stream.on('data') - producer
    constructor(stream, csv_path, encoding, delim, policy, has_header=false, comment_prefix=null, table_name='input', variable_prefix='a', trim_whitespaces=false, comment_regex=null) {
        super();
        this.stream = stream;
        this.csv_path = csv_path;
        assert((this.stream === null) != (this.csv_path === null));
        this.encoding = encoding;
        this.delim = delim;
        this.policy = policy;

        this.has_header = has_header;
        this.first_record = null;
        this.first_record_should_be_emitted = !has_header;
        this.header_preread_complete = false;

        this.table_name = table_name;
        this.variable_prefix = variable_prefix;
        this.comment_prefix = comment_prefix;
        this.comment_regex = comment_regex;
        this.trim_whitespaces = trim_whitespaces;

        this.decoder = null;
        if (encoding == 'utf-8' && this.csv_path === null) {
            // Unfortunately util.TextDecoder has serious flaws:
            // 1. It doesn't work in Node without ICU: https://nodejs.org/api/util.html#util_new_textdecoder_encoding_options
            // 2. It is broken in Electron: https://github.com/electron/electron/issues/18733

            // Technically we can implement our own custom streaming text decoder, using the 3 following technologies:
            // 1. decode-encode validation method from https://stackoverflow.com/a/32279283/2898283
            // 2. Scanning buffer chunks for non-continuation utf-8 bytes from the end of the buffer:
            //    src_buffer -> (buffer_before, buffer_after) where buffer_after is very small(a couple of bytes) and buffer_before is large and ends with a non-continuation bytes
            // 3. Internal buffer to store small tail part from the previous buffer
            this.decoder = new util.TextDecoder(encoding, {fatal: true, stream: true});
        }

        this.input_exhausted = false;
        this.started = false;

        this.utf8_bom_removed = false; // BOM doesn't get automatically removed by the decoder when utf-8 file is treated as latin-1
        this.first_defective_line = null;

        this.fields_info = new Map();
        this.NR = 0; // Record number
        this.NL = 0; // Line number (NL != NR when the CSV file has comments or multiline fields)

        this.line_aggregator = new csv_utils.MultilineRecordAggregator(comment_prefix, comment_regex);

        this.partially_decoded_line = '';
        this.partially_decoded_line_ends_with_cr = false;

        // Holds an external "resolve" function which is called when everything is fine.
        this.resolve_current_record = null;
        // Holds an external "reject" function which is called when error has occured.
        this.reject_current_record = null;
        // Holds last exception if we don't have any reject callbacks from clients yet.
        this.current_exception = null;

        this.produced_records_queue = new RecordQueue();

        this.process_line_polymorphic = policy == 'quoted_rfc' ? this.process_partial_rfc_record_line : this.process_record_line_simple;
    }


    handle_query_modifier(modifier) {
        // For `... WITH (header) ...` syntax
        if (['header', 'headers'].indexOf(modifier) != -1) {
            this.has_header = true;
            this.first_record_should_be_emitted = false;
        }
        if (['noheader', 'noheaders'].indexOf(modifier) != -1) {
            this.has_header = false;
            this.first_record_should_be_emitted = true;
        }
    }


    reset_external_callbacks() {
        // Drop external callbacks simultaneously since promises can only resolve once, see: https://stackoverflow.com/a/18218542/2898283
        this.reject_current_record = null;
        this.resolve_current_record = null;
    }

    try_propagate_exception() {
        if (this.current_exception && this.reject_current_record) {
            let reject = this.reject_current_record;
            let exception = this.current_exception;
            this.reset_external_callbacks();
            this.current_exception = null;
            reject(exception);
        }
    }


    store_or_propagate_exception(exception) {
        if (this.current_exception === null)
            // Ignore subsequent exceptions if we already have an unreported error. This way we prioritize earlier errors over the more recent ones.
            this.current_exception = exception;
        this.try_propagate_exception();
    }


    async preread_first_record() {
        if (this.header_preread_complete)
            return;
        this.first_record = await this.get_record();
        this.header_preread_complete = true; // We must set header_preread_complete to true after calling get_record(), because get_record() uses it internally.
        if (this.first_record === null) {
            return;
        }
        if (this.stream)
            this.stream.pause();
        this.first_record = this.first_record.slice();
    };


    async get_variables_map(query_text) {
        let variable_map = new Object();
        rbql.parse_basic_variables(query_text, this.variable_prefix, variable_map);
        rbql.parse_array_variables(query_text, this.variable_prefix, variable_map);

        await this.preread_first_record();
        if (this.has_header && this.first_record) {
            rbql.parse_attribute_variables(query_text, this.variable_prefix, this.first_record, 'CSV header line', variable_map);
            rbql.parse_dictionary_variables(query_text, this.variable_prefix, this.first_record, variable_map);
        }
        return variable_map;
    };

    async get_header() {
        await this.preread_first_record();
        return this.has_header ? this.first_record : null;
    }


    try_resolve_next_record() {
        this.try_propagate_exception();
        if (this.resolve_current_record === null)
            return;

        let record = null;
        if (this.first_record_should_be_emitted && this.header_preread_complete) {
            this.first_record_should_be_emitted = false;
            record = this.first_record;
        } else {
            record = this.produced_records_queue.dequeue();
        }

        if (record === null && !this.input_exhausted)
            return;
        let resolve = this.resolve_current_record;
        this.reset_external_callbacks();
        resolve(record);
    };


    async get_record() {
        if (!this.started)
            await this.start();
        if (this.stream && this.stream.isPaused())
            this.stream.resume();

        let parent_iterator = this;
        let current_record_promise = new Promise(function(resolve, reject) {
            parent_iterator.resolve_current_record = resolve;
            parent_iterator.reject_current_record = reject;
        });
        this.try_resolve_next_record();
        return current_record_promise;
    };


    async get_all_records(num_records=null) {
        let records = [];
        while (true) {
            let record = await this.get_record();
            if (record === null)
                break;
            records.push(record);
            if (num_records && records.length >= num_records) {
                this.stop();
                break;
            }
        }
        return records;
    };


    process_record_line_simple(line) {
        if (this.comment_prefix && line.startsWith(this.comment_prefix))
            return; // Just skip the line
        if (this.comment_regex && line.search(this.comment_regex) != -1)
            return; // Just skip the line
        this.process_record_line(line);
    }


    process_record_line(line) {
        this.NR += 1;
        var [record, warning] = csv_utils.smart_split(line, this.delim, this.policy, false);
        if (this.trim_whitespaces) {
            record = record.map((v) => v.trim());
        }
        if (warning) {
            if (this.first_defective_line === null) {
                this.first_defective_line = this.NL;
                if (this.policy == 'quoted_rfc')
                    this.store_or_propagate_exception(new RbqlIOHandlingError(`Inconsistent double quote escaping in ${this.table_name} table at record ${this.NR}, line ${this.NL}`));
            }
        }
        let num_fields = record.length;
        if (!this.fields_info.has(num_fields))
            this.fields_info.set(num_fields, this.NR);
        this.produced_records_queue.enqueue(record);
        this.try_resolve_next_record();
    };


    process_partial_rfc_record_line(line) {
        this.line_aggregator.add_line(line);
        if (this.line_aggregator.has_comment_line) {
            this.line_aggregator.reset();
        } else if (this.line_aggregator.has_full_record) {
            this.process_record_line(this.line_aggregator.get_full_line('\n'));
            this.line_aggregator.reset();
        }
    };


    process_line(line) {
        this.NL += 1;
        if (this.NL === 1) {
            var clean_line = remove_utf8_bom(line, this.encoding);
            if (clean_line != line) {
                line = clean_line;
                this.utf8_bom_removed = true;
            }
        }
        this.process_line_polymorphic(line);
    };


    process_data_stream_chunk(data_chunk) {
        let decoded_string = null;
        if (this.decoder) {
            try {
                decoded_string = this.decoder.decode(data_chunk);
            } catch (e) {
                if (e instanceof TypeError) {
                    this.store_or_propagate_exception(new RbqlIOHandlingError(utf_decoding_error));
                } else {
                    this.store_or_propagate_exception(e);
                }
                return;
            }
        } else {
            decoded_string = data_chunk.toString(this.encoding);
        }
        let line_starts_with_lf = decoded_string.length && decoded_string[0] == '\n';
        let first_line_index = line_starts_with_lf && this.partially_decoded_line_ends_with_cr ? 1 : 0;
        this.partially_decoded_line_ends_with_cr = decoded_string.length && decoded_string[decoded_string.length - 1] == '\r';
        let lines = csv_utils.split_lines(decoded_string);
        lines[0] = this.partially_decoded_line + lines[0];
        assert(first_line_index == 0 || lines[0].length == 0);
        this.partially_decoded_line = lines.pop();
        for (let i = first_line_index; i < lines.length; i++) {
            this.process_line(lines[i]);
        }
    };


    process_data_bulk(data_blob) {
        let decoded_string = data_blob.toString(this.encoding);
        if (this.encoding == 'utf-8') {
            // Using hacky comparison method from here: https://stackoverflow.com/a/32279283/2898283
            // TODO get rid of this once TextDecoder is really fixed or when alternative method of reliable decoding appears
            let control_buffer = Buffer.from(decoded_string, 'utf-8');
            if (Buffer.compare(data_blob, control_buffer) != 0) {
                this.store_or_propagate_exception(new RbqlIOHandlingError(utf_decoding_error));
                return;
            }
        }
        let lines = csv_utils.split_lines(decoded_string);
        if (lines.length && lines[lines.length - 1].length == 0)
            lines.pop();
        for (let i = 0; i < lines.length; i++) {
            this.process_line(lines[i]);
        }
        if (this.line_aggregator.is_inside_multiline_record()) {
            this.process_record_line(this.line_aggregator.get_full_line('\n'));
        }
        this.input_exhausted = true;
        this.try_resolve_next_record(); // Should be a NOOP here?
    }


    process_data_stream_end() {
        this.input_exhausted = true;
        if (this.partially_decoded_line.length) {
            let last_line = this.partially_decoded_line;
            this.partially_decoded_line = '';
            this.process_line(last_line);
        }
        if (this.line_aggregator.is_inside_multiline_record()) {
            this.process_record_line(this.line_aggregator.get_full_line('\n'));
        }
        this.try_resolve_next_record();
    };


    stop() {
        if (this.stream)
            this.stream.destroy(); // TODO consider using pause() instead
    };


    async start() {
        if (this.started)
            return;
        this.started = true;
        if (this.stream) {
            this.stream.on('data', (data_chunk) => { this.process_data_stream_chunk(data_chunk); });
            this.stream.on('end', () => { this.process_data_stream_end(); });
        } else {
            let parent_iterator = this;
            return new Promise(function(resolve, reject) {
                fs.readFile(parent_iterator.csv_path, (err, data_blob) => {
                    if (err) {
                        reject(err);
                    } else {
                        parent_iterator.process_data_bulk(data_blob);
                        resolve();
                    }
                });
            });
        }
    };


    get_warnings() {
        let result = [];
        if (this.first_defective_line !== null)
            result.push(`Inconsistent double quote escaping in ${this.table_name} table. E.g. at line ${this.first_defective_line}`);
        if (this.utf8_bom_removed)
            result.push(`UTF-8 Byte Order Mark (BOM) was found and skipped in ${this.table_name} table`);
        if (this.fields_info.size > 1)
            result.push(make_inconsistent_num_fields_warning(this.table_name, this.fields_info));
        return result;
    };
}


class CSVWriter extends rbql.RBQLOutputWriter {
    constructor(stream, close_stream_on_finish, encoding, delim, policy, line_separator='\n') {
        super();
        this.stream = stream;
        this.encoding = encoding;
        if (encoding)
            this.stream.setDefaultEncoding(encoding);
        this.stream.on('error', (error_obj) => { this.store_first_error(error_obj); })
        this.delim = delim;
        this.policy = policy;
        this.line_separator = line_separator;
        this.sub_array_delim = delim == '|' ? ';' : '|';

        this.close_stream_on_finish = close_stream_on_finish;

        this.null_in_output = false;
        this.delim_in_simple_output = false;
        this.header_len = null;
        this.first_error = null;

        if (policy == 'simple') {
            this.polymorphic_join = this.simple_join;
        } else if (policy == 'quoted') {
            this.polymorphic_join = this.quoted_join;
        } else if (policy == 'quoted_rfc') {
            this.polymorphic_join = this.quoted_join_rfc;
        } else if (policy == 'monocolumn') {
            this.polymorphic_join = this.mono_join;
        } else if (policy == 'whitespace') {
            this.polymorphic_join = this.simple_join;
        } else {
            throw new RbqlIOHandlingError('Unknown output csv policy');
        }
    }


    store_first_error(error_obj) {
        // Store only first error because it is typically more important than the subsequent ones.
        if (this.first_error === null)
            this.first_error = error_obj;
    }

    set_header(header) {
        if (header !== null) {
            this.header_len = header.length;
            this.write(header);
        }
    }


    quoted_join(fields) {
        let delim = this.delim;
        var quoted_fields = fields.map(function(v) { return csv_utils.quote_field(String(v), delim); });
        return quoted_fields.join(this.delim);
    };


    quoted_join_rfc(fields) {
        let delim = this.delim;
        var quoted_fields = fields.map(function(v) { return csv_utils.rfc_quote_field(String(v), delim); });
        return quoted_fields.join(this.delim);
    };


    mono_join(fields) {
        if (fields.length > 1) {
            throw new RbqlIOHandlingError('Unable to use "Monocolumn" output format: some records have more than one field');
        }
        return fields[0];
    };


    simple_join(fields) {
        var res = fields.join(this.delim);
        if (fields.join('').indexOf(this.delim) != -1) {
            this.delim_in_simple_output = true;
        }
        return res;
    };


    normalize_fields(out_fields) {
        for (var i = 0; i < out_fields.length; i++) {
            if (out_fields[i] == null) {
                this.null_in_output = true;
                out_fields[i] = '';
            } else if (Array.isArray(out_fields[i])) {
                this.normalize_fields(out_fields[i]);
                out_fields[i] = out_fields[i].join(this.sub_array_delim);
            }
        }
    };


    async write(fields) {
        if (this.header_len !== null && fields.length != this.header_len)
            throw new RbqlIOHandlingError(`Inconsistent number of columns in output header and the current record: ${this.header_len} != ${fields.length}`);
        this.normalize_fields(fields);
        this.stream.write(this.polymorphic_join(fields));
        this.stream.write(this.line_separator);
        let writer_error = this.first_error;
        return new Promise(function(resolve, reject) {
            if (writer_error !== null) {
                reject(writer_error);
            } else {
                resolve(true);
            }
        });
    };


    _write_all(table) {
        for (let i = 0; i < table.length; i++) {
            this.write(table[i]);
        }
    };


    async finish() {
        let close_stream_on_finish = this.close_stream_on_finish;
        let output_stream = this.stream;
        let output_encoding = this.encoding;
        let writer_error = this.first_error;
        let finish_promise = new Promise(function(resolve, reject) {
            if (writer_error !== null) {
                reject(writer_error);
            }
            if (close_stream_on_finish) {
                output_stream.end('', output_encoding, () => { resolve(); });
            } else {
                setTimeout(() => { resolve(); }, 0);
            }
        });
        return finish_promise;
    };


    get_warnings() {
        let result = [];
        if (this.null_in_output)
            result.push('null values in output were replaced by empty strings');
        if (this.delim_in_simple_output)
            result.push('Some output fields contain separator');
        return result;
    };

}


class FileSystemCSVRegistry extends rbql.RBQLTableRegistry {
    constructor(input_file_dir, delim, policy, encoding, has_header=false, comment_prefix=null, options=null) {
        super();
        this.input_file_dir = input_file_dir;
        this.delim = delim;
        this.policy = policy;
        this.encoding = encoding;
        this.has_header = has_header;
        this.comment_prefix = comment_prefix;
        this.options = options;
        this.active_join_files = [];
    }

    get_iterator_by_table_id(table_id) {
        let stream = null;
        let table_path = find_table_path(this.input_file_dir, table_id);
        if (table_path === null) {
            throw new RbqlIOHandlingError(`Unable to find join table "${table_id}"`);
        }
        let bulk_input_path = null;
        if (this.options && this.options['bulk_read']) {
            bulk_input_path = table_path;
        } else {
            stream = fs.createReadStream(table_path);
        }
        let trim_whitespaces = this.options && this.options['trim_whitespaces'] ? true : false;
        let comment_regex = this.options && this.options.hasOwnProperty('comment_regex') ? this.options['comment_regex'] : null;
        let record_iterator = new CSVRecordIterator(stream, bulk_input_path, this.encoding, this.delim, this.policy, this.has_header, this.comment_prefix, table_id, 'b', trim_whitespaces, comment_regex);
        this.active_join_files.push({'table_path': table_path, 'input_stream': stream, 'record_iterator': record_iterator});
        return record_iterator;
    };

    get_warnings(output_warnings) {
        if (this.has_header) {
            for (let active_join_file of this.active_join_files) {
                output_warnings.push(`The first record in JOIN file ${path.basename(active_join_file.table_path)} was also treated as header (and skipped)`);
            }
        }
    }
}


async function query_csv(query_text, input_path, input_delim, input_policy, output_path, output_delim, output_policy, csv_encoding, output_warnings, with_headers=false, comment_prefix=null, user_init_code='', options=null) {
    let input_stream = null;
    let bulk_input_path = null;
    if (options && options['bulk_read'] && input_path) {
        bulk_input_path = input_path;
    } else {
        input_stream = input_path === null ? process.stdin : fs.createReadStream(input_path);
    }
    let trim_whitespaces = options && options['trim_whitespaces'] ? true : false;
    let comment_regex = options && options.hasOwnProperty('comment_regex') ? options['comment_regex'] : null;
    let [output_stream, close_output_on_finish] = output_path === null ? [process.stdout, false] : [fs.createWriteStream(output_path), true];
    if (input_delim == '"' && input_policy == 'quoted')
        throw new RbqlIOHandlingError('Double quote delimiter is incompatible with "quoted" policy');
    if (csv_encoding == 'latin-1')
        csv_encoding = 'binary';
    if (!is_ascii(query_text) && csv_encoding == 'binary')
        throw new RbqlIOHandlingError('To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary');
    if ((!is_ascii(input_delim) || !is_ascii(output_delim)) && csv_encoding == 'binary')
        throw new RbqlIOHandlingError('To use non-ascii characters in query enable UTF-8 encoding instead of latin-1/binary');

    let default_init_source_path = path.join(os.homedir(), '.rbql_init_source.js');
    if (user_init_code == '' && fs.existsSync(default_init_source_path)) {
        user_init_code = read_user_init_code(default_init_source_path);
    }
    let input_file_dir = input_path ? path.dirname(input_path) : null;
    let join_tables_registry = new FileSystemCSVRegistry(input_file_dir, input_delim, input_policy, csv_encoding, with_headers, comment_prefix, options);
    let input_iterator = new CSVRecordIterator(input_stream, bulk_input_path, csv_encoding, input_delim, input_policy, with_headers, comment_prefix, 'input', 'a', trim_whitespaces, comment_regex);
    let output_writer = new CSVWriter(output_stream, close_output_on_finish, csv_encoding, output_delim, output_policy);

    await rbql.query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code);
    join_tables_registry.get_warnings(output_warnings);
}


module.exports.is_ascii = is_ascii;
module.exports.CSVRecordIterator = CSVRecordIterator;
module.exports.CSVWriter = CSVWriter;
module.exports.FileSystemCSVRegistry = FileSystemCSVRegistry;
module.exports.interpret_named_csv_format = interpret_named_csv_format;
module.exports.read_user_init_code = read_user_init_code;
module.exports.query_csv = query_csv;
module.exports.RecordQueue = RecordQueue;
module.exports.exception_to_error_info = rbql.exception_to_error_info;

},
"rbql_suggest.js": function (module, exports, require, __filename, __dirname) {
let rbql_suggest = {};

( function() {

rbql_suggest.active_suggest_idx = null; 
rbql_suggest.suggest_list = []
rbql_suggest.apply_suggest_callback = null;
rbql_suggest.autosuggest_header_vars = [];
rbql_suggest.input_id = null;
rbql_suggest.suggest_list_id = null;
rbql_suggest.suggest_entry_class = null;
rbql_suggest.current_join_table_id = null;
rbql_suggest.fetch_join_header_callback = null;



function js_string_escape_column_name(column_name, quote_char) {
    column_name = column_name.replace(/\\/g, '\\\\');
    column_name = column_name.replace(/\n/g, '\\n');
    column_name = column_name.replace(/\r/g, '\\r');
    column_name = column_name.replace(/\t/g, '\\t');
    if (quote_char === "'")
        return column_name.replace(/'/g, "\\'");
    if (quote_char === '"')
        return column_name.replace(/"/g, '\\"');
    return column_name.replace(/`/g, "\\`");
}


function convert_header_to_rbql_variables(header, table_var_prefix) {
    let max_suggest_len = 100; // Suggest UI could become unresponsive if there are too many suggest options to consider
    let result = [];
    for (let h of header) {
        let column_var_options = {orig_column_name: h, table_var_prefix: table_var_prefix};
        if (h.match('^[_a-zA-Z][_a-zA-Z0-9]*$') !== null) {
            column_var_options.dot_var = `${table_var_prefix}.${h}`;
        } else {
            column_var_options.dot_var = null;
        }
        let escaped_column_name = js_string_escape_column_name(h, '"');
        column_var_options.double_q_var = `${table_var_prefix}["${escaped_column_name}"]`;
        escaped_column_name = js_string_escape_column_name(h, "'");
        column_var_options.single_q_var = `${table_var_prefix}['${escaped_column_name}']`;
        result.push(column_var_options);
        if (result.length > max_suggest_len)
            break;
    }
    return result;
}


function initialize_suggest(input_id, suggest_list_id, suggest_entry_class, apply_suggest_callback, header, fetch_join_header_callback=null) {
    if (!header)
        header = [];
    rbql_suggest.autosuggest_header_vars = convert_header_to_rbql_variables(header, 'a');
    rbql_suggest.active_suggest_idx = null; 
    rbql_suggest.suggest_list = []
    rbql_suggest.input_id = input_id;
    rbql_suggest.suggest_list_id = suggest_list_id;
    rbql_suggest.suggest_entry_class = suggest_entry_class;
    rbql_suggest.apply_suggest_callback = apply_suggest_callback;
    rbql_suggest.fetch_join_header_callback = fetch_join_header_callback;
}


function hide_suggest(suggest_div) {
    if (rbql_suggest.active_suggest_idx !== null) {
        suggest_div.style.display = 'none';
        rbql_suggest.active_suggest_idx = null;
        rbql_suggest.suggest_list = [];
    }
}


function apply_suggest(suggest_index) {
    try {
        let rbql_input = document.getElementById(rbql_suggest.input_id);
        rbql_input.value = rbql_suggest.suggest_list[suggest_index][0];
        rbql_input.selectionStart = rbql_suggest.suggest_list[suggest_index][1];
        rbql_input.selectionEnd = rbql_suggest.suggest_list[suggest_index][1];
        rbql_input.focus();
        if (rbql_suggest.apply_suggest_callback) {
            rbql_suggest.apply_suggest_callback(rbql_suggest.suggest_list[suggest_index][0]);
        }
        hide_suggest(document.getElementById(rbql_suggest.suggest_list_id));
    } catch (e) {
        console.error(`Autocomplete error: ${e}`);
    }
}


function register_suggest_callback(button_element, suggest_index) {
    button_element.addEventListener("click", () => {
        apply_suggest(suggest_index);
    });
}


function highlight_active_suggest_entry(do_highlight) {
    let entry_button = document.getElementById(`rbql_suggest_var_${rbql_suggest.active_suggest_idx}`);
    if (!entry_button)
        return;
    if (do_highlight) {
        let active_entry_class = rbql_suggest.suggest_entry_class + '_active';
        entry_button.className = [rbql_suggest.suggest_entry_class, active_entry_class].join(' ');
        entry_button.scrollIntoView();
    } else {
        entry_button.className = rbql_suggest.suggest_entry_class;
    }
}


function remove_children(root_node) {
    while (root_node.firstChild) {
        root_node.removeChild(root_node.firstChild);
    }
}


function show_suggest(suggest_div, query_before_var, relevant_suggest_list, query_after_cursor) {
    let rbql_input = document.getElementById(rbql_suggest.input_id);
    let caret_left_shift = 0;
    try {
        let caret_coordinates = getCaretCoordinates(rbql_input, rbql_input.selectionStart);
        caret_left_shift = caret_coordinates.left ? caret_coordinates.left : 0;
    } catch (e) {
        caret_left_shift = 0;
    }
    remove_children(suggest_div);
    rbql_suggest.active_suggest_idx = 0;
    rbql_suggest.suggest_list = [];
    for (let i = 0; i < relevant_suggest_list.length; i++) {
        let suggest_text = relevant_suggest_list[i];
        let entry_button = document.createElement('button');
        entry_button.className = rbql_suggest.suggest_entry_class;
        entry_button.textContent = suggest_text;
        entry_button.setAttribute('id', `rbql_suggest_var_${i}`);
        register_suggest_callback(entry_button, i);
        suggest_div.appendChild(entry_button);
        rbql_suggest.suggest_list.push([query_before_var + suggest_text + query_after_cursor, (query_before_var + suggest_text).length]);
    }
    highlight_active_suggest_entry(true);
    suggest_div.style.display = 'block';
    let calculated_height = suggest_div.offsetHeight;
    let calculated_width = suggest_div.offsetWidth;
    let box = rbql_input.getBoundingClientRect();
    suggest_div.style.left = Math.max(0, Math.min(box.left + caret_left_shift, box.right - calculated_width)) + 'px';
    suggest_div.style.top = (box.top - calculated_height) + 'px';
}


function switch_active_suggest(direction) {
    if (rbql_suggest.active_suggest_idx === null)
        return false;
    highlight_active_suggest_entry(false);
    if (direction == 'up') {
        rbql_suggest.active_suggest_idx = (rbql_suggest.active_suggest_idx + rbql_suggest.suggest_list.length - 1) % rbql_suggest.suggest_list.length;
    } else {
        rbql_suggest.active_suggest_idx = (rbql_suggest.active_suggest_idx + 1) % rbql_suggest.suggest_list.length;
    }
    highlight_active_suggest_entry(true);
    return true;
}


function is_printable_key_code(keycode) {
    // Taken from here: https://stackoverflow.com/a/12467610/2898283
    return (keycode > 47 && keycode < 58) || keycode == 32 || (keycode > 64 && keycode < 91) || (keycode > 185 && keycode < 193) || (keycode > 218 && keycode < 223);
}


function handle_input_keydown(event) {
    // We need this logic to prevent the caret from going to the start of the input field with the default arrow-up keydown handler
    try {
        if (event.keyCode == 38) {
            if (switch_active_suggest('up'))
                event.preventDefault();
        } else if (event.keyCode == 40) {
            if (switch_active_suggest('down'))
                event.preventDefault();
        } else if (event.keyCode == 39) {
            if (rbql_suggest.active_suggest_idx !== null) {
                apply_suggest(rbql_suggest.active_suggest_idx);
                event.preventDefault();
            }
        }
    } catch (e) {
        console.error(`Autocomplete error: ${e}`);
    }
}


function variable_has_prefix(full_variable, cursor_var_prefix) {
    return full_variable && full_variable.toLowerCase().startsWith(cursor_var_prefix.toLowerCase()) && full_variable != cursor_var_prefix;
}


function get_best_matching_variable(cursor_var_prefix, column_var_options) {
    if (cursor_var_prefix.startsWith(column_var_options.table_var_prefix + '.')) {
        if (variable_has_prefix(column_var_options.dot_var, cursor_var_prefix))
            return column_var_options.dot_var;
        if (variable_has_prefix(column_var_options.table_var_prefix + '.' + column_var_options.orig_column_name, cursor_var_prefix))
            return column_var_options.single_q_var;
    }
    if (variable_has_prefix(column_var_options.single_q_var, cursor_var_prefix))
        return column_var_options.single_q_var;
    if (variable_has_prefix(column_var_options.double_q_var, cursor_var_prefix))
        return column_var_options.double_q_var;
    return null;
}


function get_join_table_id(query) {
    let match = query.match(/ join +([^ ]+)(?: *$| +o$| +on)/i);
    if (!match)
        return null;
    return match[1];
}


function adjust_join_table_header_callback(join_header) {
    if (!join_header || !join_header.length) {
        rbql_suggest.autosuggest_header_vars = rbql_suggest.autosuggest_header_vars.filter(v => v.table_var_prefix != 'b');
    } else {
        let join_header_vars = convert_header_to_rbql_variables(join_header, 'b');
        rbql_suggest.autosuggest_header_vars = rbql_suggest.autosuggest_header_vars.concat(join_header_vars);
    }
}


function handle_input_keyup(event) {
    try {
        if (event.keyCode == 13) {
            if (rbql_suggest.active_suggest_idx !== null)
                apply_suggest(rbql_suggest.active_suggest_idx);
            return;
        }
        if (is_printable_key_code(event.keyCode) || event.keyCode == 8 /* Bakspace */) {
            // We can't move this into the keydown handler because the characters appear in the input box only after keyUp event.
            // Or alternatively we could scan the event.keyCode to find out the next char, but this is additional logic
            let rbql_input = document.getElementById(rbql_suggest.input_id);
            let current_query = rbql_input.value;
            if (rbql_suggest.fetch_join_header_callback !== null) {
                let join_table_id = get_join_table_id(current_query);
                if (rbql_suggest.current_join_table_id != join_table_id) {
                    rbql_suggest.current_join_table_id = join_table_id;
                    if (join_table_id === null) {
                        adjust_join_table_header_callback([]);
                    } else {
                        rbql_suggest.fetch_join_header_callback(join_table_id, adjust_join_table_header_callback)
                    }
                }
            }
            let suggest_div = document.getElementById(rbql_suggest.suggest_list_id);
            hide_suggest(suggest_div);
            let cursor_pos = rbql_input.selectionStart;
            let query_before_cursor = current_query.substr(0, cursor_pos);
            let query_after_cursor = current_query.substr(cursor_pos);
            // TODO improve the match - just find last var-looking expression. The problem with this one - it won't match extended suggest like a.arbitrary-var -> a['arbitrary-var']
            let last_var_prefix_match = query_before_cursor.match(/(?:[^_a-zA-Z0-9])([ab](?:\.[_a-zA-Z0-9]*|\[[^\]]*))$/);
            if (last_var_prefix_match) {
                let relevant_suggest_list = [];
                let cursor_var_prefix = last_var_prefix_match[1];
                let query_before_var = query_before_cursor.substr(0, last_var_prefix_match.index + 1);
                for (let column_var_options of rbql_suggest.autosuggest_header_vars) {
                    let suggested_var = get_best_matching_variable(cursor_var_prefix, column_var_options);
                    if (suggested_var)
                        relevant_suggest_list.push(suggested_var);
                }
                if (relevant_suggest_list.length) {
                    show_suggest(suggest_div, query_before_var, relevant_suggest_list, query_after_cursor);
                }
            }
        }
    } catch (e) {
        console.error(`Autocomplete error: ${e}`);
    }
}


rbql_suggest.initialize_suggest = initialize_suggest;
rbql_suggest.handle_input_keydown = handle_input_keydown;
rbql_suggest.handle_input_keyup = handle_input_keyup;
rbql_suggest.convert_header_to_rbql_variables = convert_header_to_rbql_variables;

} )();

},
"syntaxes/csv.tmLanguage.json": function (module) { module.exports = {   "name": "csv syntax",
    "scopeName": "text.csv",
    "fileTypes": ["csv"],
    "patterns": [
        { "match": "((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?",
          "name": "rainbowgroup",
          "captures": {
              "1": {"name": "rainbow1"},
              "2": {"name": "keyword.rainbow2"},
              "3": {"name": "entity.name.function.rainbow3"},
              "4": {"name": "comment.rainbow4"},
              "5": {"name": "string.rainbow5"},
              "6": {"name": "variable.parameter.rainbow6"},
              "7": {"name": "constant.numeric.rainbow7"},
              "8": {"name": "entity.name.type.rainbow8"},
              "9": {"name": "markup.bold.rainbow9"},
              "10": {"name": "invalid.rainbow10"}
          }
        }

    ],
    "uuid": "ca03e352-04ef-4340-9a6b-9b99aae1c418"
}
; },
"syntaxes/dynamic_csv.tmLanguage.json": function (module) { module.exports = {   "name": "dynamic csv syntax",
    "scopeName": "text.dynamiccsv",
    "fileTypes": [],
    "patterns": [
    ],
    "uuid": "ca03e452-05ef-4039-9a7b-9b99aae2c058"
}
; },
"syntaxes/pipe_simple.tmLanguage.json": function (module) { module.exports = {   "name": "pipe syntax",
    "scopeName": "text.psv",
    "fileTypes": [],
    "patterns": [
        { "match": "([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)",
          "name": "rainbowgroup",
          "captures": {
              "1": {"name": "rainbow1"},
              "2": {"name": "keyword.rainbow2"},
              "3": {"name": "entity.name.function.rainbow3"},
              "4": {"name": "comment.rainbow4"},
              "5": {"name": "string.rainbow5"},
              "6": {"name": "variable.parameter.rainbow6"},
              "7": {"name": "constant.numeric.rainbow7"},
              "8": {"name": "entity.name.type.rainbow8"},
              "9": {"name": "markup.bold.rainbow9"},
              "10": {"name": "invalid.rainbow10"}
          }
        }

    ],
    "uuid": "ca13e332-04ef-1340-9a6b-9b99aae1c418"
}
; },
"syntaxes/scsv.tmLanguage.json": function (module) { module.exports = {   "name": "scsv syntax",
    "scopeName": "text.scsv",
    "fileTypes": ["scsv"],
    "patterns": [
        { "match": "((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?",
          "name": "rainbowgroup",
          "captures": {
              "1": {"name": "rainbow1"},
              "2": {"name": "keyword.rainbow2"},
              "3": {"name": "entity.name.function.rainbow3"},
              "4": {"name": "comment.rainbow4"},
              "5": {"name": "string.rainbow5"},
              "6": {"name": "variable.parameter.rainbow6"},
              "7": {"name": "constant.numeric.rainbow7"},
              "8": {"name": "entity.name.type.rainbow8"},
              "9": {"name": "markup.bold.rainbow9"},
              "10": {"name": "invalid.rainbow10"}
          }
        }

    ],
    "uuid": "cb13e352-03bf-4340-9a6b-9b99aae1c418"
}
; },
"syntaxes/tsv.tmLanguage.json": function (module) { module.exports = {   "name": "tsv syntax",
    "scopeName": "text.tsv",
    "fileTypes": ["tsv", "tab"],
    "patterns": [
        { "match": "([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)",
          "name": "rainbowgroup",
          "captures": {
              "1": {"name": "rainbow1"},
              "2": {"name": "keyword.rainbow2"},
              "3": {"name": "entity.name.function.rainbow3"},
              "4": {"name": "comment.rainbow4"},
              "5": {"name": "string.rainbow5"},
              "6": {"name": "variable.parameter.rainbow6"},
              "7": {"name": "constant.numeric.rainbow7"},
              "8": {"name": "entity.name.type.rainbow8"},
              "9": {"name": "markup.bold.rainbow9"},
              "10": {"name": "invalid.rainbow10"}
          }
        }

    ],
    "uuid": "ca13e332-04ef-1340-9a6b-9b99aae1c418"
}
; },
"syntaxes/wspcsv.tmLanguage.json": function (module) { module.exports = {   "name": "wspcsv syntax",
    "scopeName": "text.wspcsv",
    "fileTypes": [],
    "patterns": [
        { "match": "( *[^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)",
          "name": "rainbowgroup",
          "captures": {
              "1": {"name": "rainbow1"},
              "2": {"name": "keyword.rainbow2"},
              "3": {"name": "entity.name.function.rainbow3"},
              "4": {"name": "comment.rainbow4"},
              "5": {"name": "string.rainbow5"},
              "6": {"name": "variable.parameter.rainbow6"},
              "7": {"name": "constant.numeric.rainbow7"},
              "8": {"name": "entity.name.type.rainbow8"},
              "9": {"name": "markup.bold.rainbow9"},
              "10": {"name": "invalid.rainbow10"}
          }
        }

    ],
    "uuid": "ca02e451-04ef-4040-9a6b-9b99aae1c058"
}
; },
};

const __extension = {"commands":{"rainbow-csv.Align":"Align CSV Columns with whitespaces","rainbow-csv.CSVLint":"CSV Lint","rainbow-csv.ColumnEditAfter":"Column edit - After","rainbow-csv.ColumnEditBefore":"Column edit - Before","rainbow-csv.ColumnEditSelect":"Column edit - Selection","rainbow-csv.CopyBack":"CopyBack","rainbow-csv.ExcelCopy":"Copy for Excel / Sheets export","rainbow-csv.GoToColumn":"Go to column","rainbow-csv.MarkdownCopy":"Copy in Markdown table format","rainbow-csv.RBQL":"RBQL Query","rainbow-csv.RainbowSeparator":"Set rainbow separator","rainbow-csv.RainbowSeparatorOff":"Disable Rainbow CSV","rainbow-csv.RainbowSeparatorOn":"Re-enable Rainbow CSV","rainbow-csv.SampleHead":"Preview big CSV: head","rainbow-csv.SampleTail":"Preview big CSV: tail","rainbow-csv.SetCommentPrefix":"Set selection as comment prefix","rainbow-csv.SetHeaderLine":"Set header line","rainbow-csv.SetJoinTableName":"Set join table name for RBQL","rainbow-csv.SetVirtualHeader":"Set virtual header","rainbow-csv.Shrink":"Shrink CSV table - trim whitespaces","rainbow-csv.ToggleColumnTracking":"Toggle Column Tracking","rainbow-csv.ToggleRowBackground":"Toggle Alternating Row Background","rainbow-csv.VirtualAlign":"Virtual Align CSV Columns","rainbow-csv.VirtualShrink":"Undo Virtual Align"},"configuration":{"rainbow_csv.autodetect_separators":["TAB",",",";","|"],"rainbow_csv.autodetection_min_line_count":10,"rainbow_csv.comment_prefix":"","rainbow_csv.csv_lint_detect_trailing_spaces":false,"rainbow_csv.double_width_alignment":true,"rainbow_csv.enable_auto_csv_lint":true,"rainbow_csv.enable_context_menu_head":false,"rainbow_csv.enable_context_menu_tail":false,"rainbow_csv.enable_cursor_position_info":true,"rainbow_csv.enable_debug_logging":false,"rainbow_csv.enable_separator_autodetection":true,"rainbow_csv.enable_sticky_header":true,"rainbow_csv.enable_tooltip":true,"rainbow_csv.enable_tooltip_column_names":true,"rainbow_csv.highlight_rows":false,"rainbow_csv.rbql_output_dir":"TMP","rainbow_csv.rbql_strip_spaces":true,"rainbow_csv.rbql_with_headers_by_default":false,"rainbow_csv.virtual_alignment_char":"middot","rainbow_csv.virtual_alignment_mode":"disabled","rainbow_csv.virtual_alignment_vertical_grid":false},"entry":"dist/web/extension.js","grammars":[{"grammar":{"fileTypes":["csv"],"name":"csv syntax","patterns":[{"captures":{"1":{"name":"rainbow1"},"10":{"name":"invalid.rainbow10"},"2":{"name":"keyword.rainbow2"},"3":{"name":"entity.name.function.rainbow3"},"4":{"name":"comment.rainbow4"},"5":{"name":"string.rainbow5"},"6":{"name":"variable.parameter.rainbow6"},"7":{"name":"constant.numeric.rainbow7"},"8":{"name":"entity.name.type.rainbow8"},"9":{"name":"markup.bold.rainbow9"}},"match":"((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:,|$))|(?:[^,]*(?:,|$)))?","name":"rainbowgroup"}],"scopeName":"text.csv","uuid":"ca03e352-04ef-4340-9a6b-9b99aae1c418"},"language":"csv"},{"grammar":{"fileTypes":["tsv","tab"],"name":"tsv syntax","patterns":[{"captures":{"1":{"name":"rainbow1"},"10":{"name":"invalid.rainbow10"},"2":{"name":"keyword.rainbow2"},"3":{"name":"entity.name.function.rainbow3"},"4":{"name":"comment.rainbow4"},"5":{"name":"string.rainbow5"},"6":{"name":"variable.parameter.rainbow6"},"7":{"name":"constant.numeric.rainbow7"},"8":{"name":"entity.name.type.rainbow8"},"9":{"name":"markup.bold.rainbow9"}},"match":"([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)([^\\t]*\\t?)","name":"rainbowgroup"}],"scopeName":"text.tsv","uuid":"ca13e332-04ef-1340-9a6b-9b99aae1c418"},"language":"tsv"},{"grammar":{"fileTypes":[],"name":"pipe syntax","patterns":[{"captures":{"1":{"name":"rainbow1"},"10":{"name":"invalid.rainbow10"},"2":{"name":"keyword.rainbow2"},"3":{"name":"entity.name.function.rainbow3"},"4":{"name":"comment.rainbow4"},"5":{"name":"string.rainbow5"},"6":{"name":"variable.parameter.rainbow6"},"7":{"name":"constant.numeric.rainbow7"},"8":{"name":"entity.name.type.rainbow8"},"9":{"name":"markup.bold.rainbow9"}},"match":"([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)([^|]*\\|?)","name":"rainbowgroup"}],"scopeName":"text.psv","uuid":"ca13e332-04ef-1340-9a6b-9b99aae1c418"},"language":"csv (pipe)"},{"grammar":{"fileTypes":[],"name":"wspcsv syntax","patterns":[{"captures":{"1":{"name":"rainbow1"},"10":{"name":"invalid.rainbow10"},"2":{"name":"keyword.rainbow2"},"3":{"name":"entity.name.function.rainbow3"},"4":{"name":"comment.rainbow4"},"5":{"name":"string.rainbow5"},"6":{"name":"variable.parameter.rainbow6"},"7":{"name":"constant.numeric.rainbow7"},"8":{"name":"entity.name.type.rainbow8"},"9":{"name":"markup.bold.rainbow9"}},"match":"( *[^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)([^ ]* *)","name":"rainbowgroup"}],"scopeName":"text.wspcsv","uuid":"ca02e451-04ef-4040-9a6b-9b99aae1c058"},"language":"csv (whitespace)"},{"grammar":{"fileTypes":["scsv"],"name":"scsv syntax","patterns":[{"captures":{"1":{"name":"rainbow1"},"10":{"name":"invalid.rainbow10"},"2":{"name":"keyword.rainbow2"},"3":{"name":"entity.name.function.rainbow3"},"4":{"name":"comment.rainbow4"},"5":{"name":"string.rainbow5"},"6":{"name":"variable.parameter.rainbow6"},"7":{"name":"constant.numeric.rainbow7"},"8":{"name":"entity.name.type.rainbow8"},"9":{"name":"markup.bold.rainbow9"}},"match":"((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?((?: *\"(?:[^\"]*\"\")*[^\"]*\" *(?:;|$))|(?:[^;]*(?:;|$)))?","name":"rainbowgroup"}],"scopeName":"text.scsv","uuid":"cb13e352-03bf-4340-9a6b-9b99aae1c418"},"language":"csv (semicolon)"},{"grammar":{"fileTypes":[],"name":"dynamic csv syntax","patterns":[],"scopeName":"text.dynamiccsv","uuid":"ca03e452-05ef-4039-9a7b-9b99aae2c058"},"language":"dynamic csv"}],"id":"mechatroner.rainbow-csv","languages":[{"aliases":["CSV","csv"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[".csv"],"filenames":[],"id":"csv"},{"aliases":["TSV","tsv"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[".tsv",".tab"],"filenames":[],"id":"tsv"},{"aliases":["CSV (pipe)","csv (pipe)"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[],"filenames":[],"id":"csv (pipe)"},{"aliases":["CSV (whitespace)","csv (whitespace)"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[],"filenames":[],"id":"csv (whitespace)"},{"aliases":["CSV (semicolon)","csv (semicolon)"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[],"filenames":[],"id":"csv (semicolon)"},{"aliases":["Dynamic CSV","dynamic csv"],"configuration":{"autoClosingPairs":[["\"","\""]],"surroundingPairs":[["\"","\""]]},"extensions":[],"filenames":[],"id":"dynamic csv"}],"name":"Rainbow CSV","packageJSON":{"activationEvents":["onLanguage:csv","onLanguage:tsv","onLanguage:csv (semicolon)","onLanguage:csv (pipe)","onLanguage:csv (whitespace)","onLanguage:dynamic csv","onLanguage:plaintext","onCommand:rainbow-csv.RBQL","onCommand:rainbow-csv.RainbowSeparator","onCommand:rainbow-csv.SampleHead","onCommand:rainbow-csv.SampleTail"],"browser":"./dist/web/extension.js","capabilities":{"hoverProvider":"true"},"categories":["Data Science","Other","Programming Languages"],"contributes":{"colors":[{"defaults":{"dark":"#ff0000","highContrast":"#ff0000","highContrastLight":"#ff0000","light":"#ff0000"},"description":"Color for column tracking one.","id":"rainbowtrack1"},{"defaults":{"dark":"#00ff00","highContrast":"#00ff00","highContrastLight":"#00ff00","light":"#00ff00"},"description":"Color for column tracking two.","id":"rainbowtrack2"},{"defaults":{"dark":"#0000ff","highContrast":"#0000ff","highContrastLight":"#0000ff","light":"#0000ff"},"description":"Color for column tracking three.","id":"rainbowtrack3"}],"commands":[{"category":"Rainbow CSV","command":"rainbow-csv.CSVLint","title":"CSV Lint"},{"category":"Rainbow CSV","command":"rainbow-csv.SetVirtualHeader","title":"Set virtual header"},{"category":"Rainbow CSV","command":"rainbow-csv.SetHeaderLine","title":"Set header line"},{"category":"Rainbow CSV","command":"rainbow-csv.SetCommentPrefix","title":"Set selection as comment prefix"},{"category":"Rainbow CSV","command":"rainbow-csv.RBQL","title":"RBQL Query"},{"category":"Rainbow CSV","command":"rainbow-csv.SetJoinTableName","title":"Set join table name for RBQL"},{"category":"Rainbow CSV","command":"rainbow-csv.ColumnEditBefore","title":"Column edit - Before"},{"category":"Rainbow CSV","command":"rainbow-csv.ColumnEditAfter","title":"Column edit - After"},{"category":"Rainbow CSV","command":"rainbow-csv.ColumnEditSelect","title":"Column edit - Selection"},{"category":"Rainbow CSV","command":"rainbow-csv.RainbowSeparator","title":"Set rainbow separator"},{"category":"Rainbow CSV","command":"rainbow-csv.ToggleColumnTracking","title":"Toggle Column Tracking"},{"category":"Rainbow CSV","command":"rainbow-csv.ExcelCopy","title":"Copy for Excel / Sheets export"},{"category":"Rainbow CSV","command":"rainbow-csv.MarkdownCopy","title":"Copy in Markdown table format"},{"category":"Rainbow CSV","command":"rainbow-csv.RainbowSeparatorOff","title":"Disable Rainbow CSV"},{"category":"Rainbow CSV","command":"rainbow-csv.RainbowSeparatorOn","title":"Re-enable Rainbow CSV"},{"category":"Rainbow CSV","command":"rainbow-csv.ToggleRowBackground","title":"Toggle Alternating Row Background"},{"category":"Rainbow CSV","command":"rainbow-csv.Align","title":"Align CSV Columns with whitespaces"},{"category":"Rainbow CSV","command":"rainbow-csv.Shrink","title":"Shrink CSV table - trim whitespaces"},{"category":"Rainbow CSV","command":"rainbow-csv.VirtualAlign","title":"Virtual Align CSV Columns"},{"category":"Rainbow CSV","command":"rainbow-csv.VirtualShrink","title":"Undo Virtual Align"},{"category":"Rainbow CSV","command":"rainbow-csv.CopyBack","title":"CopyBack"},{"command":"rainbow-csv.SampleHead","title":"Preview big CSV: head"},{"command":"rainbow-csv.SampleTail","title":"Preview big CSV: tail"},{"category":"Rainbow CSV","command":"rainbow-csv.GoToColumn","title":"Go to column"}],"configuration":{"properties":{"rainbow_csv.autodetect_separators":{"default":["TAB",",",";","|"],"description":"Enable automatic content-based separator autodetection for the specified list of separators (multicharacter separators are supported).","items":{"description":"Separator","type":"string"},"order":3,"type":"array"},"rainbow_csv.autodetection_min_line_count":{"default":10,"description":"Minimum number of non-comment lines in file for content-based autodetection.","order":4,"type":"number"},"rainbow_csv.comment_prefix":{"default":"","description":"Comment lines prefix, e.g. \"#\". Set to empty string to disable.","order":15,"type":"string"},"rainbow_csv.csv_lint_detect_trailing_spaces":{"default":false,"description":"CSV Lint: detect leading and trailing whitespaces in fields and show warning.","order":14,"type":"boolean"},"rainbow_csv.double_width_alignment":{"default":true,"description":"If enabled treat double width unicode chars e.g. Chinese or Japanese chars as double wide when aligning.","order":12,"type":"boolean"},"rainbow_csv.enable_auto_csv_lint":{"default":true,"description":"Automatically run linter for every CSV file.","order":13,"type":"boolean"},"rainbow_csv.enable_context_menu_head":{"default":false,"description":"Enable \"Preview CSV head\" option in File Explorer context menu for all files.","order":19,"type":"boolean"},"rainbow_csv.enable_context_menu_tail":{"default":false,"description":"Enable \"Preview CSV tail\" option in File Explorer context menu for all files.","order":20,"type":"boolean"},"rainbow_csv.enable_cursor_position_info":{"default":true,"description":"Keyboard input text cursor: show info about the cursor CSV column in the status bar.","order":11,"type":"boolean"},"rainbow_csv.enable_debug_logging":{"default":false,"description":"Dev Mode: Enable Debug Logging. Run command [Developer: Show Logs...] -> [rainbow_csv_debug_channel] to see the output.","order":21,"type":"boolean"},"rainbow_csv.enable_separator_autodetection":{"default":true,"description":"Enable automatic content based separator autodetection.","order":2,"type":"boolean"},"rainbow_csv.enable_sticky_header":{"default":true,"description":"Enable sticky header line at the top.","order":1,"type":"boolean"},"rainbow_csv.enable_tooltip":{"default":true,"description":"Enable column-info tooltip on hover.","order":9,"type":"boolean"},"rainbow_csv.enable_tooltip_column_names":{"default":true,"description":"Show column names in tooltip.","order":10,"type":"boolean"},"rainbow_csv.highlight_rows":{"default":false,"description":"Highlight rows with alternate background colors by default.","order":5,"type":"boolean"},"rainbow_csv.rbql_output_dir":{"default":"TMP","description":"Output directory for RBQL result sets, can be `TMP`, `INPUT` or a custom absolute path. `TMP` - output in system tmp dir(default), `INPUT` - output in the same dir as input file, otherwise use provided path as the output directory e.g. `/path/to/custom/dir`.","order":16,"type":"string"},"rainbow_csv.rbql_strip_spaces":{"default":true,"description":"RBQL strips (trims) leading and trailing spaces from each field as a preprocessig step.","order":18,"type":"boolean"},"rainbow_csv.rbql_with_headers_by_default":{"default":false,"description":"RBQL treats the first line as header by default.","order":17,"type":"boolean"},"rainbow_csv.virtual_alignment_char":{"default":"middot","description":"Virtual alignment character.","enum":["middot","space"],"enumDescriptions":["Middle dot","Whitespace"],"order":7,"type":"string"},"rainbow_csv.virtual_alignment_mode":{"default":"disabled","description":"Virtual alignment based on VSCode inlay hints that doesn't change underlying file content.","enum":["disabled","manual","always"],"enumDescriptions":["Disabled. Align only when \"VirtualAlign\" command is executed","Align when \"Align\" Status Bar button is clicked","Automatically align all files"],"order":6,"type":"string"},"rainbow_csv.virtual_alignment_vertical_grid":{"default":false,"description":"Show vertical grid in virtual alignment mode.","order":8,"type":"boolean"}},"title":"Rainbow CSV","type":"object"},"configurationDefaults":{"[dynamic csv][csv][tsv][csv (semicolon)][csv (pipe)][csv (whitespace)]":{"editor.semanticHighlighting.enabled":true}},"grammars":[{"language":"csv","path":"./syntaxes/csv.tmLanguage.json","scopeName":"text.csv"},{"language":"tsv","path":"./syntaxes/tsv.tmLanguage.json","scopeName":"text.tsv"},{"language":"csv (pipe)","path":"./syntaxes/pipe_simple.tmLanguage.json","scopeName":"text.psv"},{"language":"csv (whitespace)","path":"./syntaxes/wspcsv.tmLanguage.json","scopeName":"text.wspcsv"},{"language":"csv (semicolon)","path":"./syntaxes/scsv.tmLanguage.json","scopeName":"text.scsv"},{"language":"dynamic csv","path":"./syntaxes/dynamic_csv.tmLanguage.json","scopeName":"text.dynamiccsv"}],"languages":[{"aliases":["CSV","csv"],"configuration":"./language-configuration.json","extensions":[".csv"],"id":"csv"},{"aliases":["TSV","tsv"],"configuration":"./language-configuration.json","extensions":[".tsv",".tab"],"id":"tsv"},{"aliases":["CSV (pipe)","csv (pipe)"],"configuration":"./language-configuration.json","extensions":[],"id":"csv (pipe)"},{"aliases":["CSV (whitespace)","csv (whitespace)"],"configuration":"./language-configuration.json","extensions":[],"id":"csv (whitespace)"},{"aliases":["CSV (semicolon)","csv (semicolon)"],"configuration":"./language-configuration.json","extensions":[],"id":"csv (semicolon)"},{"aliases":["Dynamic CSV","dynamic csv"],"configuration":"./language-configuration.json","extensions":[],"id":"dynamic csv"}],"menus":{"editor/context":[{"submenu":"rainbow_csv.submenu"}],"explorer/context":[{"command":"rainbow-csv.SampleHead","group":"rainbow_csv","when":"config.rainbow_csv.enable_context_menu_head || resourceLangId =~ /plaintext|^[ct]sv/"},{"command":"rainbow-csv.SampleTail","group":"rainbow_csv","when":"config.rainbow_csv.enable_context_menu_tail"}],"rainbow_csv.submenu":[{"command":"rainbow-csv.GoToColumn","group":"common@7","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.SetHeaderLine","group":"common@7","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.SetCommentPrefix","group":"common@6","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.RainbowSeparator","group":"common@5","when":"editorTextFocus && editorLangId =~ /dynamic csv|plaintext|^[ct]sv/"},{"command":"rainbow-csv.RBQL","group":"common@4","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.ToggleRowBackground","group":"common@3","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.ToggleColumnTracking","group":"common@2","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.RainbowSeparatorOn","group":"common@1","when":"editorTextFocus && editorLangId =~ /plaintext/"},{"command":"rainbow-csv.ExcelCopy","group":"datacopy@1","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.MarkdownCopy","group":"datacopy@2","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.Align","group":"regular_align@1","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.Shrink","group":"regular_align@2","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.VirtualAlign","group":"virtual_align@1","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.VirtualShrink","group":"virtual_align@2","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.ColumnEditSelect","group":"wgroup@1","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.ColumnEditBefore","group":"wgroup@2","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.ColumnEditAfter","group":"wgroup@3","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"},{"command":"rainbow-csv.RainbowSeparatorOff","group":"xgroup@1","when":"editorTextFocus && editorLangId =~ /dynamic csv|^[ct]sv/"}]},"semanticTokenScopes":[{"language":"dynamic csv","scopes":{"comment":["comment"],"rainbow1":["rainbow1"],"rainbow10":["invalid.rainbow10"],"rainbow2":["keyword.rainbow2"],"rainbow3":["entity.name.function.rainbow3"],"rainbow4":["comment.rainbow4"],"rainbow5":["string.rainbow5"],"rainbow6":["variable.parameter.rainbow6"],"rainbow7":["constant.numeric.rainbow7"],"rainbow8":["entity.name.type.rainbow8"],"rainbow9":["markup.bold.rainbow9"]}}],"submenus":[{"id":"rainbow_csv.submenu","label":"Rainbow CSV"}]},"description":"Highlight CSV and TSV files, Run SQL-like queries","devDependencies":{"@types/vscode":"^1.95.0","@vscode/test-electron":"^2.4.1","@vscode/test-web":"^0.0.64","assert":"^2.1.0","eslint":"^9.15.0","globals":"^15.12.0","process":"^0.11.10","webpack":"^5.96.1","webpack-cli":"^5.1.4"},"displayName":"Rainbow CSV","engines":{"vscode":"^1.95.0"},"icon":"rainbow_csv_logo.png","keywords":["csv","tsv","highlight"],"license":"MIT","main":"./extension","name":"rainbow-csv","publisher":"mechatroner","repository":{"type":"git","url":"https://github.com/mechatroner/vscode_rainbow_csv"},"scripts":{"compile-web":"webpack","lint":"eslint rainbow_utils.js fast_load_utils.js extension.js test/runTest.js && eslint -c .eslintrc_browser.json rainbow_utils.js rbql_client.js dialect_select.js","package-web":"webpack --mode production --devtool hidden-source-map","start-web-server":"vscode-test-web --version stable --browser=none --extensionDevelopmentPath=. test","test":"node ./test/runTest.js","test-in-browser":"vscode-test-web --version stable --browser=chromium --extensionDevelopmentPath=. --extensionTestsPath=dist/web/test/suite/index.js test","unit-test-only":"node ./test/suite/run_unit_tests.js","vscode:prepublish":"npm run package-web","watch-web":"webpack --watch"},"version":"3.24.1"}};

/** @param {any} sable */
export async function activate(sable) {
  await __sableVscode.activate(sable, __modules, __extension);
}

export async function deactivate() {
  await __sableVscode.deactivate();
}
