import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePluginViewsStore, type PluginView, type TreeNode } from "../../store/pluginViewsStore";
import { PluginWebviewFrame } from "./PluginWebviewFrame";
import "./PluginWebviewFrame.css";

/**
 * Sidebar → Plugin Views: the views plugins contribute (VS Code
 * extensions' tree views and webview views), one collapsible section each.
 */
export function PluginViewsPanel() {
  const views = usePluginViewsStore((state) => state.views);
  if (views.length === 0) {
    return <div className="plugin-views-empty">Plugins that add views (tree views, webview views) show them here.</div>;
  }
  return (
    <div className="plugin-views">
      {views.map((view) => (
        <ViewSection key={`${view.pluginId}:${view.id}`} view={view} />
      ))}
    </div>
  );
}

function ViewSection({ view }: { view: PluginView }) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className={`plugin-view${open && view.kind === "webview" ? " grows" : ""}`}>
      <button className="plugin-view-header" onClick={() => setOpen(!open)} title={view.pluginName}>
        <Chevron size={13} strokeWidth={1.5} />
        {view.name}
      </button>
      {open && (view.kind === "tree" ? <TreeChildren view={view} depth={0} /> : <WebviewSection view={view} />)}
    </section>
  );
}

function WebviewSection({ view }: { view: PluginView }) {
  useEffect(() => {
    void view.resolve?.();
  }, [view]);
  return (
    <div className="plugin-view-webview">
      <PluginWebviewFrame id={view.id} />
    </div>
  );
}

function TreeChildren({ view, nodeId, depth }: { view: PluginView; nodeId?: string; depth: number }) {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void view.children?.(nodeId).then((children) => {
      if (!cancelled) setNodes(children);
    }).catch(() => !cancelled && setNodes([]));
    return () => {
      cancelled = true;
    };
  }, [view, view.version, nodeId]);
  if (nodes === null) return <div className="plugin-tree-loading" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</div>;
  if (nodes.length === 0 && depth === 0) return <div className="plugin-tree-loading" style={{ paddingLeft: 12 }}>Nothing here.</div>;
  return (
    <>
      {nodes.map((node) => (
        <TreeItem key={node.id} view={view} node={node} depth={depth} />
      ))}
    </>
  );
}

function TreeItem({ view, node, depth }: { view: PluginView; node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(node.collapsible === 2);
  const expandable = node.collapsible > 0;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <div
        className="plugin-tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.tooltip ?? node.label}
        onClick={() => {
          if (expandable) setExpanded(!expanded);
          if (node.command) view.run?.(node.command);
        }}
      >
        <span className="plugin-tree-chevron">{expandable && <Chevron size={12} strokeWidth={1.5} />}</span>
        <span className="plugin-tree-label">{node.label}</span>
        {node.description && <span className="plugin-tree-description">{node.description}</span>}
      </div>
      {expandable && expanded && <TreeChildren view={view} nodeId={node.id} depth={depth + 1} />}
    </>
  );
}
