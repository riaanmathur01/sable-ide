// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const INDENT = "  ";

/** Words written in uppercase (outside quotes and comments). Words that are
 *  often column names (name, date, key, type, value…) are left alone. */
const KEYWORDS = new Set(
  `select from where and or not in is null like ilike between exists as on join left right full inner outer cross
  natural group by order having limit offset fetch only union all distinct intersect except insert into values
  update set delete returning with recursive case when then else end asc desc nulls true false using over partition
  window create table alter drop add column index view primary foreign references default constraint unique check
  if replace truncate cascade count sum avg min max coalesce nullif cast extract conflict do nothing integer int bigint
  smallint varchar char boolean numeric decimal real serial begin commit rollback transaction grant revoke top`.split(/\s+/),
);

/** Clauses that start a line of their own. */
const CLAUSES = new Set([
  "SELECT", "SELECT DISTINCT", "SELECT ALL", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET",
  "UNION", "UNION ALL", "UNION DISTINCT", "INTERSECT", "INTERSECT ALL", "EXCEPT", "EXCEPT ALL",
  "INSERT", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE", "DELETE FROM", "RETURNING", "WITH", "WITH RECURSIVE",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "LEFT OUTER JOIN", "RIGHT OUTER JOIN",
  "FULL OUTER JOIN", "NATURAL JOIN", "NATURAL LEFT JOIN", "NATURAL RIGHT JOIN",
]);
/** Clauses whose comma-separated items go one per line, indented. */
const LIST_CLAUSES = new Set(["SELECT", "SELECT DISTINCT", "SELECT ALL", "SET", "VALUES"]);
/** Statements that get laid out; others (CREATE TABLE …) keep their layout. */
const LAID_OUT = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "VALUES"]);

/**
 * @typedef {{ type: "word" | "string" | "comment" | "line-comment" | "number" | "op",
 *   text: string, space: string }} Token  `space`: the whitespace before it.
 */

/** SQL → tokens. Strings, quoted names and comments are single tokens, so
 *  nothing inside them is ever changed. */
