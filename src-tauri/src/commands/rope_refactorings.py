# Sable's deeper Python refactorings through Rope: Safe Delete, Change
# Signature and Move (a function/class/constant to another module; a
# module to another package or name). Run by refactor_deep.rs: reads one
# request on stdin, prints one JSON reply. Nothing is left changed on
# disk: refactorings that need several Rope steps do them on disk and
# restore every file afterwards; the editor applies the returned contents
# (previewed first, one undoable edit).
#
# Positions arrive as 1-based line + UTF-16 column (the editor's) and
# leave the same way.
import ast
import io
import json
import os
import sys
import tokenize

try:
    from rope.base import evaluate, libutils, pynames, pyobjects, worder
    from rope.base import pynamesdef
    from rope.base.change import ChangeContents, ChangeSet, MoveResource
    from rope.base.exceptions import RopeError
    from rope.base.project import Project
    from rope.refactor import occurrences
    from rope.refactor.change_signature import ChangeSignature
    from rope.refactor.functionutils import CallInfo
    from rope.refactor.move import MoveGlobal, MoveModule
    from rope.refactor.rename import Rename
except ImportError:
    print(json.dumps({"error": "rope-missing"}))
    sys.exit(0)


class Failure(Exception):
    """A message for the user."""


# --- Text positions ----------------------------------------------------------------


class Text:
    def __init__(self, source):
        self.source = source
        self.lines = source.split("\n")
        self.starts = [0]
        for line in self.lines:
            self.starts.append(self.starts[-1] + len(line) + 1)

    def offset(self, line, column):
        """1-based line + UTF-16 column -> code point offset."""
        line = max(1, min(line, len(self.lines)))
        text = self.lines[line - 1]
        units = 0
        for index, char in enumerate(text):
            if units >= column - 1:
                return self.starts[line - 1] + index
            units += 2 if ord(char) > 0xFFFF else 1
        return self.starts[line - 1] + len(text)

    def position(self, offset):
        """Code point offset -> (1-based line, 1-based UTF-16 column)."""
        lo, hi = 0, len(self.lines) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        column = sum(2 if ord(c) > 0xFFFF else 1 for c in self.lines[lo][: offset - self.starts[lo]])
        return lo + 1, column + 1

    def line_text(self, line):
        return self.lines[line - 1] if 0 < line <= len(self.lines) else ""

    def ast_offset(self, line, byte_column):
        """An ast (line, UTF-8 byte column) -> code point offset."""
        text = self.lines[line - 1]
        return self.starts[line - 1] + len(text.encode("utf-8")[:byte_column].decode("utf-8", "ignore"))


