import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { iconForFile } from "../../lib/fileIcons";
import type { FsEntry } from "../../lib/ipc";
import "./FileTree.css";

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 10;

interface FlatRow {
  entry: FsEntry;
  depth: number;
}

/**
 * Flatten the expanded portion of the tree into a list of visible rows.
 * Virtualization then renders only the rows inside the viewport, so a
 * workspace with thousands of files never creates thousands of DOM nodes.
 */
function flattenVisibleRows(
  directoryPath: string,
  childrenByPath: Record<string, FsEntry[]>,
  expandedPaths: Set<string>,
  depth: number,
  output: FlatRow[],
) {
  const children = childrenByPath[directoryPath];
  if (!children) return;
  for (const entry of children) {
    output.push({ entry, depth });
    if (entry.isDirectory && expandedPaths.has(entry.path)) {
      flattenVisibleRows(
        entry.path,
        childrenByPath,
        expandedPaths,
        depth + 1,
        output,
      );
    }
  }
}

export function FileTree() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const childrenByPath = useWorkspaceStore((state) => state.childrenByPath);
  const expandedPaths = useWorkspaceStore((state) => state.expandedPaths);
  const toggleDirectory = useWorkspaceStore((state) => state.toggleDirectory);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Track the container height so the visible window stays correct when
  // the panel is resized.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(container.clientHeight),
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    if (!rootPath) return [];
    const output: FlatRow[] = [];
    flattenVisibleRows(rootPath, childrenByPath, expandedPaths, 0, output);
    return output;
  }, [rootPath, childrenByPath, expandedPaths]);

  if (!rootPath) return null;

  const firstVisibleIndex = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const lastVisibleIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const visibleRows = rows.slice(firstVisibleIndex, lastVisibleIndex);

  return (
    <div
      ref={scrollContainerRef}
      className="file-tree"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="file-tree-spacer"
        style={{ height: rows.length * ROW_HEIGHT }}
      >
        <div
          style={{ transform: `translateY(${firstVisibleIndex * ROW_HEIGHT}px)` }}
        >
          {visibleRows.map(({ entry, depth }) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              depth={depth}
              isExpanded={expandedPaths.has(entry.path)}
              onToggle={() => toggleDirectory(entry.path)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface TreeRowProps {
  entry: FsEntry;
  depth: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function TreeRow({ entry, depth, isExpanded, onToggle }: TreeRowProps) {
  const FileIcon = entry.isDirectory
    ? isExpanded
      ? FolderOpen
      : Folder
    : iconForFile(entry.name);
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div
      className="tree-row"
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={entry.isDirectory ? onToggle : undefined}
      title={entry.path}
    >
      <span className="tree-row-chevron">
        {entry.isDirectory && <Chevron size={13} strokeWidth={1.5} />}
      </span>
      <FileIcon size={14} strokeWidth={1.5} className="tree-row-icon" />
      <span className="tree-row-name">{entry.name}</span>
    </div>
  );
}
