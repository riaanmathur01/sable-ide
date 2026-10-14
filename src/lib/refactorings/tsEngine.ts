import type * as TS from "typescript";
import { EditSet, layoutList, lineStarts, positionAt } from "./textScan";
import { formatParam, newParamId } from "./signature";
import type { Signature, SignatureParam, UsageItem } from "./types";

/**
 * TypeScript/JavaScript refactorings on the TypeScript language service
 * (the TypeScript Monaco bundles, run over the workspace's files):
 * Change Signature (the declaration, every call — `new` and `super()`
 * too — overrides and implementations), Safe Delete, Move to file, and
 * the import updates for a renamed or moved file.
 *
 * No app imports here: the functions take a TsProject and return new
 * file contents, so they can be tested outside the app.
 */

type Ts = typeof TS;

export interface TsProject {
  ts: Ts;
  service: TS.LanguageService;
  /** File name (TypeScript's, `/`-separated) → text. */
  files: Map<string, string>;
  /** The app's path for a TypeScript file name, and back. */
  toPath(fileName: string): string;
  toFileName(path: string): string;
  options: TS.CompilerOptions;
  host: TS.ModuleResolutionHost;
}

export interface TsResult {
  /** File name → new text (null: deleted). */
  changes: Map<string, string | null>;
  conflicts: string[];
}

export class TsFailure extends Error {}

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** A language service over `files` (path → text). */
export function createTsProject(ts: Ts, files: Map<string, string>, root: string): TsProject {
  const toFileName = (path: string) => path.replace(/\\/g, "/");
  const originals = new Map<string, string>();
  const texts = new Map<string, string>();
  const directories = new Set<string>();
  for (const [path, text] of files) {
    const name = toFileName(path);
    originals.set(name, path);
    texts.set(name, text);
    for (let dir = name.slice(0, name.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  }
  const options: TS.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    noLib: true,
    types: [],
  };
  const host: TS.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...texts.keys()].filter((name) => SCRIPT.test(name)),
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const text = texts.get(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => toFileName(root),
    getDefaultLibFileName: () => "/__sable_no_lib.d.ts",
    fileExists: (name) => texts.has(name),
    readFile: (name) => texts.get(name),
    directoryExists: (name) => directories.has(name.replace(/\/$/, "")),
    getDirectories: () => [],
    useCaseSensitiveFileNames: () => true,
  };
  return {
    ts,
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files: texts,
    toPath: (name) => originals.get(name) ?? name,
    toFileName,
    options,
    host,
  };
}

// --- Finding things ----------------------------------------------------------------------

function sourceFile(project: TsProject, fileName: string): TS.SourceFile {
  const file = project.service.getProgram()?.getSourceFile(fileName);
  if (!file) throw new TsFailure(`${fileName.split("/").pop()} isn't part of the TypeScript project`);
  return file;
}

