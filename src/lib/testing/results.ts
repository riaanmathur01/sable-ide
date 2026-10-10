/**
 * Parsing test runners' reports into one shape. Pure, so it can be unit-tested
 * against the tools' real output.
 */

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
  /**
   * The test, as the runner names it: pytest/JUnit "Class::test" (or just
   * "test"), Jest/Vitest's full name, a Go test name, Rust's module path.
   */
  name: string;
  /** The file it's in, when the report says. */
  file?: string;
  /**
   * Where it lives when the report doesn't name a file (the runner maps
   * this to one): a Go package's import path, a JUnit class's full name,
   * a Cargo test target's source ("src/lib.rs", "tests/api.rs").
   */
  suite?: string;
  status: TestStatus;
  durationMs?: number;
  /** The failure message (short). */
  message?: string;
  /** Details: traceback, captured output. */
  output?: string;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

/**
 * JUnit XML (pytest --junitxml, Maven Surefire, Gradle). Names become
 * "Class::method", with the class's last dotted segment (pytest's
 * classname is "module.Class"; a module-level test has just "module").
 */
export function parseJUnitXml(xml: string, options: { classIsModule?: boolean } = {}): TestResult[] {
  const results: TestResult[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const tag = match[1];
    const body = match[2] ?? "";
    // Gradle writes "adds()" (and "adds(int)[1]" per parameter set).
    const name = (attribute(tag, "name") ?? "").replace(/\(.*$/, "");
    const classname = attribute(tag, "classname") ?? "";
    const segments = classname.split(".");
    // pytest: "test_math" (module) or "test_math.TestGroup" (module.Class).
    const className = options.classIsModule
      ? segments.length > 1
        ? segments[segments.length - 1]
        : ""
      : segments[segments.length - 1];
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const time = attribute(tag, "time");
    results.push({
      name: className ? `${className}::${name}` : name,
      file: attribute(tag, "file"),
      suite: options.classIsModule ? undefined : classname || undefined,
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      durationMs: time ? Math.round(Number(time) * 1000) : undefined,
      message: failure ? attribute(failure[2] ?? failure[5] ?? "", "message")?.split("\n")[0] : undefined,
      output: failure?.[3] ? decodeXml(failure[3]).trim() : undefined,
    });
  }
  return results;
}

interface JestReport {
  testResults: {
    name: string;
    message?: string;
    assertionResults: {
      fullName: string;
      status: string;
      duration?: number | null;
      failureMessages?: string[];
    }[];
  }[];
}

/** Jest --json, Vitest --reporter=json (the same format). */
export function parseJestJson(json: string): TestResult[] {
  const report = JSON.parse(json) as JestReport;
  return report.testResults.flatMap((file) =>
    file.assertionResults.map((assertion) => {
      const failure = assertion.failureMessages?.join("\n").trim();
      // Vitest/Jest print colors in failure messages.
      const plain = failure?.replace(/\u001b\[[0-9;]*m/g, "");
      return {
        name: assertion.fullName,
        file: file.name,
        status: assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped",
        durationMs: assertion.duration != null ? Math.round(assertion.duration) : undefined,
        message: plain?.split("\n")[0],
        output: plain,
      } satisfies TestResult;
    }),
  );
}

/** `go test -json`: one event per line. */
export function parseGoTestJson(text: string): TestResult[] {
  const byTest = new Map<string, TestResult & { lines: string[] }>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { Action: string; Test?: string; Package?: string; Output?: string; Elapsed?: number };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event.Test) continue;
    const key = `${event.Package ?? ""}\u0000${event.Test}`;
    const entry = byTest.get(key) ?? { name: event.Test, suite: event.Package, status: "passed" as TestStatus, lines: [] };
    byTest.set(key, entry);
    if (event.Action === "output" && event.Output) {
      // Skip the runner's own "=== RUN" / "--- PASS" frame lines.
      if (!/^(=== |--- )/.test(event.Output.trim())) entry.lines.push(event.Output.replace(/\n$/, ""));
    } else if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") {
      entry.status = event.Action === "pass" ? "passed" : event.Action === "fail" ? "failed" : "skipped";
      if (event.Elapsed !== undefined) entry.durationMs = Math.round(event.Elapsed * 1000);
    }
  }
  return [...byTest.values()].map(({ lines, ...result }) => {
    const output = lines.map((line) => line.trim()).join("\n").trim();
    return {
      ...result,
      message: result.status === "failed" ? output.split("\n")[0] || undefined : undefined,
      output: output || undefined,
    };
  });
}

/** `cargo test` (libtest's default output). */
export function parseCargoTest(text: string): TestResult[] {
  const results: TestResult[] = [];
  // "Running unittests src/lib.rs (target/…)" / "Running tests/api.rs (…)"
  // precede each test binary's results (on stderr, which callers append).
  const targets = [...text.matchAll(/^\s*Running (?:unittests )?(\S+) \(/gm)].map((match) => ({
    at: match.index ?? 0,
    source: match[1],
  }));
  for (const match of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    const target = targets.filter((candidate) => candidate.at < (match.index ?? 0)).pop();
    results.push({
      name: match[1],
      suite: target?.source,
      status: match[2] === "ok" ? "passed" : match[2] === "FAILED" ? "failed" : "skipped",
    });
  }
  // Failure details: "---- name stdout ----" sections.
  for (const match of text.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:|^test result:)/gm)) {
    const result = results.find((candidate) => candidate.name === match[1]);
    if (!result) continue;
    const output = match[2].trim();
    result.output = output;
    // The panic message: the line(s) after "panicked at …:".
    const panic = /panicked at [^\n]*:\n([^\n]+)/.exec(output);
    result.message = panic?.[1] ?? output.split("\n")[0];
  }
  return results;
}
