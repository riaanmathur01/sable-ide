/** JSON with comments and trailing commas (keybindings.json, VS Code themes). */
export function parseJsonc(text: string): unknown {
  // Two passes: comments out (a comment can sit after a trailing comma),
  // then commas before ] or } out — never touching strings.
  const pass = (input: string, step: (input: string, index: number) => [string, number] | null) => {
    let out = "";
    let inString = false;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (inString) {
        out += char;
        if (char === "\\") out += input[++index] ?? "";
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        out += char;
        continue;
      }
      const replaced = step(input, index);
      if (replaced) {
        out += replaced[0];
        index = replaced[1];
      } else {
        out += char;
      }
    }
    return out;
  };
  const noComments = pass(text, (input, index) => {
    if (input[index] === "/" && input[index + 1] === "/") {
      let end = index;
      while (end < input.length && input[end] !== "\n") end++;
      return ["", end - 1];
    }
    if (input[index] === "/" && input[index + 1] === "*") {
      let end = index + 2;
      while (end < input.length && !(input[end] === "*" && input[end + 1] === "/")) end++;
      return [" ", end + 1];
    }
    return null;
  });
  const noTrailingCommas = pass(noComments, (input, index) => {
    if (input[index] !== ",") return null;
    const next = input.slice(index + 1).match(/^\s*(.)/)?.[1];
    return next === "]" || next === "}" ? ["", index] : null;
  });
  return JSON.parse(noTrailingCommas.trim() || "[]");
}
