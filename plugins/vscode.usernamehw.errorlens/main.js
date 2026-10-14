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
"dist/extension.js": function (module, exports, require, __filename, __dirname) {
(()=>{var e={59:function(e,t,o){"use strict";var n=this&&this.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(t,"__esModule",{value:!0}),t.NewDelay=void 0;const r=n(o(221)),i=o(687),s=o(265),a=o(398);t.NewDelay=class{constructor(e){this.onDiagnosticChange=e=>{this.updateDecorationsDebounced()},this.updateDecorationsDebounced=(0,r.default)((()=>{(0,i.updateDecorationsForAllVisibleEditors)(),s.$state.statusBarIcons.updateText(),s.$state.codeLens?.show()}),e,{leading:!1,trailing:!0}),this.documentChangeDisposable=a.workspace.onDidChangeTextDocument((e=>{"scminput"!==e.document.languageId&&(this.clearDecorationsForAllVisibleEditors(),this.updateDecorationsDebounced(),s.$state.codeLens?.hide())}))}dispose(){this.documentChangeDisposable?.dispose()}clearDecorationsForAllVisibleEditors(){for(const e of a.window.visibleTextEditors)(0,i.clearDecorations)({editor:e})}}},83:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.transmutedDecorationTypes=void 0,t.transmuteSeverity=function(e){const t=e;for(const e in n.$config.transmute){const o=n.$config.transmute[e];if(o.severity)for(const e in t){const n=t[e];for(let i=0;i<n.length;i++)s(o,n[i])&&(t[e][i].severity=r.extUtils.severityStringToNumber(o.severity))}}return t},t.setTransmutedDecorationStyle=function(e){a();const o={};for(const t in n.$config.transmute){const r=n.$config.transmute[t];o[t]={};for(const n in e){const s=e[n];o[t][n]=i.window.createTextEditorDecorationType({...s,...r.decoration})}}t.transmutedDecorationTypes=o},t.transmute=function({decorationsError:e,decorationsWarning:t,decorationsInfo:o,decorationsHint:r,decorationRenderBase:i}){const a={nonTransmuted:{error:[],warning:[],info:[],hint:[]},transmuted:(c=n.$config.transmute,Object.fromEntries(Object.keys(c).map((e=>[e,{error:[],warning:[],info:[],hint:[]}]))))};var c;for(const c in n.$config.transmute){const g=n.$config.transmute[c];for(const t of e)s(g,t.diagnostic)?a.transmuted[c].error.push({range:t.options.range,renderOptions:{...i.error,...g.decoration,...t.options.renderOptions,after:{contentText:t.options.renderOptions?.after?.contentText}}}):a.nonTransmuted.error.push(t.options);for(const e of t)s(g,e.diagnostic)?a.transmuted[c].warning.push({range:e.options.range,renderOptions:{...i.warning,...g.decoration,...e.options.renderOptions,after:{contentText:e.options.renderOptions?.after?.contentText}}}):a.nonTransmuted.warning.push(e.options);for(const e of o)s(g,e.diagnostic)?a.transmuted[c].info.push({range:e.options.range,renderOptions:{...i.info,...g.decoration,...e.options.renderOptions,after:{contentText:e.options.renderOptions?.after?.contentText}}}):a.nonTransmuted.info.push(e.options);for(const e of r)s(g,e.diagnostic)?a.transmuted[c].hint.push({range:e.options.range,renderOptions:{...i.hint,...g.decoration,...e.options.renderOptions,after:{contentText:e.options.renderOptions?.after?.contentText}}}):a.nonTransmuted.hint.push(e.options)}return a},t.doUpdateTransmutedDecorations=function(e,o){for(const n in e){const{error:r,warning:i,info:s,hint:a}=e[n];o.setDecorations(t.transmutedDecorationTypes[n].error,r),o.setDecorations(t.transmutedDecorationTypes[n].warning,i),o.setDecorations(t.transmutedDecorationTypes[n].info,s),o.setDecorations(t.transmutedDecorationTypes[n].hint,a)}},t.disposeTransmutedDecorations=a;const n=o(265),r=o(968),i=o(398);function s(e,t){const o=e.target;if(!(o.message||o.messageRegex||o.source||o.code))return!1;if(o.source&&t.source&&o.source!==t.source)return!1;if(o.code&&t.code&&o.code!==r.extUtils.getDiagnosticCode(t))return!1;const n=t.message;return o.message&&n?!!n.toLocaleLowerCase().includes(o.message.toLocaleLowerCase()):!o.messageRegex||!n||(o.messageRegex.regex?!!new RegExp(o.messageRegex.regex,o.messageRegex.flags??"ui").test(n):(i.window.showErrorMessage('Missing "regex" property'),!1))}function a(){for(const e in t.transmutedDecorationTypes){const o=t.transmutedDecorationTypes[e];for(const e in o)o[e]?.dispose()}}t.transmutedDecorationTypes={}},84:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.disableLineCommand=function(e){const t=s.window.activeTextEditor;if(!t)return;let o;if(e)o=e.range[0].line;else{const n=r.extUtils.getDiagnosticAtLine(t.document.uri,t.selection.active.line);if(!n)return;o=(e=n).range.start.line}if(!e.source)return void s.window.showWarningMessage('Diagnostic has no "source".');let a=n.$config.disableLineComments[e.source]||"";if(!a)return void async function(e){const t="Show Settings";await s.window.showInformationMessage(`Comment not specified for source "${e}"`,t)===t&&i.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens disableLineComments")}(e.source);const c=a.includes("SAME_LINE");c&&(a=a.replace(/\s?SAME_LINE\s?/u,""));let g,d=r.extUtils.diagnosticToInlineMessage(a,e,0);c?g=t.document.validatePosition(new s.Position(o,1/0)):(g=o<=1?new s.Position(0,0):new s.Position(o,0),d=`${i.vscodeUtils.getIndentationAtLine(t.document,o)}${d}\n`),t.edit((e=>{e.insert(g,d)}))};const n=o(265),r=o(968),i=o(301),s=o(398)},124:(e,t,o)=>{var n=o(325);e.exports=function(){return n.Date.now()}},128:(e,t,o)=>{var n=o(800),r=/^\s+/;e.exports=function(e){return e?e.slice(0,n(e)+1).replace(r,""):e}},135:(e,t)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.utils=void 0,t.utils={truncateString(e,t){const o=[...e];return o.length>t?`${o.slice(0,t).join("")}…`:e},replaceLinebreaks:(e,t)=>e.replace(/[\n\r\t]+/gu,t),basename:e=>e.split(/[\\/]/u).pop()??"",surround:(e,t)=>`${t}${e}${t}`}},149:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.copyProblemCodeCommand=function(e){let t="";if("string"==typeof e?.code)t=e.code;else{const e=i.window.activeTextEditor;if(!e)return;const o=n.extUtils.getDiagnosticAtLine(e.document.uri,e.selection.active.line);if(!o)return;const r=n.extUtils.getDiagnosticCode(o);if(!r)return;t=r}i.env.clipboard.writeText(t),r.vscodeUtils.showTempStatusBarNotification({message:"🟩 Copied 🟩",timeout:1e3})};const n=o(968),r=o(301),i=o(398)},158:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.codeLensOnClickCommand=function(e){switch(n.$config.codeLensOnClick){case"showProblemsView":i.commands.executeCommand("workbench.actions.view.problems");break;case"showQuickFix":r.vscodeUtils.setCaretInEditor({range:e.range}),i.commands.executeCommand("editor.action.quickFix",e);break;case"searchForProblem":r.vscodeUtils.setCaretInEditor({range:e.range}),i.commands.executeCommand("errorLens.searchForProblem",e)}};const n=o(265),r=o(301),i=o(398)},217:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.getStyleForAlignment=function({isMultilineDecoration:e,alignmentKind:t,textLine:o,indentSize:i,indentStyle:s,minVisualLineLength:a,minimumMargin:c,padding:g,problemMessage:d,start:l,end:u}){let f,h="";const p=n.extUtils.getVisualLineLength(o,i,s);let m=c+a-p;if(e);else{const e=function({start:e,end:t,message:o,minimumMargin:n,padding:r,visualLineLength:i}){let s=0;if(e)s=e<=i?0:e-i;else if(t){const e=t-o.length-i-2*r[1];s=e<0?0:e}return s<n?n:s}({start:l,end:u,visualLineLength:p,message:d,minimumMargin:c,padding:g});m=e}return"fixed"===t?(f=new r.Range(o.range.start,o.range.start),h=`position:fixed;left:${m+p}ch;padding:${g[0]}ch ${g[1]}ch;margin:0`):(f=new r.Range(o.range.start.line,o.range.end.character,o.range.start.line,o.range.end.character),h=`margin:0 0 0 ${m>=0?m:0}ch;padding:${g[0]}ch ${g[1]}ch`),{range:f,styleStr:h}};const n=o(968),r=o(398)},221:(e,t,o)=>{var n=o(805),r=o(124),i=o(374),s=Math.max,a=Math.min;e.exports=function(e,t,o){var c,g,d,l,u,f,h=0,p=!1,m=!1,v=!0;if("function"!=typeof e)throw new TypeError("Expected a function");function w(t){var o=c,n=g;return c=g=void 0,h=t,l=e.apply(n,o)}function b(e){var o=e-f;return void 0===f||o>=t||o<0||m&&e-h>=d}function $(){var e=r();if(b(e))return I(e);u=setTimeout($,function(e){var o=t-(e-f);return m?a(o,d-(e-h)):o}(e))}function I(e){return u=void 0,v&&c?w(e):(c=g=void 0,l)}function C(){var e=r(),o=b(e);if(c=arguments,g=this,f=e,o){if(void 0===u)return function(e){return h=e,u=setTimeout($,t),p?w(e):l}(f);if(m)return clearTimeout(u),u=setTimeout($,t),w(f)}return void 0===u&&(u=setTimeout($,t)),l}return t=i(t)||0,n(o)&&(p=!!o.leading,d=(m="maxWait"in o)?s(i(o.maxWait)||0,t):d,v="trailing"in o?!!o.trailing:v),C.cancel=function(){void 0!==u&&clearTimeout(u),h=0,c=f=g=u=void 0},C.flush=function(){return void 0===u?l:I(r())},C}},247:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.copyProblemMessageCommand=function(e){let t="";if("string"==typeof e)t=e;else{const e=i.window.activeTextEditor;if(!e)return void i.window.showInformationMessage("No active Text Editor.");const o=n.extUtils.groupDiagnosticsByLine(i.languages.getDiagnostics(e.document.uri))[e.selection.active.line];if(!o)return void i.window.showInformationMessage("There's no problem at the active line.");const r=o[0];t=(r.source?`[${r.source}] `:"")+r.message}i.env.clipboard.writeText(t),r.vscodeUtils.showTempStatusBarNotification({message:"🟩 Copied 🟩",timeout:1e3})};const n=o(968),r=o(301),i=o(398)},265:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.$state=t.$config=void 0,t.activate=function(e){function o(){t.$config=d.workspace.getConfiguration().get("errorLens"),u.vscodeGlobalProblemsEnabled=d.workspace.getConfiguration("problems").get("visibility")??!0,u.vscodeAutosaveEnabled="afterDelay"===d.workspace.getConfiguration("files").get("autoSave"),h(),t.$config.enabled&&f(e)}u.logger=new g.Logger({isDev:!1}),o(),(0,n.registerAllCommands)(e),t.$config.onSave&&t.$config.onSaveUpdateOnActiveEditorChange&&setTimeout((()=>{(0,r.updateDecorationsForAllVisibleEditors)()}),2*t.$config.onSaveTimeout),e.subscriptions.push(d.workspace.onDidCloseTextDocument((e=>{(0,r.forgetInlineMessagesViewportLimit)(e.uri)}))),e.subscriptions.push(d.workspace.onDidChangeConfiguration((e=>{(e.affectsConfiguration("errorLens")||e.affectsConfiguration("problems.visibility")||e.affectsConfiguration("files.autoSave")||e.affectsConfiguration("editor.fontSize"))&&o()})))},t.updateEverything=f,t.disposeEverything=h,t.deactivate=function(){};const n=o(916),r=o(687),i=o(795),s=o(541),a=o(712),c=o(968),g=o(628),d=o(398),l=o(707);class u{}function f(e){u.replaceRegexp=t.$config.replace.map((e=>{return{matcher:(t=e.matcher,new RegExp(t,"iu")),message:e.message};var t})),function(){u.excludeByMessage={regexps:[],strings:[]},u.excludeSources=[],u.excludePatterns=void 0;for(const e of t.$config.excludeBySource){const t=c.extUtils.parseSourceCodeFromString(e);t.source&&u.excludeSources.push({source:t.source,code:t.code})}for(const e of t.$config.excludeByMessage||[])if("string"==typeof e)u.excludeByMessage.strings.push(e.toLocaleLowerCase());else{if(!e.regex)continue;u.excludeByMessage.regexps.push(new RegExp(e.regex,e.flags??"iu"))}Array.isArray(t.$config.excludePatterns)&&0!==t.$config.excludePatterns.length&&(u.excludePatterns=t.$config.excludePatterns.map((e=>({pattern:e}))))}(),u.renderGutterIconsAsSeparateDecoration=t.$config.gutterIconsEnabled&&t.$config.gutterIconsFollowCursorOverride&&"allLines"!==t.$config.followCursor,u.statusBarMessage?.dispose(),u.statusBarIcons?.dispose(),u.statusBarMessage=new a.StatusBarMessage({isEnabled:c.extUtils.shouldShowStatusBarMessage(),colorsEnabled:t.$config.statusBarColorsEnabled,messageType:t.$config.statusBarMessageType,priority:t.$config.statusBarMessagePriority,alignment:t.$config.statusBarMessageAlignment}),u.statusBarIcons=new s.StatusBarIcons({isEnabled:c.extUtils.shouldShowStatusBarIcons(),atZero:t.$config.statusBarIconsAtZero,useBackground:t.$config.statusBarIconsUseBackground,priority:t.$config.statusBarIconsPriority,alignment:t.$config.statusBarIconsAlignment,targetProblems:t.$config.statusBarIconsTargetProblems}),u.codeLens?.dispose(),t.$config.codeLensEnabled&&(u.codeLens=new l.ErrorLensCodeLens(e)),u.configErrorEnabled=t.$config.enabledDiagnosticLevels.includes("error"),u.configWarningEnabled=t.$config.enabledDiagnosticLevels.includes("warning"),u.configInfoEnabled=t.$config.enabledDiagnosticLevels.includes("info"),u.configHintEnabled=t.$config.enabledDiagnosticLevels.includes("hint"),u.transmuteExists=Object.keys(t.$config.transmute).length>0,(0,r.setDecorationStyle)(e),(0,r.updateDecorationsForAllVisibleEditors)(),u.statusBarIcons.updateText(),(0,i.updateChangeDiagnosticListener)(),(0,i.updateChangeVisibleTextEditorsListener)(),(0,i.updateOnSaveListener)(),(0,i.updateCursorChangeListener)(),(0,i.updateChangedActiveTextEditorListener)(),(0,i.updateChangeBreakpointsListener)(),(0,i.updateOnVisibleRangesListener)()}function h(){(0,i.disposeAllEventListeners)(),u.statusBarMessage?.dispose(),u.statusBarIcons?.dispose(),u.codeLens?.dispose(),(0,r.disposeAllDecorations)()}t.$state=u,u.configErrorEnabled=!0,u.configWarningEnabled=!0,u.configInfoEnabled=!0,u.configHintEnabled=!0,u.vscodeGlobalProblemsEnabled=!0,u.vscodeAutosaveEnabled=!1,u.replaceRegexp=void 0,u.excludeByMessage={strings:[],regexps:[]},u.excludeSources=[],u.excludePatterns=void 0,u.log=(e,...t)=>{u.logger.log(e,...t)}},301:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.vscodeUtils=void 0;const n=o(135),r=o(398);let i;t.vscodeUtils={async updateGlobalSetting(e,t){const o=r.workspace.getConfiguration();await o.update(e,t,r.ConfigurationTarget.Global)},async toggleGlobalBooleanSetting(e){const o=r.workspace.getConfiguration().get(e);void 0!==o&&await t.vscodeUtils.updateGlobalSetting(e,!o)},svgToUri:e=>r.Uri.parse(`data:image/svg+xml;utf8,${e}`),createCommandUri(e,t){const o=t?`?${encodeURIComponent(JSON.stringify(t))}`:"";return r.Uri.parse(`command:${e}${o}`)},async openSettingGuiAt(e){await r.commands.executeCommand("workbench.action.openSettings",e)},createStyledMarkdown:({strMd:e="",backgroundColor:t="var(--vscode-editorHoverWidget-background)",color:o="var(--vscode-editorHoverWidget-foreground)"})=>`<span style="${o?`color:${o};`:""}${t?`background-color:${t};`:""}">${e}</span>`,createButtonLinkMarkdown:({text:e,href:o,title:r=""})=>`<a title="${r}" href="${o}">${t.vscodeUtils.createStyledMarkdown({strMd:n.utils.surround(e,"&nbsp;"),backgroundColor:"var(--vscode-button-background)",color:"var(--vscode-button-foreground)"})}</a>`,createProblemIconMarkdown(e){const o="error"===e?"var(--vscode-editorError-foreground)":"warning"===e?"var(--vscode-editorWarning-foreground)":"var(--vscode-editorInfo-foreground)";return t.vscodeUtils.createStyledMarkdown({strMd:`$(${e})`,color:o})},async readFileVscode(e){try{const t="string"==typeof e?r.Uri.file(e):e,o=await r.workspace.fs.readFile(t);return(new TextDecoder).decode(o)}catch(e){return r.window.showErrorMessage(e.message),""}},async openFileInVscode(e){let t;return t=await r.workspace.openTextDocument(e),r.window.showTextDocument(t)},revealLine(e,t){const o=new r.Range(t,0,t,0);e.selection=new r.Selection(o.start,o.end),e.revealRange(o,r.TextEditorRevealType.AtTop);const n=r.window.createTextEditorDecorationType({backgroundColor:"#ffa30468",isWholeLine:!0});e.setDecorations(n,[o]),setTimeout((()=>{e.setDecorations(n,[]),n?.dispose()}),700)},getIndentationAtLine(e,t){const o=e.lineAt(t);return o.text.slice(0,o.firstNonWhitespaceCharacterIndex)},setCaretInEditor({editor:e,range:t}){e||(e=r.window.activeTextEditor),e&&(e.selection=new r.Selection(t.start,t.end),e.revealRange(t))},getEditorByUri(e){for(const t of r.window.visibleTextEditors)if(t.document.uri.toString(!0)===e.toString(!0))return t},showTempStatusBarNotification({message:e,timeout:t}){i?.dispose(),i=r.window.createStatusBarItem(r.StatusBarAlignment.Left,-1e5),i.text=e,i.show(),setTimeout((()=>{i?.hide(),i?.dispose()}),t)}}},314:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.updateEverythingCommand=function(e){for(const t of s.window.visibleTextEditors)"clear"===e?.kind?(0,n.clearDecorations)({editor:t}):((0,n.updateDecorationsForUri)({uri:t.document.uri,editor:t}),r.$state.statusBarMessage.updateText(t,i.extUtils.groupDiagnosticsByLine(s.languages.getDiagnostics(t.document.uri))));r.$state.statusBarIcons.updateText()};const n=o(687),r=o(265),i=o(968),s=o(398)},325:(e,t,o)=>{var n=o(840),r="object"==typeof self&&self&&self.Object===Object&&self,i=n||r||Function("return this")();e.exports=i},346:e=>{e.exports=function(e){return null!=e&&"object"==typeof e}},350:e=>{var t=Object.prototype.toString;e.exports=function(e){return t.call(e)}},374:(e,t,o)=>{var n=o(128),r=o(805),i=o(394),s=/^[-+]0x[0-9a-f]+$/i,a=/^0b[01]+$/i,c=/^0o[0-7]+$/i,g=parseInt;e.exports=function(e){if("number"==typeof e)return e;if(i(e))return NaN;if(r(e)){var t="function"==typeof e.valueOf?e.valueOf():e;e=r(t)?t+"":t}if("string"!=typeof e)return 0===e?e:+e;e=n(e);var o=a.test(e);return o||c.test(e)?g(e.slice(2),o?2:8):s.test(e)?NaN:+e}},394:(e,t,o)=>{var n=o(552),r=o(346);e.exports=function(e){return"symbol"==typeof e||r(e)&&"[object Symbol]"==n(e)}},398:e=>{"use strict";e.exports=require("vscode")},476:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.findLinterRuleDefinitionCommand=async function(e){let t=e?.source,o=e?.code;if(!e){const e=function(){const e=s.window.activeTextEditor;if(!e)return;const t=e.selection.active.line,o=s.languages.getDiagnostics(e.document.uri),n=r.extUtils.groupDiagnosticsByLine(o);return n[t]?.[0]}();e&&(o=r.extUtils.getDiagnosticCode(e),t=e.source)}if(!t)return void s.window.showWarningMessage('Diagnostic has no "source".');if(!o)return void s.window.showWarningMessage('Diagnostic has no "code".');const g=n.$config.lintFilePaths[t];if("none"===g)return;if(!g)return void a(`No linter files specified for source: "${t}".`);const d=[];for(const e of g)d.push(s.workspace.findFiles(e,"**/node_modules/**",10));const l=(await Promise.all(d)).flat();if(!l.length)return void a(`No linter files found that match any of the globs: ${JSON.stringify(l)}.`);const u=[];for(const e of l){const t=await i.vscodeUtils.readFileVscode(e.fsPath);t.includes(o)&&u.push({fileContents:t,linterFilePath:e})}if(!u.length){const e=`No linter file with "${o}" found.`;if(1===l.length){!async function(e,t){const o="Search",n="Open Setting",r=await s.window.showWarningMessage(e,n,o);r===n?i.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens lintFilePaths"):r===o&&s.commands.executeCommand("workbench.action.findInFiles",{query:t,isRegex:!1,triggerSearch:!0,excludeSettingAndIgnoreFiles:!0})}(e,o);const t=await i.vscodeUtils.openFileInVscode(l[0]);i.vscodeUtils.revealLine(t,0)}else{const t=await s.window.showQuickPick(l.map((e=>e.fsPath)),{title:e});t&&i.vscodeUtils.openFileInVscode(t)}return}if(1===u.length){const e=u[0];return void await c(e.linterFilePath.fsPath,e.fileContents,o)}const f=await s.window.showQuickPick(u.map((e=>({label:e.linterFilePath.fsPath,linterFilePath:e.linterFilePath,fileContents:e.fileContents}))),{title:`"${o}" is found in multiple files:`});f&&c(f.linterFilePath,f.fileContents,o)};const n=o(265),r=o(968),i=o(301),s=o(398);async function a(e){const t="Open Setting";await s.window.showWarningMessage(e,t)===t&&i.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens lintFilePaths")}async function c(e,t,o){const n=await i.vscodeUtils.openFileInVscode(e),r=function(e,t){const o=e.split("\n");for(let e=0;e<o.length;e++)if(o[e].includes(t))return e}(t,o);r&&i.vscodeUtils.revealLine(n,r)}},477:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.toggleWorkspaceCommand=async function(){const e=i.window.activeTextEditor;let t,o;e?(t=i.workspace.getWorkspaceFolder(e?.document?.uri)?.uri.fsPath,t||i.window.showWarningMessage(`Counldn't find workspace folder for "${e.document.uri.toString()}".`)):(t=await async function(){const e=i.workspace.workspaceFolders;if(e?.length)return 1===e.length?e[0].uri.fsPath:await i.window.showQuickPick(e.map((e=>e.uri.fsPath)),{title:"Pick workspace folder to include/exclude:"})}(),t||i.window.showWarningMessage("No opened/picked workspace folder.")),t&&(n.$config.excludeWorkspaces?.includes(t)?(o=n.$config.excludeWorkspaces.filter((e=>e!==t)),s(`"${t}" - Removed from "errorLens.excludeWorkspaces"`)):(o=[...n.$config.excludeWorkspaces||[],t],s(`"${t}" - Added to "errorLens.excludeWorkspaces" (now ignored)`)),r.vscodeUtils.updateGlobalSetting("errorLens.excludeWorkspaces",o))};const n=o(265),r=o(301),i=o(398);async function s(e){await i.window.showInformationMessage(e,"Open Settings UI")&&r.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens excludeWorkspaces")}},517:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.getGutterStyles=function(e){const t={};return t.iconSet=r.$config.gutterIconSet,"circle"===r.$config.gutterIconSet?(t.errorIconPath=i.vscodeUtils.svgToUri(a(r.$config.errorGutterIconColor)),t.errorIconPathLight=i.vscodeUtils.svgToUri(a(r.$config.light.errorGutterIconColor||r.$config.errorGutterIconColor)),t.warningIconPath=i.vscodeUtils.svgToUri(a(r.$config.warningGutterIconColor)),t.warningIconPathLight=i.vscodeUtils.svgToUri(a(r.$config.light.warningGutterIconColor||r.$config.warningGutterIconColor)),t.infoIconPath=i.vscodeUtils.svgToUri(a(r.$config.infoGutterIconColor)),t.infoIconPathLight=i.vscodeUtils.svgToUri(a(r.$config.light.infoGutterIconColor||r.$config.infoGutterIconColor)),t.hintIconPath=i.vscodeUtils.svgToUri(a(r.$config.hintGutterIconColor)),t.hintIconPathLight=i.vscodeUtils.svgToUri(a(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconColor))):"square"===r.$config.gutterIconSet?(t.errorIconPath=i.vscodeUtils.svgToUri(c(r.$config.errorGutterIconColor)),t.errorIconPathLight=i.vscodeUtils.svgToUri(c(r.$config.light.errorGutterIconColor||r.$config.errorGutterIconColor)),t.warningIconPath=i.vscodeUtils.svgToUri(c(r.$config.warningGutterIconColor)),t.warningIconPathLight=i.vscodeUtils.svgToUri(c(r.$config.light.warningGutterIconColor||r.$config.warningGutterIconColor)),t.infoIconPath=i.vscodeUtils.svgToUri(c(r.$config.infoGutterIconColor)),t.infoIconPathLight=i.vscodeUtils.svgToUri(c(r.$config.light.infoGutterIconColor||r.$config.infoGutterIconColor)),t.hintIconPath=i.vscodeUtils.svgToUri(c(r.$config.hintGutterIconColor)),t.hintIconPathLight=i.vscodeUtils.svgToUri(c(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconColor))):"squareRounded"===r.$config.gutterIconSet?(t.errorIconPath=i.vscodeUtils.svgToUri(g(r.$config.errorGutterIconColor)),t.errorIconPathLight=i.vscodeUtils.svgToUri(g(r.$config.light.errorGutterIconColor||r.$config.errorGutterIconColor)),t.warningIconPath=i.vscodeUtils.svgToUri(g(r.$config.warningGutterIconColor)),t.warningIconPathLight=i.vscodeUtils.svgToUri(g(r.$config.light.warningGutterIconColor||r.$config.warningGutterIconColor)),t.infoIconPath=i.vscodeUtils.svgToUri(g(r.$config.infoGutterIconColor)),t.infoIconPathLight=i.vscodeUtils.svgToUri(g(r.$config.light.infoGutterIconColor||r.$config.infoGutterIconColor)),t.hintIconPath=i.vscodeUtils.svgToUri(g(r.$config.hintGutterIconColor)),t.hintIconPathLight=i.vscodeUtils.svgToUri(g(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconColor))):"letter"===r.$config.gutterIconSet?(t.errorIconPath=i.vscodeUtils.svgToUri(l(r.$config.errorGutterIconColor,"E")),t.errorIconPathLight=i.vscodeUtils.svgToUri(l(r.$config.light.errorGutterIconColor||r.$config.errorGutterIconColor,"E")),t.warningIconPath=i.vscodeUtils.svgToUri(l(r.$config.warningGutterIconColor,"W")),t.warningIconPathLight=i.vscodeUtils.svgToUri(l(r.$config.light.warningGutterIconColor||r.$config.warningGutterIconColor,"W")),t.infoIconPath=i.vscodeUtils.svgToUri(l(r.$config.infoGutterIconColor,"I")),t.infoIconPathLight=i.vscodeUtils.svgToUri(l(r.$config.light.infoGutterIconColor||r.$config.infoGutterIconColor,"I")),t.hintIconPath=i.vscodeUtils.svgToUri(l(r.$config.hintGutterIconColor,"H")),t.hintIconPathLight=i.vscodeUtils.svgToUri(l(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconColor,"H"))):"emoji"===r.$config.gutterIconSet?(t.errorIconPath=i.vscodeUtils.svgToUri(u(r.$config.errorGutterIconColor,r.$config.gutterEmoji.error)),t.errorIconPathLight=i.vscodeUtils.svgToUri(u(r.$config.light.errorGutterIconColor||r.$config.errorGutterIconColor,r.$config.gutterEmoji.error)),t.warningIconPath=i.vscodeUtils.svgToUri(u(r.$config.warningGutterIconColor,r.$config.gutterEmoji.warning)),t.warningIconPathLight=i.vscodeUtils.svgToUri(u(r.$config.light.warningGutterIconColor||r.$config.warningGutterIconColor,r.$config.gutterEmoji.warning)),t.infoIconPath=i.vscodeUtils.svgToUri(u(r.$config.infoGutterIconColor,r.$config.gutterEmoji.info)),t.infoIconPathLight=i.vscodeUtils.svgToUri(u(r.$config.light.infoGutterIconColor||r.$config.infoGutterIconColor,r.$config.gutterEmoji.info)),t.hintIconPath=i.vscodeUtils.svgToUri(u(r.$config.hintGutterIconColor,r.$config.gutterEmoji.hint)),t.hintIconPathLight=i.vscodeUtils.svgToUri(u(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconColor,r.$config.gutterEmoji.hint))):(t.errorIconPath=e.asAbsolutePath(`./img/${t.iconSet}/error-dark.svg`),t.errorIconPathLight=e.asAbsolutePath(`./img/${t.iconSet}/error-light.svg`),t.warningIconPath=e.asAbsolutePath(`./img/${t.iconSet}/warning-dark.svg`),t.warningIconPathLight=e.asAbsolutePath(`./img/${t.iconSet}/warning-light.svg`),t.infoIconPath=e.asAbsolutePath(`./img/${t.iconSet}/info-dark.svg`),t.infoIconPathLight=e.asAbsolutePath(`./img/${t.iconSet}/info-light.svg`),t.hintIconPath=e.asAbsolutePath(`./img/${t.iconSet}/hint-dark.svg`),t.hintIconPathLight=e.asAbsolutePath(`./img/${t.iconSet}/hint-light.svg`)),r.$config.errorGutterIconPath&&(t.errorIconPath=r.$config.errorGutterIconPath),(r.$config.light.errorGutterIconPath||r.$config.errorGutterIconPath)&&(t.errorIconPathLight=r.$config.light.errorGutterIconPath||r.$config.errorGutterIconPath),r.$config.warningGutterIconPath&&(t.warningIconPath=r.$config.warningGutterIconPath),(r.$config.light.warningGutterIconPath||r.$config.warningGutterIconPath)&&(t.warningIconPathLight=r.$config.light.warningGutterIconColor||r.$config.warningGutterIconPath),r.$config.infoGutterIconPath&&(t.infoIconPath=r.$config.infoGutterIconPath),(r.$config.light.infoGutterIconPath||r.$config.infoGutterIconPath)&&(t.infoIconPathLight=r.$config.light.infoGutterIconColor||r.$config.infoGutterIconPath),r.$config.hintGutterIconPath&&(t.hintIconPath=r.$config.hintGutterIconPath),(r.$config.light.hintGutterIconPath||r.$config.hintGutterIconPath)&&(t.hintIconPathLight=r.$config.light.hintGutterIconColor||r.$config.hintGutterIconPath),{errorIconPath:t.errorIconPath,errorIconPathLight:t.errorIconPathLight,warningIconPath:t.warningIconPath,warningIconPathLight:t.warningIconPathLight,infoIconPath:t.infoIconPath,infoIconPathLight:t.infoIconPathLight,hintIconPath:t.hintIconPath,hintIconPathLight:t.hintIconPathLight,iconSet:t.iconSet,transparent1x1Icon:s.Uri.parse("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")}},t.doUpdateGutterDecorations=function(e,t){const o=[],i=[],a=[],c=[];for(const e in t){const n=t[e][0],g=n.severity,d={range:n.range};switch(g){case s.DiagnosticSeverity.Error:o.push(d);break;case s.DiagnosticSeverity.Warning:i.push(d);break;case s.DiagnosticSeverity.Information:a.push(d);break;case s.DiagnosticSeverity.Hint:"circle"!==r.$config.gutterIconSet&&"square"!==r.$config.gutterIconSet&&"squareRounded"!==r.$config.gutterIconSet&&"letter"!==r.$config.gutterIconSet&&"emoji"!==r.$config.gutterIconSet||c.push(d)}}e.setDecorations(n.decorationTypes.gutterError,o),e.setDecorations(n.decorationTypes.gutterWarning,i),e.setDecorations(n.decorationTypes.gutterInfo,a),e.setDecorations(n.decorationTypes.gutterHint,c)},t.updateWorkaroundGutterIcon=function(e){const t=[];for(const o of s.debug.breakpoints){const n=o?.location;n&&n.uri.toString(!0)===e?.document.uri.toString(!0)&&t.push(n.range)}e.setDecorations(n.decorationTypes.transparent1x1Icon,t)};const n=o(687),r=o(265),i=o(301),s=o(398);function a(e){return`<svg xmlns="http://www.w3.org/2000/svg" height="30" width="30"><circle cx="15" cy="15" r="7" fill="${f(e)}"/></svg>`}function c(e,t=0){return`<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" height="40" width="40"><g transform="translate(12, 12)"><rect width="16" height="16" rx="${t}" fill="${f(e)}"/></g></svg>`}function g(e){return c(e,3)}let d="";function l(e,t){return d=d||(s.workspace.getConfiguration("editor").get("fontFamily")??""),`<svg viewBox="-10 -6 20 10" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="${f(e)}"><text font-family="${d}" text-anchor="middle" dominant-baseline="middle">${t}</text></svg>`}function u(e,t){return d=d||(s.workspace.getConfiguration("editor").get("fontFamily")??""),`<svg viewBox="-10 -6 20 10" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text fill="${f(e)}" font-family="${d}" text-anchor="middle" dominant-baseline="middle">${t}</text></svg>`}function f(e){return`%23${e.slice(1)}`}},541:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.StatusBarIcons=void 0;const n=o(968),r=o(135),i=o(398);t.StatusBarIcons=class{constructor({isEnabled:e,atZero:t,useBackground:o,priority:n,alignment:r,targetProblems:s}){this.errorBackgroundThemeColor=new i.ThemeColor("statusBarItem.errorBackground"),this.warningBackgroundThemeColor=new i.ThemeColor("statusBarItem.warningBackground"),this.errorForegroundThemeColor=new i.ThemeColor("errorLens.statusBarIconErrorForeground"),this.warningForegroundThemeColor=new i.ThemeColor("errorLens.statusBarIconWarningForeground"),this.isEnabled=e,this.atZero=t,this.useBackground=o,this.targetProblems=s;const a="right"===r?i.StatusBarAlignment.Right:i.StatusBarAlignment.Left;this.errorStatusBarItem=i.window.createStatusBarItem("errorLensError",a,n),this.errorStatusBarItem.name="Error Lens: Error icon",this.errorStatusBarItem.command="workbench.actions.view.problems",this.warningStatusBarItem=i.window.createStatusBarItem("errorLensWarning",a,n-1),this.warningStatusBarItem.name="Error Lens: Warning icon",this.warningStatusBarItem.command="workbench.actions.view.problems",this.setBackground("error"),this.setForeground("error"),this.setBackground("warning"),this.setForeground("warning"),this.isEnabled?(this.errorStatusBarItem.show(),this.warningStatusBarItem.show()):this.dispose()}updateText(){if(!this.isEnabled)return;const e=[],t=[];let o=0,r=0;const i=n.extUtils.getDiagnostics({target:this.targetProblems});for(const n of i){const i=n.uri,s=n.diagnostics,a=[],c=[];for(const e of s)0===e.severity?a.push(e):1===e.severity&&c.push(e);o+=a.length,r+=c.length,a.length&&e.push([i,a]),c.length&&t.push([i,c])}0===o?"hide"===this.atZero?this.errorStatusBarItem.text="":(this.clearBackground("error"),this.clearForeground("error"),this.errorStatusBarItem.text=`$(error) ${o}`,this.errorStatusBarItem.tooltip=this.makeTooltip(e,"error")):(this.setBackground("error"),this.setForeground("error"),this.errorStatusBarItem.text=`$(error) ${o}`,this.errorStatusBarItem.tooltip=this.makeTooltip(e,"error")),0===r?"hide"===this.atZero?this.warningStatusBarItem.text="":(this.clearBackground("warning"),this.clearForeground("warning"),this.warningStatusBarItem.text=`$(warning) ${r}`,this.warningStatusBarItem.tooltip=this.makeTooltip(t,"warning")):(this.setBackground("warning"),this.setForeground("warning"),this.warningStatusBarItem.text=`$(warning) ${r}`,this.warningStatusBarItem.tooltip=this.makeTooltip(t,"warning"))}dispose(){this.errorStatusBarItem.dispose(),this.warningStatusBarItem.dispose()}makeTooltip(e,t){const o=new i.MarkdownString(void 0,!0);o.isTrusted=!0;for(const n of e){const e=n[0],s=n[1];s.length&&o.appendMarkdown(`**${r.utils.basename(e.path)}** (${s.length})\n\n`);for(const n of s){const r=i.Uri.parse(`command:errorLens.revealLine?${encodeURIComponent(JSON.stringify([e.fsPath,[n.range.start.line,n.range.start.character]]))}`);o.appendMarkdown(`<span style="color:${"error"===t?"var(--vscode-editorError-foreground)":"var(--vscode-editorWarning-foreground)"};">$(${t})</span> [${n.message} \`${n.source??"<No source>"}\`](${r.toString()})\n\n`)}}return o}setForeground(e){"error"===e?this.errorStatusBarItem.color=this.errorForegroundThemeColor:"warning"===e&&(this.warningStatusBarItem.color=this.warningForegroundThemeColor)}clearForeground(e){"error"===e?this.errorStatusBarItem.color=void 0:"warning"===e&&(this.warningStatusBarItem.color=void 0)}setBackground(e){this.useBackground&&("error"===e?this.errorStatusBarItem.backgroundColor=this.errorBackgroundThemeColor:"warning"===e&&(this.warningStatusBarItem.backgroundColor=this.warningBackgroundThemeColor))}clearBackground(e){"error"===e?this.errorStatusBarItem.backgroundColor=void 0:"warning"===e&&(this.warningStatusBarItem.backgroundColor=void 0)}}},552:(e,t,o)=>{var n=o(873),r=o(659),i=o(350),s=n?n.toStringTag:void 0;e.exports=function(e){return null==e?void 0===e?"[object Undefined]":"[object Null]":s&&s in Object(e)?r(e):i(e)}},559:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.revealLineCommand=async function(e,[t,o]){const r=new n.Range(t,o,t,o),i=await n.workspace.openTextDocument(e),s=await n.window.showTextDocument(i);s.revealRange(r),s.selection=new n.Selection(r.start.line,r.start.character,r.start.line,r.start.character)};const n=o(398)},563:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.createHoverForDiagnostic=function({diagnostic:e,messageEnabled:t,buttonsEnabled:o,sourceCodeEnabled:s,lintFilePaths:a}){if(!t&&!o&&!s)return;const c=new i.MarkdownString(void 0,!0);c.supportHtml=!0,c.isTrusted=!0;const g=n.extUtils.getDiagnosticTarget(e),d=n.extUtils.getDiagnosticCode(e);if(t){const t=r.vscodeUtils.createProblemIconMarkdown(0===e.severity?"error":1===e.severity?"warning":"info");c.appendMarkdown("<table>"),c.appendMarkdown("<tr>"),c.appendMarkdown(`<td>${t}</td>`),c.appendMarkdown("<td>"),c.appendMarkdown("\n\n"),c.appendCodeblock(e.message,"plaintext"),c.appendMarkdown("\n\n"),c.appendMarkdown("</td>"),c.appendMarkdown("</tr>"),c.appendMarkdown("</table>")}if(s){const t=r.vscodeUtils.createButtonLinkMarkdown({text:"$(clippy) Copy code",href:r.vscodeUtils.createCommandUri("errorLens.copyProblemCode",{code:d}).toString(),title:"Copy problem code into the clipboard."}),o=r.vscodeUtils.createButtonLinkMarkdown({text:"$(clippy) Copy message",href:r.vscodeUtils.createCommandUri("errorLens.copyProblemMessage",e.message??"").toString(),title:"Copy problem mesage into the clipboard."});c.appendMarkdown("\n\n"),c.appendMarkdown(`${e.source??"<No source>"}(\`${d??"<No code>"}\`) `),c.appendMarkdown(o),c.appendMarkdown("&nbsp;".repeat(2)),d&&c.appendMarkdown(t)}if(o){const t=r.vscodeUtils.createButtonLinkMarkdown({text:"$(exclude) Exclude",href:r.vscodeUtils.createCommandUri("errorLens.excludeProblem",e).toString(),title:"Exclude problem from Error Lens by source/code"}),o=r.vscodeUtils.createButtonLinkMarkdown({text:"$(file) Definition",href:r.vscodeUtils.createCommandUri("errorLens.findLinterRuleDefinition",{source:e.source,code:d}).toString(),title:"Open diagnostic definition (linter file)."}),n=r.vscodeUtils.createButtonLinkMarkdown({text:"$(search) Search",href:r.vscodeUtils.createCommandUri("errorLens.searchForProblem",e).toString(),title:"Open problem in default browser (controlled by `errorLens.searchForProblemQuery` setting)."}),i=r.vscodeUtils.createButtonLinkMarkdown({text:"$(arrow-circle-up) Disable line",href:r.vscodeUtils.createCommandUri("errorLens.disableLine",e).toString(),title:"Add comment to disable linter rule for this line."});c.appendMarkdown("\n\n"),c.appendMarkdown(t);const s="none"!==a[String(e?.source)];if(s&&(c.appendMarkdown("&nbsp;".repeat(2)),c.appendMarkdown(o)),g){c.appendMarkdown("&nbsp;".repeat(2));const e=r.vscodeUtils.createButtonLinkMarkdown({text:"$(book) Docs",href:r.vscodeUtils.createCommandUri("vscode.open",g).toString(),title:"Open diagnostic code or search it in default browser."});c.appendMarkdown(e)}c.appendMarkdown("&nbsp;".repeat(2)),c.appendMarkdown(n),s&&(c.appendMarkdown("&nbsp;".repeat(2)),c.appendMarkdown(i))}return c};const n=o(968),r=o(301),i=o(398)},572:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.searchForProblemCommand=function(e){if(!e){const t=i.window.activeTextEditor;if(!t)return;const o=r.extUtils.getDiagnosticAtLine(t.document.uri,t.selection.active.line);if(!o)return;e=o}const t=r.extUtils.diagnosticToInlineMessage(n.$config.searchForProblemQuery,e,0);i.env.openExternal(i.Uri.parse(t))};const n=o(265),r=o(968),i=o(398)},573:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.excludeProblemCommand=async function(e){if(!e){const t=s.window.activeTextEditor;if(!t)return void s.window.showInformationMessage("No active Text Editor.");const o=r.extUtils.getDiagnosticAtLine(t.document.uri,t.selection.active.line);if(!o)return void s.window.showInformationMessage("There's no problem at the active line.");e=o}const t=r.extUtils.getDiagnosticCode(e),o=e.source;if(!o)return void a('Diagnostic has no "source".',e);if(!t)return void a('Diagnostic has no "code".',e);const c=r.extUtils.diagnosticToSourceCodeString(o,t);n.$config.excludeBySource.includes(c)||(await i.vscodeUtils.updateGlobalSetting("errorLens.excludeBySource",[...n.$config.excludeBySource,c]),async function(e){const t="Open Setting";await s.window.showInformationMessage(`Excluded problem by source+code: "${e}"`,t)===t&&i.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens excludeBySource")}(c))};const n=o(265),r=o(968),i=o(301),s=o(398);async function a(e,t){const o=await s.window.showInputBox({title:`${e}: Exclude by message:`,value:t.message});o&&(n.$config.excludeByMessage.includes(o)||(await i.vscodeUtils.updateGlobalSetting("errorLens.excludeByMessage",[...n.$config.excludeByMessage,o]),async function(e){const t="Open Setting";await s.window.showInformationMessage(`Excluded problem by message: "${e}"`,t)===t&&i.vscodeUtils.openSettingGuiAt("@ext:usernamehw.errorlens errorLens.excludeByMessage")}(o)))}},628:(e,t)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.Logger=void 0,t.Logger=class{constructor({isDev:e}){this.isEnabled=e}log(e,...t){this.innerLog("log",e,...t)}warn(e,...t){this.innerLog("warn",e,...t)}innerLog(e,t,...o){this.isEnabled&&(o.length?console[e](t,o):console[e](t))}}},659:(e,t,o)=>{var n=o(873),r=Object.prototype,i=r.hasOwnProperty,s=r.toString,a=n?n.toStringTag:void 0;e.exports=function(e){var t=i.call(e,a),o=e[a];try{e[a]=void 0;var n=!0}catch(e){}var r=s.call(e);return n&&(t?e[a]=o:delete e[a]),r}},687:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.decorationRenderOptions=t.decorationTypes=void 0,t.setDecorationStyle=function(e){let o;$(),c.extUtils.shouldShowGutterIcons()&&(o=(0,i.getGutterStyles)(e),r.$state.renderGutterIconsAsSeparateDecoration&&(t.decorationTypes.gutterError=l.window.createTextEditorDecorationType({gutterIconPath:o.errorIconPath,gutterIconSize:r.$config.gutterIconSize,light:{gutterIconPath:o.errorIconPathLight,gutterIconSize:r.$config.gutterIconSize}}),t.decorationTypes.gutterWarning=l.window.createTextEditorDecorationType({gutterIconPath:o.warningIconPath,gutterIconSize:r.$config.gutterIconSize,light:{gutterIconPath:o.warningIconPathLight,gutterIconSize:r.$config.gutterIconSize}}),t.decorationTypes.gutterInfo=l.window.createTextEditorDecorationType({gutterIconPath:o.infoIconPath,gutterIconSize:r.$config.gutterIconSize,light:{gutterIconPath:o.infoIconPathLight,gutterIconSize:r.$config.gutterIconSize}}),t.decorationTypes.gutterHint=l.window.createTextEditorDecorationType({gutterIconPath:o.hintIconPath,gutterIconSize:r.$config.gutterIconSize,light:{gutterIconPath:o.hintIconPathLight,gutterIconSize:r.$config.gutterIconSize}}),o=void 0));let n=new l.ThemeColor("errorLens.errorBackground"),s=new l.ThemeColor("errorLens.errorBackgroundLight");const g=new l.ThemeColor("errorLens.errorForeground"),d=new l.ThemeColor("errorLens.errorForegroundLight");let f=new l.ThemeColor("errorLens.errorMessageBackground"),h=new l.ThemeColor("errorLens.warningBackground"),p=new l.ThemeColor("errorLens.warningBackgroundLight");const m=new l.ThemeColor("errorLens.warningForeground"),v=new l.ThemeColor("errorLens.warningForegroundLight");let w=new l.ThemeColor("errorLens.warningMessageBackground"),b=new l.ThemeColor("errorLens.infoBackground"),I=new l.ThemeColor("errorLens.infoBackgroundLight");const C=new l.ThemeColor("errorLens.infoForeground"),x=new l.ThemeColor("errorLens.infoForegroundLight");let y=new l.ThemeColor("errorLens.infoMessageBackground"),S=new l.ThemeColor("errorLens.hintBackground"),T=new l.ThemeColor("errorLens.hintBackgroundLight");const L=new l.ThemeColor("errorLens.hintForeground"),D=new l.ThemeColor("errorLens.hintForegroundLight");let P=new l.ThemeColor("errorLens.hintMessageBackground");const E=new l.ThemeColor("errorLens.statusBarErrorForeground"),M=new l.ThemeColor("errorLens.statusBarWarningForeground"),U=new l.ThemeColor("errorLens.statusBarInfoForeground"),k=new l.ThemeColor("errorLens.statusBarHintForeground");"line"===r.$config.messageBackgroundMode?(f=void 0,w=void 0,y=void 0,P=void 0):"message"===r.$config.messageBackgroundMode?(n=void 0,s=void 0,h=void 0,p=void 0,b=void 0,I=void 0,S=void 0,T=void 0):"none"===r.$config.messageBackgroundMode&&(n=void 0,s=void 0,h=void 0,p=void 0,b=void 0,I=void 0,S=void 0,T=void 0,f=void 0,w=void 0,y=void 0,P=void 0);const B=r.$config.fontFamily?`font-family: ${r.$config.fontFamily}`:"",G=r.$config.padding?`padding: ${c.extUtils.addPxUnitsIfNeeded(r.$config.padding)}`:"",A=`border-radius: ${r.$config.borderRadius||"0"}`,O=r.$config.scrollbarHackEnabled?"position:absolute;pointer-events:none;top:50%;transform:translateY(-50%);":"";let F=r.$config.fontSize?`font-size: ${c.extUtils.addPxUnitsIfNeeded(r.$config.fontSize)}`:"";r.$config.fontSize.startsWith("-")&&(F=`font-size: ${(l.workspace.getConfiguration("editor").get("fontSize")||14)+(parseFloat(r.$config.fontSize)||0)}px`),u=`none;${B};${F};${A}`;const R={fontStyle:r.$config.fontStyleItalic?"italic":"normal",fontWeight:r.$config.fontWeight,margin:r.$config.margin?`0 0 0 ${c.extUtils.addPxUnitsIfNeeded(r.$config.margin)}`:"",textDecoration:`${u};${G};${O}`},_={backgroundColor:n,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.errorIconPath,after:{...R,border:r.$config.border?.[l.DiagnosticSeverity.Error]?r.$config.border[l.DiagnosticSeverity.Error]:void 0,color:g,backgroundColor:f,...r.$config.decorations?.errorMessage},light:{backgroundColor:s,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.errorIconPathLight,after:{color:d,...r.$config.decorations?.errorMessage,...r.$config.decorations?.errorMessage?.light}},isWholeLine:!0},j={backgroundColor:h,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.warningIconPath,after:{...R,border:r.$config.border?.[l.DiagnosticSeverity.Warning]?r.$config.border[l.DiagnosticSeverity.Warning]:void 0,color:m,backgroundColor:w,...r.$config.decorations?.warningMessage},light:{backgroundColor:p,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.warningIconPathLight,after:{color:v,...r.$config.decorations?.warningMessage,...r.$config.decorations?.warningMessage?.light}},isWholeLine:!0},W={backgroundColor:b,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.infoIconPath,after:{...R,border:r.$config.border?.[l.DiagnosticSeverity.Information]?r.$config.border[l.DiagnosticSeverity.Information]:void 0,color:C,backgroundColor:y,...r.$config.decorations?.infoMessage},light:{backgroundColor:I,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.infoIconPathLight,after:{color:x,...r.$config.decorations?.infoMessage,...r.$config.decorations?.infoMessage?.light}},isWholeLine:!0},V={backgroundColor:S,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.hintIconPath,after:{...R,border:r.$config.border?.[l.DiagnosticSeverity.Hint]?r.$config.border[l.DiagnosticSeverity.Hint]:void 0,color:L,backgroundColor:P,...r.$config.decorations?.hintMessage},light:{backgroundColor:T,gutterIconSize:r.$config.gutterIconSize,gutterIconPath:o?.hintIconPathLight,after:{color:D,...r.$config.decorations?.hintMessage,...r.$config.decorations?.hintMessage?.light}},isWholeLine:!0};c.extUtils.shouldShowInlineMessage()||(_.backgroundColor=void 0,_.after=void 0,_.light.backgroundColor=void 0,_.light.after=void 0,j.backgroundColor=void 0,j.after=void 0,j.light.backgroundColor=void 0,j.light.after=void 0,W.backgroundColor=void 0,W.after=void 0,W.light.backgroundColor=void 0,W.light.after=void 0,V.backgroundColor=void 0,V.after=void 0,V.light.backgroundColor=void 0,V.light.after=void 0),t.decorationTypes.error=l.window.createTextEditorDecorationType(_),t.decorationTypes.warning=l.window.createTextEditorDecorationType(j),t.decorationTypes.info=l.window.createTextEditorDecorationType(W),t.decorationTypes.hint=l.window.createTextEditorDecorationType(V),t.decorationRenderOptions.error=_,t.decorationRenderOptions.warning=j,t.decorationRenderOptions.info=W,t.decorationRenderOptions.hint=V,r.$state.transmuteExists&&(0,a.setTransmutedDecorationStyle)(t.decorationRenderOptions),t.decorationTypes.errorRange=l.window.createTextEditorDecorationType({backgroundColor:new l.ThemeColor("errorLens.errorRangeBackground"),rangeBehavior:l.DecorationRangeBehavior.ClosedClosed,...r.$config.decorations.errorRange}),t.decorationTypes.warningRange=l.window.createTextEditorDecorationType({backgroundColor:new l.ThemeColor("errorLens.warningRangeBackground"),rangeBehavior:l.DecorationRangeBehavior.ClosedClosed,...r.$config.decorations.warningRange}),t.decorationTypes.infoRange=l.window.createTextEditorDecorationType({backgroundColor:new l.ThemeColor("errorLens.infoRangeBackground"),rangeBehavior:l.DecorationRangeBehavior.ClosedClosed,...r.$config.decorations.infoRange}),t.decorationTypes.hintRange=l.window.createTextEditorDecorationType({backgroundColor:new l.ThemeColor("errorLens.hintRangeBackground"),rangeBehavior:l.DecorationRangeBehavior.ClosedClosed,...r.$config.decorations.hintRange});const N={gutterIconPath:o?.transparent1x1Icon,light:{gutterIconPath:o?.transparent1x1Icon}};t.decorationTypes.transparent1x1Icon=l.window.createTextEditorDecorationType(N),r.$state.statusBarMessage.statusBarColors=[E,M,U,k]},t.clearDecorations=m,t.isInlineMessagesLimitedToViewport=function(e){return f.has(e.toString(!0))},t.forgetInlineMessagesViewportLimit=function(e){const t=e.toString(!0);f.delete(t),h.delete(t)},t.updateDecorationsForAllVisibleEditors=function(){if(!r.$config.onSave||r.$config.onSaveUpdateOnActiveEditorChange)for(const e of l.window.visibleTextEditors)r.$state.log("updateDecorationsForAllVisibleEditors()"),b({uri:e.document.uri,editor:e})},t.updateDecorationsForUri=b,t.disposeAllDecorations=$;const n=o(217),r=o(265),i=o(517),s=o(563),a=o(83),c=o(968),g=o(135),d=o(301),l=o(398);t.decorationTypes={},t.decorationRenderOptions={};let u="";const f=new Set,h=new Set,p=100;function m({editor:e}){e&&v({editor:e,groupedDiagnostics:{}})}function v({editor:e,groupedDiagnostics:o,range:m,isViewportRefresh:v}){r.$state.log("doUpdateDecorations()",e.document.uri.toString(!0));const b=[],$=[],I=[],C=[],x=[],y=[],S=[],T=[];let L;if("closestProblem"===r.$config.followCursor){void 0===m&&(m=e.selection);const t=m.start.line,n=Object.entries(o).sort(((e,o)=>Math.abs(t-Number(e[0]))-Math.abs(t-Number(o[0]))));n.length=r.$config.followCursorMore+1,L=n.map((e=>e[1][0].range.start.line))}for(const t in o){const i=o[t],a=i[0];if(!a)continue;const d=a.severity;let f;const h=c.extUtils.prepareMessage({diagnostic:a,template:r.$config.messageTemplate,lineProblemCount:i.length,removeLinebreaks:r.$config.removeLinebreaks,replaceLinebreaksSymbol:r.$config.replaceLinebreaksSymbol});f=c.extUtils.shouldShowInlineMessage()?h:void 0;let p,v="";if(c.extUtils.shouldAlign()){const o=(0,n.getStyleForAlignment)({isMultilineDecoration:!1,alignmentKind:r.$config.alignMessage.useFixedPosition?"fixed":"normal",textLine:e.document.lineAt(Number(t)),indentSize:e.options.tabSize,indentStyle:e.options.insertSpaces?"spaces":"tab",minimumMargin:r.$config.alignMessage.minimumMargin,padding:r.$config.alignMessage.padding,minVisualLineLength:r.$config.alignMessage.start,start:r.$config.alignMessage.start,end:r.$config.alignMessage.end,problemMessage:f??""});v=o.styleStr,p=o.range,r.$config.alignMessage.start&&r.$config.alignMessage.end&&(f=g.utils.truncateString(f??"",r.$config.alignMessage.end-r.$config.alignMessage.start-1))}const w={after:{contentText:f,textDecoration:c.extUtils.shouldAlign()?`${u};${v}`:void 0}};let D;if("allLines"===r.$config.followCursor)D=a.range;else{void 0===m&&(m=e.selection);const t=a.range;if("activeLine"===r.$config.followCursor){const e=m.start.line-r.$config.followCursorMore,o=m.end.line+r.$config.followCursorMore;t.start.line>=e&&t.start.line<=o&&(D=t)}else"allLinesExceptActive"===r.$config.followCursor?D=t.start.line===m.start.line?void 0:t:"closestProblem"===r.$config.followCursor&&L.includes(t.start.line)&&(D=t);if(!D)continue}const P={range:p??new l.Range(D.start.line,D.start.character,D.start.line,D.start.character),hoverMessage:(0,s.createHoverForDiagnostic)({diagnostic:a,buttonsEnabled:r.$config.editorHoverPartsEnabled.buttonsEnabled,messageEnabled:r.$config.editorHoverPartsEnabled.messageEnabled,sourceCodeEnabled:r.$config.editorHoverPartsEnabled.sourceCodeEnabled,lintFilePaths:r.$config.lintFilePaths}),renderOptions:w};switch(d){case l.DiagnosticSeverity.Error:b.push({options:P,diagnostic:a}),r.$config.problemRangeDecorationEnabled&&x.push({range:D});break;case l.DiagnosticSeverity.Warning:$.push({options:P,diagnostic:a}),r.$config.problemRangeDecorationEnabled&&y.push({range:D});break;case l.DiagnosticSeverity.Information:I.push({options:P,diagnostic:a}),r.$config.problemRangeDecorationEnabled&&S.push({range:D});break;case l.DiagnosticSeverity.Hint:C.push({options:P,diagnostic:a}),r.$config.problemRangeDecorationEnabled&&T.push({range:D})}}const D=b.length+$.length+I.length+C.length,P=c.extUtils.shouldShowInlineMessage()&&r.$config.maxInlineMessages>0&&D>r.$config.maxInlineMessages;if(function({editor:e,limitInlineMessagesToViewport:t,linesWithInlineMessage:o}){const n=e.document.uri.toString(!0);if(!t)return void f.delete(n);if(f.add(n),h.has(n))return;h.add(n);const i=`Error Lens: inline messages limited to visible lines (${o} lines with problems > errorLens.maxInlineMessages)`;r.$state.log(i),d.vscodeUtils.showTempStatusBarNotification({message:i,timeout:5e3})}({editor:e,limitInlineMessagesToViewport:P,linesWithInlineMessage:D}),P){const t=function(e){return e.visibleRanges.map((e=>({start:e.start.line-p,end:e.end.line+p})))}(e);w(b,t),w($,t),w(I,t),w(C,t)}let E,M,U,k;if(c.extUtils.shouldShowGutterIcons()&&(0,i.updateWorkaroundGutterIcon)(e),r.$state.transmuteExists){const o=(0,a.transmute)({decorationsError:b,decorationsWarning:$,decorationsInfo:I,decorationsHint:C,decorationRenderBase:t.decorationRenderOptions});E=o.nonTransmuted.error,M=o.nonTransmuted.warning,U=o.nonTransmuted.info,k=o.nonTransmuted.hint,(0,a.doUpdateTransmutedDecorations)(o.transmuted,e)}else E=b.map((e=>e.options)),M=$.map((e=>e.options)),U=I.map((e=>e.options)),k=C.map((e=>e.options));e.setDecorations(t.decorationTypes.error,E),e.setDecorations(t.decorationTypes.warning,M),e.setDecorations(t.decorationTypes.info,U),e.setDecorations(t.decorationTypes.hint,k),r.$config.problemRangeDecorationEnabled&&(e.setDecorations(t.decorationTypes.errorRange,x),e.setDecorations(t.decorationTypes.warningRange,y),e.setDecorations(t.decorationTypes.infoRange,S),e.setDecorations(t.decorationTypes.hintRange,T)),r.$state.renderGutterIconsAsSeparateDecoration&&(0,i.doUpdateGutterDecorations)(e,o),v||(r.$state.statusBarMessage.updateText(e,o),r.$state.codeLens?.update())}function w(e,t){for(const o of e){const e=o.options.range.start.line;t.some((t=>e>=t.start&&e<=t.end))||delete o.options.renderOptions}}function b({uri:e,editor:t,groupedDiagnostics:o,range:n,isViewportRefresh:r}){if(void 0===t&&(t=d.vscodeUtils.getEditorByUri(e)),!t)return;if(!t.document.uri.fsPath)return;const i=c.extUtils.shouldExcludeEditor(t);"exclude"!==i&&("excludeAndClearDecorations"!==i?v({editor:t,groupedDiagnostics:o??c.extUtils.groupDiagnosticsByLine(l.languages.getDiagnostics(e)),range:n,isViewportRefresh:r}):m({editor:t}))}function $(){for(const e of Object.values(t.decorationTypes))e?.dispose();(0,a.disposeTransmutedDecorations)()}},707:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.ErrorLensCodeLens=void 0;const n=o(265),r=o(135),i=o(301),s=o(398),a=o(968);t.ErrorLensCodeLens=class{constructor(e){this.isHidden=!1,this.onDidChangeEventEmitter=new s.EventEmitter,this.onDidChangeCodeLenses=this.onDidChangeEventEmitter.event,this.disposables=[this.onDidChangeEventEmitter,s.languages.registerCodeLensProvider("*",this)]}formatDiagnostic(e){return a.extUtils.prepareMessage({template:n.$config.codeLensTemplate,diagnostic:e,lineProblemCount:1,removeLinebreaks:!0,replaceLinebreaksSymbol:n.$config.replaceLinebreaksSymbol})}createTooltip(e){return e.map(this.formatDiagnostic).join("\n")}createTitle(e){const t=this.formatDiagnostic(e);return r.utils.truncateString(t,n.$config.codeLensLength.max).padEnd(n.$config.codeLensLength.min,"⠀")}provideCodeLenses(e,t){const o=i.vscodeUtils.getEditorByUri(e.uri);if(!o)return[];if(!this.isEnabled())return[];const n=a.extUtils.shouldExcludeEditor(o);if("exclude"===n||"excludeAndClearDecorations"===n)return[];const r=a.extUtils.groupDiagnosticsByLine(s.languages.getDiagnostics(e.uri)),c=[];for(const e in r){const t=r[e];for(const o of t)c.push(new s.CodeLens(new s.Range(Number(e),0,Number(e),0),{title:this.createTitle(o),command:"errorLens.codeLensOnClick",tooltip:this.createTooltip(t),arguments:[o]}))}return c}isEnabled(){return!(!n.$config.enabled||n.$config.onSave&&this.isHidden||n.$config.delay>0&&this.isHidden)}update(){this.onDidChangeEventEmitter.fire()}hide(){this.isHidden=!0}show(){this.isHidden=!1,this.update()}dispose(){this.update(),setInterval((()=>{for(const e of this.disposables)e?.dispose();this.disposables=[]}),500)}}},712:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.StatusBarMessage=void 0;const n=o(265),r=o(563),i=o(968),s=o(135),a=o(398);t.StatusBarMessage=class{constructor({isEnabled:e,colorsEnabled:t,messageType:o,priority:n,alignment:r}){this.statusBarColors=[],this.activeMessageText="",this.activeMessageSource="";const i="right"===r?a.StatusBarAlignment.Right:a.StatusBarAlignment.Left;this.isEnabled=e,this.colorsEnabled=t,this.messageType=o,this.statusBarItem=a.window.createStatusBarItem("errorLensMessage",i,n),this.statusBarItem.name="Error Lens: Message",this.statusBarItem.command="errorLens.statusBarCommand",this.isEnabled?this.statusBarItem.show():this.dispose()}updateText(e,t){if(!this.isEnabled)return;const o=Object.keys(t);if(0===o.length)return void this.clear();const r=e.selection.active.line;let c,g=0;if("activeLine"===this.messageType){if(!t[r])return void this.clear();c=t[r][0],g=t[r].length}else if("activeCursor"===this.messageType)t[r]&&(c=t[r].sort(((e,t)=>{const o=this.distanceInCharachtersToCursor(e),n=this.distanceInCharachtersToCursor(t);return o===n?e.severity-t.severity:o-n}))[0]);else if("closestProblem"===this.messageType){const e=o.map(Number).sort(((e,t)=>Math.abs(r-e)-Math.abs(r-t)));e:for(const o of e){const e=t[o];for(const t of e)if(i.extUtils.isSeverityEnabled(t.severity)){c=t,g=e.length;break e}}}else if("closestSeverity"===this.messageType){const e=o.map((e=>t[e])).flat().sort(((e,t)=>1e4*e.severity-1e4*t.severity+(Math.abs(r-e.range.start.line)-Math.abs(r-t.range.start.line))));for(const o of e)if(i.extUtils.isSeverityEnabled(o.severity)){c=o,g=t[o.range.start.line].length;break}}if(!c)return void this.clear();this.activeMessageLocation=new a.Location(e.document.uri,c.range.start);let d=i.extUtils.diagnosticToInlineMessage(n.$config.statusBarMessageTemplate||n.$config.messageTemplate,c,g);n.$config.removeLinebreaks&&(d=s.utils.replaceLinebreaks(d,n.$config.replaceLinebreaksSymbol)),this.activeMessageText=d,this.activeMessageSource=c.source,this.colorsEnabled&&(this.statusBarItem.color=this.statusBarColors[c.severity]),this.statusBarItem.text=d,this.statusBarItem.tooltip=this.makeTooltip(c,n.$config.lintFilePaths)}clear(){this.isEnabled&&(this.statusBarItem.text="",this.statusBarItem.tooltip="")}distanceInCharachtersToCursor(e){const t=a.window.activeTextEditor?.selection.active;return t?e.range.contains(t)?0:Math.min(Math.abs(e.range.start.character-t.character),Math.abs(e.range.end.character-t.character)):0}dispose(){this.statusBarItem.dispose()}makeTooltip(e,t){return(0,r.createHoverForDiagnostic)({diagnostic:e,buttonsEnabled:!0,messageEnabled:!0,sourceCodeEnabled:!0,lintFilePaths:t})}}},795:function(e,t,o){"use strict";var n=this&&this.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(t,"__esModule",{value:!0}),t.updateChangedActiveTextEditorListener=function(){p?.dispose(),p=f.window.onDidChangeActiveTextEditor((e=>{g.$state.log("onDidChangeActiveTextEditor()",e?.document.uri.toString(!0)),g.$config.onSave&&!g.$config.onSaveUpdateOnActiveEditorChange||(e?(0,s.updateDecorationsForUri)({uri:e.document.uri,editor:e}):g.$state.statusBarMessage.clear())}))},t.updateChangeVisibleTextEditorsListener=function(){m?.dispose(),m=f.window.onDidChangeVisibleTextEditors(s.updateDecorationsForAllVisibleEditors)},t.updateChangeDiagnosticListener=function(){if(h?.dispose(),D(),!g.$config.onSave)if("number"==typeof g.$config.delay&&g.$config.delay>0){const e=Math.max(g.$config.delay,500)||500;if("old"===g.$config.delayMode){const t=new a.CustomDelay(e);h=f.languages.onDidChangeDiagnostics(t.onDiagnosticChange)}else"debounce"===g.$config.delayMode?h=f.languages.onDidChangeDiagnostics((0,r.default)((e=>{T(e.uris)}),e)):"new"===g.$config.delayMode&&(x?.dispose(),x=new c.NewDelay(e),h=f.languages.onDidChangeDiagnostics(x.onDiagnosticChange))}else h=f.languages.onDidChangeDiagnostics(L)},t.updateCursorChangeListener=function(){v?.dispose();const e="activeLine"===g.$config.followCursor||"closestProblem"===g.$config.followCursor||"allLinesExceptActive"===g.$config.followCursor;if(e||l.extUtils.shouldShowStatusBarMessage()){let t=-1;v=f.window.onDidChangeTextEditorSelection((o=>{const n=o.selections[0];(function(e,t){return 1===e.length&&e[0].isEmpty&&t!==e[0].active.line})(o.selections,t)&&(g.$state.log("caret moved to another line"),e&&(0,s.updateDecorationsForUri)({uri:o.textEditor.document.uri,editor:o.textEditor,range:n}),l.extUtils.shouldShowStatusBarMessage()&&g.$state.statusBarMessage.updateText(o.textEditor,l.extUtils.groupDiagnosticsByLine(f.languages.getDiagnostics(o.textEditor.document.uri))),t=o.selections[0].active.line),"activeCursor"===g.$config.statusBarMessageType&&g.$state.statusBarMessage.updateText(o.textEditor,l.extUtils.groupDiagnosticsByLine(f.languages.getDiagnostics(o.textEditor.document.uri)))}))}},t.updateOnVisibleRangesListener=function(){b?.dispose(),b=f.window.onDidChangeTextEditorVisibleRanges((e=>{(0,s.isInlineMessagesLimitedToViewport)(e.textEditor.document.uri)&&P()}))},t.updateOnSaveListener=function(){C?.dispose(),I?.dispose(),g.$config.onSave&&(C=f.workspace.onWillSaveTextDocument((e=>{g.$state.log("onWillSaveTextDocument()"),e.reason===f.TextDocumentSaveReason.Manual&&setTimeout((()=>{(0,s.updateDecorationsForUri)({uri:e.document.uri}),g.$state.codeLens?.show()}),g.$config.onSaveTimeout)})),I=f.workspace.onDidChangeTextDocument((e=>{(0,s.clearDecorations)({editor:u.vscodeUtils.getEditorByUri(e.document.uri)}),g.$state.codeLens?.hide()})))},t.updateCloseTextDocumentListener=function(){$?.dispose(),$=f.workspace.onDidCloseTextDocument((e=>{l.extUtils.clearMergeConflictCache(e)}))},t.updateChangeBreakpointsListener=function(){w?.dispose(),l.extUtils.shouldShowGutterIcons()&&(w=f.debug.onDidChangeBreakpoints((()=>{for(const e of f.window.visibleTextEditors)(0,d.updateWorkaroundGutterIcon)(e)})))},t.disposeAllEventListeners=function(){m?.dispose(),h?.dispose(),p?.dispose(),v?.dispose(),w?.dispose(),b?.dispose(),P.cancel(),C?.dispose(),I?.dispose(),$?.dispose(),x?.dispose(),D(),l.extUtils.clearMergeConflictCache()};const r=n(o(221)),i=n(o(969)),s=o(687),a=o(934),c=o(59),g=o(265),d=o(517),l=o(968),u=o(301),f=o(398);let h,p,m,v,w,b,$,I,C,x;const y=new Map;let S;function T(e){if(0!==f.window.visibleTextEditors.filter((e=>"vscode-notebook-cell"===e.document.uri.scheme)).length)(0,s.updateDecorationsForAllVisibleEditors)();else{for(const t of e)for(const e of f.window.visibleTextEditors)t.toString(!0)===e.document.uri.toString(!0)&&(g.$state.log("onChangedDiagnostics()"),(0,s.updateDecorationsForUri)({uri:t,editor:e}));g.$state.statusBarIcons.updateText()}}function L(e){for(const t of e.uris)y.set(t.toString(!0),t);void 0===S&&(S=setTimeout((()=>{S=void 0;const e=[...y.values()];y.clear(),T(e)}),0))}function D(){void 0!==S&&(clearTimeout(S),S=void 0),y.clear()}const P=(0,i.default)((()=>{for(const e of f.window.visibleTextEditors)(0,s.isInlineMessagesLimitedToViewport)(e.document.uri)&&(0,s.updateDecorationsForUri)({uri:e.document.uri,editor:e,isViewportRefresh:!0})}),100,{leading:!0,trailing:!0})},800:e=>{var t=/\s/;e.exports=function(e){for(var o=e.length;o--&&t.test(e.charAt(o)););return o}},805:e=>{e.exports=function(e){var t=typeof e;return null!=e&&("object"==t||"function"==t)}},840:e=>{var t="object"==typeof global&&global&&global.Object===Object&&global;e.exports=t},873:(e,t,o)=>{var n=o(325).Symbol;e.exports=n},897:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.toggleEnabledLevels=async function(e,t){const o=t.indexOf(e);-1===o?t.push(e):t.splice(o,1),await n.vscodeUtils.updateGlobalSetting("errorLens.enabledDiagnosticLevels",t)};const n=o(301)},916:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.registerAllCommands=function(e){e.subscriptions.push(w.commands.registerCommand("errorLens.toggle",(()=>{v.vscodeUtils.updateGlobalSetting("errorLens.enabled",!m.$config.enabled)}))),e.subscriptions.push(w.commands.registerCommand("errorLens.toggleError",(()=>{(0,f.toggleEnabledLevels)("error",m.$config.enabledDiagnosticLevels)}))),e.subscriptions.push(w.commands.registerCommand("errorLens.toggleWarning",(()=>{(0,f.toggleEnabledLevels)("warning",m.$config.enabledDiagnosticLevels)}))),e.subscriptions.push(w.commands.registerCommand("errorLens.toggleInfo",(()=>{(0,f.toggleEnabledLevels)("info",m.$config.enabledDiagnosticLevels)}))),e.subscriptions.push(w.commands.registerCommand("errorLens.toggleHint",(()=>{(0,f.toggleEnabledLevels)("hint",m.$config.enabledDiagnosticLevels)}))),e.subscriptions.push(w.commands.registerCommand("errorLens.toggleInlineMessage",(()=>{v.vscodeUtils.toggleGlobalBooleanSetting("errorLens.messageEnabled")}))),e.subscriptions.push(w.commands.registerCommand("errorlens.toggleWorkspace",h.toggleWorkspaceCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.updateEverything",p.updateEverythingCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.findLinterRuleDefinition",c.findLinterRuleDefinitionCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.searchForProblem",d.searchForProblemCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.copyProblemCode",r.copyProblemCodeCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.disableLine",s.disableLineCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.copyProblemMessage",i.copyProblemMessageCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.excludeProblem",a.excludeProblemCommand)),e.subscriptions.push(w.commands.registerTextEditorCommand("errorLens.selectProblem",l.selectProblemCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.codeLensOnClick",n.codeLensOnClickCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.revealLine",g.revealLineCommand)),e.subscriptions.push(w.commands.registerCommand("errorLens.statusBarCommand",u.statusBarCommand))};const n=o(158),r=o(149),i=o(247),s=o(84),a=o(573),c=o(476),g=o(559),d=o(572),l=o(923),u=o(955),f=o(897),h=o(477),p=o(314),m=o(265),v=o(301),w=o(398)},923:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.selectProblemCommand=function(e){let t;"closestProblem"===n.$config.selectProblemType?t=r.extUtils.getClosestDiagnostic(e):"closestSeverity"===n.$config.selectProblemType?t=r.extUtils.getClosestBySeverityDiagnostic(e):"activeLine"===n.$config.selectProblemType&&(t=r.extUtils.getDiagnosticAtLine(e.document.uri,e.selection.active.line)),t&&(e.selection=new i.Selection(t.range.start,t.range.end),e.revealRange(t.range))};const n=o(265),r=o(968),i=o(398)},934:function(e,t,o){"use strict";var n=this&&this.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(t,"__esModule",{value:!0}),t.CustomDelay=void 0;const r=n(o(221)),i=n(o(969)),s=o(687),a=o(265),c=o(968),g=o(398);t.CustomDelay=class{constructor(e){this.cachedDiagnostics={},this.onDiagnosticChange=e=>{if(e.uris.length)for(const t of e.uris)this.updateCachedDiagnosticForUri(t);else this.cachedDiagnostics={}},this.updateCachedDiagnosticForUri=e=>{const t=e.toString(),o=g.languages.getDiagnostics(e),n=this.cachedDiagnostics[t],r={[t]:{}};for(const e of o)r[t]&&(r[t][this.convertDiagnosticToId(e)]=e);if(n){const o=r[t],i=Object.keys(n),s=Object.keys(o);for(const t of i)if(!s.includes(t))return void this.updateDecorationsThrottled(e);for(const t of s)if(!i.includes(t))return void this.updateDecorationsDebounced(e)}else this.cachedDiagnostics[t]=r[t],this.updateDecorationsThrottled(e)},this.updateDecorations=e=>{const t=e.toString(),o=g.languages.getDiagnostics(e),n=c.extUtils.groupDiagnosticsByLine(o);this.cachedDiagnostics[t]={};for(const e of o)this.cachedDiagnostics[t][this.convertDiagnosticToId(e)]=e;for(const t of g.window.visibleTextEditors)t.document.uri.toString(!0)===e.toString(!0)&&(a.$state.log("CustomDelay => updateDecorations()"),(0,s.updateDecorationsForUri)({uri:e,editor:t,groupedDiagnostics:n}));a.$state.statusBarIcons.updateText()},this.updateDecorationsThrottled=(0,i.default)(this.updateDecorations,300,{leading:!0,trailing:!0}),this.updateDecorationsDebounced=(0,r.default)(this.updateDecorationsThrottled,e,{leading:!1,trailing:!0})}convertDiagnosticToId(e){return`${e.range.start.line}_${e.message}`}}},955:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.statusBarCommand=async function(){if("goToLine"===n.$config.statusBarCommand||"goToProblem"===n.$config.statusBarCommand){const e=n.$state.statusBarMessage.activeMessageLocation;if(!e)return;const t=r.vscodeUtils.getEditorByUri(e.uri);if(!t)return;await i.window.showTextDocument(t.document),t.selection=new i.Selection(e.range.start,e.range.end),t.revealRange(e.range,i.TextEditorRevealType.Default),await i.commands.executeCommand("workbench.action.focusActiveEditorGroup"),"goToProblem"===n.$config.statusBarCommand&&i.commands.executeCommand("editor.action.marker.next")}else if("copyMessage"===n.$config.statusBarCommand){const e=n.$state.statusBarMessage.activeMessageSource?`[${n.$state.statusBarMessage.activeMessageSource}] `:"";i.env.clipboard.writeText(e+n.$state.statusBarMessage.activeMessageText)}};const n=o(265),r=o(301),i=o(398)},968:(e,t,o)=>{"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.extUtils=void 0;const n=o(265),r=o(83),i=o(135),s=o(398),a=new Map;t.extUtils={prepareMessage({template:e,diagnostic:o,lineProblemCount:r,removeLinebreaks:s,replaceLinebreaksSymbol:a}){e||(e="$message");const c=t.extUtils.diagnosticToInlineMessage(e,o,r);return i.utils.truncateString(s?i.utils.replaceLinebreaks(c,a):c,n.$config.messageMaxChars)},_VscodeDiagnosticsArrayToObject:e=>e.map((e=>({uri:e[0],diagnostics:e[1]}))),getDiagnostics(e){const t=s.languages.getDiagnostics();let o=[];if(void 0===e||"all"===e.target)o=this._VscodeDiagnosticsArrayToObject(t);else if("activeEditor"===e.target)o=this._VscodeDiagnosticsArrayToObject(t).filter((e=>e.uri.toString(!0)===s.window.activeTextEditor?.document.uri.toString(!0)));else if("visibleEditors"===e.target){const e=[];for(const o of this._VscodeDiagnosticsArrayToObject(t))for(const t of s.window.visibleTextEditors)t.document.uri.toString(!0)===o.uri.toString(!0)&&e.push(o);o=e}return o},getDiagnosticTarget:e=>"number"!=typeof e.code&&"string"!=typeof e.code&&e.code?.target,getDiagnosticCode(e){const t="string"==typeof e.code||"number"==typeof e.code?e.code:e.code?.value;if(void 0!==t)return String(t)},parseSourceCodeFromString(e){const t=/(?<source>[^()]+)(?:\((?<code>.+)\))?/u.exec(e),o=t?.groups?.source,n=t?.groups?.code;return{source:o,code:n}},diagnosticToSourceCodeString:(e,t)=>`${e}${t?`(${t})`:""}`,groupDiagnosticsByLine(e){let o={};for(const n of e){if(t.extUtils.shouldExcludeDiagnostic(n))continue;const e=n.range.start.line;o[e]?o[e].push(n):o[e]=[n]}n.$state.transmuteExists&&(o=(0,r.transmuteSeverity)(o));for(const e in o)o[e]=o[e].sort(((e,t)=>e.severity-t.severity));return o},shouldExcludeDiagnostic(e){if(!t.extUtils.isSeverityEnabled(e.severity))return!0;if(e.source)for(const t of n.$state.excludeSources)if(t.source===e.source){let o="";if("number"==typeof e.code?o=String(e.code):"string"==typeof e.code?o=e.code:e.code?.value&&(o=String(e.code.value)),!t.code)return!0;if(t.code&&o&&t.code===o)return!0}const o=e.message.toLocaleLowerCase();for(const e of n.$state.excludeByMessage.strings)if(o.includes(e))return!0;for(const t of n.$state.excludeByMessage.regexps)if(t.test(e.message))return!0;return!1},shouldExcludeEditor(e){if(n.$config.ignoreUntitled&&"untitled"===e.document.uri.scheme)return"excludeAndClearDecorations";if(n.$config.ignoreDirty&&!n.$state.vscodeAutosaveEnabled&&e.document.isDirty)return"excludeAndClearDecorations";if(!n.$config.enableOnDiffView&&void 0===e.viewColumn&&"vscode-notebook-cell"!==e.document.uri.scheme)return"excludeAndClearDecorations";if(!n.$config.enabledInMergeConflict&&t.extUtils.hasMergeConflict(e.document))return"excludeAndClearDecorations";if(n.$state.excludePatterns)for(const t of n.$state.excludePatterns)if(0!==s.languages.match(t,e.document))return"exclude";const o=s.workspace.getWorkspaceFolder(e.document.uri)?.uri.fsPath;return o&&n.$config.excludeWorkspaces.includes(o)?"exclude":"doNotExclude"},hasMergeConflict(e){const t=e.uri.toString(),o=a.get(t);if(o?.version===e.version)return o.hasMergeConflict;const n=e.getText(),r=n.includes("<<<<<<<")||n.includes("=======")||n.includes(">>>>>>>");return a.set(t,{version:e.version,hasMergeConflict:r}),r},clearMergeConflictCache(e){e?a.delete(e.uri.toString()):a.clear()},isSeverityEnabled:e=>0===e&&n.$state.configErrorEnabled||1===e&&n.$state.configWarningEnabled||2===e&&n.$state.configInfoEnabled||3===e&&n.$state.configHintEnabled,severityStringToNumber(e){if("error"===e)return 0;if("warning"===e)return 1;if("info"===e)return 2;if("hint"===e)return 3;throw Error(`Unknown severity ${String(e)}`)},diagnosticToInlineMessage(e,t,o){let r=t?.message;if(!r)return"";if(n.$state.replaceRegexp)for(const e of n.$state.replaceRegexp){const t=e.matcher.exec(r);if(t){r=e.message;for(let e=0;e<t.length;e++)r=r.replace(new RegExp(`\\$${e}`,"gu"),t[Number(e)]);break}}if("$message"===e)return r;{let i=e.replace("$message",r).replace("$severity",n.$config.severityText[t.severity]||"").replace("$lineStart",String(t.range.start.line+1)).replace("$lineEnd",String(t.range.end.line+1));if(e.includes("$count")&&(i=o>1?i.replace("$count",String(o)):i.replace(/(\s*?)?(\S*?)?(\$count)(\S*?)?(\s*?)?/u,((e,t,o,n,r,i)=>(t??"")+(i??"")))),e.includes("$source")&&(i=t.source?i.replace("$source",String(t.source)):i.replace(/(\s*?)?(\S*?)?(\$source)(\S*?)?(\s*?)?/u,((e,t,o,n,r,i)=>(t??"")+(i??"")))),e.includes("$code")){const e="object"==typeof t.code?String(t.code.value):String(t.code);i=t.code?i.replace("$code",e):i.replace(/(\s*?)?(\S*?)?(\$code)(\S*?)?(\s*?)?/u,((e,t,o,n,r,i)=>(t??"")+(i??"")))}return i}},getDiagnosticAtLine(e,o){const n=s.languages.getDiagnostics(e),r=t.extUtils.groupDiagnosticsByLine(n)[o];if(r)return r[0]},getClosestDiagnostic(e){const o=t.extUtils.groupDiagnosticsByLine(s.languages.getDiagnostics(e.document.uri)),n=Object.keys(o),r=e.selection.active.line,i=n.map(Number).sort(((e,t)=>Math.abs(r-e)-Math.abs(r-t)));for(const e of i){const n=o[e];for(const e of n)if(t.extUtils.isSeverityEnabled(e.severity))return e}},getClosestBySeverityDiagnostic(e){const o=t.extUtils.groupDiagnosticsByLine(s.languages.getDiagnostics(e.document.uri)),n=Object.keys(o),r=e.selection.active.line,i=n.map((e=>o[e])).flat().sort(((e,t)=>1e4*e.severity-1e4*t.severity+(Math.abs(r-e.range.start.line)-Math.abs(r-t.range.start.line))));for(const e of i)if(t.extUtils.isSeverityEnabled(e.severity))return e},getClosestDiagnosticInViewport(e){const o=t.extUtils.groupDiagnosticsByLine(s.languages.getDiagnostics(e.document.uri)),n=e.selection.active.line;for(const n in o){const r=o[n][0];t.extUtils.isDiagnosticInViewport(e,r)||delete o[n]}const r=o,i=Object.keys(r).sort(((e,t)=>Math.abs(n-Number(e))-Math.abs(n-Number(t))));for(const e of i){const n=o[e];for(const e of n)if(t.extUtils.isSeverityEnabled(e.severity))return e}},isDiagnosticInViewport(e,t){for(const o of e.visibleRanges)if(o.intersection(t.range))return!0;return!1},getVisualLineLength(e,t,o){if("spaces"===o)return e.range.end.character;{const o=e.text.slice(0,e.firstNonWhitespaceCharacterIndex).replace(/[^\t]/gu,""),n=o.length,r=e.text.slice(n);return o.length*t+r.length}},shouldAlign:()=>Boolean(n.$config.alignMessage.start||n.$config.alignMessage.end),shouldShowInlineMessage(){const e=n.$config.messageEnabled,t=n.$config.respectUpstreamEnabled;return t.enabled&&t.inlineMessage?e&&n.$state.vscodeGlobalProblemsEnabled:e},shouldShowGutterIcons(){const e=n.$config.gutterIconsEnabled,t=n.$config.respectUpstreamEnabled;return t.enabled&&t.gutter?e&&n.$state.vscodeGlobalProblemsEnabled:e},shouldShowStatusBarIcons(){const e=n.$config.statusBarIconsEnabled,t=n.$config.respectUpstreamEnabled;return t.enabled&&t.statusBar?e&&n.$state.vscodeGlobalProblemsEnabled:e},shouldShowStatusBarMessage(){const e=n.$config.statusBarMessageEnabled,t=n.$config.respectUpstreamEnabled;return t.enabled&&t.statusBar?e&&n.$state.vscodeGlobalProblemsEnabled:e},addPxUnitsIfNeeded:e=>/^\d+$/u.test(e)?`${e}px`:e}},969:(e,t,o)=>{var n=o(221),r=o(805);e.exports=function(e,t,o){var i=!0,s=!0;if("function"!=typeof e)throw new TypeError("Expected a function");return r(o)&&(i="leading"in o?!!o.leading:i,s="trailing"in o?!!o.trailing:s),n(e,t,{leading:i,maxWait:t,trailing:s})}}},t={},o=function o(n){var r=t[n];if(void 0!==r)return r.exports;var i=t[n]={exports:{}};return e[n].call(i.exports,i,i.exports,o),i.exports}(265);module.exports=o})();
},
"package.json": function (module) { module.exports = {
	"name": "errorlens",
	"displayName": "Error Lens",
	"description": "Improve highlighting of errors, warnings and other language diagnostics.",
	"version": "3.29.0",
	"publisher": "usernamehw",
	"license": "MIT",
	"engines": {
		"vscode": "^1.107.0",
		"npm": ">=10.0.0"
	},
	"extensionKind": [
		"ui",
		"workspace"
	],
	"categories": [
		"Other"
	],
	"qna": false,
	"keywords": [
		"highlight",
		"problem",
		"problems",
		"error",
		"warning",
		"inline",
		"message",
		"diagnostic",
		"status bar",
		"gutter"
	],
	"icon": "img/icon.png",
	"repository": {
		"type": "git",
		"url": "https://github.com/usernamehw/vscode-error-lens"
	},
	"activationEvents": [
		"onStartupFinished"
	],
	"main": "./dist/extension.js",
	"browser": "./dist/extension.js",
	"contributes": {
		"commands": [
			{
				"command": "errorLens.toggle",
				"title": "Toggle (Enable/Disable) Everything",
				"description": "Toggle (Enable/Disable) Everything (toggle global setting `\"errorLens.enabled\"`)",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.toggleError",
				"title": "Toggle Errors",
				"description": "Enable/Disable Errors in `\"errorLens.enabledDiagnosticLevels\"` setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.toggleWarning",
				"title": "Toggle Warnings",
				"description": "Enable/Disable Warnings in `\"errorLens.enabledDiagnosticLevels\"` setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.toggleInfo",
				"title": "Toggle Info",
				"description": "Enable/Disable Info in `\"errorLens.enabledDiagnosticLevels\"` setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.toggleHint",
				"title": "Toggle Hint",
				"description": "Enable/Disable Hint in `\"errorLens.enabledDiagnosticLevels\"` setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.toggleInlineMessage",
				"title": "Toggle Inline Message",
				"description": "Toggle global setting `\"errorLens.messageEnabled\"`.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.searchForProblem",
				"title": "Search for problem",
				"description": "Open problem in default browser (controlled by `errorLens.searchForProblemQuery` setting).",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.selectProblem",
				"title": "Select Problem",
				"description": "Set editor selection to the problem range (controlled by `errorLens.selectProblemType` setting).",
				"category": "Error Lens"
			},
			{
				"command": "errorlens.toggleWorkspace",
				"title": "Toggle Workspace in Disabled List",
				"description": "Exclude/Include current workspace by fs path.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.disableLine",
				"title": "Disable line",
				"description": "Add a comment to disable line for linter rule. Comment format is controlled by `\"errorLens.disableLineComments\"` setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.findLinterRuleDefinition",
				"title": "Find Linter Rule Definition",
				"description": "Search in local linter files (like `.eslintrc.json`) for the rule definition. Target files are controlled by \"errorLens.lintFilePaths\" setting.",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.copyProblemMessage",
				"title": "Copy Problem Message",
				"description": "Copy problem message to the clipboard (at the active cursor).",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.excludeProblem",
				"title": "Exclude Problem",
				"description": "Exclude problem (at the active cursor) (write into settings).",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.copyProblemCode",
				"title": "Copy Problem Code",
				"description": "Copy problem code to the clipboard (at the active cursor).",
				"category": "Error Lens"
			},
			{
				"command": "errorLens.updateEverything",
				"title": "Update Everything",
				"description": "Update all decorations. Supports args {\"kind\": \"update\" | \"clear\"}",
				"category": "Error Lens"
			}
		],
		"configuration": {
			"properties": {
				"errorLens.enabled": {
					"type": "boolean",
					"default": true,
					"markdownDescription": "Controls all decorations and features (except commands)."
				},
				"errorLens.respectUpstreamEnabled": {
					"type": "object",
					"properties": {
						"enabled": {
							"type": "boolean",
							"description": "When true - extension will honour VSCode setting `#problems.visibility#` and not show errors if `#problems.visibility#` is false.",
							"default": true
						},
						"inlineMessage": {
							"type": "boolean",
							"default": true
						},
						"gutter": {
							"type": "boolean",
							"default": true
						},
						"statusBar": {
							"type": "boolean",
							"default": false
						}
					},
					"default": {
						"enabled": true,
						"inlineMessage": true,
						"gutter": true,
						"statusBar": false
					},
					"markdownDescription": "When enabled - extension will take into account global VSCode setting `#problems.visibility#`. ([1.85.0 changelog](https://code.visualstudio.com/updates/v1_85#_hide-problem-decorations)).",
					"additionalProperties": false
				},
				"errorLens.enabledInMergeConflict": {
					"type": "boolean",
					"default": true,
					"markdownDescription": "Controls if decorations are shown if the editor has git merge conflict indicators `<<<<<<<` or `=======` or `>>>>>>>`."
				},
				"errorLens.fontFamily": {
					"type": "string",
					"default": "",
					"markdownDescription": "Font family of inline message. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontfamily). May break `#errorLens.alignMessage#`"
				},
				"errorLens.fontWeight": {
					"type": "string",
					"enum": [
						"100",
						"200",
						"300",
						"400",
						"normal",
						"500",
						"600",
						"700",
						"bold",
						"800",
						"900"
					],
					"default": "normal",
					"markdownDescription": "Font weight of inline message. (`\"normal\"` is alias for 400, `\"bold\"` is alias for 700). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontweight)"
				},
				"errorLens.fontStyleItalic": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "When enabled - shows inline message in italic font style. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontstyleitalic)"
				},
				"errorLens.fontSize": {
					"type": "string",
					"default": "",
					"markdownDescription": "Font size of inline message ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/length)). Use negative value to have it relative to the editor's fontSize (e.g. `-3px`). May break `#errorLens.alignMessage#`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontsize)."
				},
				"errorLens.margin": {
					"type": "string",
					"default": "4ch",
					"markdownDescription": "Distance between the last word on the line and the start of inline message ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/length)). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmargin)"
				},
				"errorLens.alignMessage": {
					"type": "object",
					"properties": {
						"start": {
							"type": "integer",
							"minimum": 0,
							"description": "Starting column where to align decorations."
						},
						"end": {
							"type": "integer",
							"minimum": 0,
							"description": "Ending column where to align decorations."
						},
						"minimumMargin": {
							"type": "integer",
							"description": "Minimal space between line end and decoration. Very similar to the global setting `errorLens.margin`, but can only be a number of characters.",
							"minimum": 4
						},
						"padding": {
							"type": "array",
							"items": {
								"type": "number",
								"default": 0,
								"minimum": 0
							},
							"minItems": 2,
							"maxItems": 2,
							"default": [
								0,
								0
							],
							"description": "Very similar to the global setting `errorLens.padding`, but it can only be a number (not any CSS unit like pixels). First number is top+bottom padding; Second number - left+right padding."
						},
						"useFixedPosition": {
							"type": "boolean",
							"default": true,
							"description": "Use fixed position for decoration that has stuttering/twitching on the active line (e.g. when typing). Will prevent hover over decoration text."
						}
					},
					"default": {
						"start": 0,
						"end": 0,
						"minimumMargin": 4,
						"padding": [
							0,
							0
						],
						"useFixedPosition": true
					},
					"markdownDescription": "Align inline error message (either by starting position or ending position). Only works for monospace fonts. Set \"start\" and \"end\" to **0** to disable. ❗Will conflict with other extension decorations. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensalignmessage)",
					"additionalProperties": false
				},
				"errorLens.border": {
					"type": "array",
					"default": [
						"",
						"",
						"",
						""
					],
					"items": {
						"type": "string",
						"default": ""
					},
					"minItems": 4,
					"maxItems": 4,
					"additionalItems": false,
					"markdownDescription": "Border of the inline message. Examples: `1px solid`, `1px dashed`, `2px dotted`, `1px solid #00000050`... Set to empty string to disable. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensborder)"
				},
				"errorLens.padding": {
					"type": "string",
					"default": "",
					"markdownDescription": "Padding of the inline message. Visible when `#errorLens.messageBackgroundMode#` is set to \"message\". [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenspadding)",
					"examples": [
						"2px 1ch"
					]
				},
				"errorLens.borderRadius": {
					"type": "string",
					"default": "0.2em",
					"markdownDescription": "Border radius of the inline message. Visible when `#errorLens.messageBackgroundMode#` is set to \"message\". [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensborderradius)",
					"examples": [
						"5px",
						"5em 0px",
						"0px 5em 5em 0px"
					]
				},
				"errorLens.enabledDiagnosticLevels": {
					"type": "array",
					"items": {
						"type": "string",
						"enum": [
							"error",
							"warning",
							"info",
							"hint"
						]
					},
					"uniqueItems": true,
					"markdownDescription": "Customize which diagnostic levels(severity) to highlight. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensenableddiagnosticlevels)",
					"default": [
						"error",
						"warning",
						"info"
					]
				},
				"errorLens.messageTemplate": {
					"type": "string",
					"default": "$message",
					"markdownDescription": "Template used for all inline messages. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagetemplate)"
				},
				"errorLens.messageMaxChars": {
					"type": "integer",
					"default": 500,
					"minimum": 0,
					"markdownDescription": "Cut off inline message if it's longer than this value. (Improves performance when the diagnostic message is long). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagemaxchars)"
				},
				"errorLens.maxInlineMessages": {
					"type": "integer",
					"default": 1000,
					"minimum": 0,
					"markdownDescription": "Limit inline messages to the lines currently visible in the editor when a file has more lines with problems than this value. VSCode creates a separate set of CSS rules for every distinct inline message, so a file with thousands of problems can freeze the editor for a long time. Line highlighting, gutter icons, problem range decorations, hovers and status bar are not affected. `0` - no limit."
				},
				"errorLens.severityText": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"markdownDescription": "Replaces `$severity` variable in `#errorLens.messageTemplate#`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensseveritytext)",
					"default": [
						"⛔",
						"⚠",
						"ℹ",
						"🍏"
					],
					"minItems": 4,
					"maxItems": 4
				},
				"errorLens.messageEnabled": {
					"type": "boolean",
					"default": true,
					"markdownDescription": "Controls whether inline message is shown or not (Including background highlight). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessageenabled)"
				},
				"errorLens.messageBackgroundMode": {
					"type": "string",
					"default": "line",
					"enum": [
						"line",
						"message",
						"none"
					],
					"enumDescriptions": [
						"The entire line is highlighted.",
						"Inline message is highlighted.",
						"Message is not highlighted (only has foreground colors)."
					],
					"markdownDescription": "Controls how inline message is highlighted in the editor (entire line / only message / none). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagebackgroundmode)"
				},
				"errorLens.problemRangeDecorationEnabled": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "When checked - highlight the entire problem range. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensproblemrangedecorationenabled)"
				},
				"errorLens.editorHoverPartsEnabled": {
					"type": "object",
					"properties": {
						"messageEnabled": {
							"type": "boolean",
							"default": false
						},
						"sourceCodeEnabled": {
							"type": "boolean",
							"default": false
						},
						"buttonsEnabled": {
							"type": "boolean",
							"default": false
						}
					},
					"additionalProperties": false,
					"default": {
						"messageEnabled": false,
						"sourceCodeEnabled": false,
						"buttonsEnabled": false
					},
					"markdownDescription": "Controls which parts of the editor hover tooltip to show."
				},
				"errorLens.statusBarIconsEnabled": {
					"type": "boolean",
					"markdownDescription": "When enabled - shows highlighted error/warning icons in status bar. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbariconsenabled)",
					"default": false
				},
				"errorLens.statusBarIconsPriority": {
					"type": "integer",
					"markdownDescription": "Move status bar icons left or right by adjusting the number priority.",
					"default": -9000
				},
				"errorLens.statusBarIconsAlignment": {
					"type": "string",
					"markdownDescription": "Choose on which side the icons status bar is on: left or right.",
					"enum": [
						"left",
						"right"
					],
					"default": "left"
				},
				"errorLens.statusBarIconsTargetProblems": {
					"type": "string",
					"enum": [
						"all",
						"activeEditor",
						"visibleEditors"
					],
					"enumDescriptions": [
						"Should be the same as native status bar icons - counts all known problems from all files.",
						"Count only problems from the Active Text Editor.",
						"Count only problems from the Visible Text Editors."
					],
					"default": "all",
					"markdownDescription": "Which problems to use for counting problems at icons status bar."
				},
				"errorLens.statusBarIconsUseBackground": {
					"type": "boolean",
					"markdownDescription": "When enabled - highlights status bar icons with background, when disabled - with foreground.",
					"default": true
				},
				"errorLens.statusBarIconsAtZero": {
					"type": "string",
					"markdownDescription": "What to do when there are 0 errors/warnings - hide the item or strip its background color.",
					"enum": [
						"hide",
						"removeBackground"
					],
					"default": "removeBackground"
				},
				"errorLens.statusBarMessageEnabled": {
					"type": "boolean",
					"markdownDescription": "When enabled - shows message in status bar. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbarmessageenabled)",
					"default": false
				},
				"errorLens.statusBarMessagePriority": {
					"type": "integer",
					"markdownDescription": "Move status bar message left or right by adjusting the number priority.",
					"default": -10000
				},
				"errorLens.statusBarMessageAlignment": {
					"type": "string",
					"markdownDescription": "Choose on which side the message status bar is on: left or right.",
					"enum": [
						"left",
						"right"
					],
					"default": "left"
				},
				"errorLens.statusBarColorsEnabled": {
					"type": "boolean",
					"markdownDescription": "When enabled - use message decoration foreground as color of Status Bar text. Uses colors `errorLens.statusBarErrorForeground`, `errorLens.statusBarWarningForeground`, `errorLens.statusBarInfoForeground`, `errorLens.statusBarHintForeground`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbarcolorsenabled)",
					"default": false
				},
				"errorLens.statusBarMessageType": {
					"type": "string",
					"markdownDescription": "Pick what to show in Status Bar: closest message or only message for the active line.",
					"enum": [
						"closestProblem",
						"closestSeverity",
						"activeLine",
						"activeCursor"
					],
					"enumDescriptions": [
						"Show closest to the cursor diagnostic.",
						"Show closest to the cursor diagnostic sorted by severity (e.g. error will be shown before warning even if it's farther from the cursor).",
						"Show only diagnostic that is on the same line as the cursor.",
						"Similar to \"activeLine\" but follows the cursor movement inside the line."
					],
					"default": "activeLine"
				},
				"errorLens.statusBarCommand": {
					"type": "string",
					"markdownDescription": "Command that executes on click for Status Bar.",
					"enum": [
						"goToProblem",
						"goToLine",
						"copyMessage"
					],
					"default": "goToProblem"
				},
				"errorLens.statusBarMessageTemplate": {
					"type": "string",
					"default": "",
					"markdownDescription": "Template for status bar message. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic"
				},
				"errorLens.replace": {
					"type": "array",
					"default": [],
					"items": {
						"type": "object",
						"properties": {
							"matcher": {
								"type": "string",
								"description": "The RegExp pattern against which to match diagnostic messages"
							},
							"message": {
								"type": "string",
								"description": "The entire replacement for messages matching matcher. Can reference match groups like $0 (entire expression), $1 (first capture group), etc."
							}
						},
						"required": [
							"matcher",
							"message"
						]
					},
					"markdownDescription": "Specify message to transform. E.g. if this is configured to [{ matcher: 'foo (.*)', message: 'just $1' }], the message 'foo bar' would be displayed as 'just bar'. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensreplace)"
				},
				"errorLens.transmute": {
					"type": "object",
					"default": {},
					"patternProperties": {
						".*": {
							"type": "object",
							"properties": {
								"target": {
									"type": "object",
									"properties": {
										"message": {
											"type": "string",
											"description": "Match with problem's message (case-insensitive).",
											"default": ""
										},
										"messageRegex": {
											"type": "object",
											"properties": {
												"regex": {
													"type": "string",
													"default": ""
												},
												"flags": {
													"type": "string",
													"default": "iu"
												}
											},
											"description": "Match with problem's message using Regular Expressions.",
											"required": [
												"regex"
											],
											"additionalProperties": false
										},
										"source": {
											"type": "string",
											"description": "Match with problem's source, e.g.: `eslint`, `ts`, ...",
											"default": ""
										},
										"code": {
											"description": "Match with problem's code, e.g.: `@typescript-eslint/semi`, `6133`, ...",
											"type": "string"
										}
									}
								},
								"severity": {
									"type": "string",
									"markdownDescription": "Change problem's severity (can affect which decoration is rendered).",
									"enum": [
										"error",
										"warning",
										"info",
										"hint"
									]
								},
								"decoration": {
									"type": "object",
									"markdownDescription": "Change decoration properties.",
									"properties": {
										"light": {
											"type": "object",
											"description": "Only works for Light color themes.",
											"properties": {
												"backgroundColor": {
													"type": "string",
													"format": "color"
												},
												"color": {
													"type": "string",
													"format": "color"
												},
												"border": {
													"type": "string"
												},
												"outline": {
													"type": "string"
												},
												"borderRadius": {
													"type": "string"
												},
												"borderSpacing": {
													"type": "string"
												},
												"fontStyle": {
													"type": "string"
												},
												"fontWeight": {
													"type": "string"
												},
												"textDecoration": {
													"type": "string"
												},
												"opacity": {
													"type": "string"
												},
												"letterSpacing": {
													"type": "string"
												},
												"after": {
													"type": "object",
													"description": "Change the properties of the inline message.",
													"properties": {
														"backgroundColor": {
															"type": "string",
															"format": "color"
														},
														"color": {
															"type": "string",
															"format": "color"
														},
														"border": {
															"type": "string"
														},
														"borderRadius": {
															"type": "string"
														},
														"fontStyle": {
															"type": "string"
														},
														"fontWeight": {
															"type": "string"
														},
														"textDecoration": {
															"type": "string"
														}
													}
												}
											}
										},
										"dark": {
											"type": "object",
											"description": "Only works for Dark color themes.",
											"properties": {
												"backgroundColor": {
													"type": "string",
													"format": "color"
												},
												"color": {
													"type": "string",
													"format": "color"
												},
												"border": {
													"type": "string"
												},
												"outline": {
													"type": "string"
												},
												"borderRadius": {
													"type": "string"
												},
												"borderSpacing": {
													"type": "string"
												},
												"fontStyle": {
													"type": "string"
												},
												"fontWeight": {
													"type": "string"
												},
												"textDecoration": {
													"type": "string"
												},
												"opacity": {
													"type": "string"
												},
												"letterSpacing": {
													"type": "string"
												},
												"after": {
													"type": "object",
													"description": "Change the properties of the inline message.",
													"properties": {
														"backgroundColor": {
															"type": "string",
															"format": "color"
														},
														"color": {
															"type": "string",
															"format": "color"
														},
														"border": {
															"type": "string"
														},
														"borderRadius": {
															"type": "string"
														},
														"fontStyle": {
															"type": "string"
														},
														"fontWeight": {
															"type": "string"
														},
														"textDecoration": {
															"type": "string"
														}
													}
												}
											}
										}
									}
								}
							}
						}
					},
					"markdownDescription": "Change severity or editor decoration for specific problems. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenstransmute)"
				},
				"errorLens.excludeByMessage": {
					"type": "array",
					"default": [],
					"items": {
						"oneOf": [
							{
								"type": "string",
								"default": ""
							},
							{
								"type": "object",
								"properties": {
									"regex": {
										"type": "string",
										"default": ""
									},
									"flags": {
										"type": "string",
										"default": "iu"
									}
								},
								"additionalProperties": false,
								"default": {
									"regex": "",
									"flags": "iu"
								}
							}
						]
					},
					"markdownDescription": "Exclude diagnostics by message. Excludes when the diagnostic message contains the excluding string (case-insensitive). Can use Regular Expressions (use object instead of a string)."
				},
				"errorLens.excludeBySource": {
					"type": "array",
					"default": [],
					"items": {
						"type": "string"
					},
					"markdownDescription": "Specify `source` or `source(code)` pair to exclude. Examples: \n\n```json\n[\n\t\"eslint\",// exclude all problems from eslint linter\n\t\"eslint(padded-blocks)\",// exclude padded-blocks rule from eslint linter\n\t\"Pylance(reportUndefinedVariable)\",// exlude reportUndefinedVariable rule from Pylance linter\n]\n```"
				},
				"errorLens.excludePatterns": {
					"type": "array",
					"default": [],
					"items": {
						"type": "string"
					},
					"markdownDescription": "Exclude files by using [glob](https://code.visualstudio.com/docs/editor/glob-patterns) pattern. Example `[\"**/*.{ts,js}\"]`"
				},
				"errorLens.excludeWorkspaces": {
					"type": "array",
					"default": [],
					"items": {
						"type": "string"
					},
					"markdownDescription": "Exclude workspaces by path."
				},
				"errorLens.disableLineComments": {
					"type": "object",
					"markdownDescription": "Used for `errorLens.disableLine` command that adds a comment disabling linter rule for a line.\nTo force comment on the same line - add `SAME_LINE` to the message: `\"eslint\": \"// eslint-disable-line $code SAME_LINE\"`",
					"patternProperties": {
						".*": {
							"type": "string"
						}
					},
					"default": {
						"eslint": "// eslint-disable-next-line $code",
						"Stylelint": "/* stylelint-disable-next-line $code */"
					}
				},
				"errorLens.lintFilePaths": {
					"type": "object",
					"default": {
						"eslint": [
							"**/*eslint.config.{js,mjs,cjs,ts,mts,cts}",
							"**/*.eslintrc.{js,cjs,yaml,yml,json}",
							"**/*package.json"
						],
						"Stylelint": [
							"**/*.stylelintrc",
							"**/*.stylelintrc.{cjs,js,json,yaml,yml}",
							"**/*stylelint.config.{cjs,js}",
							"**/*package.json"
						]
					},
					"patternProperties": {
						".*": {
							"oneOf": [
								{
									"type": "array",
									"items": {
										"type": "string"
									}
								},
								{
									"type": "string",
									"enum": [
										"none"
									]
								}
							]
						}
					},
					"markdownDescription": "Specify where to search for linter rule definitions by diagnostic source ([glob](https://code.visualstudio.com/docs/editor/glob-patterns) for local linter files). `node_modules` folder is excluded."
				},
				"errorLens.searchForProblemQuery": {
					"type": "string",
					"default": "https://duckduckgo.com/?q=$message",
					"markdownDescription": "Pick query to open in default browser when searching for problem with `errorLens.searchForProblem` command."
				},
				"errorLens.selectProblemType": {
					"type": "string",
					"default": "closestProblem",
					"enum": [
						"closestProblem",
						"closestSeverity",
						"activeLine"
					],
					"enumDescriptions": [
						"Show closest to the cursor diagnostic.",
						"Show closest to the cursor diagnostic (sorted by severity e.g. error will be shown before warning even if it's farther from the cursor).",
						"Show only diagnostic that is on the same line as the cursor."
					],
					"markdownDescription": "Which problem to select (closest / active line) when executing `errorLens.selectProblem` command."
				},
				"errorLens.light": {
					"type": "object",
					"markdownDescription": "Specify color of decorations for when the light color theme is active.",
					"properties": {
						"errorGutterIconPath": {
							"type": "string",
							"description": "Absolute path to error gutter icon for light themes.",
							"default": ""
						},
						"warningGutterIconPath": {
							"type": "string",
							"description": "Absolute path to warning gutter icon for light themes.",
							"default": ""
						},
						"infoGutterIconPath": {
							"type": "string",
							"description": "Absolute path to info gutter icon for light themes.",
							"default": ""
						},
						"hintGutterIconPath": {
							"type": "string",
							"description": "Absolute path to hint gutter icon for light themes.",
							"default": ""
						},
						"errorGutterIconColor": {
							"type": "string",
							"default": "",
							"markdownDescription": "Error color of simple gutter icons (shapes and letters) for light themes.",
							"format": "color"
						},
						"warningGutterIconColor": {
							"type": "string",
							"default": "",
							"markdownDescription": "Warning color of simple gutter icons (shapes and letters) for light themes.",
							"format": "color"
						},
						"infoGutterIconColor": {
							"type": "string",
							"default": "",
							"markdownDescription": "Info color of simple gutter icons (shapes and letters) for light themes.",
							"format": "color"
						},
						"hintGutterIconColor": {
							"type": "string",
							"default": "",
							"markdownDescription": "Hint color of simple gutter icons (shapes and letters) for light themes.",
							"format": "color"
						}
					}
				},
				"errorLens.delay": {
					"type": "integer",
					"markdownDescription": "Delay (ms) before showing problem decorations (**0** to disable). Minimum delay of **500** is enforced by the extension. `#errorLens.delayMode#` controls how to handle the delay.",
					"default": 0
				},
				"errorLens.delayMode": {
					"type": "string",
					"default": "new",
					"enum": [
						"new",
						"old",
						"debounce"
					],
					"markdownEnumDescriptions": [
						"New problems appear according to `errorLens.delay` setting. Fixed problems disappear faster.",
						"Decorations for problems are debounced according to `errorLens.delay` setting.",
						"Decorations disappear when document changes (typing)."
					],
					"markdownDescription": "Pick which version of the delay to use."
				},
				"errorLens.onSave": {
					"type": "boolean",
					"markdownDescription": "When enabled - updates decorations only on document save (manual).",
					"default": false
				},
				"errorLens.onSaveTimeout": {
					"type": "integer",
					"markdownDescription": "Time period (ms) that used for showing decorations after the document save (manual, not auto save).",
					"default": 500,
					"minimum": 50
				},
				"errorLens.onSaveUpdateOnActiveEditorChange": {
					"type": "boolean",
					"markdownDescription": "When `#errorLens.onSave#` enabled - extension still draws decorations when active/visible editors change.",
					"default": true
				},
				"errorLens.enableOnDiffView": {
					"type": "boolean",
					"markdownDescription": "Enable decorations when viewing a diff view in the editor (e.g. Git diff). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensenableondiffview)",
					"default": false
				},
				"errorLens.followCursor": {
					"type": "string",
					"enum": [
						"allLines",
						"allLinesExceptActive",
						"activeLine",
						"closestProblem"
					],
					"enumDescriptions": [
						"Highlight all problems in file",
						"Highlight all problems in file (except the line at the cursor)",
						"Highlight only the problem at the cursor",
						"Highlight only closest to the cursor problem"
					],
					"markdownDescription": "Highlight only portion of the problems. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfollowcursor)",
					"default": "allLines"
				},
				"errorLens.followCursorMore": {
					"type": "number",
					"markdownDescription": "Augments `#errorLens.followCursor#`.\nAdds number of lines to top and bottom when `#errorLens.followCursor#` is set to `activeLine`.\n Adds number of closest problems when `#errorLens.followCursor#` is `closestProblem` [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfollowcursormore)",
					"default": 0
				},
				"errorLens.gutterIconsEnabled": {
					"type": "boolean",
					"markdownDescription": "When enabled - shows gutter icons (In place of the debug breakpoint icon). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsenabled)",
					"default": false
				},
				"errorLens.gutterIconsFollowCursorOverride": {
					"type": "boolean",
					"markdownDescription": "When enabled and `#errorLens.followCursor#` setting is not `allLines`, then gutter icons would be rendered for all problems. But line decorations (background, message) only for active line. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsfollowcursoroverride)",
					"default": true
				},
				"errorLens.gutterIconSize": {
					"type": "string",
					"markdownDescription": "Change gutter icon size. Examples: `auto`, `contain`, `cover`, `50%`, `150%` ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/background-size)). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsize)",
					"examples": [
						"auto",
						"contain",
						"cover",
						"50%",
						"150%"
					],
					"default": "100%"
				},
				"errorLens.gutterIconSet": {
					"type": "string",
					"markdownDescription": "Change gutter icon style. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonset)",
					"enum": [
						"default",
						"defaultOutline",
						"borderless",
						"circle",
						"square",
						"squareRounded",
						"letter",
						"emoji"
					],
					"enumDescriptions": [
						"Similar to vscode icons in Problems Panel (old).",
						"Similar to vscode icons in Problems Panel (new).",
						"Similar to vscode icons in Problems Panel, only without a border.",
						"Simple filled circle.",
						"Simple filled square.",
						"Simple filled square with rounded corners.",
						"Simple one letter icon (E,W,I,H).",
						"Emoji. (`errorLens.gutterEmoji` to control which emoji to show.)"
					],
					"default": "default"
				},
				"errorLens.gutterEmoji": {
					"type": "object",
					"properties": {
						"error": {
							"type": "string",
							"minLength": 0,
							"default": "💀"
						},
						"warning": {
							"type": "string",
							"minLength": 0,
							"default": "😞"
						},
						"info": {
							"type": "string",
							"minLength": 0,
							"default": "🆗"
						},
						"hint": {
							"type": "string",
							"minLength": 0,
							"default": "🍏"
						}
					},
					"default": {
						"error": "💀",
						"warning": "😞",
						"info": "🆗",
						"hint": "🍏"
					},
					"additionalProperties": false,
					"markdownDescription": "Pick emoji symbol for gutter icon when `#errorLens.gutterIconSet#` is `emoji`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensgutteremoji)"
				},
				"errorLens.errorGutterIconPath": {
					"type": "string",
					"markdownDescription": "Absolute path to error gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)",
					"default": ""
				},
				"errorLens.warningGutterIconPath": {
					"type": "string",
					"markdownDescription": "Absolute path to warning gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)",
					"default": ""
				},
				"errorLens.infoGutterIconPath": {
					"type": "string",
					"markdownDescription": "Absolute path to info gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)",
					"default": ""
				},
				"errorLens.hintGutterIconPath": {
					"type": "string",
					"markdownDescription": "Absolute path to hint gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)",
					"default": ""
				},
				"errorLens.errorGutterIconColor": {
					"type": "string",
					"default": "#e45454",
					"markdownDescription": "Error color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)",
					"format": "color"
				},
				"errorLens.warningGutterIconColor": {
					"type": "string",
					"default": "#ff942f",
					"markdownDescription": "Warning color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)",
					"format": "color"
				},
				"errorLens.infoGutterIconColor": {
					"type": "string",
					"default": "#00b7e4",
					"markdownDescription": "Info color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)",
					"format": "color"
				},
				"errorLens.hintGutterIconColor": {
					"type": "string",
					"default": "#2faf64",
					"markdownDescription": "Hint color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)",
					"format": "color"
				},
				"errorLens.removeLinebreaks": {
					"type": "boolean",
					"default": true,
					"markdownDescription": "When enabled - replaces line breaks in inline diagnostic message with whitespaces."
				},
				"errorLens.replaceLinebreaksSymbol": {
					"type": "string",
					"default": "⏎",
					"markdownDescription": "Symbol to replace linebreaks. Requires enabling `#errorLens.removeLinebreaks#`."
				},
				"errorLens.scrollbarHackEnabled": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "When enabled - prevents showing horizontal scrollbar in editor (caused by inline decorations). Also prevents mouse hover at inline message. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensscrollbarhackenabled)"
				},
				"errorLens.decorations": {
					"type": "object",
					"markdownDescription": "Advanced decoration tweaking. Possible keys: `errorRange`, `warningRange`, `infoRange`, `hintRange`, `errorMessage`, `warningMessage`, `infoMessage`, `hintMessage`.\n\n Possible properties: `backgroundColor`, `color`, `outline`, `border`, ... [api](https://code.visualstudio.com/api/references/vscode-api#ThemableDecorationAttachmentRenderOptions). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensdecorations)",
					"default": {
						"errorRange": {},
						"warningRange": {},
						"infoRange": {},
						"hintRange": {},
						"errorMessage": {},
						"warningMessage": {},
						"infoMessage": {},
						"hintMessage": {}
					},
					"patternProperties": {
						"^(errorRange|warningRange|infoRange|hintRange|errorMessage|warningMessage|infoMessage|hintMessage)$": {
							"type": "object",
							"markdownDescription": "☑️ Key exists.",
							"properties": {}
						}
					},
					"additionalProperties": false
				},
				"errorLens.ignoreUntitled": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "Controls whether to run on untitled (unsaved) files."
				},
				"errorLens.ignoreDirty": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "Controls whether to run on dirty (modified unsaved) files."
				},
				"errorLens.codeLensEnabled": {
					"type": "boolean",
					"default": false,
					"markdownDescription": "Controls whether to show the Error Lens as a Code Lens above the code. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenscodelensenabled)"
				},
				"errorLens.codeLensLength": {
					"type": "object",
					"properties": {
						"min": {
							"type": "integer",
							"minimum": 0,
							"default": 0
						},
						"max": {
							"type": "integer",
							"minimum": 10,
							"default": 200
						}
					},
					"additionalProperties": false,
					"default": {
						"min": 0,
						"max": 200
					},
					"markdownDescription": "Enforce minimum and maximum length of code lens messages."
				},
				"errorLens.codeLensTemplate": {
					"type": "string",
					"default": "$severity $message",
					"markdownDescription": "Template used for all messages appearing in the `#errorLens.codeLensEnabled#`. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic"
				},
				"errorLens.codeLensOnClick": {
					"type": "string",
					"enum": [
						"none",
						"showProblemsView",
						"showQuickFix",
						"searchForProblem"
					],
					"enumDescriptions": [
						"Does nothing.",
						"Shows problems view.",
						"Shows quick fix menu.",
						"Search for the problem."
					],
					"default": "showQuickFix",
					"markdownDescription": "Controls what do on clicking the `#errorLens.codeLensEnabled#`."
				},
				"errorLens.experimental": {
					"type": "object",
					"properties": {},
					"tags": [
						"experimental"
					],
					"additionalProperties": false,
					"markdownDescription": "Experimental / temporary settings.",
					"default": {}
				}
			}
		},
		"colors": [
			{
				"id": "errorLens.errorBackground",
				"defaults": {
					"dark": "#e454541b",
					"light": "#e4545420",
					"highContrast": "#e454541b"
				},
				"description": "Background color of the entire line containing error."
			},
			{
				"id": "errorLens.errorMessageBackground",
				"defaults": {
					"dark": "#e4545419",
					"light": "#e4545419",
					"highContrast": "#e4545419"
				},
				"description": "Background color of the error message."
			},
			{
				"id": "errorLens.errorRangeBackground",
				"defaults": {
					"dark": "#e4545419",
					"light": "#e4545419",
					"highContrast": "#e4545419"
				},
				"description": "Background color of the error range (when errorLens.problemRangeDecorationEnabled setting enabled)."
			},
			{
				"id": "errorLens.errorBackgroundLight",
				"defaults": {
					"dark": "#e4545420",
					"light": "#e4545420",
					"highContrast": "#e4545420"
				},
				"description": "Background color of the entire line containing error (Only in light themes)."
			},
			{
				"id": "errorLens.errorForeground",
				"defaults": {
					"dark": "#ff6464",
					"light": "#e45454",
					"highContrast": "#ff6464"
				},
				"description": "Text color used to highlight lines containing errors."
			},
			{
				"id": "errorLens.errorForegroundLight",
				"defaults": {
					"dark": "#e45454",
					"light": "#e45454",
					"highContrast": "#e45454"
				},
				"description": "Text color used to highlight lines containing errors (Only in light themes)."
			},
			{
				"id": "errorLens.warningBackground",
				"defaults": {
					"dark": "#ff942f1b",
					"light": "#ff942f20",
					"highContrast": "#ff942f1b"
				},
				"description": "Background color used to highlight lines containing warnings."
			},
			{
				"id": "errorLens.warningMessageBackground",
				"defaults": {
					"dark": "#ff942f19",
					"light": "#ff942f19",
					"highContrast": "#ff942f19"
				},
				"description": "Background color of the warning message."
			},
			{
				"id": "errorLens.warningRangeBackground",
				"defaults": {
					"dark": "#ff942f19",
					"light": "#ff942f19",
					"highContrast": "#ff942f19"
				},
				"description": "Background color of the warning range (when errorLens.problemRangeDecorationEnabled setting enabled)."
			},
			{
				"id": "errorLens.warningBackgroundLight",
				"defaults": {
					"dark": "#ff942f20",
					"light": "#ff942f20",
					"highContrast": "#ff942f20"
				},
				"description": "Background color used to highlight lines containing warnings (Only in light themes)."
			},
			{
				"id": "errorLens.warningForeground",
				"defaults": {
					"dark": "#fa973a",
					"light": "#ff942f",
					"highContrast": "#fa973a"
				},
				"description": "Text color used to highlight lines containing warnings."
			},
			{
				"id": "errorLens.warningForegroundLight",
				"defaults": {
					"dark": "#ff942f",
					"light": "#ff942f",
					"highContrast": "#ff942f"
				},
				"description": "Text color used to highlight lines containing warnings (Only in light themes)."
			},
			{
				"id": "errorLens.infoBackground",
				"defaults": {
					"dark": "#00b7e420",
					"light": "#00b7e420",
					"highContrast": "#00b7e420"
				},
				"description": "Background color used to highlight lines containing info."
			},
			{
				"id": "errorLens.infoMessageBackground",
				"defaults": {
					"dark": "#00b7e419",
					"light": "#00b7e419",
					"highContrast": "#00b7e419"
				},
				"description": "Background color of the info message."
			},
			{
				"id": "errorLens.infoRangeBackground",
				"defaults": {
					"dark": "#00b7e419",
					"light": "#00b7e419",
					"highContrast": "#00b7e419"
				},
				"description": "Background color of the info range (when errorLens.problemRangeDecorationEnabled setting enabled)."
			},
			{
				"id": "errorLens.infoBackgroundLight",
				"defaults": {
					"dark": "#00b7e420",
					"light": "#00b7e420",
					"highContrast": "#00b7e420"
				},
				"description": "Background color used to highlight lines containing info (Only in light themes)."
			},
			{
				"id": "errorLens.infoForeground",
				"defaults": {
					"dark": "#00b7e4",
					"light": "#00b7e4",
					"highContrast": "#00b7e4"
				},
				"description": "Text color used to highlight lines containing info."
			},
			{
				"id": "errorLens.infoForegroundLight",
				"defaults": {
					"dark": "#00b7e4",
					"light": "#00b7e4",
					"highContrast": "#00b7e4"
				},
				"description": "Text color used to highlight lines containing info (Only in light themes)."
			},
			{
				"id": "errorLens.hintBackground",
				"defaults": {
					"dark": "#17a2a220",
					"light": "#17a2a220",
					"highContrast": "#17a2a220"
				},
				"description": "Background color used to highlight lines containing hints."
			},
			{
				"id": "errorLens.hintMessageBackground",
				"defaults": {
					"dark": "#17a2a219",
					"light": "#17a2a219",
					"highContrast": "#17a2a219"
				},
				"description": "Background color of the hint message."
			},
			{
				"id": "errorLens.hintRangeBackground",
				"defaults": {
					"dark": "#17a2a219",
					"light": "#17a2a219",
					"highContrast": "#17a2a219"
				},
				"description": "Background color of the hint range (when errorLens.problemRangeDecorationEnabled setting enabled)."
			},
			{
				"id": "errorLens.hintBackgroundLight",
				"defaults": {
					"dark": "#17a2a220",
					"light": "#17a2a220",
					"highContrast": "#17a2a220"
				},
				"description": "Background color used to highlight lines containing hints (Only in light themes)."
			},
			{
				"id": "errorLens.hintForeground",
				"defaults": {
					"dark": "#2faf64",
					"light": "#2faf64",
					"highContrast": "#2faf64"
				},
				"description": "Text color used to highlight lines containing hints."
			},
			{
				"id": "errorLens.hintForegroundLight",
				"defaults": {
					"dark": "#2faf64",
					"light": "#2faf64",
					"highContrast": "#2faf64"
				},
				"description": "Text color used to highlight lines containing hints (Only in light themes)."
			},
			{
				"id": "errorLens.statusBarIconErrorForeground",
				"defaults": {
					"dark": "#ff6464",
					"light": "#e45454",
					"highContrast": "#ff6464"
				},
				"description": "Status bar icon item error color. Foreground is used when the `errorLens.statusBarIconsUseBackground` setting is disabled."
			},
			{
				"id": "errorLens.statusBarIconWarningForeground",
				"defaults": {
					"dark": "#fa973a",
					"light": "#ff942f",
					"highContrast": "#fa973a"
				},
				"description": "Status bar icon item error color. Foreground is used when the `errorLens.statusBarIconsUseBackground` setting is disabled."
			},
			{
				"id": "errorLens.statusBarErrorForeground",
				"defaults": {
					"dark": "#ff6464",
					"light": "#e45454",
					"highContrast": "#ff6464"
				},
				"description": "Status bar item error color."
			},
			{
				"id": "errorLens.statusBarWarningForeground",
				"defaults": {
					"dark": "#fa973a",
					"light": "#ff942f",
					"highContrast": "#fa973a"
				},
				"description": "Status bar item warning color."
			},
			{
				"id": "errorLens.statusBarInfoForeground",
				"defaults": {
					"dark": "#00b7e4",
					"light": "#00b7e4",
					"highContrast": "#00b7e4"
				},
				"description": "Status bar item info color."
			},
			{
				"id": "errorLens.statusBarHintForeground",
				"defaults": {
					"dark": "#2faf64",
					"light": "#2faf64",
					"highContrast": "#2faf64"
				},
				"description": "Status bar item hint color."
			}
		]
	},
	"scripts": {
		"vscode:prepublish": "webpack --mode production --color --devtool hidden-source-map",
		"watch": "webpack --mode development --watch --stats minimal"
	},
	"devDependencies": {
		"@soda/friendly-errors-webpack-plugin": "^1.8.1",
		"@types/lodash": "^4.17.16",
		"@types/node": "^22.19.3",
		"@types/vscode": "^1.107.0",
		"@typescript-eslint/eslint-plugin": "^5.62.0",
		"@typescript-eslint/parser": "^5.62.0",
		"eslint": "^8.57.1",
		"ts-loader": "^9.5.2",
		"typescript": "^5.8.2",
		"webpack": "^5.98.0",
		"webpack-cli": "^6.0.1"
	},
	"dependencies": {
		"lodash": "^4.17.21"
	}
}
; },
};

