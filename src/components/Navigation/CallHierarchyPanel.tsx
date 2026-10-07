import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { goTo, useNavigationStore, type HierarchyNode } from "../../store/navigationStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { SYMBOL_KIND_NAMES } from "../../lib/lsp/navigation";
import { relativePath } from "./UsagesPanel";
import "../Problems/ProblemsPanel.css";
import "./Navigation.css";

function Node({ node, depth }: { node: HierarchyNode; depth: number }) {
  const toggle = useNavigationStore((state) => state.toggleHierarchyNode);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const { item } = node;
  const leaf = node.children !== undefined && node.children.length === 0;
  const Chevron = node.loading ? LoaderCircle : node.expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <div
        className="problems-row nav-tree-row"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => void goTo(item.path, item.line, item.column)}
        title={`${SYMBOL_KIND_NAMES[item.kind] ?? "symbol"} ${item.name}`}
      >
        <span
          className={leaf ? "nav-twisty leaf" : "nav-twisty"}
          onClick={(event) => {
            event.stopPropagation();
            void toggle(node.id);
          }}
        >
          <Chevron size={13} strokeWidth={1.5} className={node.loading ? "nav-spin" : undefined} />
        </span>
        <span className="nav-symbol-name">{item.name}</span>
        {item.detail && <span className="nav-symbol-detail">{item.detail}</span>}
        <span className="problems-position">
          {relativePath(item.path, rootPath)}:{item.line}
        </span>
      </div>
      {node.expanded && node.children?.map((child) => <Node key={child.id} node={child} depth={depth + 1} />)}
    </>
  );
}

/**
 * Call Hierarchy (⌃⌥H): who calls a function (Callers) or what it calls
 * (Callees), expanded level by level, like JetBrains' Hierarchy window.
 */
export function CallHierarchyPanel() {
  const hierarchy = useNavigationStore((state) => state.hierarchy);
  const setDirection = useNavigationStore((state) => state.setHierarchyDirection);

  if (!hierarchy) {
    return (
      <div className="problems-panel">
        <div className="problems-empty">
          Put the cursor on a function and press ⌃⌥H (Call Hierarchy) to see what calls it.
        </div>
      </div>
    );
  }
  return (
    <div className="problems-panel">
      <div className="nav-summary">
        <div className="nav-segmented" role="radiogroup" aria-label="Direction">
          {(["incoming", "outgoing"] as const).map((direction) => (
            <button
              key={direction}
              role="radio"
              aria-checked={hierarchy.direction === direction}
              className={hierarchy.direction === direction ? "active" : undefined}
              onClick={() => void setDirection(direction)}
            >
              {direction === "incoming" ? "Callers" : "Callees"}
            </button>
          ))}
        </div>
      </div>
      <div className="problems-list">
        {hierarchy.roots.map((root) => (
          <Node key={root.id} node={root} depth={0} />
        ))}
      </div>
    </div>
  );
}
