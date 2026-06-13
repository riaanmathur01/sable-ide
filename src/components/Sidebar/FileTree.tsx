import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { useGitStore } from "../../store/gitStore";
import type { GitFileStatus } from "../../lib/ipc";
import { iconForFile } from "../../lib/fileIcons";
import {
  createDirectory,
  createFile,
  deletePath,
  movePath,
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
 * Tree-internal drag state for moving entries. Implemented with raw
 * mouse events (not HTML5 drag-and-drop) because Tauri's native drop
 * zone — which powers drag-a-folder-from-the-OS-to-open — swallows
 * HTML5 drag events inside the webview.
 */
interface DragState {
  entry: FsEntry;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Becomes true after the pointer travels past a small threshold. */
  active: boolean;
}

const DRAG_THRESHOLD_PX = 4;

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
  const errorCountByPath = useDiagnosticsStore(
    (state) => state.errorCountByPath,
  );
  const gitStatusByPath = useGitStore((state) => state.statusByPath);

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

  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTargetDirectory, setDropTargetDirectory] = useState<
    string | null
  >(null);
  // A completed drag must not fire the row's click (open/toggle).
  const suppressNextClickRef = useRef(false);

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

  // A folder shows the error dot if any file inside it has errors, so
  // problems in collapsed folders are still visible. Errors are few, so
  // the prefix scan is cheap.
  const erroredPaths = useMemo(
    () => Object.keys(errorCountByPath),
    [errorCountByPath],
  );
  const entryHasError = (entry: FsEntry): boolean => {
    if (!entry.isDirectory) {
      return (errorCountByPath[entry.path] ?? 0) > 0;
    }
    return erroredPaths.some(
      (errored) =>
        errored.startsWith(`${entry.path}/`) ||
        errored.startsWith(`${entry.path}\\`),
    );
  };

  // Drive an in-progress drag from window-level mouse events, so it
  // keeps working when the pointer leaves the sidebar.
  useEffect(() => {
    if (!drag || !rootPath) return;

    function resolveDropTarget(clientX: number, clientY: number) {
      const elementUnderPointer = document.elementFromPoint(clientX, clientY);
      const rowElement = elementUnderPointer?.closest<HTMLElement>(
        "[data-tree-path]",
      );
      let target: string | null = null;
      if (rowElement?.dataset.treePath) {
        target =
          rowElement.dataset.treeDir === "1"
            ? rowElement.dataset.treePath
            : parentDirectoryOf(rowElement.dataset.treePath);
      } else if (elementUnderPointer?.closest("[data-tree-root]")) {
        target = rootPath; // empty area below the rows → workspace root
      }
      if (!target) return null;
      const source = drag!.entry.path;
      // No-ops and impossible targets: same parent, itself, descendants.
      if (target === parentDirectoryOf(source)) return null;
      if (
        target === source ||
        target.startsWith(`${source}/`) ||
        target.startsWith(`${source}\\`)
      ) {
        return null;
      }
      return target;
    }

    function onMouseMove(event: MouseEvent) {
      setDrag((current) => {
        if (!current) return current;
        const movedFar =
          Math.abs(event.clientX - current.startX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - current.startY) > DRAG_THRESHOLD_PX;
        return {
          ...current,
          x: event.clientX,
          y: event.clientY,
          active: current.active || movedFar,
        };
      });
      if (drag!.active) {
        setDropTargetDirectory(resolveDropTarget(event.clientX, event.clientY));
      }
    }

    function onMouseUp(event: MouseEvent) {
      const target = drag!.active
        ? resolveDropTarget(event.clientX, event.clientY)
        : null;
      if (drag!.active) suppressNextClickRef.current = true;
      const draggedEntry = drag!.entry;
      setDrag(null);
      setDropTargetDirectory(null);
      if (target) void moveEntry(draggedEntry, target);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, rootPath]);

  if (!rootPath) return null;

  async function moveEntry(entry: FsEntry, targetDirectory: string) {
    try {
      // Flush unsaved edits in any affected tab to the old location
      // first, so nothing is lost when paths change.
      const tabsState = useTabsStore.getState();
      for (const tab of tabsState.tabs) {
        if (
          tab.isDirty &&
          (tab.path === entry.path ||
            tab.path.startsWith(`${entry.path}/`) ||
            tab.path.startsWith(`${entry.path}\\`))
        ) {
          await tabsState.saveTab(tab.path);
        }
      }
      const newPath = await movePath(entry.path, targetDirectory);
      if (newPath === entry.path) return; // no-op drop
      await refreshDirectory(parentDirectoryOf(entry.path));
      await refreshDirectory(targetDirectory);
      await useTabsStore.getState().remapMovedPaths(entry.path, newPath);
    } catch (error) {
      setLastError(String(error));
    }
  }

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
        data-tree-root="1"
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
                hasError={entryHasError(entry)}
                gitStatus={
                  entry.isDirectory ? undefined : gitStatusByPath[entry.path]
                }
                isDropTarget={
                  entry.isDirectory && entry.path === dropTargetDirectory
                }
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameSubmit={() => confirmRename(entry)}
                onRenameCancel={() => setRenamingPath(null)}
                onActivate={() => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    return;
                  }
                  if (entry.isDirectory) toggleDirectory(entry.path);
                  else openFile(entry.path);
                }}
                onDragStart={(event) => {
                  if (event.button !== 0 || renamingPath === entry.path)
                    return;
                  setDrag({
                    entry,
                    startX: event.clientX,
                    startY: event.clientY,
                    x: event.clientX,
                    y: event.clientY,
                    active: false,
                  });
                }}
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
      {drag?.active && (
        <div
          className="tree-drag-ghost"
          style={{ left: drag.x + 12, top: drag.y + 10 }}
        >
          {drag.entry.name}
        </div>
      )}
    </>
  );
}

