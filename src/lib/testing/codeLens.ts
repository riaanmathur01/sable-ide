import type * as MonacoTypes from "monaco-editor";
import { pathFromUri } from "../editorRegistry";
import { resultFor, testsIn, useTestStore } from "../../store/testStore";

/**
 * "▶ Run | Debug" above every test (and "Run all" above the first), with
 * the last result's ✓ / ✗ — the editor's view of the test runner.
 */

type Monaco = typeof MonacoTypes;

const LANGUAGES = ["python", "typescript", "javascript", "go", "rust", "java"];
const STATUS = { passed: "✓", failed: "✗", skipped: "⊘" };

export function registerTestCodeLenses(monaco: Monaco) {
  monaco.editor.registerCommand("sable.test.run", (_accessor, file: string, itemId?: string) => {
    void testsIn(file).then((found) => {
      const item = found?.items.find((candidate) => candidate.id === itemId);
      void useTestStore.getState().runFileTests(file, item ? [item] : undefined);
    });
  });
  monaco.editor.registerCommand("sable.test.coverage", (_accessor, file: string) => {
    void useTestStore.getState().runFileTests(file, undefined, true);
  });
  monaco.editor.registerCommand("sable.test.debug", (_accessor, file: string, itemId: string) => {
    void testsIn(file).then((found) => {
      const item = found?.items.find((candidate) => candidate.id === itemId);
      if (item) void useTestStore.getState().debugTest(file, item);
    });
  });

  // Results change → refresh the annotations.
  const changed = new monaco.Emitter<MonacoTypes.languages.CodeLensProvider>();
  const provider: MonacoTypes.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses: async (model) => {
      if (model.uri.scheme !== "file") return { lenses: [], dispose() {} };
      const file = pathFromUri(model.uri);
      const found = await testsIn(file);
      if (!found || found.items.length === 0 || model.isDisposed()) return { lenses: [], dispose() {} };
      const { context, items } = found;
      const running = useTestStore.getState().run?.running ?? false;
      const lenses: MonacoTypes.languages.CodeLens[] = [];
      const range = (line: number) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
      const testCount = items.filter((item) => item.kind === "test").length;
      if (testCount > 1) {
        lenses.push({
          range: range(items[0].line),
          command: { id: "sable.test.run", title: running ? "Running…" : `▶ Run all ${testCount} tests in file`, arguments: [file] },
        });
      }
      if (testCount > 0 && !running) {
        lenses.push({
          range: range(items[0].line),
          command: { id: "sable.test.coverage", title: "Run with Coverage", tooltip: "Run this file's tests and mark which lines ran", arguments: [file] },
        });
      }
      for (const item of items) {
        const result = resultFor(file, context, item);
        const status = result ? `${STATUS[result.status]} ` : "";
        lenses.push({
          range: range(item.line),
          command: {
            id: "sable.test.run",
            title: `${status}▶ Run${item.kind === "suite" ? " all" : ""}`,
            tooltip: result?.message ?? (result ? result.status : "Run this test"),
            arguments: [file, item.id],
          },
        });
        lenses.push({
          range: range(item.line),
          command: { id: "sable.test.debug", title: "Debug", tooltip: "Debug this test", arguments: [file, item.id] },
        });
      }
      return { lenses, dispose() {} };
    },
  };
  for (const language of LANGUAGES) monaco.languages.registerCodeLensProvider(language, provider);
  useTestStore.subscribe((state, previous) => {
    if (state.version !== previous.version) changed.fire(provider);
  });
}
