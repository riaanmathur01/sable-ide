import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, LoaderCircle, Percent, Play, RotateCcw } from "lucide-react";
import { useCoverageStore } from "../../store/coverageStore";
import { useTestStore, testsIn } from "../../store/testStore";
import { goTo } from "../../store/navigationStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { resultMatches } from "../../lib/testing/runner";
import type { TestResult } from "../../lib/testing/results";
import { iconForFile } from "../../lib/fileIcons";
import { relativePath } from "../Navigation/UsagesPanel";
import "../Problems/ProblemsPanel.css";
import "./TestsPanel.css";

const STATUS_ICON = { passed: CircleCheck, failed: CircleX, skipped: CircleSlash };

/** Jump to a result's test in its file. */
async function openResult(result: TestResult) {
  if (!result.file) return;
  const found = await testsIn(result.file);
  const item = found?.items.find((candidate) => resultMatches(found.context.framework, result, candidate));
  await goTo(result.file, item?.line ?? 1);
}

function ResultRow({ result }: { result: TestResult }) {
  const [open, setOpen] = useState(result.status === "failed");
  const Icon = STATUS_ICON[result.status];
  const details = result.output ?? result.message;
  return (
    <>
      <div className="problems-row tests-row" onClick={() => void openResult(result)} title={result.name}>
        <span
          className={details ? "tests-twisty" : "tests-twisty empty"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? <ChevronDown size={13} strokeWidth={1.5} /> : <ChevronRight size={13} strokeWidth={1.5} />}
        </span>
        <Icon size={13} strokeWidth={1.75} className={`tests-icon ${result.status}`} />
        <span className="problems-message">{result.name.replace(/::/g, " › ")}</span>
        {result.status === "failed" && result.message && (
          <span className="tests-message">{result.message}</span>
        )}
        {result.durationMs !== undefined && <span className="problems-position">{result.durationMs} ms</span>}
      </div>
      {open && details && <pre className="tests-output">{details}</pre>}
    </>
  );
}

/**
 * Tests tab: the last run — a summary, rerun buttons, and every result
 * grouped by file (click to jump, expand for the failure).
 */
export function TestsPanel() {
  const run = useTestStore((state) => state.run);
  const results = useTestStore((state) => state.lastResults);
  const coveragePercent = useCoverageStore((state) => state.percent);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const [showLog, setShowLog] = useState(false);
  const { rerun, rerunFailed, runProject } = useTestStore.getState();

  const groups = useMemo(() => {
    const byFile = new Map<string, TestResult[]>();
    for (const result of results) {
      const key = result.file ?? "";
      byFile.set(key, [...(byFile.get(key) ?? []), result]);
    }
    // Failures first.
    return [...byFile.entries()].sort(
      ([, a], [, b]) =>
        Number(b.some((result) => result.status === "failed")) - Number(a.some((result) => result.status === "failed")),
    );
  }, [results]);

  if (!run) {
    return (
      <div className="problems-panel">
        <div className="problems-empty">
          Run a test with the ▶ above it in the editor, ⌃⇧R for the test at the cursor, or “Tests: Run All Tests” in the
          command palette. Results appear here.
        </div>
        <div className="tests-actions">
          <button onClick={() => void runProject()}>
            <Play size={12} strokeWidth={1.75} /> Run all tests
          </button>
        </div>
      </div>
    );
  }

  const counts = {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };

  return (
    <div className="problems-panel">
      <div className="tests-summary">
        {run.running ? (
          <>
            <LoaderCircle size={13} strokeWidth={1.75} className="tests-spin" /> Running {run.label}…
          </>
        ) : (
          <>
            <span className={counts.failed ? "tests-headline failed" : "tests-headline passed"}>
              {run.error && results.length === 0
                ? run.error
                : `${counts.failed ? `${counts.failed} failed, ` : ""}${counts.passed} passed${counts.skipped ? `, ${counts.skipped} skipped` : ""}`}
            </span>
            <span className="tests-label">
              {run.label}
              {run.durationMs !== undefined && ` · ${(run.durationMs / 1000).toFixed(1)} s`}
            </span>
          </>
        )}
        <div className="tests-actions">
          <button disabled={run.running} onClick={() => void rerun()} title="Run again">
            <RotateCcw size={12} strokeWidth={1.75} /> Rerun
          </button>
          {counts.failed > 0 && (
            <button disabled={run.running} onClick={() => void rerunFailed()}>
              <RotateCcw size={12} strokeWidth={1.75} /> Rerun failed
            </button>
          )}
          <button
            disabled={run.running}
            onClick={() => void rerun(true)}
            title="Run again, and mark which lines ran in the editor"
          >
            <Percent size={12} strokeWidth={1.75} /> Coverage
          </button>
          {run.log && (
            <button onClick={() => setShowLog(!showLog)}>{showLog ? "Hide output" : "Show output"}</button>
          )}
        </div>
      </div>
      {(coveragePercent !== null || run.coverageError) && !run.running && (
        <div className="tests-coverage">
          {coveragePercent !== null ? (
            <>
              <span className="tests-coverage-bar">
                <span style={{ width: `${coveragePercent}%` }} />
              </span>
              <span>
                {coveragePercent}% of lines covered — green / red bars in the editor gutter
              </span>
              <button onClick={() => useCoverageStore.getState().hide()}>Hide</button>
            </>
          ) : (
            <span className="tests-coverage-error">{run.coverageError}</span>
          )}
        </div>
      )}
      <div className="problems-list">
        {showLog && run.log && <pre className="tests-output tests-log">{run.log}</pre>}
        {groups.map(([file, fileResults]) => {
          const name = file ? (file.split(/[/\\]/).pop() ?? file) : "Other";
          const FileIcon = iconForFile(name);
          return (
            <div key={file || "other"}>
              <div className="problems-file" title={file}>
                <FileIcon size={13} strokeWidth={1.5} className="problems-file-icon" />
                <span className="problems-file-name">{name}</span>
                {file && (
                  <span className="problems-file-dir">
                    {relativePath(file, rootPath).slice(0, -name.length).replace(/[/\\]$/, "")}
                  </span>
                )}
              </div>
              {fileResults.map((result) => (
                <ResultRow key={result.name} result={result} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