interface TreeRowProps {
  entry: FsEntry;
  depth: number;
  isExpanded: boolean;
  isRenaming: boolean;
  hasError: boolean;
  gitStatus?: GitFileStatus;
  isDropTarget: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onActivate: () => void;
  onDragStart: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

function TreeRow({
  entry,
  depth,
  isExpanded,
  isRenaming,
  hasError,
  gitStatus,
  isDropTarget,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onActivate,
  onDragStart,
  onContextMenu,
}: TreeRowProps) {
  const FileIcon = entry.isDirectory
    ? isExpanded
      ? FolderOpen
      : Folder
    : iconForFile(entry.name);
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  const gitBadge = gitStatus ? GIT_BADGES[gitStatus] : undefined;
  // Error color wins over git tint on the name; the git letter still shows.
  const nameClass = hasError
    ? "tree-row-name error"
    : gitBadge
      ? `tree-row-name ${gitBadge.colorClass}`
      : "tree-row-name";

  return (
    <div
      className={isDropTarget ? "tree-row drop-target" : "tree-row"}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-tree-path={entry.path}
      data-tree-dir={entry.isDirectory ? "1" : "0"}
      onClick={!isRenaming ? onActivate : undefined}
      onMouseDown={onDragStart}
      onContextMenu={onContextMenu}
      title={entry.path}
    >
      <span className="tree-row-chevron">
        {entry.isDirectory && <Chevron size={13} strokeWidth={1.5} />}
      </span>
      {hasError && <span className="tree-row-error-dot" />}
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
        <span className={nameClass}>{entry.name}</span>
      )}
      {!isRenaming && gitBadge && (
        <span className={`tree-row-git ${gitBadge.colorClass}`}>
          {gitBadge.letter}
        </span>
      )}
    </div>
  );
}

/** Single-letter git indicator + color, shown at the right of a row. */
const GIT_BADGES: Record<
  GitFileStatus,
  { letter: string; colorClass: string }
> = {
  modified: { letter: "M", colorClass: "git-modified" },
  added: { letter: "A", colorClass: "git-added" },
  untracked: { letter: "U", colorClass: "git-added" },
  deleted: { letter: "D", colorClass: "git-deleted" },
  renamed: { letter: "R", colorClass: "git-modified" },
};