/** The innermost node at `position` (tokens included). */
function tokenAt(file: TS.SourceFile, position: number): TS.Node {
  let node: TS.Node = file;
  for (;;) {
    let next: TS.Node | undefined;
    for (const child of node.getChildren(file)) {
      if (child.getStart(file) <= position && position < child.end) {
        next = child;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

function identifierAt(ts: Ts, file: TS.SourceFile, position: number): TS.Node | null {
  for (const at of [position, position - 1]) {
    if (at < 0) continue;
    const node = tokenAt(file, at);
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || node.kind === ts.SyntaxKind.ConstructorKeyword) return node;
  }
  return null;
}

type Declaration = TS.Declaration & { name?: TS.Node };

function isDeclarationName(ts: Ts, node: TS.Node): boolean {
  const parent = node.parent as Declaration | undefined;
  if (!parent || parent.name !== node) return false;
  return (
    ts.isFunctionDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isParameter(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isModuleDeclaration(parent)
  );
}

/** The declaration of what's at `position` (here, or where it's defined). */
export function declarationAt(project: TsProject, path: string, position: number): { file: TS.SourceFile; node: Declaration } {
  const { ts } = project;
  const fileName = project.toFileName(path);
  const file = sourceFile(project, fileName);
  const id = identifierAt(ts, file, position);
  if (!id) throw new TsFailure("Put the cursor on a name");
  if (id.kind === ts.SyntaxKind.ConstructorKeyword) return { file, node: id.parent as Declaration };
  if (isDeclarationName(ts, id)) return { file, node: id.parent as Declaration };
  const definitions = project.service.getDefinitionAtPosition(fileName, id.getStart(file)) ?? [];
  for (const definition of definitions) {
    if (!project.files.has(definition.fileName)) continue;
    const target = sourceFile(project, definition.fileName);
    const name = identifierAt(ts, target, definition.textSpan.start);
    if (name && isDeclarationName(ts, name)) return { file: target, node: name.parent as Declaration };
  }
  throw new TsFailure(`Can't find where “${id.getText(file)}” is declared in this project`);
}

type FunctionLike = TS.SignatureDeclaration & { body?: TS.Node };

/** The function a declaration is (or holds), and the node naming it. */
function functionOf(ts: Ts, node: Declaration): { fn: FunctionLike; name: TS.Node; kind: string } {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const constructor = node.members.find(ts.isConstructorDeclaration);
    if (!constructor) throw new TsFailure(`${node.name?.getText() ?? "This class"} has no constructor to change`);
    return { fn: constructor, name: node.name ?? constructor, kind: "constructor" };
  }
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent as TS.ClassDeclaration;
    return { fn: node, name: owner.name ?? node, kind: "constructor" };
  }
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
    const value = node.initializer;
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return { fn: value, name: node.name, kind: "function" };
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return { fn: node, name: node.name ?? node, kind: "function" };
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return { fn: node, name: node.name, kind: "method" };
  throw new TsFailure("Put the cursor on a function, method or constructor");
}

interface Reference {
  fileName: string;
  start: number;
  end: number;
  isDefinition: boolean;
}

function referencesOf(project: TsProject, fileName: string, position: number): Reference[] {
  const found = project.service.findReferences(fileName, position) ?? [];
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const symbol of found) {
    for (const reference of symbol.references) {
      const key = `${reference.fileName}:${reference.textSpan.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fileName: reference.fileName,
        start: reference.textSpan.start,
        end: reference.textSpan.start + reference.textSpan.length,
        isDefinition: !!reference.isDefinition,
      });
    }
  }
  return out;
}

function usageItem(project: TsProject, fileName: string, start: number, end: number, kind?: UsageItem["kind"]): UsageItem {
  const text = project.files.get(fileName) ?? "";
  const from = positionAt(text, start);
  const to = positionAt(text, end);
  const starts = lineStarts(text);
  const lineEnd = from.line < starts.length ? starts[from.line] - 1 : text.length;
  return {
    path: project.toPath(fileName),
    line: from.line,
    column: from.column,
    endColumn: to.line === from.line ? to.column : from.column,
    preview: text.slice(starts[from.line - 1], lineEnd),
    kind,
  };
}

// --- Change Signature ----------------------------------------------------------------------

/** `(` and `)` of a function's parameter list (none: `x => …`). */
function parens(ts: Ts, file: TS.SourceFile, fn: FunctionLike): { open: number; close: number } | null {
  const children = fn.getChildren(file);
  const open = children.find((child) => child.kind === ts.SyntaxKind.OpenParenToken);
  const close = children.find((child) => child.kind === ts.SyntaxKind.CloseParenToken);
  return open && close ? { open: open.getStart(file), close: close.getStart(file) } : null;
}

function ownParams(ts: Ts, fn: FunctionLike): TS.ParameterDeclaration[] {
  // TypeScript's `this: T` isn't an argument.
  return fn.parameters.filter((param) => !(ts.isIdentifier(param.name) && param.name.text === "this"));
}

function readParam(ts: Ts, file: TS.SourceFile, param: TS.ParameterDeclaration, index: number): SignatureParam {
  const modifiers = (ts.canHaveModifiers(param) ? ts.getModifiers(param) : undefined)?.map((m) => m.getText(file)).join(" ");
  const decorators = (ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined)?.map((d) => d.getText(file)).join(" ");
  return {
    id: newParamId(),
    name: param.name.getText(file),
    type: param.type?.getText(file) ?? "",
    defaultValue: param.initializer?.getText(file) ?? "",
    value: "",
    original: index,
    kind: param.dotDotDotToken ? "rest" : "positional",
    optional: !!param.questionToken,
    raw: param.getText(file),
    modifiers: [decorators, modifiers].filter(Boolean).join(" ") || undefined,
  };
}

export function tsSignature(project: TsProject, path: string, position: number): Signature {
  const { ts } = project;
  const { file, node } = declarationAt(project, path, position);
  const { fn, name, kind } = functionOf(ts, node);
  const javascript = /\.(js|jsx|mjs|cjs)$/i.test(file.fileName);
  return {
    name: kind === "constructor" ? name.getText(file) : name.getText(file),
    params: ownParams(ts, fn).map((param, index) => readParam(ts, file, param, index)),
    returnType: javascript || kind === "constructor" ? null : (fn.type?.getText(file) ?? ""),
    language: javascript ? "javascript" : "typescript",
    kind,
  };
}

/** The new argument list for a call, or null (with a conflict) if it can't be rewritten. */
function newArguments(signature: Signature, args: string[], spread: boolean, conflicts: string[], where: string): string[] | null {
  if (spread) {
    conflicts.push(`${where}: a call spreads its arguments (…args), so it wasn't changed`);
    return null;
  }
  const out: (string | null)[] = [];
  for (const param of signature.params) {
    if (param.kind === "rest") {
      if (param.original !== null) out.push(...args.slice(param.original));
      continue;
    }
    if (param.original !== null) out.push(args[param.original] ?? null);
    else out.push(param.value.trim() || (param.defaultValue.trim() || param.optional ? null : "undefined"));
  }
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out.map((value) => value ?? "undefined");
}

export function tsChangeSignature(project: TsProject, path: string, position: number, signature: Signature): TsResult {
  const { ts, service } = project;
  const { file, node } = declarationAt(project, path, position);
  const { fn, name, kind } = functionOf(ts, node);
  const original = ownParams(ts, fn);
  const conflicts: string[] = [];
  const sets = new Map<string, EditSet>();
  const editsFor = (fileName: string) => {
    let set = sets.get(fileName);
    if (!set) sets.set(fileName, (set = new EditSet(project.files.get(fileName) ?? "")));
    return set;
  };
  const describe = (fileName: string, at: number) => {
    const { line } = positionAt(project.files.get(fileName) ?? "", at);
    return `${fileName.split("/").pop()}:${line}`;
  };

  // A removed parameter the body still uses.
  const kept = new Set(signature.params.map((param) => param.original));
  original.forEach((param, index) => {
    if (kept.has(index) || !ts.isIdentifier(param.name)) return;
    const uses = referencesOf(project, file.fileName, param.name.getStart(file)).filter((ref) => !ref.isDefinition);
    if (uses.length > 0) conflicts.push(`Parameter “${param.name.text}” is removed but the body still uses it (${describe(uses[0].fileName, uses[0].start)})`);
  });

  // 1. The new name, everywhere (TypeScript's rename: imports, shorthand properties…).
  const oldName = name.getText(file);
  if (kind !== "constructor" && signature.name !== oldName) {
    const clash = nameClash(project, file, node, signature.name);
    if (clash) conflicts.push(clash);
    const locations = service.findRenameLocations(file.fileName, name.getStart(file), false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
    for (const location of locations) {
      editsFor(location.fileName).add({
        start: location.textSpan.start,
        end: location.textSpan.start + location.textSpan.length,
        text: (location.prefixText ?? "") + signature.name + (location.suffixText ?? ""),
      });
    }
  }
  // 2. Renamed parameters, in the body.
  signature.params.forEach((param) => {
    if (param.original === null) return;
    const before = original[param.original];
    if (!before || !ts.isIdentifier(before.name) || before.name.text === param.name) return;
    for (const location of service.findRenameLocations(file.fileName, before.name.getStart(file), false, false, {}) ?? []) {
      editsFor(location.fileName).add({ start: location.textSpan.start, end: location.textSpan.start + location.textSpan.length, text: param.name });
    }
  });

  // 3. Calls (inner ones first, so an outer call sees them), overrides.
  const calls: { fileName: string; call: TS.CallExpression | TS.NewExpression; file: TS.SourceFile }[] = [];
  const overrides: { file: TS.SourceFile; fn: FunctionLike }[] = [];
  const refs = referencesOf(project, file.fileName, name.getStart(file));
  for (const ref of refs) {
    const refFile = sourceFile(project, ref.fileName);
    const id = identifierAt(ts, refFile, ref.start);
    if (!id) continue;
    let expression: TS.Node = id;
    if (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) expression = id.parent;
    const parent = expression.parent;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expression) {
      if (kind === "constructor" ? ts.isNewExpression(parent) : true) calls.push({ fileName: ref.fileName, call: parent, file: refFile });
      continue;
    }
    if (kind === "constructor" && ts.isExpressionWithTypeArguments(id.parent) && ts.isHeritageClause(id.parent.parent)) {
      // A subclass: its constructor's super(…) call.
      const subclass = id.parent.parent.parent as TS.ClassLikeDeclaration;
      const constructor = subclass.members.find(ts.isConstructorDeclaration);
      const visit = (child: TS.Node) => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword) {
          calls.push({ fileName: ref.fileName, call: child, file: refFile });
        }
        ts.forEachChild(child, visit);
      };
      if (constructor?.body) visit(constructor.body);
      continue;
    }
    if (kind !== "constructor" && isDeclarationName(ts, id) && id.parent !== node) {
      try {
        const other = functionOf(ts, id.parent as Declaration);
        if (other.fn !== fn) overrides.push({ file: refFile, fn: other.fn });
      } catch {
        /* not a function (a property holding it…) */
      }
    }
  }
  calls.sort((a, b) => b.call.getStart(b.file) - a.call.getStart(a.file));
  for (const { fileName, call, file: callFile } of calls) {
    const edits = editsFor(fileName);
    const args = call.arguments ?? ts.factory.createNodeArray<TS.Expression>();
    const texts = args.map((arg) => edits.peek(arg.getStart(callFile), arg.end));
    const spread = args.some((arg) => ts.isSpreadElement(arg));
    const values = newArguments(signature, texts, spread, conflicts, describe(fileName, call.getStart(callFile)));
    if (!values) continue;
    if (!call.arguments) {
      // `new Foo` without parentheses.
      if (values.length > 0) edits.replace(call.end, call.end, `(${values.join(", ")})`);
      continue;
    }
    const open = args.pos;
    const close = call.end - 1;
    const inner = edits.text.slice(open, close);
    edits.replace(open, close, layoutList(inner, values, edits.text, open - 1));
  }

  // 4. The declaration, and the overrides (by position, their own texts).
  const rewriteParams = (target: TS.SourceFile, targetFn: FunctionLike, primary: boolean) => {
    const edits = editsFor(target.fileName);
    const theirs = ownParams(ts, targetFn);
    const thisParam = targetFn.parameters.find((param) => ts.isIdentifier(param.name) && param.name.text === "this");
    const parts = signature.params.map((param) => {
      if (!primary && param.original !== null && theirs[param.original]) return theirs[param.original].getText(target);
      return formatParam(signature.language, param);
    });
    if (thisParam) parts.unshift(thisParam.getText(target));
    const bounds = parens(ts, target, targetFn);
    if (bounds) {
      const inner = edits.text.slice(bounds.open + 1, bounds.close);
      edits.replace(bounds.open + 1, bounds.close, layoutList(inner, parts, edits.text, bounds.open));
    } else {
      const only = targetFn.parameters[0];
      edits.replace(only.getStart(target), only.end, `(${parts.join(", ")})`);
    }
    if (primary && signature.returnType !== null && kind !== "constructor") {
      const wanted = signature.returnType.trim();
      if (targetFn.type) {
        const typeStart = targetFn.type.getStart(target);
        // `): T` — remove the colon too when the type goes.
        const colon = edits.text.lastIndexOf(":", typeStart);
        if (wanted) edits.replace(typeStart, targetFn.type.end, wanted);
        else edits.replace(colon, targetFn.type.end, "");
      } else if (wanted && bounds) {
        edits.replace(bounds.close + 1, bounds.close + 1, `: ${wanted}`);
      }
    }
  };
  rewriteParams(file, fn, true);
  for (const override of overrides) rewriteParams(override.file, override.fn, false);

  const changes = new Map<string, string | null>();
  for (const [fileName, edits] of sets) {
    const result = edits.result();
    if (result !== edits.text) changes.set(fileName, result);
  }
  return { changes, conflicts };
}

