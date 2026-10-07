#!/usr/bin/env python3
"""
Extract JetBrains' editor color schemes into src/lib/jetbrains/schemes.generated.ts.

JetBrains IDEs color code through TextAttributesKeys ("PY.SELF_PARAMETER",
"DEFAULT_KEYWORD", …). A key's color comes from the active scheme — the
base scheme XML plus "additional text attributes" files that each language
plugin registers — or, when the scheme doesn't set it, from the key's
fallback chain (KOTLIN_KEYWORD → JAVA_KEYWORD → DEFAULT_KEYWORD). The XML
files are inside the IDEs' jars; the fallback chains only exist in compiled
code, so they're read from the classes' static initializers with `javap`.

Usage:
  python3 scripts/jetbrains-colors/extract.py \\
      --ide /Applications/CLion.app --ide /Applications/PyCharm.app \\
      --ide /Volumes/GoLand/GoLand.app --ide /Volumes/Rider/Rider.app … \\
      --out src/lib/jetbrains/schemes.generated.ts

`--ide` takes IDE .app bundles, unpacked plugin folders, or plugin .zip
files, in priority order (the first one that has a file wins). Language
coverage depends on what's given: Python (PyCharm or CLion), JavaScript/
TypeScript, C/C++ and Rust (CLion), Go (GoLand), PHP (PhpStorm), Ruby
(RubyMine), C# (Rider). Java and Kotlin key definitions are open source and
fetched from GitHub. Needs a JDK (`javap`) on PATH.

Lookup rules follow IntelliJ's own (EditorColorsSchemeImpl,
AbstractColorsScheme, DefaultColorsScheme, EditorColorsManagerImpl):
  - a key's own value (in the scheme or its parent), else its fallback
    chain, else the parent scheme;
  - Darcula is a built-in default scheme: it never inherits from the light
    "Default" scheme, except as the last resort for keys with no value and
    no fallback (TextAttributesKey.getDefaultAttributes()).
  - Dark and Islands Dark both have Darcula as their parent; language files
    are applied after the base XML and overwrite it.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import tempfile
import textwrap
import xml.etree.ElementTree as ET
import zipfile

SCHEMES = ("Default", "Darcula", "Dark", "Islands Dark")
BASE_FILES = {
    "DefaultColorSchemesManager.xml": "base",
    "themes/expUI/expUI_darkScheme.xml": "Dark",
    "themes/islands/IslandSchemeDark.xml": "Islands Dark",
}
# Rust registers its files through provider classes, not XML.
RUST_FILES = {
    "org/rust/ide/colors/RustDefault.xml": "Default",
    "org/rust/ide/colors/RustDarcula.xml": "Darcula",
    "org/rust/ide/colors/RustDark.xml": "Dark",
}
INTELLIJ = "https://raw.githubusercontent.com/JetBrains/intellij-community/master/"
OPEN_SOURCE_KEYS = {
    "JavaHighlightingColors": "java/java-frontback-psi-impl/src/com/intellij/ide/highlighter/JavaHighlightingColors.java",
    "KotlinHighlightingColors": "plugins/kotlin/highlighting/highlighting-minimal/src/org/jetbrains/kotlin/idea/highlighter/KotlinHighlightingColors.java",
}
KOTLIN_SCHEMES = {
    "Default": "plugins/kotlin/base/resources/resources/colorScheme/Default_Kotlin.xml",
    "Darcula": "plugins/kotlin/base/resources/resources/colorScheme/Darcula_Kotlin.xml",
}

# Which keys to ship (the rest are UI/debugger/VCS keys).
PREFIXES = (
    "DEFAULT_", "ReSharper.", "PY.", "JS.", "TS.", "JAVA_", "KOTLIN_", "GO_", "org.rust.", "OC.",
    "PHP_", "RUBY_", "CSS.", "SASS_", "LESS_", "HTML_", "XML_", "JSON.", "YAML_", "MARKDOWN_",
    "SQL_", "BASH.",
)
EXTRA_KEYS = {
    "TEXT", "BAD_CHARACTER", "DEPRECATED_ATTRIBUTES", "TODO_DEFAULT_ATTRIBUTES",
    # Java's semantic keys (CodeInsightColors).
    "INSTANCE_FIELD_ATTRIBUTES", "INSTANCE_FINAL_FIELD_ATTRIBUTES", "STATIC_FIELD_ATTRIBUTES",
    "STATIC_FINAL_FIELD_ATTRIBUTES", "STATIC_FIELD_IMPORTED_ATTRIBUTES", "METHOD_CALL_ATTRIBUTES",
    "METHOD_DECLARATION_ATTRIBUTES", "STATIC_METHOD_ATTRIBUTES", "STATIC_METHOD_CALL_IMPORTED_ATTRIBUTES",
    "ABSTRACT_METHOD_ATTRIBUTES", "PARAMETER_ATTRIBUTES", "LOCAL_VARIABLE_ATTRIBUTES",
    "CLASS_NAME_ATTRIBUTES", "INTERFACE_NAME_ATTRIBUTES", "ENUM_NAME_ATTRIBUTES",
    "TYPE_PARAMETER_NAME_ATTRIBUTES", "ANNOTATION_NAME_ATTRIBUTES", "ANNOTATION_ATTRIBUTE_NAME_ATTRIBUTES",
    "CONSTRUCTOR_CALL_ATTRIBUTES", "CONSTRUCTOR_DECLARATION_ATTRIBUTES", "ABSTRACT_CLASS_NAME_ATTRIBUTES",
    "RECORD_COMPONENT_ATTRIBUTES", "REASSIGNED_LOCAL_VARIABLE_ATTRIBUTES", "REASSIGNED_PARAMETER_ATTRIBUTES",
}

INHERIT = "INHERIT"


# --- Collecting files from the IDEs -------------------------------------------


def jars_of(source, scratch):
    """All jars of an IDE bundle, plugin folder, or plugin zip."""
    if source.endswith(".zip"):
        target = os.path.join(scratch, "unzipped", os.path.basename(source))
        if not os.path.isdir(target):
            with zipfile.ZipFile(source) as archive:
                archive.extractall(target)
        source = target
    return sorted(glob.glob(os.path.join(source, "**", "*.jar"), recursive=True))


def collect(sources, scratch):
    """Base schemes, language scheme files and key-defining classes."""
    base, addons, classes = {}, {}, {}
    class_dir = os.path.join(scratch, "classes")
    for source in sources:
        jars = jars_of(source, scratch)
        registrations = set()
        for jar in jars:
            try:
                archive = zipfile.ZipFile(jar)
                names = archive.namelist()
            except (zipfile.BadZipFile, OSError):
                continue
            for name in names:
                if name in BASE_FILES and name not in base:
                    base[name] = archive.read(name)
                if name in RUST_FILES and (RUST_FILES[name], name) not in addons:
                    addons[(RUST_FILES[name], name)] = archive.read(name)
                if name.endswith(".xml"):
                    try:
                        text = archive.read(name).decode("utf-8", "ignore")
                    except (KeyError, OSError):
                        continue
                    for match in re.finditer(r'<additionalTextAttributes\s+scheme="([^"]+)"\s+file="([^"]+)"', text):
                        if match.group(1) in SCHEMES:
                            registrations.add((match.group(1), match.group(2).lstrip("/")))
                elif name.endswith(".class") and name not in classes:
                    data = archive.read(name)
                    # Keys are made by createTextAttributesKey, or by
                    # helpers (JS: getOrCreateTextAttributesKey; Rider:
                    # *TextAttributeKeys.key()).
                    if (
                        b"createTextAttributesKey" in data
                        or b"CreateTextAttributesKey" in data
                        or name.endswith("TextAttributeKeys.class")
                    ):
                        path = os.path.join(class_dir, name)
                        os.makedirs(os.path.dirname(path), exist_ok=True)
                        with open(path, "wb") as out:
                            out.write(data)
                        classes[name] = path
        # The registered files may live in any jar of the same product.
        wanted = {reg for reg in registrations if reg not in addons}
        for jar in jars:
            if not wanted:
                break
            try:
                archive = zipfile.ZipFile(jar)
                names = set(archive.namelist())
            except (zipfile.BadZipFile, OSError):
                continue
            for scheme, name in list(wanted):
                if name in names:
                    addons[(scheme, name)] = archive.read(name)
                    wanted.discard((scheme, name))
    for scheme, path in KOTLIN_SCHEMES.items():
        addons[(scheme, path)] = fetch(path).encode()
    missing = [name for name in BASE_FILES if name not in base]
    if missing:
        raise SystemExit(f"Base scheme files not found: {missing}")
    return base, addons, class_dir


def fetch(path):
    # curl, not urllib: python.org builds on macOS ship without CA certs.
    return subprocess.run(["curl", "-sfL", INTELLIJ + path], capture_output=True, text=True, check=True).stdout


# --- Key fallbacks, from bytecode -------------------------------------------------


def static_initializers(class_dir):
    """`javap -c` output of each class's static initializer, batched."""
    names = [
        os.path.relpath(path, class_dir)[:-6].replace(os.sep, ".")
        for path in glob.glob(os.path.join(class_dir, "**", "*.class"), recursive=True)
    ]
    result = {}
    for start in range(0, len(names), 150):
        batch = names[start:start + 150]
        output = subprocess.run(
            ["javap", "-c", "-p", "-constants", "-cp", class_dir, *batch],
            capture_output=True, text=True,
        ).stdout
        # javap prints "Compiled from …" before each class.
        for chunk in re.split(r"(?m)^Compiled from .*$", output)[1:]:
            header = re.search(r"(?m)^\S.*?(?:class|interface|enum) ([\w.$]+)", chunk)
            if header and "static {};" in chunk:
                result[header.group(1)] = chunk.split("static {};", 1)[1]
    return result


