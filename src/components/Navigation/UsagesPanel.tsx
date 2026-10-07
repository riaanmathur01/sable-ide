import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { goTo, useNavigationStore, type Usage } from "../../store/navigationStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { iconForFile } from "../../lib/fileIcons";
import "../Problems/ProblemsPanel.css";
import "./Navigation.css";

export function relativePath(path: string, root: string | null): string {
  return root && path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
}

/** The line's code with the usage highlighted (leading indentation trimmed). */
function Preview({ usage }: { usage: Usage }) {
  const text = usage.preview;
  const indent = text.length - text.trimStart().length;
  const start = Math.max(usage.column - 1, indent);
  const end = Math.max(start, usage.endColumn - 1);
  return (
    <span className="nav-preview">
      {text.slice(indent, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  );
}

/**
 * Find Usages (⌥F7): every use of a symbol across the project, grouped by
 * file, like JetBrains' Find tool window. Click to jump.
 */
export function UsagesPanel() {
  const result = useNavigationStore((state) => state.usages);
  const loading = useNavigationStore((state) => state.usagesLoading);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const byFile = new Map<string, Usage[]>();
    for (const usage of result?.usages ?? []) {
      byFile.set(usage.path, [...(byFile.get(usage.path) ?? []), usage]);
    }
    return [...byFile.entries()];
  }, [result]);

  if (!result) {
    return (
      <div className="problems-panel">
        <div className="problems-empty">
          Put the cursor on a name and press ⌥F7 (Find Usages) to list every place it's used.
        </div>
      </div>
    );
  }
  const total = result.usages.length;

  return (
    <div className="problems-panel">
      <div className="nav-summary">
        {loading
          ? `Finding usages of ${result.symbol}…`
          : `${total} usage${total === 1 ? "" : "s"} of ${result.symbol} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}
      </div>
      <div className="problems-list">
        {!loading && total === 0 && <div className="problems-empty">No usages found.</div>}
        {groups.map(([path, usages]) => {
          const isCollapsed = collapsed.has(path);
          const Chevron = isCollapsed ? ChevronRight : ChevronDown;
          const name = path.split(/[/\\]/).pop() ?? path;
          const FileIcon = iconForFile(name);
          const directory = relativePath(path, rootPath).slice(0, -name.length).replace(/[/\\]$/, "");
          return (
            <div key={path}>
              <div
                className="problems-file"
                title={path}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <Chevron size={13} strokeWidth={1.5} />
                <FileIcon size={13} strokeWidth={1.5} className="problems-file-icon" />
                <span className="problems-file-name">{name}</span>
                <span className="problems-file-dir">{directory}</span>
                <span className="problems-count">{usages.length}</span>
              </div>
              {!isCollapsed &&
                usages.map((usage) => (
                  <div
                    key={`${usage.line}:${usage.column}`}
                    className="problems-row"
                    onClick={() => void goTo(usage.path, usage.line, usage.column)}
                  >
                    <span className="nav-line-number">{usage.line}</span>
                    <Preview usage={usage} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