function nameClash(project: TsProject, file: TS.SourceFile, node: TS.Node, name: string): string | null {
  const { ts } = project;
  const checker = project.service.getProgram()?.getTypeChecker();
  if (!checker) return null;
  if (ts.isClassElement(node) || ts.isTypeElement(node)) {
    const owner = node.parent as TS.ClassLikeDeclaration | TS.InterfaceDeclaration;
    const member = owner.members.find((m) => m.name?.getText(file) === name);
    return member ? `${name} is already a member (line ${positionAt(file.text, member.getStart(file)).line})` : null;
  }
  const scope = node.parent ?? file;
  const symbols = checker.getSymbolsInScope(scope, ts.SymbolFlags.Value | ts.SymbolFlags.Type);
  const clash = symbols.find((symbol) => symbol.name === name && symbol.declarations?.some((d) => d.getSourceFile() === file));
  if (!clash) return null;
  const at = clash.declarations?.[0];
  return `“${name}” is already declared${at ? ` at line ${positionAt(file.text, at.getStart(file)).line}` : ""}`;
}

// --- Safe Delete ---------------------------------------------------------------------------------

export interface TsUsages {
  what: string;
  usages: UsageItem[];
  /** A parameter: deleting removes it and its arguments. */
  parameter: boolean;
  /** Where it is declared (path, 1-based lines), to tell usages from itself. */
  declaration: { path: string; startLine: number; endLine: number };
}