def segments(initializers):
    """Per static field: the strings and key fields read before it's set."""
    segs = {}
    for cls, code in initializers.items():
        current = {"s": [], "g": []}
        for line in code.splitlines():
            match = re.search(r"ldc(?:_w)?\s+#\d+\s+// String (.*)$", line)
            if match:
                current["s"].append(match.group(1))
                continue
            match = re.search(r"getstatic\s+#\d+\s+// Field (\S+):L([^;]+);", line)
            if match:
                field = match.group(1)
                field = field if "/" in field else cls.replace(".", "/") + "." + field
                current["g"].append(field.replace("/", "."))
                continue
            # A Kotlin property getter returning a key reads like a field.
            match = re.search(
                r"invoke(?:virtual|static)\s+#\d+\s+// Method (\S+)\.get([A-Z_][A-Z0-9_]*):\(\)"
                r"Lcom/intellij/openapi/editor/colors/TextAttributesKey;",
                line,
            )
            if match:
                current["g"].append((match.group(1) + "." + match.group(2)).replace("/", "."))
                continue
            match = re.search(r"putstatic\s+#\d+\s+// Field (\S+):L([^;]+);", line)
            if match:
                field = match.group(1)
                full = (field if "/" in field else cls.replace(".", "/") + "." + field).replace("/", ".")
                # Kotlin null checks name the expression; they aren't key names.
                simple = {read.rsplit(".", 1)[-1] for read in current["g"]}
                current["s"] = [s for s in current["s"] if s not in simple]
                segs[full] = current
                current = {"s": [], "g": []}
    return segs