const __extension = {"commands":{"errorLens.copyProblemCode":"Copy Problem Code","errorLens.copyProblemMessage":"Copy Problem Message","errorLens.disableLine":"Disable line","errorLens.excludeProblem":"Exclude Problem","errorLens.findLinterRuleDefinition":"Find Linter Rule Definition","errorLens.searchForProblem":"Search for problem","errorLens.selectProblem":"Select Problem","errorLens.toggle":"Toggle (Enable/Disable) Everything","errorLens.toggleError":"Toggle Errors","errorLens.toggleHint":"Toggle Hint","errorLens.toggleInfo":"Toggle Info","errorLens.toggleInlineMessage":"Toggle Inline Message","errorLens.toggleWarning":"Toggle Warnings","errorLens.updateEverything":"Update Everything","errorlens.toggleWorkspace":"Toggle Workspace in Disabled List"},"configuration":{"errorLens.alignMessage":{"end":0,"minimumMargin":4,"padding":[0,0],"start":0,"useFixedPosition":true},"errorLens.border":["","","",""],"errorLens.borderRadius":"0.2em","errorLens.codeLensEnabled":false,"errorLens.codeLensLength":{"max":200,"min":0},"errorLens.codeLensOnClick":"showQuickFix","errorLens.codeLensTemplate":"$severity $message","errorLens.decorations":{"errorMessage":{},"errorRange":{},"hintMessage":{},"hintRange":{},"infoMessage":{},"infoRange":{},"warningMessage":{},"warningRange":{}},"errorLens.delay":0,"errorLens.delayMode":"new","errorLens.disableLineComments":{"Stylelint":"/* stylelint-disable-next-line $code */","eslint":"// eslint-disable-next-line $code"},"errorLens.editorHoverPartsEnabled":{"buttonsEnabled":false,"messageEnabled":false,"sourceCodeEnabled":false},"errorLens.enableOnDiffView":false,"errorLens.enabled":true,"errorLens.enabledDiagnosticLevels":["error","warning","info"],"errorLens.enabledInMergeConflict":true,"errorLens.errorGutterIconColor":"#e45454","errorLens.errorGutterIconPath":"","errorLens.excludeByMessage":[],"errorLens.excludeBySource":[],"errorLens.excludePatterns":[],"errorLens.excludeWorkspaces":[],"errorLens.experimental":{},"errorLens.followCursor":"allLines","errorLens.followCursorMore":0,"errorLens.fontFamily":"","errorLens.fontSize":"","errorLens.fontStyleItalic":false,"errorLens.fontWeight":"normal","errorLens.gutterEmoji":{"error":"💀","hint":"🍏","info":"🆗","warning":"😞"},"errorLens.gutterIconSet":"default","errorLens.gutterIconSize":"100%","errorLens.gutterIconsEnabled":false,"errorLens.gutterIconsFollowCursorOverride":true,"errorLens.hintGutterIconColor":"#2faf64","errorLens.hintGutterIconPath":"","errorLens.ignoreDirty":false,"errorLens.ignoreUntitled":false,"errorLens.infoGutterIconColor":"#00b7e4","errorLens.infoGutterIconPath":"","errorLens.light":{},"errorLens.lintFilePaths":{"Stylelint":["**/*.stylelintrc","**/*.stylelintrc.{cjs,js,json,yaml,yml}","**/*stylelint.config.{cjs,js}","**/*package.json"],"eslint":["**/*eslint.config.{js,mjs,cjs,ts,mts,cts}","**/*.eslintrc.{js,cjs,yaml,yml,json}","**/*package.json"]},"errorLens.margin":"4ch","errorLens.maxInlineMessages":1000,"errorLens.messageBackgroundMode":"line","errorLens.messageEnabled":true,"errorLens.messageMaxChars":500,"errorLens.messageTemplate":"$message","errorLens.onSave":false,"errorLens.onSaveTimeout":500,"errorLens.onSaveUpdateOnActiveEditorChange":true,"errorLens.padding":"","errorLens.problemRangeDecorationEnabled":false,"errorLens.removeLinebreaks":true,"errorLens.replace":[],"errorLens.replaceLinebreaksSymbol":"⏎","errorLens.respectUpstreamEnabled":{"enabled":true,"gutter":true,"inlineMessage":true,"statusBar":false},"errorLens.scrollbarHackEnabled":false,"errorLens.searchForProblemQuery":"https://duckduckgo.com/?q=$message","errorLens.selectProblemType":"closestProblem","errorLens.severityText":["⛔","⚠","ℹ","🍏"],"errorLens.statusBarColorsEnabled":false,"errorLens.statusBarCommand":"goToProblem","errorLens.statusBarIconsAlignment":"left","errorLens.statusBarIconsAtZero":"removeBackground","errorLens.statusBarIconsEnabled":false,"errorLens.statusBarIconsPriority":-9000,"errorLens.statusBarIconsTargetProblems":"all","errorLens.statusBarIconsUseBackground":true,"errorLens.statusBarMessageAlignment":"left","errorLens.statusBarMessageEnabled":false,"errorLens.statusBarMessagePriority":-10000,"errorLens.statusBarMessageTemplate":"","errorLens.statusBarMessageType":"activeLine","errorLens.transmute":{},"errorLens.warningGutterIconColor":"#ff942f","errorLens.warningGutterIconPath":""},"entry":"dist/extension.js","grammars":[],"id":"usernamehw.errorlens","languages":[],"name":"Error Lens","packageJSON":{"activationEvents":["onStartupFinished"],"browser":"./dist/extension.js","categories":["Other"],"contributes":{"colors":[{"defaults":{"dark":"#e454541b","highContrast":"#e454541b","light":"#e4545420"},"description":"Background color of the entire line containing error.","id":"errorLens.errorBackground"},{"defaults":{"dark":"#e4545419","highContrast":"#e4545419","light":"#e4545419"},"description":"Background color of the error message.","id":"errorLens.errorMessageBackground"},{"defaults":{"dark":"#e4545419","highContrast":"#e4545419","light":"#e4545419"},"description":"Background color of the error range (when errorLens.problemRangeDecorationEnabled setting enabled).","id":"errorLens.errorRangeBackground"},{"defaults":{"dark":"#e4545420","highContrast":"#e4545420","light":"#e4545420"},"description":"Background color of the entire line containing error (Only in light themes).","id":"errorLens.errorBackgroundLight"},{"defaults":{"dark":"#ff6464","highContrast":"#ff6464","light":"#e45454"},"description":"Text color used to highlight lines containing errors.","id":"errorLens.errorForeground"},{"defaults":{"dark":"#e45454","highContrast":"#e45454","light":"#e45454"},"description":"Text color used to highlight lines containing errors (Only in light themes).","id":"errorLens.errorForegroundLight"},{"defaults":{"dark":"#ff942f1b","highContrast":"#ff942f1b","light":"#ff942f20"},"description":"Background color used to highlight lines containing warnings.","id":"errorLens.warningBackground"},{"defaults":{"dark":"#ff942f19","highContrast":"#ff942f19","light":"#ff942f19"},"description":"Background color of the warning message.","id":"errorLens.warningMessageBackground"},{"defaults":{"dark":"#ff942f19","highContrast":"#ff942f19","light":"#ff942f19"},"description":"Background color of the warning range (when errorLens.problemRangeDecorationEnabled setting enabled).","id":"errorLens.warningRangeBackground"},{"defaults":{"dark":"#ff942f20","highContrast":"#ff942f20","light":"#ff942f20"},"description":"Background color used to highlight lines containing warnings (Only in light themes).","id":"errorLens.warningBackgroundLight"},{"defaults":{"dark":"#fa973a","highContrast":"#fa973a","light":"#ff942f"},"description":"Text color used to highlight lines containing warnings.","id":"errorLens.warningForeground"},{"defaults":{"dark":"#ff942f","highContrast":"#ff942f","light":"#ff942f"},"description":"Text color used to highlight lines containing warnings (Only in light themes).","id":"errorLens.warningForegroundLight"},{"defaults":{"dark":"#00b7e420","highContrast":"#00b7e420","light":"#00b7e420"},"description":"Background color used to highlight lines containing info.","id":"errorLens.infoBackground"},{"defaults":{"dark":"#00b7e419","highContrast":"#00b7e419","light":"#00b7e419"},"description":"Background color of the info message.","id":"errorLens.infoMessageBackground"},{"defaults":{"dark":"#00b7e419","highContrast":"#00b7e419","light":"#00b7e419"},"description":"Background color of the info range (when errorLens.problemRangeDecorationEnabled setting enabled).","id":"errorLens.infoRangeBackground"},{"defaults":{"dark":"#00b7e420","highContrast":"#00b7e420","light":"#00b7e420"},"description":"Background color used to highlight lines containing info (Only in light themes).","id":"errorLens.infoBackgroundLight"},{"defaults":{"dark":"#00b7e4","highContrast":"#00b7e4","light":"#00b7e4"},"description":"Text color used to highlight lines containing info.","id":"errorLens.infoForeground"},{"defaults":{"dark":"#00b7e4","highContrast":"#00b7e4","light":"#00b7e4"},"description":"Text color used to highlight lines containing info (Only in light themes).","id":"errorLens.infoForegroundLight"},{"defaults":{"dark":"#17a2a220","highContrast":"#17a2a220","light":"#17a2a220"},"description":"Background color used to highlight lines containing hints.","id":"errorLens.hintBackground"},{"defaults":{"dark":"#17a2a219","highContrast":"#17a2a219","light":"#17a2a219"},"description":"Background color of the hint message.","id":"errorLens.hintMessageBackground"},{"defaults":{"dark":"#17a2a219","highContrast":"#17a2a219","light":"#17a2a219"},"description":"Background color of the hint range (when errorLens.problemRangeDecorationEnabled setting enabled).","id":"errorLens.hintRangeBackground"},{"defaults":{"dark":"#17a2a220","highContrast":"#17a2a220","light":"#17a2a220"},"description":"Background color used to highlight lines containing hints (Only in light themes).","id":"errorLens.hintBackgroundLight"},{"defaults":{"dark":"#2faf64","highContrast":"#2faf64","light":"#2faf64"},"description":"Text color used to highlight lines containing hints.","id":"errorLens.hintForeground"},{"defaults":{"dark":"#2faf64","highContrast":"#2faf64","light":"#2faf64"},"description":"Text color used to highlight lines containing hints (Only in light themes).","id":"errorLens.hintForegroundLight"},{"defaults":{"dark":"#ff6464","highContrast":"#ff6464","light":"#e45454"},"description":"Status bar icon item error color. Foreground is used when the `errorLens.statusBarIconsUseBackground` setting is disabled.","id":"errorLens.statusBarIconErrorForeground"},{"defaults":{"dark":"#fa973a","highContrast":"#fa973a","light":"#ff942f"},"description":"Status bar icon item error color. Foreground is used when the `errorLens.statusBarIconsUseBackground` setting is disabled.","id":"errorLens.statusBarIconWarningForeground"},{"defaults":{"dark":"#ff6464","highContrast":"#ff6464","light":"#e45454"},"description":"Status bar item error color.","id":"errorLens.statusBarErrorForeground"},{"defaults":{"dark":"#fa973a","highContrast":"#fa973a","light":"#ff942f"},"description":"Status bar item warning color.","id":"errorLens.statusBarWarningForeground"},{"defaults":{"dark":"#00b7e4","highContrast":"#00b7e4","light":"#00b7e4"},"description":"Status bar item info color.","id":"errorLens.statusBarInfoForeground"},{"defaults":{"dark":"#2faf64","highContrast":"#2faf64","light":"#2faf64"},"description":"Status bar item hint color.","id":"errorLens.statusBarHintForeground"}],"commands":[{"category":"Error Lens","command":"errorLens.toggle","description":"Toggle (Enable/Disable) Everything (toggle global setting `\"errorLens.enabled\"`)","title":"Toggle (Enable/Disable) Everything"},{"category":"Error Lens","command":"errorLens.toggleError","description":"Enable/Disable Errors in `\"errorLens.enabledDiagnosticLevels\"` setting.","title":"Toggle Errors"},{"category":"Error Lens","command":"errorLens.toggleWarning","description":"Enable/Disable Warnings in `\"errorLens.enabledDiagnosticLevels\"` setting.","title":"Toggle Warnings"},{"category":"Error Lens","command":"errorLens.toggleInfo","description":"Enable/Disable Info in `\"errorLens.enabledDiagnosticLevels\"` setting.","title":"Toggle Info"},{"category":"Error Lens","command":"errorLens.toggleHint","description":"Enable/Disable Hint in `\"errorLens.enabledDiagnosticLevels\"` setting.","title":"Toggle Hint"},{"category":"Error Lens","command":"errorLens.toggleInlineMessage","description":"Toggle global setting `\"errorLens.messageEnabled\"`.","title":"Toggle Inline Message"},{"category":"Error Lens","command":"errorLens.searchForProblem","description":"Open problem in default browser (controlled by `errorLens.searchForProblemQuery` setting).","title":"Search for problem"},{"category":"Error Lens","command":"errorLens.selectProblem","description":"Set editor selection to the problem range (controlled by `errorLens.selectProblemType` setting).","title":"Select Problem"},{"category":"Error Lens","command":"errorlens.toggleWorkspace","description":"Exclude/Include current workspace by fs path.","title":"Toggle Workspace in Disabled List"},{"category":"Error Lens","command":"errorLens.disableLine","description":"Add a comment to disable line for linter rule. Comment format is controlled by `\"errorLens.disableLineComments\"` setting.","title":"Disable line"},{"category":"Error Lens","command":"errorLens.findLinterRuleDefinition","description":"Search in local linter files (like `.eslintrc.json`) for the rule definition. Target files are controlled by \"errorLens.lintFilePaths\" setting.","title":"Find Linter Rule Definition"},{"category":"Error Lens","command":"errorLens.copyProblemMessage","description":"Copy problem message to the clipboard (at the active cursor).","title":"Copy Problem Message"},{"category":"Error Lens","command":"errorLens.excludeProblem","description":"Exclude problem (at the active cursor) (write into settings).","title":"Exclude Problem"},{"category":"Error Lens","command":"errorLens.copyProblemCode","description":"Copy problem code to the clipboard (at the active cursor).","title":"Copy Problem Code"},{"category":"Error Lens","command":"errorLens.updateEverything","description":"Update all decorations. Supports args {\"kind\": \"update\" | \"clear\"}","title":"Update Everything"}],"configuration":{"properties":{"errorLens.alignMessage":{"additionalProperties":false,"default":{"end":0,"minimumMargin":4,"padding":[0,0],"start":0,"useFixedPosition":true},"markdownDescription":"Align inline error message (either by starting position or ending position). Only works for monospace fonts. Set \"start\" and \"end\" to **0** to disable. ❗Will conflict with other extension decorations. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensalignmessage)","properties":{"end":{"description":"Ending column where to align decorations.","minimum":0,"type":"integer"},"minimumMargin":{"description":"Minimal space between line end and decoration. Very similar to the global setting `errorLens.margin`, but can only be a number of characters.","minimum":4,"type":"integer"},"padding":{"default":[0,0],"description":"Very similar to the global setting `errorLens.padding`, but it can only be a number (not any CSS unit like pixels). First number is top+bottom padding; Second number - left+right padding.","items":{"default":0,"minimum":0,"type":"number"},"maxItems":2,"minItems":2,"type":"array"},"start":{"description":"Starting column where to align decorations.","minimum":0,"type":"integer"},"useFixedPosition":{"default":true,"description":"Use fixed position for decoration that has stuttering/twitching on the active line (e.g. when typing). Will prevent hover over decoration text.","type":"boolean"}},"type":"object"},"errorLens.border":{"additionalItems":false,"default":["","","",""],"items":{"default":"","type":"string"},"markdownDescription":"Border of the inline message. Examples: `1px solid`, `1px dashed`, `2px dotted`, `1px solid #00000050`... Set to empty string to disable. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensborder)","maxItems":4,"minItems":4,"type":"array"},"errorLens.borderRadius":{"default":"0.2em","examples":["5px","5em 0px","0px 5em 5em 0px"],"markdownDescription":"Border radius of the inline message. Visible when `#errorLens.messageBackgroundMode#` is set to \"message\". [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensborderradius)","type":"string"},"errorLens.codeLensEnabled":{"default":false,"markdownDescription":"Controls whether to show the Error Lens as a Code Lens above the code. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenscodelensenabled)","type":"boolean"},"errorLens.codeLensLength":{"additionalProperties":false,"default":{"max":200,"min":0},"markdownDescription":"Enforce minimum and maximum length of code lens messages.","properties":{"max":{"default":200,"minimum":10,"type":"integer"},"min":{"default":0,"minimum":0,"type":"integer"}},"type":"object"},"errorLens.codeLensOnClick":{"default":"showQuickFix","enum":["none","showProblemsView","showQuickFix","searchForProblem"],"enumDescriptions":["Does nothing.","Shows problems view.","Shows quick fix menu.","Search for the problem."],"markdownDescription":"Controls what do on clicking the `#errorLens.codeLensEnabled#`.","type":"string"},"errorLens.codeLensTemplate":{"default":"$severity $message","markdownDescription":"Template used for all messages appearing in the `#errorLens.codeLensEnabled#`. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic","type":"string"},"errorLens.decorations":{"additionalProperties":false,"default":{"errorMessage":{},"errorRange":{},"hintMessage":{},"hintRange":{},"infoMessage":{},"infoRange":{},"warningMessage":{},"warningRange":{}},"markdownDescription":"Advanced decoration tweaking. Possible keys: `errorRange`, `warningRange`, `infoRange`, `hintRange`, `errorMessage`, `warningMessage`, `infoMessage`, `hintMessage`.\n\n Possible properties: `backgroundColor`, `color`, `outline`, `border`, ... [api](https://code.visualstudio.com/api/references/vscode-api#ThemableDecorationAttachmentRenderOptions). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensdecorations)","patternProperties":{"^(errorRange|warningRange|infoRange|hintRange|errorMessage|warningMessage|infoMessage|hintMessage)$":{"markdownDescription":"☑️ Key exists.","properties":{},"type":"object"}},"type":"object"},"errorLens.delay":{"default":0,"markdownDescription":"Delay (ms) before showing problem decorations (**0** to disable). Minimum delay of **500** is enforced by the extension. `#errorLens.delayMode#` controls how to handle the delay.","type":"integer"},"errorLens.delayMode":{"default":"new","enum":["new","old","debounce"],"markdownDescription":"Pick which version of the delay to use.","markdownEnumDescriptions":["New problems appear according to `errorLens.delay` setting. Fixed problems disappear faster.","Decorations for problems are debounced according to `errorLens.delay` setting.","Decorations disappear when document changes (typing)."],"type":"string"},"errorLens.disableLineComments":{"default":{"Stylelint":"/* stylelint-disable-next-line $code */","eslint":"// eslint-disable-next-line $code"},"markdownDescription":"Used for `errorLens.disableLine` command that adds a comment disabling linter rule for a line.\nTo force comment on the same line - add `SAME_LINE` to the message: `\"eslint\": \"// eslint-disable-line $code SAME_LINE\"`","patternProperties":{".*":{"type":"string"}},"type":"object"},"errorLens.editorHoverPartsEnabled":{"additionalProperties":false,"default":{"buttonsEnabled":false,"messageEnabled":false,"sourceCodeEnabled":false},"markdownDescription":"Controls which parts of the editor hover tooltip to show.","properties":{"buttonsEnabled":{"default":false,"type":"boolean"},"messageEnabled":{"default":false,"type":"boolean"},"sourceCodeEnabled":{"default":false,"type":"boolean"}},"type":"object"},"errorLens.enableOnDiffView":{"default":false,"markdownDescription":"Enable decorations when viewing a diff view in the editor (e.g. Git diff). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensenableondiffview)","type":"boolean"},"errorLens.enabled":{"default":true,"markdownDescription":"Controls all decorations and features (except commands).","type":"boolean"},"errorLens.enabledDiagnosticLevels":{"default":["error","warning","info"],"items":{"enum":["error","warning","info","hint"],"type":"string"},"markdownDescription":"Customize which diagnostic levels(severity) to highlight. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensenableddiagnosticlevels)","type":"array","uniqueItems":true},"errorLens.enabledInMergeConflict":{"default":true,"markdownDescription":"Controls if decorations are shown if the editor has git merge conflict indicators `<<<<<<<` or `=======` or `>>>>>>>`.","type":"boolean"},"errorLens.errorGutterIconColor":{"default":"#e45454","format":"color","markdownDescription":"Error color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)","type":"string"},"errorLens.errorGutterIconPath":{"default":"","markdownDescription":"Absolute path to error gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)","type":"string"},"errorLens.excludeByMessage":{"default":[],"items":{"oneOf":[{"default":"","type":"string"},{"additionalProperties":false,"default":{"flags":"iu","regex":""},"properties":{"flags":{"default":"iu","type":"string"},"regex":{"default":"","type":"string"}},"type":"object"}]},"markdownDescription":"Exclude diagnostics by message. Excludes when the diagnostic message contains the excluding string (case-insensitive). Can use Regular Expressions (use object instead of a string).","type":"array"},"errorLens.excludeBySource":{"default":[],"items":{"type":"string"},"markdownDescription":"Specify `source` or `source(code)` pair to exclude. Examples: \n\n```json\n[\n\t\"eslint\",// exclude all problems from eslint linter\n\t\"eslint(padded-blocks)\",// exclude padded-blocks rule from eslint linter\n\t\"Pylance(reportUndefinedVariable)\",// exlude reportUndefinedVariable rule from Pylance linter\n]\n```","type":"array"},"errorLens.excludePatterns":{"default":[],"items":{"type":"string"},"markdownDescription":"Exclude files by using [glob](https://code.visualstudio.com/docs/editor/glob-patterns) pattern. Example `[\"**/*.{ts,js}\"]`","type":"array"},"errorLens.excludeWorkspaces":{"default":[],"items":{"type":"string"},"markdownDescription":"Exclude workspaces by path.","type":"array"},"errorLens.experimental":{"additionalProperties":false,"default":{},"markdownDescription":"Experimental / temporary settings.","properties":{},"tags":["experimental"],"type":"object"},"errorLens.followCursor":{"default":"allLines","enum":["allLines","allLinesExceptActive","activeLine","closestProblem"],"enumDescriptions":["Highlight all problems in file","Highlight all problems in file (except the line at the cursor)","Highlight only the problem at the cursor","Highlight only closest to the cursor problem"],"markdownDescription":"Highlight only portion of the problems. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfollowcursor)","type":"string"},"errorLens.followCursorMore":{"default":0,"markdownDescription":"Augments `#errorLens.followCursor#`.\nAdds number of lines to top and bottom when `#errorLens.followCursor#` is set to `activeLine`.\n Adds number of closest problems when `#errorLens.followCursor#` is `closestProblem` [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfollowcursormore)","type":"number"},"errorLens.fontFamily":{"default":"","markdownDescription":"Font family of inline message. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontfamily). May break `#errorLens.alignMessage#`","type":"string"},"errorLens.fontSize":{"default":"","markdownDescription":"Font size of inline message ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/length)). Use negative value to have it relative to the editor's fontSize (e.g. `-3px`). May break `#errorLens.alignMessage#`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontsize).","type":"string"},"errorLens.fontStyleItalic":{"default":false,"markdownDescription":"When enabled - shows inline message in italic font style. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontstyleitalic)","type":"boolean"},"errorLens.fontWeight":{"default":"normal","enum":["100","200","300","400","normal","500","600","700","bold","800","900"],"markdownDescription":"Font weight of inline message. (`\"normal\"` is alias for 400, `\"bold\"` is alias for 700). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensfontweight)","type":"string"},"errorLens.gutterEmoji":{"additionalProperties":false,"default":{"error":"💀","hint":"🍏","info":"🆗","warning":"😞"},"markdownDescription":"Pick emoji symbol for gutter icon when `#errorLens.gutterIconSet#` is `emoji`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensgutteremoji)","properties":{"error":{"default":"💀","minLength":0,"type":"string"},"hint":{"default":"🍏","minLength":0,"type":"string"},"info":{"default":"🆗","minLength":0,"type":"string"},"warning":{"default":"😞","minLength":0,"type":"string"}},"type":"object"},"errorLens.gutterIconSet":{"default":"default","enum":["default","defaultOutline","borderless","circle","square","squareRounded","letter","emoji"],"enumDescriptions":["Similar to vscode icons in Problems Panel (old).","Similar to vscode icons in Problems Panel (new).","Similar to vscode icons in Problems Panel, only without a border.","Simple filled circle.","Simple filled square.","Simple filled square with rounded corners.","Simple one letter icon (E,W,I,H).","Emoji. (`errorLens.gutterEmoji` to control which emoji to show.)"],"markdownDescription":"Change gutter icon style. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonset)","type":"string"},"errorLens.gutterIconSize":{"default":"100%","examples":["auto","contain","cover","50%","150%"],"markdownDescription":"Change gutter icon size. Examples: `auto`, `contain`, `cover`, `50%`, `150%` ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/background-size)). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsize)","type":"string"},"errorLens.gutterIconsEnabled":{"default":false,"markdownDescription":"When enabled - shows gutter icons (In place of the debug breakpoint icon). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsenabled)","type":"boolean"},"errorLens.gutterIconsFollowCursorOverride":{"default":true,"markdownDescription":"When enabled and `#errorLens.followCursor#` setting is not `allLines`, then gutter icons would be rendered for all problems. But line decorations (background, message) only for active line. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensguttericonsfollowcursoroverride)","type":"boolean"},"errorLens.hintGutterIconColor":{"default":"#2faf64","format":"color","markdownDescription":"Hint color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)","type":"string"},"errorLens.hintGutterIconPath":{"default":"","markdownDescription":"Absolute path to hint gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)","type":"string"},"errorLens.ignoreDirty":{"default":false,"markdownDescription":"Controls whether to run on dirty (modified unsaved) files.","type":"boolean"},"errorLens.ignoreUntitled":{"default":false,"markdownDescription":"Controls whether to run on untitled (unsaved) files.","type":"boolean"},"errorLens.infoGutterIconColor":{"default":"#00b7e4","format":"color","markdownDescription":"Info color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)","type":"string"},"errorLens.infoGutterIconPath":{"default":"","markdownDescription":"Absolute path to info gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)","type":"string"},"errorLens.light":{"markdownDescription":"Specify color of decorations for when the light color theme is active.","properties":{"errorGutterIconColor":{"default":"","format":"color","markdownDescription":"Error color of simple gutter icons (shapes and letters) for light themes.","type":"string"},"errorGutterIconPath":{"default":"","description":"Absolute path to error gutter icon for light themes.","type":"string"},"hintGutterIconColor":{"default":"","format":"color","markdownDescription":"Hint color of simple gutter icons (shapes and letters) for light themes.","type":"string"},"hintGutterIconPath":{"default":"","description":"Absolute path to hint gutter icon for light themes.","type":"string"},"infoGutterIconColor":{"default":"","format":"color","markdownDescription":"Info color of simple gutter icons (shapes and letters) for light themes.","type":"string"},"infoGutterIconPath":{"default":"","description":"Absolute path to info gutter icon for light themes.","type":"string"},"warningGutterIconColor":{"default":"","format":"color","markdownDescription":"Warning color of simple gutter icons (shapes and letters) for light themes.","type":"string"},"warningGutterIconPath":{"default":"","description":"Absolute path to warning gutter icon for light themes.","type":"string"}},"type":"object"},"errorLens.lintFilePaths":{"default":{"Stylelint":["**/*.stylelintrc","**/*.stylelintrc.{cjs,js,json,yaml,yml}","**/*stylelint.config.{cjs,js}","**/*package.json"],"eslint":["**/*eslint.config.{js,mjs,cjs,ts,mts,cts}","**/*.eslintrc.{js,cjs,yaml,yml,json}","**/*package.json"]},"markdownDescription":"Specify where to search for linter rule definitions by diagnostic source ([glob](https://code.visualstudio.com/docs/editor/glob-patterns) for local linter files). `node_modules` folder is excluded.","patternProperties":{".*":{"oneOf":[{"items":{"type":"string"},"type":"array"},{"enum":["none"],"type":"string"}]}},"type":"object"},"errorLens.margin":{"default":"4ch","markdownDescription":"Distance between the last word on the line and the start of inline message ([CSS units](https://developer.mozilla.org/en-US/docs/Web/CSS/length)). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmargin)","type":"string"},"errorLens.maxInlineMessages":{"default":1000,"markdownDescription":"Limit inline messages to the lines currently visible in the editor when a file has more lines with problems than this value. VSCode creates a separate set of CSS rules for every distinct inline message, so a file with thousands of problems can freeze the editor for a long time. Line highlighting, gutter icons, problem range decorations, hovers and status bar are not affected. `0` - no limit.","minimum":0,"type":"integer"},"errorLens.messageBackgroundMode":{"default":"line","enum":["line","message","none"],"enumDescriptions":["The entire line is highlighted.","Inline message is highlighted.","Message is not highlighted (only has foreground colors)."],"markdownDescription":"Controls how inline message is highlighted in the editor (entire line / only message / none). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagebackgroundmode)","type":"string"},"errorLens.messageEnabled":{"default":true,"markdownDescription":"Controls whether inline message is shown or not (Including background highlight). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessageenabled)","type":"boolean"},"errorLens.messageMaxChars":{"default":500,"markdownDescription":"Cut off inline message if it's longer than this value. (Improves performance when the diagnostic message is long). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagemaxchars)","minimum":0,"type":"integer"},"errorLens.messageTemplate":{"default":"$message","markdownDescription":"Template used for all inline messages. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensmessagetemplate)","type":"string"},"errorLens.onSave":{"default":false,"markdownDescription":"When enabled - updates decorations only on document save (manual).","type":"boolean"},"errorLens.onSaveTimeout":{"default":500,"markdownDescription":"Time period (ms) that used for showing decorations after the document save (manual, not auto save).","minimum":50,"type":"integer"},"errorLens.onSaveUpdateOnActiveEditorChange":{"default":true,"markdownDescription":"When `#errorLens.onSave#` enabled - extension still draws decorations when active/visible editors change.","type":"boolean"},"errorLens.padding":{"default":"","examples":["2px 1ch"],"markdownDescription":"Padding of the inline message. Visible when `#errorLens.messageBackgroundMode#` is set to \"message\". [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenspadding)","type":"string"},"errorLens.problemRangeDecorationEnabled":{"default":false,"markdownDescription":"When checked - highlight the entire problem range. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensproblemrangedecorationenabled)","type":"boolean"},"errorLens.removeLinebreaks":{"default":true,"markdownDescription":"When enabled - replaces line breaks in inline diagnostic message with whitespaces.","type":"boolean"},"errorLens.replace":{"default":[],"items":{"properties":{"matcher":{"description":"The RegExp pattern against which to match diagnostic messages","type":"string"},"message":{"description":"The entire replacement for messages matching matcher. Can reference match groups like $0 (entire expression), $1 (first capture group), etc.","type":"string"}},"required":["matcher","message"],"type":"object"},"markdownDescription":"Specify message to transform. E.g. if this is configured to [{ matcher: 'foo (.*)', message: 'just $1' }], the message 'foo bar' would be displayed as 'just bar'. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensreplace)","type":"array"},"errorLens.replaceLinebreaksSymbol":{"default":"⏎","markdownDescription":"Symbol to replace linebreaks. Requires enabling `#errorLens.removeLinebreaks#`.","type":"string"},"errorLens.respectUpstreamEnabled":{"additionalProperties":false,"default":{"enabled":true,"gutter":true,"inlineMessage":true,"statusBar":false},"markdownDescription":"When enabled - extension will take into account global VSCode setting `#problems.visibility#`. ([1.85.0 changelog](https://code.visualstudio.com/updates/v1_85#_hide-problem-decorations)).","properties":{"enabled":{"default":true,"description":"When true - extension will honour VSCode setting `#problems.visibility#` and not show errors if `#problems.visibility#` is false.","type":"boolean"},"gutter":{"default":true,"type":"boolean"},"inlineMessage":{"default":true,"type":"boolean"},"statusBar":{"default":false,"type":"boolean"}},"type":"object"},"errorLens.scrollbarHackEnabled":{"default":false,"markdownDescription":"When enabled - prevents showing horizontal scrollbar in editor (caused by inline decorations). Also prevents mouse hover at inline message. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensscrollbarhackenabled)","type":"boolean"},"errorLens.searchForProblemQuery":{"default":"https://duckduckgo.com/?q=$message","markdownDescription":"Pick query to open in default browser when searching for problem with `errorLens.searchForProblem` command.","type":"string"},"errorLens.selectProblemType":{"default":"closestProblem","enum":["closestProblem","closestSeverity","activeLine"],"enumDescriptions":["Show closest to the cursor diagnostic.","Show closest to the cursor diagnostic (sorted by severity e.g. error will be shown before warning even if it's farther from the cursor).","Show only diagnostic that is on the same line as the cursor."],"markdownDescription":"Which problem to select (closest / active line) when executing `errorLens.selectProblem` command.","type":"string"},"errorLens.severityText":{"default":["⛔","⚠","ℹ","🍏"],"items":{"type":"string"},"markdownDescription":"Replaces `$severity` variable in `#errorLens.messageTemplate#`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensseveritytext)","maxItems":4,"minItems":4,"type":"array"},"errorLens.statusBarColorsEnabled":{"default":false,"markdownDescription":"When enabled - use message decoration foreground as color of Status Bar text. Uses colors `errorLens.statusBarErrorForeground`, `errorLens.statusBarWarningForeground`, `errorLens.statusBarInfoForeground`, `errorLens.statusBarHintForeground`. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbarcolorsenabled)","type":"boolean"},"errorLens.statusBarCommand":{"default":"goToProblem","enum":["goToProblem","goToLine","copyMessage"],"markdownDescription":"Command that executes on click for Status Bar.","type":"string"},"errorLens.statusBarIconsAlignment":{"default":"left","enum":["left","right"],"markdownDescription":"Choose on which side the icons status bar is on: left or right.","type":"string"},"errorLens.statusBarIconsAtZero":{"default":"removeBackground","enum":["hide","removeBackground"],"markdownDescription":"What to do when there are 0 errors/warnings - hide the item or strip its background color.","type":"string"},"errorLens.statusBarIconsEnabled":{"default":false,"markdownDescription":"When enabled - shows highlighted error/warning icons in status bar. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbariconsenabled)","type":"boolean"},"errorLens.statusBarIconsPriority":{"default":-9000,"markdownDescription":"Move status bar icons left or right by adjusting the number priority.","type":"integer"},"errorLens.statusBarIconsTargetProblems":{"default":"all","enum":["all","activeEditor","visibleEditors"],"enumDescriptions":["Should be the same as native status bar icons - counts all known problems from all files.","Count only problems from the Active Text Editor.","Count only problems from the Visible Text Editors."],"markdownDescription":"Which problems to use for counting problems at icons status bar.","type":"string"},"errorLens.statusBarIconsUseBackground":{"default":true,"markdownDescription":"When enabled - highlights status bar icons with background, when disabled - with foreground.","type":"boolean"},"errorLens.statusBarMessageAlignment":{"default":"left","enum":["left","right"],"markdownDescription":"Choose on which side the message status bar is on: left or right.","type":"string"},"errorLens.statusBarMessageEnabled":{"default":false,"markdownDescription":"When enabled - shows message in status bar. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlensstatusbarmessageenabled)","type":"boolean"},"errorLens.statusBarMessagePriority":{"default":-10000,"markdownDescription":"Move status bar message left or right by adjusting the number priority.","type":"integer"},"errorLens.statusBarMessageTemplate":{"default":"","markdownDescription":"Template for status bar message. Whitespace between items is important.\n\nList of variables:\n\n- `$message` - diagnostic message text\n\n- `$count` - Number of diagnostics on the line\n\n- `$severity` - Severity prefix taken from `#errorLens.severityText#`\n\n- `$source` - Source of diagnostic e.g. \"eslint\"\n\n- `$code` - Code of the diagnostic","type":"string"},"errorLens.statusBarMessageType":{"default":"activeLine","enum":["closestProblem","closestSeverity","activeLine","activeCursor"],"enumDescriptions":["Show closest to the cursor diagnostic.","Show closest to the cursor diagnostic sorted by severity (e.g. error will be shown before warning even if it's farther from the cursor).","Show only diagnostic that is on the same line as the cursor.","Similar to \"activeLine\" but follows the cursor movement inside the line."],"markdownDescription":"Pick what to show in Status Bar: closest message or only message for the active line.","type":"string"},"errorLens.transmute":{"default":{},"markdownDescription":"Change severity or editor decoration for specific problems. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenstransmute)","patternProperties":{".*":{"properties":{"decoration":{"markdownDescription":"Change decoration properties.","properties":{"dark":{"description":"Only works for Dark color themes.","properties":{"after":{"description":"Change the properties of the inline message.","properties":{"backgroundColor":{"format":"color","type":"string"},"border":{"type":"string"},"borderRadius":{"type":"string"},"color":{"format":"color","type":"string"},"fontStyle":{"type":"string"},"fontWeight":{"type":"string"},"textDecoration":{"type":"string"}},"type":"object"},"backgroundColor":{"format":"color","type":"string"},"border":{"type":"string"},"borderRadius":{"type":"string"},"borderSpacing":{"type":"string"},"color":{"format":"color","type":"string"},"fontStyle":{"type":"string"},"fontWeight":{"type":"string"},"letterSpacing":{"type":"string"},"opacity":{"type":"string"},"outline":{"type":"string"},"textDecoration":{"type":"string"}},"type":"object"},"light":{"description":"Only works for Light color themes.","properties":{"after":{"description":"Change the properties of the inline message.","properties":{"backgroundColor":{"format":"color","type":"string"},"border":{"type":"string"},"borderRadius":{"type":"string"},"color":{"format":"color","type":"string"},"fontStyle":{"type":"string"},"fontWeight":{"type":"string"},"textDecoration":{"type":"string"}},"type":"object"},"backgroundColor":{"format":"color","type":"string"},"border":{"type":"string"},"borderRadius":{"type":"string"},"borderSpacing":{"type":"string"},"color":{"format":"color","type":"string"},"fontStyle":{"type":"string"},"fontWeight":{"type":"string"},"letterSpacing":{"type":"string"},"opacity":{"type":"string"},"outline":{"type":"string"},"textDecoration":{"type":"string"}},"type":"object"}},"type":"object"},"severity":{"enum":["error","warning","info","hint"],"markdownDescription":"Change problem's severity (can affect which decoration is rendered).","type":"string"},"target":{"properties":{"code":{"description":"Match with problem's code, e.g.: `@typescript-eslint/semi`, `6133`, ...","type":"string"},"message":{"default":"","description":"Match with problem's message (case-insensitive).","type":"string"},"messageRegex":{"additionalProperties":false,"description":"Match with problem's message using Regular Expressions.","properties":{"flags":{"default":"iu","type":"string"},"regex":{"default":"","type":"string"}},"required":["regex"],"type":"object"},"source":{"default":"","description":"Match with problem's source, e.g.: `eslint`, `ts`, ...","type":"string"}},"type":"object"}},"type":"object"}},"type":"object"},"errorLens.warningGutterIconColor":{"default":"#ff942f","format":"color","markdownDescription":"Warning color of simple gutter icons (shapes and letters). [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericoncolor)","type":"string"},"errorLens.warningGutterIconPath":{"default":"","markdownDescription":"Absolute path to warning gutter icon. [demo](https://github.com/usernamehw/vscode-error-lens/blob/master/docs/docs.md#errorlenserrorguttericonpath)","type":"string"}}}},"dependencies":{"lodash":"^4.17.21"},"description":"Improve highlighting of errors, warnings and other language diagnostics.","devDependencies":{"@soda/friendly-errors-webpack-plugin":"^1.8.1","@types/lodash":"^4.17.16","@types/node":"^22.19.3","@types/vscode":"^1.107.0","@typescript-eslint/eslint-plugin":"^5.62.0","@typescript-eslint/parser":"^5.62.0","eslint":"^8.57.1","ts-loader":"^9.5.2","typescript":"^5.8.2","webpack":"^5.98.0","webpack-cli":"^6.0.1"},"displayName":"Error Lens","engines":{"npm":">=10.0.0","vscode":"^1.107.0"},"extensionKind":["ui","workspace"],"icon":"img/icon.png","keywords":["highlight","problem","problems","error","warning","inline","message","diagnostic","status bar","gutter"],"license":"MIT","main":"./dist/extension.js","name":"errorlens","publisher":"usernamehw","qna":false,"repository":{"type":"git","url":"https://github.com/usernamehw/vscode-error-lens"},"scripts":{"vscode:prepublish":"webpack --mode production --color --devtool hidden-source-map","watch":"webpack --mode development --watch --stats minimal"},"version":"3.29.0"}};

/** @param {any} sable */
export async function activate(sable) {
  await __sableVscode.activate(sable, __modules, __extension);
}

export async function deactivate() {
  await __sableVscode.deactivate();
}
