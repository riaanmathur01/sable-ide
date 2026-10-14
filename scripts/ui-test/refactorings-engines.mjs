// Tests the engines behind Safe Delete / Change Signature / Move that
// don't need the app around them (no browser needed):
//
//   - TypeScript/JavaScript (src/lib/refactorings/tsEngine.ts) on the
//     TypeScript language service Monaco bundles — the same one the app
//     runs — over a small multi-file project;
//   - the text-based engine for other languages (textEngine.ts) on Java,
//     Go, Rust and Kotlin samples, with the references a language server
//     would report.
//
//   node scripts/ui-test/refactorings-engines.mjs
//
// (Python's engine, Rope, is tested by `cargo test --lib refactor_deep`.)
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const load = async (file) => {
  const bundle = await build({ entryPoints: [path.join(app, file)], bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
};
const engine = await load("src/lib/refactorings/tsEngine.ts");
const text = await load("src/lib/refactorings/textEngine.ts");
const { typescript: ts } = await import(path.join(app, "node_modules/monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js"));

const ROOT = "/project";
const FILES = {
  "/project/src/math.ts": `/** Scales a value. */
export function scaled(value: number, factor: number, offset = 0): number {
  return value * factor + offset;
}

// Nobody calls this.
export function unused(a: string) {
  return a.length;
}

export class Shape {
  constructor(public name: string, sides: number) {}
  area(width: number, height: number): number {
    return width * height;
  }
}

export class Square extends Shape {
  constructor() {
    super("square", 4);
  }
  area(w: number, h: number): number {
    return w * h;
  }
}
`,
  "/project/src/app.ts": `import { scaled, Shape, Square } from "./math";

const a = scaled(1, 2);
const b = scaled(scaled(1, 2, 3), 4);
const s = new Shape("tri", 3);
s.area(1, 2);
new Square().area(3, 4);
export const total = a + b;
`,
  "/project/src/other.ts": `export const PI = 3.14;
`,
};

const project = () => engine.createTsProject(ts, new Map(Object.entries(FILES)), ROOT);
const at = (file, needle, delta = 0) => {
  const index = FILES[file].indexOf(needle);
  assert.ok(index >= 0, needle);
  return index + delta;
};
const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push(`  ok  ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
};

test("signature of a function, read at a call", () => {
  const signature = engine.tsSignature(project(), "/project/src/app.ts", at("/project/src/app.ts", "scaled(1, 2)"));
  assert.equal(signature.name, "scaled");
  assert.deepEqual(signature.params.map((p) => [p.name, p.type, p.defaultValue]), [["value", "number", ""], ["factor", "number", ""], ["offset", "", "0"]]);
  assert.equal(signature.returnType, "number");
});

test("change signature: reorder, rename, remove, add with a value, nested calls", () => {
  const p = project();
  const signature = engine.tsSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "scaled"));
  const [value, factor] = signature.params;
  signature.name = "scale";
  signature.params = [
    { ...factor, raw: factor.raw },
    { ...value, name: "input", raw: undefined },
    { id: "n", name: "round", type: "boolean", defaultValue: "false", value: "true", original: null, kind: "positional" },
  ];
  const { changes, conflicts } = engine.tsChangeSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "scaled"), signature);
  const math = changes.get("/project/src/math.ts");
  assert.match(math, /export function scale\(factor: number, input: number, round: boolean = false\): number \{\n  return input \* factor \+ offset;/);
  const app = changes.get("/project/src/app.ts");
  assert.match(app, /import \{ scale, Shape, Square \} from "\.\/math";/);
  assert.match(app, /const a = scale\(2, 1, true\);/);
  assert.match(app, /const b = scale\(4, scale\(2, 1, true\), true\);/);
  assert.ok(conflicts.some((c) => c.includes("offset")), conflicts.join("\n"));
});

test("change signature of a method: overrides and calls follow", () => {
  const p = project();
  const signature = engine.tsSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "area(width"));
  signature.params.reverse();
  const { changes } = engine.tsChangeSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "area(width"), signature);
  const math = changes.get("/project/src/math.ts");
  assert.match(math, /area\(height: number, width: number\): number \{\n    return width \* height;/);
  assert.match(math, /area\(h: number, w: number\): number \{\n    return w \* h;/);
  const app = changes.get("/project/src/app.ts");
  assert.match(app, /s\.area\(2, 1\);/);
  assert.match(app, /new Square\(\)\.area\(4, 3\);/);
});

test("change signature of a constructor: new and super() calls", () => {
  const p = project();
  const signature = engine.tsSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "constructor(public"));
  assert.equal(signature.kind, "constructor");
  signature.params.push({ id: "c", name: "color", type: "string", defaultValue: "", value: '"red"', original: null, kind: "positional" });
  const { changes } = engine.tsChangeSignature(p, "/project/src/math.ts", at("/project/src/math.ts", "constructor(public"), signature);
  const math = changes.get("/project/src/math.ts");
  assert.match(math, /constructor\(public name: string, sides: number, color: string\) \{\}/);
  assert.match(math, /super\("square", 4, "red"\);/);
  assert.match(changes.get("/project/src/app.ts"), /new Shape\("tri", 3, "red"\)/);
});

test("safe delete: usages, and deleting an unused function with its comment", () => {
  const p = project();
  const used = engine.tsUsages(p, "/project/src/math.ts", at("/project/src/math.ts", "scaled"));
  assert.equal(used.what, "function scaled");
  assert.equal(used.usages.length, 4, JSON.stringify(used.usages));
  assert.equal(used.usages.filter((u) => u.kind === "import").length, 1);
  const unused = engine.tsUsages(p, "/project/src/math.ts", at("/project/src/math.ts", "unused"));
  assert.equal(unused.usages.length, 0);
  const { changes } = engine.tsSafeDelete(p, "/project/src/math.ts", at("/project/src/math.ts", "unused"));
  const math = changes.get("/project/src/math.ts");
  assert.ok(!math.includes("unused") && !math.includes("Nobody"), math);
  assert.match(math, /return value \* factor \+ offset;\n}\n\nexport class Shape/);
});

test("safe delete of a parameter removes its arguments", () => {
  const p = project();
  const { changes } = engine.tsSafeDelete(p, "/project/src/math.ts", at("/project/src/math.ts", "offset = 0"));
  assert.match(changes.get("/project/src/math.ts"), /scaled\(value: number, factor: number\): number/);
  assert.match(changes.get("/project/src/app.ts"), /const b = scaled\(scaled\(1, 2\), 4\);/);
});

test("move a function to a new file", () => {
  const p = project();
  const { changes } = engine.tsMove(p, "/project/src/math.ts", at("/project/src/math.ts", "scaled"), "/project/src/scaling.ts");
  const moved = changes.get("/project/src/scaling.ts");
  assert.match(moved, /export function scaled\(value: number/);
  assert.ok(!changes.get("/project/src/math.ts").includes("function scaled"));
  assert.match(changes.get("/project/src/app.ts"), /import \{ scaled \} from "\.\/scaling";/);
});

test("move a function to an existing file", () => {
  const p = project();
  const { changes } = engine.tsMove(p, "/project/src/math.ts", at("/project/src/math.ts", "unused"), "/project/src/other.ts");
  assert.match(changes.get("/project/src/other.ts"), /export const PI = 3\.14;[\s\S]*export function unused/);
});

test("renaming a file updates its importers; importers found", () => {
  const p = project();
  const { changes } = engine.tsFileRename(p, "/project/src/math.ts", "/project/src/lib/geometry.ts");
  assert.match(changes.get("/project/src/app.ts"), /from "\.\/lib\/geometry";/);
  const importers = engine.tsImporters(p, "/project/src/math.ts");
  assert.equal(importers.length, 1);
  assert.equal(importers[0].path, "/project/src/app.ts");
});

// --- The text-based engine -------------------------------------------------------------

/** References to `name` in `files` (path → text), as a server would report: in code, not strings or comments. */
const referencesTo = (files, name) =>
  Object.entries(files).flatMap(([file, source]) =>
    [...source.matchAll(new RegExp(`\\b${name}\\b`, "g"))]
      .filter((match) => {
        const before = source.slice(source.lastIndexOf("\\n", match.index) + 1, match.index);
        return !before.includes("//") && (before.match(/"/g) ?? []).length % 2 === 0;
      })
      .map((match) => ({ path: file, start: match.index, end: match.index + name.length })),
  );
const change = (files, file, name, edit) => {
  const declaration = text.readDeclaration(file, files[file], files[file].indexOf(`${name}(`));
  const signature = { ...declaration.signature, params: declaration.signature.params.map((p) => ({ ...p })) };
  edit(signature);
  const plan = text.rewriteSignature(declaration, signature, referencesTo(files, name), new Map(Object.entries(files)));
  return { plan, after: Object.fromEntries(plan.files.map((f) => [f.path, f.after])) };
};

const JAVA = {
  "/j/Pricing.java": `public class Pricing {
    /** Totals. */
    @Deprecated
    public static double total(double[] prices, double tax, Map<String, Integer> extra) {
        return sum(prices) * (1 + tax); // total(...) in a comment
    }

    static double unused(int a) {
        return a;
    }
}
`,
  "/j/App.java": `class App {
    void run() {
        double a = Pricing.total(new double[] {1, 2}, 0.2, Map.of("a", 1));
        double b = Pricing.total(prices(), Pricing.total(xs, 0.1, m), m);
        String s = "total(1, 2)";
    }
}
`,
};

test("text engine: Java signature read with generics and arrays", () => {
  const declaration = text.readDeclaration("/j/Pricing.java", JAVA["/j/Pricing.java"], JAVA["/j/Pricing.java"].indexOf("total("));
  assert.deepEqual(
    declaration.signature.params.map((p) => [p.type, p.name]),
    [["double[]", "prices"], ["double", "tax"], ["Map<String, Integer>", "extra"]],
  );
});

test("text engine: Java reorder, remove, add (its default is what calls pass), nested calls", () => {
  const { after, plan } = change(JAVA, "/j/Pricing.java", "total", (signature) => {
    const [prices, tax] = signature.params;
    signature.params = [tax, prices, { id: "c", name: "currency", type: "String", defaultValue: '"EUR"', value: "", original: null, kind: "positional" }];
  });
  assert.match(after["/j/Pricing.java"], /public static double total\(double tax, double\[\] prices, String currency\) \{/);
  assert.match(after["/j/Pricing.java"], /\/\/ total\(\.\.\.\) in a comment/);
  assert.match(after["/j/App.java"], /Pricing\.total\(0\.2, new double\[\] \{1, 2\}, "EUR"\);/);
  assert.match(after["/j/App.java"], /Pricing\.total\(Pricing\.total\(0\.1, xs, "EUR"\), prices\(\), "EUR"\);/);
  assert.match(after["/j/App.java"], /"total\(1, 2\)"/, "strings untouched");
  assert.equal(plan.conflicts.length, 0, plan.conflicts.join("\n"));
});

test("text engine: Java Safe Delete takes the doc comment and annotations; a parameter is found", () => {
  const source = JAVA["/j/Pricing.java"];
  const plan = text.deleteDeclaration("/j/Pricing.java", source, source.indexOf("unused("));
  assert.equal(plan.files[0].after, source.replace("\n    static double unused(int a) {\n        return a;\n    }\n", ""), "the blank line before it goes too");
  const total = text.deleteDeclaration("/j/Pricing.java", source, source.indexOf("total("));
  assert.ok(!total.files[0].after.includes("Totals") && !total.files[0].after.includes("@Deprecated"), total.files[0].after);
  const parameter = text.parameterOf(source, source.indexOf("tax,"), {});
  assert.deepEqual(parameter, { functionAt: source.indexOf("total("), index: 1 });
  assert.equal(text.parameterOf(source, source.indexOf("sum("), {}), null);
});

test("text engine: Go and Rust (self stays first), overrides by position", () => {
  const go = { "/g/m.go": "package m\n\nfunc Scale(value int, factor int) int {\n\treturn value * factor\n}\n\nvar x = Scale(1, 2)\n" };
  const g = change(go, "/g/m.go", "Scale", (signature) => signature.params.reverse());
  assert.match(g.after["/g/m.go"], /func Scale\(factor int, value int\) int \{/);
  assert.match(g.after["/g/m.go"], /var x = Scale\(2, 1\)/);
  const rust = {
    "/r/lib.rs": "trait Area {\n    fn area(&self, w: f64, h: f64) -> f64;\n}\n\nimpl Area for Shape {\n    fn area(&self, width: f64, height: f64) -> f64 {\n        width * height\n    }\n}\n\nfn main() {\n    let a = s.area(1.0, 2.0);\n}\n",
  };
  const r = change(rust, "/r/lib.rs", "area", (signature) => signature.params.reverse());
  assert.match(r.after["/r/lib.rs"], /fn area\(&self, h: f64, w: f64\) -> f64;/);
  assert.match(r.after["/r/lib.rs"], /fn area\(&self, height: f64, width: f64\) -> f64 \{/);
  assert.match(r.after["/r/lib.rs"], /s\.area\(2\.0, 1\.0\)/);
});

test("text engine: named arguments are reported, not rewritten", () => {
  const kotlin = { "/k/a.kt": "fun scale(value: Int, factor: Int = 2): Int = value * factor\n\nval a = scale(value = 1, factor = 3)\nval b = scale(4)\n" };
  const k = change(kotlin, "/k/a.kt", "scale", (signature) => signature.params.reverse());
  assert.match(k.after["/k/a.kt"], /fun scale\(factor: Int = 2, value: Int\): Int/);
  assert.match(k.after["/k/a.kt"], /scale\(value = 1, factor = 3\)/);
  assert.ok(k.plan.conflicts.some((c) => c.includes("named")), k.plan.conflicts.join("\n"));
});

console.log(results.join("\n"));