JS_SPECIAL = {
    "BAD_CHARACTER": "BADCHARACTER", "PARENTHESES": "PARENTHS", "PRIMITIVE_TYPE": "PRIMITIVE.TYPE",
    "EXPORTED_VARIABLE": "EXPORTED.VARIABLE", "EXPORTED_FUNCTION": "EXPORTED.FUNCTION",
    "EXPORTED_CLASS": "EXPORTED.CLASS",
}
TS_DESCRIPTOR_FALLBACKS = {
    "MODULE_NAME": "com.intellij.openapi.editor.DefaultLanguageHighlighterColors.IDENTIFIER",
    "ENUM": "com.intellij.lang.javascript.highlighting.TypeScriptHighlighter.TS_CLASS",
    "ENUM_MEMBER": "com.intellij.lang.javascript.highlighting.TypeScriptHighlighter.TS_STATIC_MEMBER_VARIABLE",
}
KEY_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.\-: ]*$")
BUNDLE_KEY = re.compile(r"^[a-z]+(\.[a-z0-9]+)+$")


def fallback_table(segs):
    """External key name → its fallback key's name (or None)."""
    field_name, field_fallback, alias = {}, {}, {}
    for field, seg in segs.items():
        cls, name = field.rsplit(".", 1)
        strings = seg["s"]
        reads = [r for r in seg["g"] if not r.endswith("INSTANCE") and "Bundle" not in r and "$WhenMappings" not in r]
        if cls.endswith("RsColor"):
            # Rust's enum: "org.rust." + the constant's name.
            if name in ("$VALUES", "$ENTRIES", "Companion"):
                continue
            field_name[field] = "org.rust." + name
        elif cls.endswith("JavaScriptHighlightDescriptor"):
            if not strings:
                continue
            field_name[field] = "JS." + JS_SPECIAL.get(name, name)
        elif cls.endswith("TypeScriptHighlightDescriptor"):
            if not strings:
                continue
            field_name[field] = "TS." + name
            if name in TS_DESCRIPTOR_FALLBACKS:
                field_fallback[field] = TS_DESCRIPTOR_FALLBACKS[name]
            continue
        else:
            names = [s for s in strings if KEY_NAME.match(s) and not BUNDLE_KEY.match(s) and not s.endswith("(...)")]
            if not names:
                if len(reads) == 1:
                    alias[field] = reads[0]
                continue
            field_name[field] = names[0]
        if reads:
            field_fallback[field] = reads[-1]

    def through_alias(field):
        for _ in range(10):
            if field not in alias:
                break
            field = alias[field]
        return field

    fallback = {}
    for field, name in field_name.items():
        target = field_fallback.get(field)
        target = through_alias(target) if target else None
        fallback[name] = field_name.get(target) if target else None
    fields = dict(field_name)
    for field in alias:
        if through_alias(field) in field_name:
            fields[field] = field_name[through_alias(field)]

    # Java and Kotlin keys, from the open-source definitions.
    source_keys = {}
    for cls, path in OPEN_SOURCE_KEYS.items():
        pattern = (r'TextAttributesKey\s+(\w+)\s*=\s*(?:TextAttributesKey\.)?createTextAttributesKey\('
                   r'\s*"([^"]+)"\s*(?:,\s*([\w.]+))?\s*\)')
        for match in re.finditer(pattern, fetch(path)):
            source_keys[cls + "." + match.group(1)] = (match.group(2), match.group(3), cls)
    for name, target, cls in source_keys.values():
        if not target:
            fallback[name] = None
            continue
        owner, member = (target.rsplit(".", 1) if "." in target else (cls, target))
        owner = owner.split(".")[-1]
        if owner + "." + member in source_keys:
            fallback[name] = source_keys[owner + "." + member][0]
        else:
            fallback[name] = next((n for f, n in fields.items() if f.endswith("." + owner + "." + member)), None)
    return fallback