function describeDeclaration(ts: Ts, node: TS.Node, file: TS.SourceFile): string {
  const name = (node as Declaration).name?.getText(file) ?? "this";
  if (ts.isParameter(node)) return `parameter ${name}`;
  if (ts.isClassDeclaration(node)) return `class ${name}`;
  if (ts.isInterfaceDeclaration(node)) return `interface ${name}`;
  if (ts.isTypeAliasDeclaration(node)) return `type ${name}`;
  if (ts.isEnumDeclaration(node)) return `enum ${name}`;
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return `method ${name}`;
  if (ts.isFunctionDeclaration(node)) return `function ${name}`;
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return `property ${name}`;
  if (ts.isVariableDeclaration(node)) {
    const value = node.initializer;
    if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return `function ${name}`;
    return `${node.parent.flags & ts.NodeFlags.Const ? "constant" : "variable"} ${name}`;
  }
  return name;
}

/** The text range deleting a declaration removes (whole lines, its comments). */
export function deletionRange(ts: Ts, file: TS.SourceFile, node: TS.Node): { start: number; end: number } {
  const text = file.text;
  let target: TS.Node = node;
  if (ts.isVariableDeclaration(node)) {
    const list = node.parent as TS.VariableDeclarationList;
    if (list.declarations.length > 1) {
      // `const a = 1, b = 2`: just this one, and a comma.
      const index = list.declarations.indexOf(node);
      if (index < list.declarations.length - 1) return { start: node.getStart(file), end: list.declarations[index + 1].getStart(file) };
      return { start: list.declarations[index - 1].end, end: node.end };
    }
    target = ts.isVariableStatement(list.parent) ? list.parent : list;
  }
  // JSDoc, decorators and modifiers belong to it; so do comments right above.
  let start = target.getStart(file, true);
  const comments = ts.getLeadingCommentRanges(text, target.getFullStart()) ?? [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const between = text.slice(comments[i].end, start);
    if (between.split("\n").length > 2) break; // a blank line separates it
    start = Math.min(start, comments[i].pos);
  }
  let end = target.end;
  // Whole lines when it has them to itself.
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim() === "") start = lineStart;
  const lineEnd = text.indexOf("\n", end);
  if (text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim() === "") end = lineEnd < 0 ? text.length : lineEnd + 1;
  // One blank line goes with it when it sat between blank lines.
  const blankBefore = start === 0 || /\n[ \t]*\n$/.test(text.slice(0, start)) || text.slice(0, start).trim() === "";
  const after = text.slice(end).match(/^[ \t]*\n/);
  if (after && blankBefore) end += after[0].length;
  else if (!after && blankBefore && start > 0 && text.slice(end).trim() !== "") {
    // Last in its block (`}` next): the blank line before it goes.
    start = text.lastIndexOf("\n", start - 2) + 1;
  }
  // At the end of the file: the blank lines before it go instead.
  if (text.slice(end).trim() === "") {
    end = text.length;
    while (start > 1 && text[start - 1] === "\n" && text[start - 2] === "\n") start--;
  }
  return { start, end };
}

