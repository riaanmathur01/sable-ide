import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { iconForFile } from "../../lib/fileIcons";
import {
  createDirectory,
  createFile,
  deletePath,
  parentDirectoryOf,
  renamePath,
  type FsEntry,
} from "../../lib/ipc";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../ContextMenu/ContextMenu";
import "./FileTree.css";

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 10;

interface FlatRow {
  entry: FsEntry;
  depth: number;
}

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

interface PendingCreate {
  kind: "file" | "folder";
  parentDirectory: string;
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
  const refreshDirectory = useWorkspaceStore((state) => state.refreshDirectory);
  const openFile = useTabsStore((state) => state.openFile);
  const setLastError = useUiStore((state) => state.setLastError);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [pendingName, setPendingName] = useState("");

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

  function startCreate(kind: "file" | "folder", entry: FsEntry) {
    const parentDirectory = entry.isDirectory
      ? entry.path
      : parentDirectoryOf(entry.path);
    if (entry.isDirectory && !expandedPaths.has(entry.path)) {
      toggleDirectory(entry.path);
    }
    setPendingCreate({ kind, parentDirectory });
    setPendingName("");
  }

  async function confirmCreate() {
    const name = pendingName.trim();
    if (!pendingCreate || !name) {
      setPendingCreate(null);
      return;
    }
    const { kind, parentDirectory } = pendingCreate;
    const newPath = `${parentDirectory}/${name}`;
    try {
      if (kind === "file") {
        await createFile(newPath);
      } else {
        await createDirectory(newPath);
      }
      await refreshDirectory(parentDirectory);
    } catch (error) {
      setLastError(String(error));
    }
    setPendingCreate(null);
  }

  async function confirmRename(entry: FsEntry) {
    const newName = renameValue.trim();
    setRenamingPath(null);
    if (!newName || newName === entry.name) return;
    try {
      await renamePath(entry.path, newName);
      await refreshDirectory(parentDirectoryOf(entry.path));
    } catch (error) {
      setLastError(String(error));
    }
  }

  async function confirmDelete(entry: FsEntry) {
    const accepted = await confirmNative(
      `Delete "${entry.name}"${entry.isDirectory ? " and all its contents" : ""}? This cannot be undone.`,
      { title: "Delete", kind: "warning" },
    );
    if (!accepted) return;
    try {
      await deletePath(entry.path);
      await refreshDirectory(parentDirectoryOf(entry.path));
    } catch (error) {
      setLastError(String(error));
    }
  }

  function menuItemsFor(entry: FsEntry): ContextMenuItem[] {
    return [
      { label: "New File", onSelect: () => startCreate("file", entry) },
      { label: "New Folder", onSelect: () => startCreate("folder", entry) },
      {
        label: "Rename",
        onSelect: () => {
          setRenameValue(entry.name);
          setRenamingPath(entry.path);
        },
      },
      {
        label: "Delete",
        danger: true,
        onSelect: () => confirmDelete(entry),
      },
    ];
  }

  const firstVisibleIndex = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS,
  );
  const lastVisibleIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const visibleRows = rows.slice(firstVisibleIndex, lastVisibleIndex);

  const createTargetName = pendingCreate
    ? (pendingCreate.parentDirectory.split(/[/\\]/).filter(Boolean).pop() ?? "")
    : "";

  return (
    <>
      {pendingCreate && (
        <input
          className="tree-create-input"
          autoFocus
          placeholder={`new ${pendingCreate.kind} in ${createTargetName}`}
          value={pendingName}
          onChange={(event) => setPendingName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") confirmCreate();
            if (event.key === "Escape") setPendingCreate(null);
          }}
          onBlur={() => setPendingCreate(null)}
        />
      )}
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
            style={{
              transform: `translateY(${firstVisibleIndex * ROW_HEIGHT}px)`,
            }}
          >
            {visibleRows.map(({ entry, depth }) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={depth}
                isExpanded={expandedPaths.has(entry.path)}
                isRenaming={renamingPath === entry.path}
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameSubmit={() => confirmRename(entry)}
                onRenameCancel={() => setRenamingPath(null)}
                onActivate={() =>
                  entry.isDirectory
                    ? toggleDirectory(entry.path)
                    : openFile(entry.path)
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, entry });
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

interface TreeRowProps {
  entry: FsEntry;
  depth: number;
  isExpanded: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onActivate: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

function TreeRow({
  entry,
  depth,
  isExpanded,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onActivate,
  onContextMenu,
}: TreeRowProps) {
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
      onClick={!isRenaming ? onActivate : undefined}
      onContextMenu={onContextMenu}
      title={entry.path}
    >
      <span className="tree-row-chevron">
        {entry.isDirectory && <Chevron size={13} strokeWidth={1.5} />}
      </span>
      <FileIcon size={14} strokeWidth={1.5} className="tree-row-icon" />
      {isRenaming ? (
        <input
          className="tree-rename-input"
          autoFocus
          value={renameValue}
          onChange={(event) => onRenameChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRenameSubmit();
            if (event.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameCancel}
          onFocus={(event) => {
            // Preselect the basename so typing replaces it, like VS Code.
            const dotIndex = entry.name.lastIndexOf(".");
            event.target.setSelectionRange(
              0,
              dotIndex > 0 ? dotIndex : entry.name.length,
            );
          }}
        />
      ) : (
        <span className="tree-row-name">{entry.name}</span>
      )}
    </div>
  );
}