# --- Resolving schemes -------------------------------------------------------------


def read_attributes(element, into):
    if element is None:
        return
    for option in element.findall("option"):
        value = option.find("value")
        if value is not None:
            into[option.get("name")] = {o.get("name"): o.get("value") for o in value.findall("option")}
        elif option.get("baseAttributes") is not None:
            into[option.get("name")] = INHERIT


class Scheme:
    def __init__(self, parent=None, key_defaults=None):
        self.parent, self.key_defaults, self.attrs = parent, key_defaults, {}

    def direct(self, key):
        if key in self.attrs:
            return self.attrs[key]
        return self.parent.direct(key) if self.parent else None

    def through_fallbacks(self, key, fallback):
        while True:
            attrs, following = self.direct(key), fallback.get(key)
            if attrs is not None and (attrs != INHERIT or following is None):
                return attrs
            if following is None:
                return None
            key = following

    def get(self, key, fallback):
        attrs = self.direct(key)
        if attrs is not None and attrs != INHERIT:
            return attrs
        if fallback.get(key):
            attrs = self.through_fallbacks(fallback[key], fallback)
            if attrs is not None and attrs != INHERIT:
                return attrs
        if self.parent:
            return self.parent.get(key, fallback)
        if self.key_defaults:
            for candidate in (key, fallback.get(key)):
                attrs = self.key_defaults.direct(candidate) if candidate else None
                if attrs is not None and attrs != INHERIT:
                    return attrs
        return None


def build_schemes(base, addons):
    manager = ET.fromstring(base["DefaultColorSchemesManager.xml"])
    by_name = {scheme.get("name"): scheme for scheme in manager.findall("scheme")}
    default = Scheme()
    read_attributes(by_name["Default"].find("attributes"), default.attrs)
    darcula = Scheme(key_defaults=default)
    read_attributes(by_name["Darcula"].find("attributes"), darcula.attrs)
    schemes = {"Default": default, "Darcula": darcula}
    roots = {"Darcula": by_name["Darcula"]}
    for path, name in BASE_FILES.items():
        if name == "base":
            continue
        root = ET.fromstring(base[path])
        schemes[name] = Scheme(parent=darcula)
        read_attributes(root.find("attributes"), schemes[name].attrs)
        roots[name] = root
    for (scheme, _), data in addons.items():
        root = ET.fromstring(data)
        element = root if root.tag == "attributes" else root.find("attributes")
        read_attributes(element if element is not None else root, schemes[scheme].attrs)
    return schemes, roots


