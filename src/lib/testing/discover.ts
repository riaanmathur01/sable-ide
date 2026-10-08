/**
 * Finding tests in a file, per framework, from its text. Pure (no I/O),
 * so it's unit-tested. Deliberately simple patterns — the conventions each
 * framework itself uses to find tests.
 */

export type Framework = "pytest" | "vitest" | "jest" | "go" | "cargo" | "junit";

export interface TestItem {
  /** Unique within the file. */
  id: string;
  /** What's shown: the test's own name. */
  label: string;
  /** 1-based line of the test's declaration. */
  line: number;
  kind: "test" | "suite";
  /** Suites/classes enclosing it (for display and matching). */
  parents: string[];
  /**
   * How the runner selects it: a pytest node id suffix ("Class::test"),
   * a Jest/Vitest full name, a Go/Rust/JUnit test name.
   */
  selector: string;
}

/** Whether a file holds tests for `framework`, by its name. */
export function isTestFile(path: string, framework: Framework): boolean {
  const name = path.split(/[/\\]/).pop() ?? path;
  switch (framework) {
    case "pytest":
      return /^test_.*\.py$|_test\.py$/.test(name);
    case "vitest":
    case "jest":
      return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /[/\\]__tests__[/\\]/.test(path);
    case "go":
      return name.endsWith("_test.go");
    case "cargo":
      return name.endsWith(".rs");
    case "junit":
      return /\.java$/.test(name);
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function pytestTests(lines: string[]): TestItem[] {
  const items: TestItem[] = [];
  let currentClass: { name: string; indent: number } | null = null;
  lines.forEach((text, index) => {
    if (!text.trim() || text.trimStart().startsWith("#")) return;
    const indent = indentOf(text);
    if (currentClass && indent <= currentClass.indent) currentClass = null;
    const classMatch = /^(\s*)class\s+(Test\w*)\b/.exec(text);
    if (classMatch) {
      currentClass = { name: classMatch[2], indent: classMatch[1].length };
      items.push({ id: classMatch[2], label: classMatch[2], line: index + 1, kind: "suite", parents: [], selector: classMatch[2] });
      return;
    }
    const functionMatch = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(text);
    if (!functionMatch) return;
    const name = functionMatch[1];
    if (currentClass && indent > currentClass.indent) {
      const selector = `${currentClass.name}::${name}`;
      items.push({ id: selector, label: name, line: index + 1, kind: "test", parents: [currentClass.name], selector });
    } else if (indent === 0) {
      items.push({ id: name, label: name, line: index + 1, kind: "test", parents: [], selector: name });
    }
  });
  return items;
}

const JS_CALL = /^(\s*)(describe|it|test)(?:\.(?:only|skip|concurrent|todo|each\([^)]*\)))*\s*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/;

function jsTests(lines: string[]): TestItem[] {
  const items: TestItem[] = [];
  // Open describe blocks, by the indentation of their line.
  const stack: { name: string; indent: number }[] = [];
  lines.forEach((text, index) => {
    const match = JS_CALL.exec(text);
    if (!match) return;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parents = stack.map((entry) => entry.name);
    const name = match[4];
    const fullName = [...parents, name].join(" ");
    const kind = match[2] === "describe" ? "suite" : "test";
    items.push({ id: fullName, label: name, line: index + 1, kind, parents, selector: fullName });
    if (kind === "suite") stack.push({ name, indent });
  });
  return items;
}

function goTests(lines: string[]): TestItem[] {
  return lines.flatMap((text, index) => {
    const match = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(text);
    return match ? [{ id: match[1], label: match[1], line: index + 1, kind: "test" as const, parents: [], selector: match[1] }] : [];
  });
}

function rustTests(lines: string[]): TestItem[] {
  const items: TestItem[] = [];
  let pendingAttribute = false;
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (/^#\[(?:[\w:]+::)?test\b/.test(trimmed)) {
      pendingAttribute = true;
      return;
    }
    if (!pendingAttribute) return;
    const match = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(trimmed);
    if (match) {
      items.push({ id: match[1], label: match[1], line: index + 1, kind: "test", parents: [], selector: match[1] });
      pendingAttribute = false;
    } else if (trimmed && !trimmed.startsWith("#[") && !trimmed.startsWith("//")) {
      pendingAttribute = false;
    }
  });
  return items;
}

function junitTests(lines: string[], path: string): TestItem[] {
  const className = (path.split(/[/\\]/).pop() ?? "").replace(/\.java$/, "");
  const items: TestItem[] = [];
  let pendingTest = false;
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (/^@(?:org\.junit\.(?:jupiter\.api\.)?)?(Test|ParameterizedTest|RepeatedTest)\b/.test(trimmed)) {
      pendingTest = true;
      return;
    }
    if (!pendingTest) return;
    const match = /\bvoid\s+(\w+)\s*\(/.exec(trimmed);
    if (match) {
      items.push({
        id: match[1],
        label: match[1],
        line: index + 1,
        kind: "test",
        parents: [className],
        selector: `${className}#${match[1]}`,
      });
      pendingTest = false;
    } else if (trimmed && !trimmed.startsWith("@") && !trimmed.startsWith("//")) {
      pendingTest = false;
    }
  });
  if (items.length > 0) {
    const classLine = lines.findIndex((text) => new RegExp(`\\bclass\\s+${className}\\b`).test(text));
    items.unshift({ id: className, label: className, line: classLine + 1, kind: "suite", parents: [], selector: className });
  }
  return items;
}

/** The tests a file declares. */
export function discoverTests(path: string, text: string, framework: Framework): TestItem[] {
  if (!isTestFile(path, framework)) return [];
  const lines = text.split("\n");
  switch (framework) {
    case "pytest":
      return pytestTests(lines);
    case "vitest":
    case "jest":
      return jsTests(lines);
    case "go":
      return goTests(lines);
    case "cargo":
      return rustTests(lines);
    case "junit":
      return junitTests(lines, path);
  }
}
