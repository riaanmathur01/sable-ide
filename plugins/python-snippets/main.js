// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/**
 * The snippets: prefix → description, body, and whether it's offered in
 * the middle of a line (expressions) or only where a statement starts.
 * Bodies use snippet syntax: $1, ${2:placeholder}, ${3|a,b|} (a choice),
 * $0 (where the cursor ends). Indents are 4 spaces.
 * @type {Record<string, [string, string, ("statement" | "expression")?]>}
 */
const SNIPPETS = {
  ifmain: ["if __name__ == \"__main__\" guard", 'if __name__ == "__main__":\n    ${1:main()}$0'],
  dataclass: [
    "Dataclass (from dataclasses import dataclass)",
    "@dataclass\nclass ${1:Name}:\n    ${2:field}: ${3:str}$0",
  ],
  class: [
    "Class with __init__",
    "class ${1:Name}:\n    def __init__(self, ${2:value}):\n        self.${2:value} = ${2:value}$0",
  ],
  def: ["Function with a docstring", 'def ${1:name}(${2:args}):\n    """${3:Describe what it does.}"""\n    ${0:pass}'],
  adef: ["Async function with a docstring", 'async def ${1:name}(${2:args}):\n    """${3:Describe what it does.}"""\n    ${0:pass}'],
  try: [
    "try / except / finally",
    "try:\n    ${1:pass}\nexcept ${2:Exception} as ${3:error}:\n    ${4:raise}\nfinally:\n    ${0:pass}",
  ],
  withopen: [
    "with open(…) as f",
    'with open(${1:"file.txt"}, ${2|"r","w","a","rb","wb"|}, encoding="utf-8") as ${3:f}:\n    ${0:data = f.read()}',
  ],
  lc: ["List comprehension", "[${1:x} for ${2:x} in ${3:items}]$0", "expression"],
  dc: ["Dict comprehension", "{${1:key}: ${2:value} for ${1:key}, ${2:value} in ${3:mapping}.items()}$0", "expression"],
  argparse: [
    "Command-line program with argparse",
    "import argparse\n\n\ndef main():\n    parser = argparse.ArgumentParser(description=\"${1:What the program does.}\")\n" +
      "    parser.add_argument(\"${2:path}\", help=\"${3:Input file}\")\n" +
      "    parser.add_argument(\"-v\", \"--verbose\", action=\"store_true\", help=\"More output\")\n" +
      "    args = parser.parse_args()\n    $0\n\n\nif __name__ == \"__main__\":\n    main()",
  ],
  test: ["pytest test function", "def test_${1:something}():\n    ${2:result = ...}\n    assert ${3:result == expected}$0"],
  logging: [
    "Logging setup",
    'import logging\n\nlogging.basicConfig(\n    level=logging.${1|INFO,DEBUG,WARNING,ERROR|},\n' +
      '    format="%(asctime)s %(levelname)s %(name)s: %(message)s",\n)\nlogger = logging.getLogger(__name__)$0',
  ],
  namedtuple: [
    "Typed NamedTuple (from typing import NamedTuple)",
    "class ${1:Point}(NamedTuple):\n    ${2:x}: ${3:float}\n    ${4:y}: ${5:float}$0",
  ],
};

/** A snippet as plain text, placeholders filled with their defaults, for
 *  the suggestion's documentation. */
function preview(body) {
  return body
    .replace(/\$\{\d+\|([^,|]*)[^|]*\|\}/g, "$1")
    .replace(/\$\{\d+:([^${}]*)\}/g, "$1")
    .replace(/\$\{?\d+\}?/g, "");
}

/** @param {Sable} sable */
export function activate(sable) {
  sable.languages.registerCompletions("python", ({ linePrefix }) => {
    // Statements only where one starts; comprehensions after anything but a "." or a name.
    const statementStart = /^\s*[A-Za-z_]*$/.test(linePrefix);
    if (!statementStart && !/(^|[^\w.])[A-Za-z_]*$/.test(linePrefix)) return [];
    return Object.entries(SNIPPETS)
      .filter(([, [, , where = "statement"]]) => statementStart || where === "expression")
      .map(([prefix, [description, body]]) => ({
        label: prefix,
        insertText: body,
        snippet: true,
        kind: /** @type {const} */ ("snippet"),
        detail: `${description} (Python snippet)`,
        documentation: preview(body),
      }));
  });
}