def editor_colors(schemes, roots, scheme_name, new_ui):
    """Monaco editor colors from the scheme's <colors> and a few attributes."""
    colors = {}
    for name in ("Darcula", scheme_name):
        element = roots[name].find("colors")
        for option in (element.findall("option") if element is not None else []):
            if option.get("value"):
                colors[option.get("name")] = option.get("value")
    scheme = schemes[scheme_name]

    def attr(key, field):
        attrs = scheme.get(key, {})
        return attrs.get(field) if isinstance(attrs, dict) else None

    def hex_color(value):
        return "#" + value.lower() if value else None

    background = hex_color(attr("TEXT", "BACKGROUND"))
    mapping = {
        "editor.background": background,
        "editor.foreground": hex_color(attr("TEXT", "FOREGROUND")),
        "editorCursor.foreground": hex_color(colors.get("CARET_COLOR")),
        "editor.lineHighlightBackground": hex_color(colors.get("CARET_ROW_COLOR")),
        "editor.selectionBackground": hex_color(colors.get("SELECTION_BACKGROUND")),
        "editorLineNumber.foreground": hex_color(colors.get("LINE_NUMBERS_COLOR")),
        "editorLineNumber.activeForeground": hex_color(colors.get("LINE_NUMBER_ON_CARET_ROW_COLOR")),
        # The New UI paints the gutter in the editor background.
        "editorGutter.background": background if new_ui else hex_color(colors.get("GUTTER_BACKGROUND")),
        "editorIndentGuide.background1": hex_color(colors.get("INDENT_GUIDE")),
        "editorIndentGuide.activeBackground1": hex_color(colors.get("SELECTED_INDENT_GUIDE")),
        "editorWhitespace.foreground": hex_color(colors.get("WHITESPACES")),
        "editorRuler.foreground": hex_color(colors.get("RIGHT_MARGIN_COLOR")),
        "editor.findMatchBackground": hex_color(attr("TEXT_SEARCH_RESULT_ATTRIBUTES", "BACKGROUND")),
        "editor.findMatchHighlightBackground": hex_color(attr("TEXT_SEARCH_RESULT_ATTRIBUTES", "BACKGROUND")),
        "editor.wordHighlightBackground": hex_color(attr("IDENTIFIER_UNDER_CARET_ATTRIBUTES", "BACKGROUND")),
        "editor.wordHighlightStrongBackground": hex_color(attr("WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES", "BACKGROUND")),
        "editorBracketMatch.background": hex_color(attr("MATCHED_BRACE_ATTRIBUTES", "BACKGROUND")),
        "editorBracketMatch.border": hex_color(attr("MATCHED_BRACE_ATTRIBUTES", "BACKGROUND")),
        "editorError.foreground": hex_color(attr("ERRORS_ATTRIBUTES", "EFFECT_COLOR")),
        "editorWarning.foreground": hex_color(attr("WARNING_ATTRIBUTES", "EFFECT_COLOR")),
        "editorOverviewRuler.errorForeground": hex_color(attr("ERRORS_ATTRIBUTES", "ERROR_STRIPE_COLOR")),
        "editorOverviewRuler.warningForeground": hex_color(attr("WARNING_ATTRIBUTES", "ERROR_STRIPE_COLOR")),
        "editorGutter.addedBackground": hex_color(colors.get("ADDED_LINES_COLOR")),
        "editorGutter.modifiedBackground": hex_color(colors.get("MODIFIED_LINES_COLOR")),
        "editorGutter.deletedBackground": hex_color(colors.get("DELETED_LINES_COLOR")),
        "editorSuggestWidget.background": hex_color(colors.get("LOOKUP_COLOR")),
        "editorHoverWidget.background": hex_color(colors.get("DOCUMENTATION_COLOR")),
        "editorWidget.background": hex_color(colors.get("LOOKUP_COLOR")),
    }
    return {key: value for key, value in mapping.items() if value}


# --- Output ----------------------------------------------------------------------------


def style(attrs):
    out = {}
    if attrs.get("FOREGROUND"):
        out["fg"] = "#" + attrs["FOREGROUND"].lower().rjust(6, "0")
    font = attrs.get("FONT_TYPE")
    if font in ("1", "3"):
        out["bold"] = True
    if font in ("2", "3"):
        out["italic"] = True
    effect = attrs.get("EFFECT_TYPE")
    # IntelliJ effect types: 1 underline, 4 bold underline, 3 strikeout.
    # (Wave underlines and boxes have no Monaco equivalent.)
    if effect in ("1", "4") and attrs.get("EFFECT_COLOR"):
        out["underline"] = True
    if effect == "3":
        out["strikethrough"] = True
    return out


