import { create } from "zustand";
import { getEditor, getModelValue, pathFromUri } from "../lib/editorRegistry";
import { readFile } from "../lib/ipc";
import { discoverTests, type TestItem } from "../lib/testing/discover";
import type { TestResult } from "../lib/testing/results";
import {
  debugLaunchFor,
  resultMatches,
  runTests,
  testContext,
  type TestContext,
  type TestScope,
} from "../lib/testing/runner";
import { useDebugStore } from "./debugStore";
import { useTabsStore } from "./tabsStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useCoverageStore } from "./coverageStore";

/**
 * Test runs: what's running, the latest results per file (shown in the
 * Tests panel and as ✓/✗ next to each test), and the actions — run a
 * test, a file, the project, rerun failed ones, debug a test.
 */

export interface TestRunSummary {
  label: string;
  running: boolean;
  startedAt: number;
  durationMs?: number;
  error?: string;
  log?: string;
  /** Run again (the same scope). */
  rerun?: { context: TestContext; scope: TestScope; coverage?: boolean };
  /** A coverage run that produced no coverage: why. */
  coverageError?: string;
}

interface TestState {
  /** Latest result of every test, by file. */
  resultsByFile: Record<string, TestResult[]>;
  /** The last run's results (what the Tests panel lists). */
  lastResults: TestResult[];
  run: TestRunSummary | null;
  /** Bumps on every change (editor annotations refresh on it). */
  version: number;

  runFileTests: (file: string, items?: TestItem[], coverage?: boolean) => Promise<void>;
  runProject: (coverage?: boolean) => Promise<void>;
  rerun: (coverage?: boolean) => Promise<void>;
  rerunFailed: () => Promise<void>;
  debugTest: (file: string, item: TestItem) => Promise<void>;
  /** Run (or debug) the test the cursor is in — ⌃⇧R / ⌃⇧D. */
  atCursor: (debug: boolean) => Promise<void>;
}

/** The tests in a file, from its open buffer or disk. */
export async function testsIn(file: string): Promise<{ context: TestContext; items: TestItem[] } | null> {
  const context = await testContext(file);
  if (!context) return null;
  const text = getModelValue(file) ?? (await readFile(file).catch(() => ""));
  return { context, items: discoverTests(file, text, context.framework) };
}

/** A test's latest result. */
export function resultFor(file: string, context: TestContext, item: TestItem): TestResult | undefined {
  const results = useTestStore.getState().resultsByFile[file] ?? [];
  if (item.kind === "suite") {
    const children = results.filter((result) =>
      context.framework === "pytest"
        ? result.name.startsWith(`${item.selector}::`)
        : context.framework === "junit"
          ? result.name.startsWith(`${item.selector}::`)
          : result.name.startsWith(`${item.selector} `),
    );
    if (children.length === 0) return undefined;
    const status = children.some((child) => child.status === "failed")
      ? "failed"
      : children.every((child) => child.status === "skipped")
        ? "skipped"
        : "passed";
    return { name: item.selector, status };
  }
  return results.find((result) => resultMatches(context.framework, result, item));
}

/** A file's tests' names, for the run's label. */
function describeScope(scope: TestScope, items?: TestItem[]): string {
  if ("project" in scope) return "All tests";
  const name = scope.file.split(/[/\\]/).pop() ?? scope.file;
  if (items && items.length === 1) return `${items[0].parents.concat(items[0].label).join(" › ")} (${name})`;
  return `Tests in ${name}`;
}