function tokenize(sql) {
  /** @type {Token[]} */
  const tokens = [];
  const patterns = /** @type {[Token["type"], RegExp][]} */ ([
    ["line-comment", /--[^\r\n]*/y],
    ["comment", /\/\*[\s\S]*?(?:\*\/|$)/y],
    ["string", /'(?:[^']|'')*(?:'|$)/y],
    ["string", /"(?:[^"]|"")*(?:"|$)/y],
    ["string", /`(?:[^`]|``)*(?:`|$)/y],
    ["string", /\$([A-Za-z_]\w*)?\$[\s\S]*?(?:\$\1\$|$)/y], // PostgreSQL $$ … $$
    ["number", /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y],
    ["word", /[\p{L}_@#][\p{L}\p{N}_$@#]*/uy],
    ["op", /<>|<=|>=|!=|\|\||::|->>|->|=>|:=|[^\s]/y],
  ]);
  let i = 0;
  let space = "";
  while (i < sql.length) {
    const whitespace = /\s+/y;
    whitespace.lastIndex = i;
    const gap = whitespace.exec(sql);
    if (gap) {
      space += gap[0];
      i += gap[0].length;
      continue;
    }
    for (const [type, pattern] of patterns) {
      pattern.lastIndex = i;
      const match = pattern.exec(sql);
      if (!match || !match[0]) continue;
      tokens.push({ type, text: match[0], space });
      i += match[0].length;
      space = "";
      break;
    }
  }
  return tokens;
}

/** Tokens → statements (each ending at, and including, its ";"). */
function statements(tokens) {
  const result = [[]];
  for (const token of tokens) {
    result[result.length - 1].push(token);
    if (token.text === ";") result.push([]);
  }
  // Empty statements (a stray ";") are dropped.
  return result.filter((statement) => statement.some((token) => token.text !== ";"));
}

const isKeyword = (tokens, i) => {
  if (tokens[i].type !== "word" || tokens[i - 1]?.text === "." || tokens[i + 1]?.text === ".") return false;
  const word = tokens[i].text.toLowerCase();
  // "key" only in PRIMARY KEY / FOREIGN KEY (it's a common column name).
  if (word === "key") return /^(primary|foreign)$/i.test(tokens[i - 1]?.text ?? "");
  return KEYWORDS.has(word);
};

/** A statement we don't lay out: keywords uppercased, spacing kept. */
function keepLayout(tokens) {
  return tokens
    .map((token, i) => (i ? token.space : "") + (isKeyword(tokens, i) ? token.text.toUpperCase() : token.text))
    .join("")
    .trim();
}

/** The keyword phrase starting at tokens[i] ("GROUP BY", "LEFT OUTER JOIN"), and its length in tokens. */
function phraseAt(tokens, i) {
  const word = (k) => (tokens[k]?.type === "word" && isKeyword(tokens, k) ? tokens[k].text.toUpperCase() : "");
  const first = word(i);
  const PHRASES = [
    ["GROUP", "BY"], ["ORDER", "BY"], ["PARTITION", "BY"], ["INSERT", "INTO"], ["DELETE", "FROM"],
    ["SELECT", "DISTINCT"], ["SELECT", "ALL"], ["UNION", "ALL"], ["UNION", "DISTINCT"], ["INTERSECT", "ALL"],
    ["EXCEPT", "ALL"], ["WITH", "RECURSIVE"],
    ["LEFT", "OUTER", "JOIN"], ["RIGHT", "OUTER", "JOIN"], ["FULL", "OUTER", "JOIN"],
    ["NATURAL", "LEFT", "JOIN"], ["NATURAL", "RIGHT", "JOIN"], ["NATURAL", "JOIN"],
    ["LEFT", "JOIN"], ["RIGHT", "JOIN"], ["FULL", "JOIN"], ["INNER", "JOIN"], ["CROSS", "JOIN"],
  ];
  for (const phrase of PHRASES) {
    if (phrase.every((part, k) => word(i + k) === part)) return { text: phrase.join(" "), length: phrase.length };
  }
  return { text: first, length: 1 };
}

/** One SELECT/INSERT/UPDATE/DELETE statement, laid out. */
function layOut(tokens) {
  let out = "";
  let level = 0;
  /** @type {string | null} */
  let clause = null;
  let caseDepth = 0;
  let between = false;
  let forceSpace = false;
  let noSpace = false;
  let pendingNewline = false;
  /** @type {{ sub: boolean, level: number, clause: string | null, caseDepth: number, indent: number }[]} */
  const stack = [];

  const lineIndent = () => (/(?:^|\n)( *)[^\n]*$/.exec(out)?.[1].length ?? 0) / INDENT.length;
  const lineEmpty = () => /(?:^|\n) *$/.test(out);
  const newline = (indent) => {
    out = out.replace(/ +$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
    out += INDENT.repeat(indent);
  };
  const write = (text, space) => {
    if (!lineEmpty() && !noSpace && (space || forceSpace)) out += " ";
    out += text;
    forceSpace = noSpace = false;
  };
  /** Not inside a function call's or a list's parentheses. */
  const queryLevel = () => !stack.length || stack[stack.length - 1].sub;
  const inListClause = () => queryLevel() && clause !== null && LIST_CLAUSES.has(clause);
  const conditions = () => clause === "WHERE" || clause === "HAVING" || !!clause?.endsWith("JOIN");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (pendingNewline) {
      newline(inListClause() ? level + 1 : level);
      pendingNewline = false;
    }
    if (token.type === "comment" || token.type === "line-comment") {
      // A comment on its own line stays on its own line.
      if (token.space.includes("\n") && out) newline(inListClause() ? level + 1 : level);
      write(token.text, !!token.space);
      if (token.type === "line-comment") pendingNewline = true;
      continue;
    }
    if (token.type === "word" && isKeyword(tokens, i)) {
      const phrase = phraseAt(tokens, i);
      i += phrase.length - 1;
      const text = phrase.text;
      if (CLAUSES.has(text) && queryLevel()) {
        if (out.trim()) newline(level);
        write(text, true);
        clause = text;
        between = false;
        if (LIST_CLAUSES.has(text)) newline(level + 1);
        else forceSpace = true;
      } else if ((text === "AND" || text === "OR") && queryLevel() && caseDepth === 0 && !between && conditions()) {
        newline(level + 1);
        write(text, true);
        forceSpace = true;
      } else {
        if (text === "AND" && between) between = false;
        if (text === "BETWEEN") between = true;
        if (text === "CASE") caseDepth++;
        if (text === "END" && caseDepth) caseDepth--;
        write(text, !!token.space);
        if (text.endsWith("JOIN") || text === "ON") forceSpace = true;
      }
      continue;
    }
    switch (token.text) {
      case "(": {
        // A subquery: "(" then SELECT or WITH.
        const next = tokens.slice(i + 1).find((t) => t.type !== "comment" && t.type !== "line-comment");
        const sub = !!next && next.type === "word" && /^(select|with)$/i.test(next.text);
        stack.push({ sub, level, clause, caseDepth, indent: lineIndent() });
        write("(", !!token.space);
        noSpace = true;
        if (sub) {
          level = lineIndent() + 1;
          clause = null;
          caseDepth = 0;
        }
        break;
      }
      case ")": {
        const open = stack.pop();
        if (open?.sub) {
          newline(open.indent);
          ({ level, clause, caseDepth } = open);
        }
        noSpace = true;
        write(")", false);
        break;
      }
      case ",":
        noSpace = true;
        write(",", false);
        if (inListClause()) newline(level + 1);
        else if (queryLevel() && clause?.startsWith("WITH")) newline(level);
        else forceSpace = true;
        break;
      case ";":
        noSpace = true;
        write(";", false);
        break;
      case ".":
        noSpace = true;
        write(".", false);
        noSpace = true;
        break;
      default:
        write(token.text, !!token.space);
    }
  }
  return out.trim();
}

/** Formats SQL text: each SELECT/INSERT/UPDATE/DELETE statement laid out,
 *  others with keywords uppercased; one blank line between statements. */
function formatSql(sql) {
  const formatted = statements(tokenize(sql)).map((tokens) => {
    const first = tokens.find((t) => t.type !== "comment" && t.type !== "line-comment" && t.text !== "(");
    return first && first.type === "word" && LAID_OUT.has(first.text.toUpperCase()) ? layOut(tokens) : keepLayout(tokens);
  });
  const trailing = /\r?\n\s*$/.test(sql) ? "\n" : "";
  return formatted.filter(Boolean).join("\n\n") + trailing;
}

/** @param {Sable} sable */
export function activate(sable) {
  // Format Document (⇧⌥F) and format on save, for .sql files.
  sable.languages.registerFormatter("sql", ({ text }) => formatSql(text));

  sable.commands.register("format", "Format SQL", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const selected = editor.selection?.text ?? "";
    if (selected.trim()) await sable.editor.replaceSelection(formatSql(selected));
    else await sable.editor.setText(formatSql(editor.text));
  });
}