export function tsUsages(project: TsProject, path: string, position: number): TsUsages {
  const { ts } = project;
  const { file, node } = declarationAt(project, path, position);
  const what = describeDeclaration(ts, node, file);
  const name = node.name;
  if (!name) throw new TsFailure("This can't be deleted safely");
  if (ts.isParameter(node)) {
    const uses = referencesOf(project, file.fileName, name.getStart(file)).filter((ref) => !ref.isDefinition);
    const own = { path: project.toPath(file.fileName), startLine: positionAt(file.text, node.getStart(file)).line, endLine: positionAt(file.text, node.end).line };
    return { what, parameter: true, declaration: own, usages: uses.map((ref) => usageItem(project, ref.fileName, ref.start, ref.end, "reference")) };
  }
  const own = deletionRange(ts, file, node);
  const usages = referencesOf(project, file.fileName, name.getStart(file))
    .filter((ref) => !(ref.fileName === file.fileName && ref.start >= own.start && ref.start < own.end))
    .map((ref) => {
      const refFile = sourceFile(project, ref.fileName);
      const id = identifierAt(ts, refFile, ref.start);
      let kind: UsageItem["kind"] = "reference";
      if (id) {
        let expression: TS.Node = id;
        if (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) expression = id.parent;
        if ((ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) && expression.parent.expression === expression) kind = "call";
        let up: TS.Node | undefined = id;
        while (up && !ts.isSourceFile(up)) {
          if (ts.isImportDeclaration(up) || ts.isExportDeclaration(up) || ts.isImportEqualsDeclaration(up)) kind = "import";
          up = up.parent;
        }
      }
      return usageItem(project, ref.fileName, ref.start, ref.end, kind);
    });
  const declaration = { path: project.toPath(file.fileName), startLine: positionAt(file.text, own.start).line, endLine: positionAt(file.text, Math.max(own.start, own.end - 1)).line };
  return { what, parameter: false, declaration, usages };
}