def read(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def write(path, contents):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(contents)


# --- Running several Rope steps -------------------------------------------------------


class Session:
    """Applies Rope changes to disk, remembering every file's original so
    the final contents can be returned and the originals restored."""

    def __init__(self, project):
        self.project = project
        self.originals = {}
        self.created = []
        self.moves = []

    def remember(self, path):
        if path not in self.originals:
            self.originals[path] = read(path) if os.path.exists(path) else None

    def create(self, path):
        """An empty new module (Rope moves into existing files)."""
        missing = []
        directory = os.path.dirname(path)
        while directory and not os.path.exists(directory):
            missing.append(directory)
            directory = os.path.dirname(directory)
        # New folders inside a package are packages too (so the module has
        # a dotted name to import it by).
        packaged = os.path.exists(os.path.join(directory, "__init__.py"))
        for folder in reversed(missing):
            os.mkdir(folder)
            if packaged:
                init = os.path.join(folder, "__init__.py")
                write(init, "")
                self.created.append(init)
                self.originals[init] = None
        self.created_dirs = getattr(self, "created_dirs", []) + list(missing)
        write(path, "")
        self.created.append(path)
        self.remember(path)
        self.originals[path] = None

    def do(self, changes):
        for change in flatten(changes):
            if isinstance(change, ChangeContents):
                self.remember(change.resource.real_path)
        self.project.do(changes)

    def results(self):
        files = []
        for path, original in self.originals.items():
            current = read(path) if os.path.exists(path) else None
            if current is not None and current != (original or ""):
                files.append({"path": path, "contents": current})
            elif current is not None and path in self.created:
                files.append({"path": path, "contents": current})
        return files

    def restore(self):
        for path, original in self.originals.items():
            if original is None:
                if os.path.exists(path):
                    os.remove(path)
            else:
                write(path, original)
        for folder in sorted(getattr(self, "created_dirs", []), key=len, reverse=True):
            try:
                os.rmdir(folder)
            except OSError:
                pass


def flatten(changes):
    if hasattr(changes, "changes"):
        for change in changes.changes:
            yield from flatten(change)
    else:
        yield changes


def contents_of(changes):
    """A ChangeSet that hasn't been applied -> [{path, contents}]."""
    return [
        {"path": change.resource.real_path, "contents": change.new_contents}
        for change in flatten(changes)
        if isinstance(change, ChangeContents)
    ]


# --- Resolving the name at the cursor -------------------------------------------------


def resolve(project, resource, offset):
    name = worder.get_name_at(resource, offset)
    if not name:
        raise Failure("Put the cursor on a name")
    pymodule = project.get_pymodule(resource)
    primary, pyname = evaluate.eval_location2(pymodule, offset)
    if pyname is None:
        raise Failure("Can't tell what “%s” is" % name)
    return name, primary, pyname


def definition_of(pyname):
    """(resource, lineno) of a name's definition."""
    module, lineno = pyname.get_definition_location()
    if module is None or lineno is None or module.get_resource() is None:
        raise Failure("The definition isn't in this project")
    return module.get_resource(), lineno


def kind_of(pyname):
    if isinstance(pyname, pynamesdef.ParameterName):
        return "parameter"
    if isinstance(pyname, pynames.ImportedModule):
        return "module"
    obj = pyname.get_object()
    if isinstance(obj, pyobjects.PyClass):
        return "class"
    if isinstance(obj, pyobjects.PyFunction):
        return "method" if obj.get_kind() != "function" else "function"
    return "variable"


def statements_in(tree):
    """Every statement with its parent body (list) and the owning node."""
    stack = [(tree, None)]
    while stack:
        node, owner = stack.pop()
        for field in ("body", "orelse", "finalbody", "handlers"):
            body = getattr(node, field, None)
            if isinstance(body, list):
                for child in body:
                    if isinstance(child, ast.stmt) or isinstance(child, ast.excepthandler):
                        yield child, body, node
                        stack.append((child, node))


def declaration_node(source, lineno, name):
    """The def/class/assignment statement defining `name` at `lineno`."""
    tree = ast.parse(source)
    best = None
    for node, body, owner in statements_in(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == name and node.lineno <= lineno <= node.end_lineno:
                if node.lineno == lineno or best is None:
                    best = (node, body, owner)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if name in names and node.lineno <= lineno <= node.end_lineno:
                best = (node, body, owner)
    return best


def declaration_lines(text, node):
    """1-based first/last line of a declaration, with its decorators and the
    comment block directly above it."""
    first = node.lineno
    for decorator in getattr(node, "decorator_list", []):
        first = min(first, decorator.lineno)
    while first > 1 and text.line_text(first - 1).strip().startswith("#"):
        first -= 1
    return first, node.end_lineno


def delete_lines(text, first, last, body, node):
    """Source without lines first..last; a lone statement becomes `pass`;
    the blank lines around the gap are collapsed (as many as were before
    it, or after it at the end of the file)."""
    lines = text.lines
    indent = lines[node.lineno - 1][: len(lines[node.lineno - 1]) - len(lines[node.lineno - 1].lstrip())]
    if len(body) == 1:
        replacement = [indent + "pass"]
        return "\n".join(lines[: first - 1] + replacement + lines[last:])
    after = last
    while after < len(lines) and lines[after].strip() == "":
        after += 1
    before = first - 1
    while before > 0 and lines[before - 1].strip() == "":
        before -= 1
    blank_before = (first - 1) - before
    if after >= len(lines) or (after == len(lines) - 1 and lines[-1] == ""):
        # At the end: drop the blank lines before it too, keep the final newline.
        kept = lines[:before]
        return "\n".join(kept) + ("\n" if text.source.endswith("\n") else "")
    blank_after = after - last
    keep = max(blank_before, blank_after) if before > 0 else 0
    return "\n".join(lines[:before] + [""] * keep + lines[after:])


# --- Usages (Safe Delete) -------------------------------------------------------------------


def usage_entry(texts, resource, start, end, kind):
    path = resource.real_path
    if path not in texts:
        texts[path] = Text(resource.read())
    text = texts[path]
    line, column = text.position(start)
    _, end_column = text.position(end)
    return {"path": path, "line": line, "column": column, "endColumn": end_column, "preview": text.line_text(line), "kind": kind}


def find_usages(project, resource, offset):
    name, primary, pyname = resolve(project, resource, offset)
    kind = kind_of(pyname)
    def_resource, def_line = definition_of(pyname)
    source = def_resource.read()
    texts = {def_resource.real_path: Text(source)}
    text = texts[def_resource.real_path]
    symbol = {"name": name, "kind": kind, "path": def_resource.real_path, "line": def_line}
    if kind == "parameter":
        function = enclosing_function(source, def_line, name)
        if function is None:
            raise Failure("Can't find the function of parameter “%s”" % name)
        symbol["function"] = function.name
        first, last = function.body[0].lineno, function.end_lineno
        if isinstance(function.body[0], ast.Expr) and isinstance(getattr(function.body[0], "value", None), ast.Constant):
            first = function.body[0].lineno  # a docstring can't use it anyway
        start, end = text.starts[first - 1], text.starts[last]
        finder = occurrences.create_finder(project, name, pyname)
        usages = []
        for occurrence in finder.find_occurrences(def_resource):
            word_start, word_end = occurrence.get_word_range()
            if start <= word_start < end:
                usages.append(usage_entry(texts, def_resource, word_start, word_end, "reference"))
        return {"symbol": symbol, "usages": usages}
    found = declaration_node(source, def_line, name)
    own_range = None
    if found:
        first, last = declaration_lines(text, found[0])
        own_range = (text.starts[first - 1], text.starts[last] if last < len(text.starts) else len(source))
        symbol["line"] = found[0].lineno
        symbol["endLine"] = found[0].end_lineno
    finder = occurrences.create_finder(project, name, pyname, instance=primary)
    usages = []
    for file in project.get_python_files():
        for occurrence in finder.find_occurrences(file):
            word_start, word_end = occurrence.get_word_range()
            if file == def_resource and own_range and own_range[0] <= word_start < own_range[1]:
                continue  # the declaration itself, recursion
            if occurrence.is_in_import_statement():
                kind_ = "import"
            elif occurrence.is_called():
                kind_ = "call"
            else:
                kind_ = "reference"
            usages.append(usage_entry(texts, file, word_start, word_end, kind_))
    return {"symbol": symbol, "usages": usages}


def enclosing_function(source, lineno, parameter):
    tree = ast.parse(source)
    best = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            if node.lineno <= lineno <= node.end_lineno:
                args = node.args
                names = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
                names += [a.arg for a in (args.vararg, args.kwarg) if a is not None]
                if parameter in names and (best is None or node.lineno >= best.lineno):
                    best = node
    return best


def module_name_of(project, resource):
    return libutils.modname(resource)


def module_usages(project, resource):
    """Imports of a module (for deleting the file)."""
    target = module_name_of(project, resource)
    usages = []
    texts = {}
    for file in project.get_python_files():
        if file == resource:
            continue
        try:
            source = file.read()
            tree = ast.parse(source)
        except (SyntaxError, ValueError):
            continue
        own = module_name_of(project, file)
        package = own if file.name == "__init__.py" else own.rpartition(".")[0]
        text = Text(source)
        for node in ast.walk(tree):
            hit = False
            if isinstance(node, ast.Import):
                hit = any(alias.name == target or alias.name.startswith(target + ".") for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = package.split(".") if package else []
                    parts = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
                    base = ".".join([p for p in parts if p] + ([node.module] if node.module else []))
                hit = base == target or any(base + "." + alias.name == target for alias in node.names)
            if hit:
                line = text.line_text(node.lineno)
                if isinstance(node, ast.ImportFrom):
                    written = "." * node.level + (node.module or "")
                    if base != target:
                        written = next(alias.name for alias in node.names if base + "." + alias.name == target)
                else:
                    written = next(alias.name for alias in node.names if alias.name == target or alias.name.startswith(target + "."))
                column = line.find(written, node.col_offset) if written else -1
                if column < 0:
                    column, written = node.col_offset, line[node.col_offset:]
                start = text.starts[node.lineno - 1] + column
                end = start + len(written)
                texts[file.real_path] = text
                usages.append(usage_entry(texts, file, start, end, "import"))
    return {"symbol": {"name": resource.name, "kind": "file", "path": resource.real_path, "line": 1}, "usages": usages}


def safe_delete(project, resource, offset):
    name, primary, pyname = resolve(project, resource, offset)
    kind = kind_of(pyname)
    def_resource, def_line = definition_of(pyname)
    source = def_resource.read()
    text = Text(source)
    if kind == "parameter":
        function = enclosing_function(source, def_line, name)
        if function is None or isinstance(function, ast.Lambda):
            raise Failure("Can't remove a parameter of this function")
        signature = read_signature(text, function)
        params = [
            dict(p, original=i) for i, p in enumerate(signature["params"]) if p["name"] != name
        ]
        name_offset = function_name_offset(text, function)
        return change_signature(project, def_resource, name_offset, {"params": params})
    found = declaration_node(source, def_line, name)
    if not found:
        raise Failure("Can't find the declaration of “%s”" % name)
    node, body, owner = found
    if isinstance(node, ast.Assign) and len(node.targets) > 1:
        raise Failure("“%s” is assigned together with other names" % name)
    first, last = declaration_lines(text, node)
    return {"files": [{"path": def_resource.real_path, "contents": delete_lines(text, first, last, body, node)}]}


# --- Change Signature ---------------------------------------------------------------------


def function_name_offset(text, node):
    """Offset of a def's name."""
    line = text.line_text(node.lineno)
    start = text.ast_offset(node.lineno, node.col_offset)
    index = line.find(node.name, start - text.starts[node.lineno - 1])
    if index < 0:
        raise Failure("Can't find the function's name")
    return text.starts[node.lineno - 1] + index


def segment(text, node):
    if node is None:
        return None
    start = text.ast_offset(node.lineno, node.col_offset)
    end = text.ast_offset(node.end_lineno, node.end_col_offset)
    return text.source[start:end]


def read_signature(text, node):
    """A def's parameters as the dialog shows them."""
    args = node.args
    params = []
    positional = args.posonlyargs + args.args
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, arg in enumerate(positional):
        params.append({
            "name": arg.arg,
            "annotation": segment(text, arg.annotation),
            "default": segment(text, defaults[index]),
            "kind": "posonly" if index < len(args.posonlyargs) else "positional",
        })
    if args.vararg is not None:
        params.append({"name": args.vararg.arg, "annotation": segment(text, args.vararg.annotation), "default": None, "kind": "vararg"})
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        params.append({"name": arg.arg, "annotation": segment(text, arg.annotation), "default": segment(text, default), "kind": "kwonly"})
    if args.kwarg is not None:
        params.append({"name": args.kwarg.arg, "annotation": segment(text, args.kwarg.annotation), "default": None, "kind": "kwarg"})
    return {"name": node.name, "params": params, "returnType": segment(text, node.returns)}


def function_at(project, resource, offset):
    """The function the cursor is on (its def or a call), as (resource, node,
    text, is_method, implicit)."""
    name, primary, pyname = resolve(project, resource, offset)
    obj = pyname.get_object()
    if isinstance(obj, pyobjects.PyClass):
        if "__init__" not in obj:
            raise Failure("“%s” has no __init__ to change" % name)
        pyname = obj["__init__"]
        obj = pyname.get_object()
    if not isinstance(obj, pyobjects.PyFunction):
        raise Failure("Put the cursor on a function or method")
    def_resource = obj.get_module().get_resource()
    if def_resource is None:
        raise Failure("The function isn't in this project")
    source = def_resource.read()
    text = Text(source)
    lineno = obj.get_ast().lineno
    node = None
    for candidate in ast.walk(ast.parse(source)):
        if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef)) and candidate.lineno == lineno:
            node = candidate
    if node is None:
        raise Failure("Can't find the function's definition")
    kind = obj.get_kind()
    implicit = kind in ("method", "classmethod")
    return def_resource, node, text, kind, implicit


def signature(project, resource, offset):
    def_resource, node, text, kind, implicit = function_at(project, resource, offset)
    info = read_signature(text, node)
    if implicit and info["params"]:
        info["implicit"] = info["params"].pop(0)["name"]
    info["kind"] = kind
    info["path"] = def_resource.real_path
    info["line"] = node.lineno
    return info


def format_param(param):
    text = param["name"]
    if param.get("kind") == "vararg":
        text = "*" + text
    elif param.get("kind") == "kwarg":
        text = "**" + text
    if param.get("annotation"):
        text += ": " + param["annotation"]
    if param.get("default"):
        text += (" = " if param.get("annotation") else "=") + param["default"]
    return text


def format_params(params, implicit):
    """New parameter list text: `/` and `*` markers where needed."""
    parts = [implicit] if implicit else []
    posonly = [p for p in params if p.get("kind") == "posonly"]
    if posonly:
        for p in params:
            if p.get("kind") == "posonly":
                parts.append(format_param(p))
        parts.append("/")
    rest = [p for p in params if p.get("kind") != "posonly"]
    starred = any(p.get("kind") == "vararg" for p in rest)
    for p in rest:
        if p.get("kind") == "kwonly" and not starred:
            parts.append("*")
            starred = True
        parts.append(format_param(p))
    return parts


class SignatureChanger:
    """Rewrites the definition and every call (Rope finds them; this does
    the arguments, so annotations, keyword-only parameters and keyword
    arguments come out right)."""

    def __init__(self, text, node, implicit, params, old_names):
        params_now = read_signature(text, node)["params"]
        self.all = params_now
        self.implicit = params_now[0]["name"] if implicit and params_now else None
        self.own = params_now[1:] if self.implicit else params_now
        # Names before this refactoring renamed any (keyword arguments
        # Rope didn't rename still use them).
        self.old_names = old_names
        self.params = params
        start = function_name_offset(text, node)
        self.header = text.source[start: header_end(text, start)]
        self.conflicts = []

    def change_definition(self, call):
        name = call[: call.index("(")].strip()
        if call.strip() == self.header.strip():
            parts = format_params(self.params, self.implicit)
        else:
            # An override: the same changes by position, its own parameters.
            parts = self.override_params(call)
            if parts is None:
                return None
        return name + layout(call[call.index("("):], parts)

    def override_params(self, call):
        try:
            code = "def " + call + ": pass"
            node = ast.parse(code).body[0]
        except SyntaxError:
            return None
        theirs = read_signature(Text(code), node)["params"]
        implicit = theirs[0]["name"] if self.implicit and theirs else None
        own = theirs[1:] if implicit else theirs
        out = []
        for p in self.params:
            index = p.get("original")
            out.append(own[index] if index is not None and index < len(own) else p)
        return format_params(out, implicit)

    def match(self, params, keyword):
        for p in params:
            if p["name"] == keyword:
                return p
        for index, old in enumerate(self.old_names):
            if old == keyword and index < len(self.own):
                return self.own[index]
        return None

    def change_call(self, primary, pyname, call):
        code = call.strip()
        try:
            expression = ast.parse(code, mode="eval").body
        except SyntaxError:
            return None
        if not isinstance(expression, ast.Call):
            return None
        text = Text(code)
        func_end = text.ast_offset(expression.func.end_lineno, expression.func.end_col_offset)
        implicit_call = bool(self.implicit) and (
            CallInfo._is_method_call(primary, pyname) or CallInfo._is_classmethod(pyname) or CallInfo._is_class(pyname)
        )
        # Called through the class, a method's call passes the instance too.
        params = self.own if (implicit_call or not self.implicit) else self.all
        positional = [p for p in params if p["kind"] in ("posonly", "positional")]
        values = {}
        extra_positional = []
        extra_keywords = []
        for index, arg in enumerate(expression.args):
            if isinstance(arg, ast.Starred):
                self.conflicts.append(
                    "A call passes *%s, so its arguments weren't changed: %s" % (segment(text, arg.value), code.split("\n")[0][:80])
                )
                return None
            if index < len(positional):
                values[positional[index]["name"]] = (segment(text, arg), "positional")
            else:
                extra_positional.append(segment(text, arg))
        for keyword in expression.keywords:
            if keyword.arg is None:
                extra_keywords.append("**" + segment(text, keyword.value))
                continue
            p = self.match(params, keyword.arg)
            if p is not None:
                values[p["name"]] = (segment(text, keyword.value), "keyword")
            else:
                extra_keywords.append(keyword.arg + "=" + segment(text, keyword.value))
        args = []
        if self.implicit and not implicit_call and self.implicit in values:
            args.append(values.pop(self.implicit)[0])
        positional_ok = True
        for p in self.params:
            if p.get("kind") in ("vararg", "kwarg"):
                continue
            index = p.get("original")
            value, style = None, "positional"
            if index is not None and index < len(self.own):
                if self.own[index]["name"] in values:
                    value, style = values[self.own[index]["name"]]
            elif p.get("value"):
                value = p["value"]
            elif not p.get("default"):
                value = "None"
            if value is None:
                positional_ok = False
                continue
            if p.get("kind") == "kwonly" or style == "keyword" or not positional_ok:
                positional_ok = False
                args.append(p["name"] + "=" + value)
            else:
                args.append(value)
        if extra_positional:
            if not positional_ok:
                self.conflicts.append("A call's extra arguments (%s) can't follow keyword arguments" % ", ".join(extra_positional))
                return None
            args.extend(extra_positional)
        args.extend(extra_keywords)
        return code[:func_end] + layout(code[func_end:], args)


def change_calls(project, cs, changer):
    """Rope's ChangeSignature call rewriting, but nested calls work: an inner
    call is rewritten first and the outer call sees the result."""
    finder = occurrences.create_finder(
        project, cs.name, cs.pyname, instance=cs.primary, in_hierarchy=cs.is_method()
    )
    if cs.others:
        name, pyname = cs.others
        finder = _Finders([finder, occurrences.create_finder(project, name, pyname, only_calls=True)])
    changes = ChangeSet("Changing signature of <%s>" % cs.name)
    for file in project.get_python_files():
        source = file.read()
        word_finder = worder.Worder(source)
        edits = []  # (start, end, text), none overlapping
        found = []
        for occurrence in finder.find_occurrences(file):
            if not occurrence.is_called() and not occurrence.is_defined():
                continue
            start, end = occurrence.get_primary_range()
            try:
                end_parens = word_finder.get_word_parens_range(end - 1)[1]
            except Exception:
                continue
            found.append((start, end_parens, occurrence))
        for start, end_parens, occurrence in sorted(found, key=lambda item: -item[0]):
            inner = [edit for edit in edits if start <= edit[0] and edit[1] <= end_parens]
            text = source[start:end_parens]
            for edit_start, edit_end, replacement in sorted(inner, reverse=True):
                text = text[: edit_start - start] + replacement + text[edit_end - start:]
            if occurrence.is_called():
                primary, pyname = occurrence.get_primary_and_pyname()
                changed = changer.change_call(primary, pyname, text)
            else:
                changed = changer.change_definition(text)
            if changed is None:
                continue
            edits = [edit for edit in edits if edit not in inner] + [(start, end_parens, changed)]
        if edits:
            new = source
            for start, end, replacement in sorted(edits, reverse=True):
                new = new[:start] + replacement + new[end:]
            if new != source:
                changes.add_change(ChangeContents(file, new))
    return changes


class _Finders:
    def __init__(self, finders):
        self.finders = finders

    def find_occurrences(self, resource=None, pymodule=None):
        found = []
        for finder in self.finders:
            found.extend(finder.find_occurrences(resource, pymodule))
        return found


def layout(parens, parts):
    """`(a, b)`, or one per line when the original list was laid out so."""
    inner = parens[1:]
    stripped = inner.lstrip(" \t")
    if stripped.startswith("\n") and parts:
        body = stripped[1:]
        indent = body[: len(body) - len(body.lstrip(" \t"))]
        last_newline = parens.rfind("\n")
        closing = parens[last_newline + 1: parens.rfind(")")] if last_newline >= 0 else ""
        if closing.strip():
            closing = ""
        return "(\n" + "".join(indent + part + ",\n" for part in parts) + closing + ")"
    return "(" + ", ".join(parts) + ")"


def header_end(text, name_start):
    """Offset just past the `)` closing a def's parameters."""
    depth = 0
    index = text.source.index("(", name_start)
    tokens = tokenize.generate_tokens(io.StringIO(text.source[index:]).readline)
    for token in tokens:
        if token.type == tokenize.OP and token.string in "([{":
            depth += 1
        elif token.type == tokenize.OP and token.string in ")]}":
            depth -= 1
            if depth == 0:
                line, column = token.end
                local = Text(text.source[index:])
                return index + local.starts[line - 1] + column
    raise Failure("Can't read the function's parameters")


def set_return_type(source, lineno, return_type):
    """Replace (or add, or remove) a def's `-> type`."""
    text = Text(source)
    node = next(
        n for n in ast.walk(ast.parse(source))
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == lineno
    )
    close = header_end(text, function_name_offset(text, node))
    # The `:` that ends the header (after any annotation).
    colon = None
    depth = 0
    tokens = tokenize.generate_tokens(io.StringIO(source[close:]).readline)
    local = Text(source[close:])
    for token in tokens:
        if token.type == tokenize.OP and token.string in "([{":
            depth += 1
        elif token.type == tokenize.OP and token.string in ")]}":
            depth -= 1
        elif token.type == tokenize.OP and token.string == ":" and depth == 0:
            line, column = token.start
            colon = close + local.starts[line - 1] + column
            break
    if colon is None:
        return source
    middle = " -> " + return_type if return_type else ""
    return source[:close] + middle + source[colon:]


def change_signature(project, resource, offset, options):
    session = Session(project)
    conflicts = []
    try:
        def_resource, node, text, kind, implicit = function_at(project, resource, offset)
        path = def_resource.real_path
        lineno = node.lineno
        original = read_signature(text, node)
        own = original["params"][1:] if implicit and original["params"] else original["params"]
        params = [dict(p) for p in options["params"]]
        names = [p["name"] for p in params]
        if len(set(names)) != len(names):
            raise Failure("Two parameters can't have the same name")
        seen_default = False
        for p in params:
            if p.get("kind") in ("vararg", "kwarg", "kwonly"):
                continue
            if p.get("default"):
                seen_default = True
            elif seen_default:
                raise Failure("Parameter “%s” needs a default value: it follows one that has one" % p["name"])
        kept = {p.get("original") for p in params}
        body_names = set()
        for statement in node.body:
            body_names |= used_names(statement)
        for index, p in enumerate(own):
            if index not in kept and p["name"] in body_names:
                conflicts.append("Parameter “%s” is removed but %s() still uses it" % (p["name"], original["name"]))
        # 1. Renamed parameters (Rope renames their uses in the body).
        for p in params:
            index = p.get("original")
            if index is None or index >= len(own) or own[index]["name"] == p["name"]:
                continue
            source = read(path)
            current = Text(source)
            fn = next(
                n for n in ast.walk(ast.parse(source))
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == lineno
            )
            all_args = fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs + [a for a in (fn.args.vararg, fn.args.kwarg) if a]
            old_name = own[index]["name"]
            arg = next(a for a in all_args if a.arg == old_name)
            arg_offset = current.ast_offset(arg.lineno, arg.col_offset)
            resource_now = project.get_file(os.path.relpath(path, project.address))
            session.do(Rename(project, resource_now, arg_offset).get_changes(p["name"], docs=False))
        # 2. Rope rewrites the definition and every call (overrides too).
        source = read(path)
        current = Text(source)
        fn = next(
            n for n in ast.walk(ast.parse(source))
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == lineno
        )
        name_offset = function_name_offset(current, fn)
        resource_now = project.get_file(os.path.relpath(path, project.address))
        changer = SignatureChanger(current, fn, implicit, params, [p["name"] for p in own])
        cs = ChangeSignature(project, resource_now, name_offset)
        session.do(change_calls(project, cs, changer))
        conflicts.extend(changer.conflicts)
        # 3. The return type.
        if "returnType" in options and (options["returnType"] or None) != original["returnType"]:
            session.remember(path)
            write(path, set_return_type(read(path), lineno, options["returnType"]))
        # 4. The new name, everywhere.
        new_name = options.get("name") or original["name"]
        if new_name != original["name"]:
            source = read(path)
            current = Text(source)
            fn = next(
                n for n in ast.walk(ast.parse(source))
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == lineno
            )
            clash = name_clash(source, fn, new_name)
            if clash:
                conflicts.append(clash)
            resource_now = project.get_file(os.path.relpath(path, project.address))
            # Rope reads the file from disk; it changed behind its back.
            project.validate(resource_now)
            session.do(Rename(project, resource_now, function_name_offset(current, fn)).get_changes(new_name, in_hierarchy=True, docs=False))
        files = session.results()
        for changed in files:
            if changed["path"].endswith((".py", ".pyw")):
                try:
                    ast.parse(changed["contents"])
                except SyntaxError as error:
                    conflicts.append("%s doesn't parse afterwards (line %s)" % (os.path.basename(changed["path"]), error.lineno))
        return {"files": files, "conflicts": conflicts}
    finally:
        session.restore()


def name_clash(source, fn, new_name):
    """Another definition of `new_name` where the function lives."""
    tree = ast.parse(source)
    for node, body, owner in statements_in(tree):
        if node is fn:
            for sibling in body:
                if sibling is fn:
                    continue
                if isinstance(sibling, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and sibling.name == new_name:
                    return "“%s” is already defined at line %d" % (new_name, sibling.lineno)
                if isinstance(sibling, ast.Assign) and any(isinstance(t, ast.Name) and t.id == new_name for t in sibling.targets):
                    return "“%s” is already defined at line %d" % (new_name, sibling.lineno)
    return None


# --- Move ------------------------------------------------------------------------------------


def module_level_names(source):
    names = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def used_names(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def remove_unused_imports(source, candidates):
    """Drop module-level imports of `candidates` that nothing uses now."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return source
    used = set()
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            used |= used_names(node)
    text = Text(source)
    edits = []
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        keep = []
        dropped = False
        for alias in node.names:
            bound = alias.asname or alias.name.split(".")[0]
            if bound in candidates and bound not in used and alias.name != "*":
                dropped = True
            else:
                keep.append(alias)
        if not dropped:
            continue
        start = text.starts[node.lineno - 1]
        end = text.starts[node.end_lineno] if node.end_lineno < len(text.lines) else len(source)
        if keep:
            names = ", ".join(a.name + (" as " + a.asname if a.asname else "") for a in keep)
            indent = text.line_text(node.lineno)[: node.col_offset]
            if isinstance(node, ast.Import):
                line = indent + "import " + names + "\n"
            else:
                line = indent + "from " + "." * node.level + (node.module or "") + " import " + names + "\n"
            edits.append((start, end, line))
        else:
            edits.append((start, end, ""))
    for start, end, replacement in sorted(edits, reverse=True):
        source = source[:start] + replacement + source[end:]
    return source


def move(project, resource, offset, options):
    target = os.path.abspath(options["target"])
    session = Session(project)
    try:
        name, primary, pyname = resolve(project, resource, offset)
        def_resource, def_line = definition_of(pyname)
        if def_resource.real_path == target:
            raise Failure("“%s” is already in %s" % (name, os.path.basename(target)))
        source = def_resource.read()
        found = declaration_node(source, def_line, name)
        if not found or found[2] is not None and not isinstance(found[2], ast.Module):
            raise Failure("Only top-level classes, functions and variables can be moved")
        conflicts = []
        if os.path.exists(target):
            if name in module_level_names(read(target)):
                conflicts.append("%s already defines “%s”" % (os.path.basename(target), name))
        else:
            session.create(target)
        moved_names = used_names(found[0])
        dest = project.get_file(os.path.relpath(target, project.address))
        offset_now = Text(source).starts[found[0].lineno - 1] + Text(source).line_text(found[0].lineno).find(name)
        if isinstance(found[0], (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            offset_now = function_name_offset(Text(source), found[0])
        mover = MoveGlobal(project, project.get_file(os.path.relpath(def_resource.real_path, project.address)), offset_now)
        session.do(mover.get_changes(dest))
        # Imports only the moved code used are unused at the source now.
        source_path = def_resource.real_path
        if os.path.exists(source_path):
            write(source_path, remove_unused_imports(read(source_path), moved_names))
        files = session.results()
        for changed in files:
            try:
                ast.parse(changed["contents"])
            except SyntaxError as error:
                conflicts.append("%s doesn't parse afterwards (line %s)" % (os.path.basename(changed["path"]), error.lineno))
        return {"files": files, "creates": [p for p in session.created], "conflicts": conflicts}
    finally:
        session.restore()


def move_module(project, resource, options):
    """A module moved to another folder, or renamed: imports updated."""
    target = os.path.abspath(options["target"])
    old = resource.real_path
    if os.path.exists(target):
        raise Failure("%s already exists" % os.path.basename(target))
    same_folder = os.path.dirname(target) == os.path.dirname(old)
    if same_folder:
        new_name = os.path.basename(target)
        if not new_name.endswith(".py"):
            raise Failure("A Python module's name must end in .py")
        changes = Rename(project, resource).get_changes(new_name[:-3])
    else:
        if os.path.basename(target) != os.path.basename(old):
            raise Failure("Move and rename separately")
        folder = os.path.dirname(target)
        if not os.path.isdir(folder):
            raise Failure("No folder %s" % folder)
        dest = project.get_folder(os.path.relpath(folder, project.address)) if folder != project.address else project.root
        changes = MoveModule(project, resource).get_changes(dest)
    files = contents_of(changes)
    moves = [
        {"from": change.resource.real_path, "to": change.new_resource.real_path}
        for change in flatten(changes)
        if isinstance(change, MoveResource)
    ]
    return {"files": files, "moves": moves, "conflicts": []}


# --- Entry ---------------------------------------------------------------------------------


def main():
    request = json.load(sys.stdin)
    root = request["root"]
    project = Project(root, ropefolder=None)
    try:
        # `from pkg.module import name`, as people write (and JetBrains adds).
        project.prefs.imports.preferred_import_style = "from-global"
    except AttributeError:
        pass
    try:
        path = request["file"]
        relative = os.path.relpath(path, root)
        if relative.startswith(".."):
            raise Failure("%s isn't inside the project folder" % os.path.basename(path))
        resource = project.get_file(relative)
        kind = request["kind"]
        options = request.get("options") or {}
        offset = None
        if request.get("position"):
            offset = Text(resource.read()).offset(*request["position"])
        if kind == "usages":
            reply = find_usages(project, resource, offset)
        elif kind == "module_usages":
            reply = module_usages(project, resource)
        elif kind == "safe_delete":
            reply = safe_delete(project, resource, offset)
        elif kind == "signature":
            reply = signature(project, resource, offset)
        elif kind == "change_signature":
            reply = change_signature(project, resource, offset, options)
        elif kind == "move":
            reply = move(project, resource, offset, options)
        elif kind == "move_module":
            reply = move_module(project, resource, options)
        else:
            raise Failure("unknown refactoring " + kind)
        print(json.dumps(reply))
    except (Failure, RopeError) as error:
        print(json.dumps({"error": str(error) or type(error).__name__}))
    except Exception as error:  # a bug here: say what, don't crash silently
        print(json.dumps({"error": "%s: %s" % (type(error).__name__, error)}))
    finally:
        project.close()


main()
