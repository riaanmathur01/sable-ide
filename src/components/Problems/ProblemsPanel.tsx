import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  Info,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  mergeProblems,
  useProblemsStore,
  type Problem,
} from "../../store/problemsStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useAgentStore } from "../../store/agentStore";
import { revealPosition } from "../../lib/editorRegistry";
import { iconForFile } from "../../lib/fileIcons";
import "./ProblemsPanel.css";

function relativePath(path: string, root: string | null): string {
  return root && path.startsWith(root)
    ? path.slice(root.length).replace(/^[/\\]/, "")
    : path;
}

async function jumpTo(problem: Problem) {
  await useTabsStore.getState().openFile(problem.path);
  revealPosition(problem.path, problem.line, problem.column);
}

/** Hand one problem to the agent (it reads the file itself). */
function fixWithAgent(problem: Problem, root: string | null) {
  const origin = [problem.source, problem.code].filter(Boolean).join(" ");
  const prompt = `Fix this ${problem.severity} in \`${relativePath(problem.path, root)}:${problem.line}\`${origin ? ` (${origin})` : ""}:\n\n> ${problem.message}\n\nMake the smallest correct change, then briefly explain the cause.`;
  useUiStore.getState().focusAgent();
  const agent = useAgentStore.getState();
  if (agent.isRunning) agent.setDraft(prompt);
  else void agent.send(prompt);
}

const SEVERITY_ICON = {
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
};

/**
 * Problems tab: every error/warning the editor knows about, grouped by
 * file. Click to jump; ✨ hands the problem to the AI agent.
 */
export function ProblemsPanel() {
  const state = useProblemsStore();
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return Object.entries(mergeProblems(state))
      .map(([path, problems]) => ({
        path,
        problems: needle
          ? problems.filter(
              (problem) =>
                problem.message.toLowerCase().includes(needle) ||
                path.toLowerCase().includes(needle) ||
                (problem.source ?? "").toLowerCase().includes(needle),
            )
          : problems,
      }))
      .filter((group) => group.problems.length > 0)
      .sort((a, b) => {
        const errorsA = a.problems.filter((p) => p.severity === "error").length;
        const errorsB = b.problems.filter((p) => p.severity === "error").length;
        return errorsB - errorsA || a.path.localeCompare(b.path);
      });
  }, [state, filter]);

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="problems-panel">
      <input
        className="problems-filter"
        placeholder="Filter (e.g. text, file, source)"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="problems-list">
        {groups.length === 0 && (
          <div className="problems-empty">
            {filter
              ? "No problems match the filter."
              : "No problems detected. Errors from open files (and, for Python, the whole workspace) appear here."}
          </div>
        )}
        {groups.map(({ path, problems }) => {
          const isCollapsed = collapsed.has(path);
          const Chevron = isCollapsed ? ChevronRight : ChevronDown;
          const name = path.split(/[/\\]/).pop() ?? path;
          const FileIcon = iconForFile(name);
          const directory = relativePath(path, rootPath).slice(0, -name.length).replace(/[/\\]$/, "");
          return (
            <div key={path}>
              <div className="problems-file" onClick={() => toggle(path)} title={path}>
                <Chevron size={13} strokeWidth={1.5} />
                <FileIcon size={13} strokeWidth={1.5} className="problems-file-icon" />
                <span className="problems-file-name">{name}</span>
                <span className="problems-file-dir">{directory}</span>
                <span className="problems-count">{problems.length}</span>
              </div>
              {!isCollapsed &&
                problems.map((problem, index) => {
                  const Icon = SEVERITY_ICON[problem.severity];
                  return (
                    <div
                      key={`${problem.line}:${problem.column}:${index}`}
                      className="problems-row"
                      onClick={() => void jumpTo(problem)}
                      title={problem.message}
                    >
                      <Icon size={13} strokeWidth={1.75} className={`problems-icon ${problem.severity}`} />
                      <span className="problems-message">{problem.message}</span>
                      {(problem.source || problem.code) && (
                        <span className="problems-source">
                          {problem.source}
                          {problem.code ? `(${problem.code})` : ""}
                        </span>
                      )}
                      <span className="problems-position">
                        [Ln {problem.line}, Col {problem.column}]
                      </span>
                      {problem.severity !== "info" && (
                        <button
                          className="problems-fix"
                          title="Fix with Agent"
                          onClick={(event) => {
                            event.stopPropagation();
                            fixWithAgent(problem, rootPath);
                          }}
                        >
                          <Sparkles size={12} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