export function tsSafeDelete(project: TsProject, path: string, position: number): TsResult {
  const { ts } = project;
  const { file, node } = declarationAt(project, path, position);
  if (ts.isParameter(node)) {
    const fn = node.parent as FunctionLike;
    const owner = ts.isConstructorDeclaration(fn) ? (fn.parent as TS.ClassDeclaration).name : (fn as { name?: TS.Node }).name;
    const at = owner ?? fn;
    const signature = tsSignature(project, project.toPath(file.fileName), at.getStart(file));
    const index = ownParams(ts, fn).indexOf(node);
    signature.params = signature.params.filter((param) => param.original !== index);
    return tsChangeSignature(project, project.toPath(file.fileName), at.getStart(file), signature);
  }
  const range = deletionRange(ts, file, node);
  const text = file.text;
  return { changes: new Map([[file.fileName, text.slice(0, range.start) + text.slice(range.end)]]), conflicts: [] };
}

// --- Move ------------------------------------------------------------------------------------------

const PREFERENCES: TS.UserPreferences = {
  quotePreference: "auto",
  importModuleSpecifierPreference: "relative",
  allowTextChangesInNewFiles: true,
};

function formatSettings(ts: Ts, text: string): TS.FormatCodeSettings {
  const indent = text.match(/^( +)\S/m)?.[1].length ?? 2;
  return { ...ts.getDefaultFormatCodeSettings("\n"), indentSize: Math.min(indent, 8), tabSize: Math.min(indent, 8), convertTabsToSpaces: true };
}