def resolved(scheme, fallback):
    keys = set(fallback) | set(scheme.attrs) | (set(scheme.parent.attrs) if scheme.parent else set())
    out = {}
    for key in sorted(keys):
        if not (key.startswith(PREFIXES) or key in EXTRA_KEYS) or BUNDLE_KEY.match(key):
            continue
        attrs = scheme.get(key, fallback)
        if attrs and attrs != INHERIT:
            out[key] = style(attrs)
    return out


def ts_object(entries):
    lines = []
    for key, value in entries.items():
        parts = [f'fg: "{value["fg"]}"'] if "fg" in value else []
        parts += [f"{flag}: true" for flag in ("bold", "italic", "underline", "strikethrough") if flag in value]
        lines.append(f"  {json.dumps(key)}: {{ {', '.join(parts)} }}," if parts else f"  {json.dumps(key)}: {{}},")
    return "\n".join(lines)


def ts_colors(name, colors):
    body = "\n".join(f'  {json.dumps(key)}: "{value}",' for key, value in colors.items())
    return f"export const {name}: Record<string, string> = {{\n{body}\n}};"


HEADER = """/**
 * JetBrains editor color schemes, as resolved attribute values.
 *
 * GENERATED by scripts/jetbrains-colors/extract.py — do not edit by hand
 * (see scripts/jetbrains-colors/README.md). Sources: the color schemes
 * bundled with
 * {sources},
 * plus the open-source IntelliJ Java/Kotlin key definitions.
 *
 * Keys are IntelliJ's TextAttributesKey names ("PY.SELF_PARAMETER",
 * "DEFAULT_KEYWORD", …). Each value is what the IDE actually renders:
 * the key's own setting, or its fallback chain (e.g. KOTLIN_KEYWORD →
 * JAVA_KEYWORD → DEFAULT_KEYWORD), resolved the way IntelliJ does. A key
 * with no `fg` renders in the default text color.
 */

export interface JbStyle {{
  fg?: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
}}

export type JbScheme = Record<string, JbStyle>;
"""


def describe(source):
    """"CLion 2026.2.2" for an IDE bundle, the file name otherwise."""
    info = os.path.join(source, "Contents", "Resources", "product-info.json")
    if os.path.exists(info):
        with open(info) as file:
            product = json.load(file)
        return f"{product['name']} {product['version']}"
    return os.path.basename(source.rstrip("/"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ide", action="append", required=True, help="IDE .app, plugin folder or plugin .zip")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as scratch:
        base, addons, class_dir = collect(args.ide, scratch)
        fallback = fallback_table(segments(static_initializers(class_dir)))
    schemes, roots = build_schemes(base, addons)

    darcula = resolved(schemes["Darcula"], fallback)
    dark = resolved(schemes["Dark"], fallback)
    islands = resolved(schemes["Islands Dark"], fallback)
    islands_diff = {key: value for key, value in islands.items() if dark.get(key) != value}

    sources = textwrap.fill(", ".join(describe(path) for path in args.ide), 72).replace("\n", "\n * ")
    output = HEADER.format(sources=sources) + f"""
/** Darcula (the classic JetBrains dark scheme). */
export const DARCULA: JbScheme = {{
{ts_object(darcula)}
}};

/** Dark (the New UI scheme). */
export const DARK: JbScheme = {{
{ts_object(dark)}
}};

/** Islands Dark (the 2025.3+ default): Dark's colors on a darker
 *  background, except Rust, which has its own Islands colors. */
export const ISLANDS_DARK: JbScheme = {{
  ...DARK,
{ts_object(islands_diff)}
}};

/** Editor colors (Monaco keys) from each scheme's <colors> section. */
{ts_colors("DARCULA_EDITOR", editor_colors(schemes, roots, "Darcula", False))}

{ts_colors("DARK_EDITOR", editor_colors(schemes, roots, "Dark", True))}

{ts_colors("ISLANDS_DARK_EDITOR", editor_colors(schemes, roots, "Islands Dark", True))}
"""
    with open(args.out, "w") as out:
        out.write(output)
    print(f"Wrote {args.out}: {len(darcula)} Darcula, {len(dark)} Dark keys")


if __name__ == "__main__":
    main()