async function execute(context: TestContext, scope: TestScope, label: string, coverage = false) {
  const store = useTestStore;
  if (store.getState().run?.running) {
    useUiStore.getState().showStatus("Tests are already running");
    return;
  }
  const startedAt = Date.now();
  store.setState((state) => ({
    run: { label, running: true, startedAt, rerun: { context, scope, coverage } },
    version: state.version + 1,
  }));
  useUiStore.getState().setBottomPanel("tests");
  // Run what's on screen, not stale files.
  const tabs = useTabsStore.getState();
  if ("file" in scope && tabs.tabs.some((tab) => tab.path === scope.file)) await tabs.saveTab(scope.file);
  try {
    const run = await runTests(context, scope, { coverage });
    if (run.coverage) useCoverageStore.getState().set(run.coverage);
    const byFile: Record<string, TestResult[]> = { ...store.getState().resultsByFile };
    for (const result of run.results) {
      if (!result.file) continue;
      byFile[result.file] = [
        ...(byFile[result.file] ?? []).filter((existing) => existing.name !== result.name),
        result,
      ];
    }
    store.setState((state) => ({
      resultsByFile: byFile,
      lastResults: run.results,
      run: {
        label,
        running: false,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: run.error ?? (run.results.length === 0 ? "No tests ran" : undefined),
        log: run.log,
        rerun: { context, scope, coverage },
        coverageError: run.coverageError,
      },
      version: state.version + 1,
    }));
    const failed = run.results.filter((result) => result.status === "failed").length;
    const passed = run.results.filter((result) => result.status === "passed").length;
    useUiStore
      .getState()
      .showStatus(run.error ? run.error : failed ? `Tests: ${failed} failed, ${passed} passed` : `Tests: ${passed} passed`);
  } catch (error) {
    store.setState((state) => ({
      run: { label, running: false, startedAt, error: String(error), rerun: { context, scope, coverage } },
      version: state.version + 1,
    }));
  }
}

export const useTestStore = create<TestState>((_set, get) => ({
  resultsByFile: {},
  lastResults: [],
  run: null,
  version: 0,

  runFileTests: async (file, items, coverage) => {
    const found = await testsIn(file);
    if (!found) {
      useUiStore.getState().showStatus("No test runner found for this file (pytest, Vitest, Jest, Go, Cargo, JUnit)");
      return;
    }
    const scope: TestScope = items ? { file, items } : { file, items: "all" };
    await execute(found.context, scope, describeScope(scope, items), coverage);
  },

  runProject: async (coverage) => {
    const active = useTabsStore.getState().lastFilePath;
    const context = active ? await testContext(active) : null;
    if (!context) {
      useUiStore.getState().showStatus("Open a test file (or a file in the project) first, so Sable knows which test runner to use");
      return;
    }
    // The project root of that runner (Go: the module, not the package).
    const root = useWorkspaceStore.getState().rootPath ?? context.projectDir;
    await execute(
      { ...context, projectDir: context.framework === "go" ? root : context.projectDir },
      { project: true },
      "All tests",
      coverage,
    );
  },

  rerun: async (coverage) => {
    const run = get().run;
    if (run?.rerun) await execute(run.rerun.context, run.rerun.scope, run.label, coverage ?? run.rerun.coverage);
  },

  rerunFailed: async () => {
    const failedByFile = new Map<string, TestResult[]>();
    for (const result of get().lastResults) {
      if (result.status === "failed" && result.file) {
        failedByFile.set(result.file, [...(failedByFile.get(result.file) ?? []), result]);
      }
    }
    for (const [file, failed] of failedByFile) {
      const found = await testsIn(file);
      if (!found) continue;
      const items = found.items.filter(
        (item) => item.kind === "test" && failed.some((result) => resultMatches(found.context.framework, result, item)),
      );
      if (items.length) await execute(found.context, { file, items }, `Failed tests in ${file.split(/[/\\]/).pop()}`);
    }
  },

  debugTest: async (file, item) => {
    const context = await testContext(file);
    if (!context) return;
    const launch = await debugLaunchFor(context, file, item);
    if ("error" in launch) {
      useUiStore.getState().showStatus(launch.error);
      return;
    }
    await useDebugStore.getState().start(file, launch);
  },

  atCursor: async (debug) => {
    const editor = getEditor();
    const model = editor?.getModel();
    const line = editor?.getPosition()?.lineNumber;
    if (!model || !line) return;
    const file = pathFromUri(model.uri);
    const found = await testsIn(file);
    if (!found || found.items.length === 0) {
      useUiStore.getState().showStatus("No tests in this file");
      return;
    }
    // The nearest test (or suite) at or above the cursor.
    const item = [...found.items].reverse().find((candidate) => candidate.line <= line) ?? found.items[0];
    if (debug) await get().debugTest(file, item);
    else await get().runFileTests(file, [item]);
  },
}));