function applyFileTextChanges(project: TsProject, edits: readonly TS.FileTextChanges[], changes: Map<string, string | null>) {
  for (const edit of edits) {
    const base = changes.get(edit.fileName) ?? (edit.isNewFile ? "" : (project.files.get(edit.fileName) ?? ""));
    const set = new EditSet(base);
    for (const change of edit.textChanges) set.add({ start: change.span.start, end: change.span.start + change.span.length, text: change.newText });
    changes.set(edit.fileName, set.result());
  }
}

/** The top-level statement declaring what's at `position`. */
export function topLevelStatement(project: TsProject, path: string, position: number): { file: TS.SourceFile; statement: TS.Statement; name: string } {
  const { ts } = project;
  const { file, node } = declarationAt(project, path, position);
  let statement: TS.Node = node;
  while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
  if (!statement.parent || statement.getSourceFile() !== file) throw new TsFailure("Only top-level declarations can be moved");
  return { file, statement: statement as TS.Statement, name: node.name?.getText(file) ?? "this" };
}

export function tsMove(project: TsProject, path: string, position: number, target: string): TsResult {
  const { ts, service } = project;
  const { file, statement, name } = topLevelStatement(project, path, position);
  const targetName = project.toFileName(target);
  if (targetName === file.fileName) throw new TsFailure(`${name} is already in ${target.split(/[/\\]/).pop()}`);
  const conflicts: string[] = [];
  const existing = project.files.get(targetName);
  if (existing !== undefined && new RegExp(`\\b(function|class|interface|type|enum|const|let|var)\\s+${name}\\b`).test(existing)) {
    conflicts.push(`${target.split(/[/\\]/).pop()} already declares “${name}”`);
  }
  const range = { pos: statement.getStart(file), end: statement.end };
  const edits = service.getEditsForRefactor(
    file.fileName,
    formatSettings(ts, file.text),
    range,
    "Move to file",
    "Move to file",
    PREFERENCES,
    { targetFile: targetName },
  );
  if (!edits || edits.edits.length === 0) throw new TsFailure(`${name} can't be moved`);
  const changes = new Map<string, string | null>();
  applyFileTextChanges(project, edits.edits, changes);
  // TypeScript leaves the blank lines that were around what moved.
  for (const [fileName, text] of changes) {
    if (text === null) continue;
    const before = project.files.get(fileName) ?? "";
    let tidy = text;
    if (!/^\s*\n/.test(before)) tidy = tidy.replace(/^\s*\n/, "");
    if (!/\n\n\n/.test(before)) tidy = tidy.replace(/\n{3,}/g, "\n\n");
    changes.set(fileName, tidy);
  }
  return { changes, conflicts };
}

/** Import updates for moving/renaming a file (`from` → `to`, paths). */
export function tsFileRename(project: TsProject, from: string, to: string): TsResult {
  const { ts, service } = project;
  const fromName = project.toFileName(from);
  const edits = service.getEditsForFileRename(fromName, project.toFileName(to), formatSettings(ts, project.files.get(fromName) ?? ""), PREFERENCES);
  const changes = new Map<string, string | null>();
  applyFileTextChanges(project, edits, changes);
  return { changes, conflicts: [] };
}

/** Imports of a file (for deleting it). */
export function tsImporters(project: TsProject, path: string): UsageItem[] {
  const { ts } = project;
  const target = project.toFileName(path);
  const program = project.service.getProgram();
  if (!program) return [];
  const usages: UsageItem[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.fileName === target || !project.files.has(file.fileName)) continue;
    const check = (specifier: TS.Expression | undefined, node: TS.Node) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const resolved = ts.resolveModuleName(specifier.text, file.fileName, project.options, project.host).resolvedModule;
      if (resolved?.resolvedFileName === target) usages.push(usageItem(project, file.fileName, node.getStart(file), specifier.end, "import"));
    };
    const visit = (node: TS.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier, node);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression, node);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        check(node.arguments[0], node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return usages;
}
