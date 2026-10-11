// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/**
 * The snippets: prefix → description and body. Bodies use snippet syntax:
 * $1, ${2:placeholder}, $0 (where the cursor ends), and NAME for the
 * component name taken from the file's name.
 * @type {Record<string, [string, string]>}
 */
const SNIPPETS = {
  rfc: [
    "Function component (export default)",
    "export default function ${1:NAME}(${2:props}) {\n  return (\n    <div>\n      $0\n    </div>\n  );\n}",
  ],
  rafce: [
    "Arrow function component, exported",
    "const ${1:NAME} = (${2:props}) => {\n  return (\n    <div>\n      $0\n    </div>\n  );\n};\n\nexport default ${1:NAME};",
  ],
  useState: ["useState hook", "const [${1:value}, set${1/(.*)/${1:/capitalize}/}] = useState(${2:initialValue});$0"],
  useEffect: ["useEffect hook", "useEffect(() => {\n  ${1:// effect}\n}, [${2:dependencies}]);$0"],
  useRef: ["useRef hook", "const ${1:ref} = useRef(${2:null});$0"],
  useMemo: ["useMemo hook", "const ${1:value} = useMemo(() => ${2:compute()}, [${3:dependencies}]);$0"],
  useCallback: ["useCallback hook", "const ${1:handleClick} = useCallback((${2:event}) => {\n  $0\n}, [${3:dependencies}]);"],
  useContext: ["useContext hook", "const ${1:value} = useContext(${2:MyContext});$0"],
  createContext: ["createContext", "export const ${1:My}Context = createContext(${2:null});$0"],
  imr: ["import React", 'import React from "react";$0'],
  imrs: ["import React with useState and useEffect", 'import React, { useState, useEffect } from "react";$0'],
  dprops: ["Destructure props", "const { ${1:children} } = props;$0"],
};

/** "src/user-card.tsx" → "UserCard" ("index.jsx" uses its folder's name). */
function componentName(path) {
  const parts = path.split(/[\\/]/);
  let base = (parts.pop() ?? "").replace(/\..*$/, "");
  if (base === "index" && parts.length) base = parts.pop() ?? base;
  const name = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : "Component";
}

/** A snippet as plain text, placeholders filled with their defaults, for
 *  the suggestion's documentation. */
function preview(body) {
  /** @type {Record<string, string>} */
  const defaults = {};
  for (const match of body.matchAll(/\$\{(\d+):([^${}]*)\}/g)) defaults[match[1]] ??= match[2];
  return body
    .replace(/\$\{(\d+)\/\(\.\*\)\/\$\{\d+:\/capitalize\}\/\}/g, (_, n) => (defaults[n] ?? "").replace(/^./, (c) => c.toUpperCase()))
    .replace(/\$\{(\d+)\|([^,|]*)[^|]*\|\}/g, "$2")
    .replace(/\$\{\d+:([^${}]*)\}/g, "$1")
    .replace(/\$\{?\d+\}?/g, "");
}

/** @param {Sable} sable */
export function activate(sable) {
  const provide = ({ linePrefix, path }) => {
    // Only where a statement starts: the prefix is all that's on the line.
    if (!/^\s*[A-Za-z]*$/.test(linePrefix)) return [];
    const name = componentName(path);
    return Object.entries(SNIPPETS).map(([prefix, [description, body]]) => {
      const text = body.replace(/NAME/g, name);
      return {
        label: prefix,
        insertText: text,
        snippet: true,
        kind: /** @type {const} */ ("snippet"),
        detail: `${description} (React snippet)`,
        documentation: preview(text),
      };
    });
  };
  for (const language of ["javascriptreact", "typescriptreact", "javascript", "typescript"]) {
    sable.languages.registerCompletions(language, provide);
  }
}
