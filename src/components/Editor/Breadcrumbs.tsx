import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Braces,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Code,
  Folder,
  Hash,
  Key,
  Package,
  SquareFunction,
  Type,
  Variable,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { iconForFile } from "../../lib/fileIcons";
import { readDirectory, type FsEntry } from "../../lib/ipc";
import { editorForGroup, onEditorsChange } from "../../lib/editorRegistry";
import { registerBreadcrumbsFocus } from "../../lib/breadcrumbs/focus";
import { documentSymbolTree, siblingsAt, symbolPathAt, type SymbolNode } from "../../lib/breadcrumbs/symbols";
import { folderName, folderOf, useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import "./Breadcrumbs.css";

/**
 * The breadcrumb bar above a group's editor, like VS Code's: the file's
 * path in its workspace folder, then the symbols around the cursor
 * (`src › lib › themes.ts › themeById`). Click a folder for its files, the
 * file for its neighbours, a symbol for the symbols beside it; ⇧⌘. focuses
 * the bar for ←/→, Enter and Esc.
 */

type Editor = MonacoTypes.editor.ICodeEditor;

/** Debounce for following the cursor, and for re-reading symbols after edits. */
const CURSOR_DELAY_MS = 100;
const SYMBOLS_DELAY_MS = 500;

interface PathSegment {
  kind: "folder" | "file";
  name: string;
  /** The directory the dropdown lists: the folder itself, or the file's folder. */
  directory: string;
  path: string;
}

type Segment = PathSegment | { kind: "symbol"; name: string; node: SymbolNode; depth: number };

const separatorOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

/** The path part of the bar: folders from the workspace folder down, then the file. */
function pathSegments(path: string, multiRoot: boolean): PathSegment[] {
  const separator = separatorOf(path);
  const folder = folderOf(path);
  const parts = path.slice(folder?.length ?? 0).split(/[/\\]/).filter(Boolean);
  const segments: PathSegment[] = [];
  if (folder && multiRoot) segments.push({ kind: "folder", name: folderName(folder), directory: folder, path: folder });
  // Outside the workspace: the whole path, from the root.
  const leading = path.startsWith("/") ? "/" : "";
  let directory = folder ?? "";
  parts.forEach((part, index) => {
    const full = directory ? `${directory}${separator}${part}` : `${leading}${part}`;
    if (index === parts.length - 1) segments.push({ kind: "file", name: part, directory: directory || leading || full, path: full });
    else segments.push({ kind: "folder", name: part, directory: full, path: full });
    directory = full;
  });
  return segments;
}

// --- Symbol icons (Monaco SymbolKind) -----------------------------------------------------------

const SYMBOL_ICONS: Record<number, { icon: LucideIcon; tone: string }> = {
  1: { icon: Package, tone: "module" }, // module
  2: { icon: Braces, tone: "module" }, // namespace
  3: { icon: Package, tone: "module" }, // package
  4: { icon: Box, tone: "type" }, // class
  5: { icon: SquareFunction, tone: "function" }, // method
  6: { icon: Wrench, tone: "field" }, // property
  7: { icon: Code, tone: "field" }, // field (also HTML elements)
  8: { icon: SquareFunction, tone: "function" }, // constructor
  9: { icon: Type, tone: "type" }, // enum
  10: { icon: Type, tone: "type" }, // interface
  11: { icon: SquareFunction, tone: "function" }, // function
  12: { icon: Variable, tone: "variable" }, // variable
  13: { icon: Hash, tone: "variable" }, // constant
  19: { icon: Braces, tone: "module" }, // object
  20: { icon: Key, tone: "field" }, // key
  21: { icon: CircleDot, tone: "variable" }, // null
  22: { icon: Hash, tone: "type" }, // enum member
  23: { icon: Box, tone: "type" }, // struct
  25: { icon: CircleDot, tone: "function" }, // operator
  26: { icon: Type, tone: "type" }, // type parameter
};

function SymbolIcon({ kind }: { kind: number }) {
  const { icon: Icon, tone } = SYMBOL_ICONS[kind] ?? { icon: CircleDot, tone: "variable" };
  return <Icon size={13} strokeWidth={1.7} className={`breadcrumbs-icon symbol-${tone}`} />;
}

function EntryIcon({ entry }: { entry: { name: string; isDirectory: boolean } }) {
  const Icon = entry.isDirectory ? Folder : iconForFile(entry.name);
  return <Icon size={13} strokeWidth={1.5} className="breadcrumbs-icon" />;
}

function segmentIcon(segment: Segment): ReactNode {
  if (segment.kind === "symbol") return <SymbolIcon kind={segment.node.kind} />;
  return <EntryIcon entry={{ name: segment.name, isDirectory: segment.kind === "folder" }} />;
}

// --- The bar ------------------------------------------------------------------------------------

/** Follows a group's editor: its cursor and its model's symbols. */
function useEditorSymbols(groupId: string, path: string) {
  const [editor, setEditor] = useState<Editor | null>(() => editorForGroup(groupId));
  useEffect(() => {
    setEditor(editorForGroup(groupId));
    return onEditorsChange(() => setEditor(editorForGroup(groupId)));
  }, [groupId]);

  const [tree, setTree] = useState<SymbolNode[]>([]);
  const [position, setPosition] = useState<MonacoTypes.IPosition | null>(null);
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    let symbolsTimer: ReturnType<typeof setTimeout> | undefined;
    let cursorTimer: ReturnType<typeof setTimeout> | undefined;
    const readSymbols = () => {
      const model = editor.getModel();
      if (!model) return setTree([]);
      void documentSymbolTree(editor).then((symbols) => {
        // Still the same file?
        if (!cancelled && editor.getModel() === model) setTree(symbols);
      });
    };
    const readPosition = () => setPosition(editor.getPosition());
    readSymbols();
    readPosition();
    const subscriptions = [
      editor.onDidChangeModel(() => {
        setTree([]);
        readSymbols();
        readPosition();
      }),
      editor.onDidChangeModelContent(() => {
        clearTimeout(symbolsTimer);
        symbolsTimer = setTimeout(readSymbols, SYMBOLS_DELAY_MS);
      }),
      editor.onDidChangeCursorPosition(() => {
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(readPosition, CURSOR_DELAY_MS);
      }),
      // A language server that starts later brings symbols with it.
      editor.onDidChangeModelLanguage(readSymbols),
    ];
    // The language's outline provider may still be loading (TS worker): ask again shortly.
    const retry = setTimeout(readSymbols, 1500);
    return () => {
      cancelled = true;
      clearTimeout(symbolsTimer);
      clearTimeout(cursorTimer);
      clearTimeout(retry);
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [editor, path]);
  return { editor, tree, position };
}

interface OpenDropdown {
  index: number;
  anchor: DOMRect;
}

export function Breadcrumbs({ groupId, path }: { groupId: string; path: string }) {
  const multiRoot = useWorkspaceStore((state) => state.folders.length > 1);
  // Re-read when folders change (a file can move into a workspace folder).
  useWorkspaceStore((state) => state.folders);
  const { editor, tree, position } = useEditorSymbols(groupId, path);
  const modelMatches = editor?.getModel()?.uri.path === path.replace(/\\/g, "/") || editor?.getModel()?.uri.fsPath === path;
  const symbolPath = useMemo(() => (position && modelMatches ? symbolPathAt(tree, position) : []), [tree, position, modelMatches]);

  const segments: Segment[] = useMemo(
    () => [
      ...pathSegments(path, multiRoot),
      ...symbolPath.map((node, depth) => ({ kind: "symbol" as const, name: node.name, node, depth })),
    ],
    [path, multiRoot, symbolPath],
  );

  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [dropdown, setDropdown] = useState<OpenDropdown | null>(null);

  // Keep the deepest part in view when the bar overflows.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar && focusIndex === null) bar.scrollLeft = bar.scrollWidth;
  }, [segments, focusIndex]);

  useEffect(() => {
    if (focusIndex !== null) itemRefs.current[focusIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusIndex]);

  const focusBar = useCallback(() => {
    setFocusIndex(segments.length - 1);
    barRef.current?.focus();
  }, [segments.length]);
  useEffect(() => registerBreadcrumbsFocus(groupId, focusBar), [groupId, focusBar]);

  const openDropdown = (index: number) => {
    const element = itemRefs.current[index];
    if (!element) return;
    setFocusIndex(index);
    setDropdown({ index, anchor: element.getBoundingClientRect() });
  };

  const closeDropdown = (refocusBar: boolean) => {
    setDropdown(null);
    if (refocusBar) barRef.current?.focus();
  };

  const backToEditor = () => {
    setFocusIndex(null);
    setDropdown(null);
    editor?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (dropdown) return;
    const last = segments.length - 1;
    const current = focusIndex ?? last;
    switch (event.key) {
      case "ArrowLeft":
        setFocusIndex(Math.max(0, current - 1));
        break;
      case "ArrowRight":
        setFocusIndex(Math.min(last, current + 1));
        break;
      case "Home":
        setFocusIndex(0);
        break;
      case "End":
        setFocusIndex(last);
        break;
      case "Enter":
      case " ":
      case "ArrowDown":
        openDropdown(current);
        break;
      case "Escape":
        backToEditor();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const segment = dropdown ? segments[dropdown.index] : null;

  return (
    <>
      <div
        ref={barRef}
        className="breadcrumbs"
        role="navigation"
        aria-label="Breadcrumbs"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (!dropdown && !event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIndex(null);
        }}
      >
        {segments.map((item, index) => (
          <Fragment key={`${item.kind}:${index}:${item.name}`}>
            {index > 0 && <ChevronRight size={12} strokeWidth={1.5} className="breadcrumbs-separator" />}
            <button
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              className={[
                "breadcrumbs-item",
                item.kind === "symbol" ? "symbol" : "",
                focusIndex === index ? "focused" : "",
                dropdown?.index === index ? "open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              tabIndex={-1}
              title={item.kind === "symbol" ? item.node.detail || item.name : item.path}
              // Keep the editor's focus (and cursor) until the dropdown takes it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (dropdown?.index === index ? closeDropdown(false) : openDropdown(index))}
            >
              {segmentIcon(item)}
              <span className="breadcrumbs-label">{item.name}</span>
            </button>
          </Fragment>
        ))}
      </div>
      {dropdown &&
        segment &&
        createPortal(
          segment.kind === "symbol" ? (
            <SymbolDropdown
              anchor={dropdown.anchor}
              items={siblingsAt(tree, symbolPath, segment.depth)}
              current={segment.node}
              onPick={(node) => {
                backToEditor();
                revealSymbol(editor, node);
              }}
              onClose={closeDropdown}
              ignore={barRef.current}
            />
          ) : (
            <FileDropdown
              anchor={dropdown.anchor}
              directory={segment.directory}
              current={segment.kind === "file" ? segment.path : null}
              onPick={(file) => {
                setDropdown(null);
                setFocusIndex(null);
                void useTabsStore.getState().openFile(file, { groupId });
              }}
              onClose={closeDropdown}
              ignore={barRef.current}
            />
          ),
          document.body,
        )}
    </>
  );
}

function revealSymbol(editor: Editor | null, node: SymbolNode) {
  if (!editor) return;
  const { startLineNumber, startColumn } = node.selectionRange;
  editor.setPosition({ lineNumber: startLineNumber, column: startColumn });
  editor.revealRangeInCenterIfOutsideViewport(node.selectionRange);
  editor.focus();
}

// --- Dropdowns ---------------------------------------------------------------------------------------

interface Row {
  key: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  /** Folders and symbols with children open a level down (→ or the chevron). */
  hasChildren: boolean;
  current: boolean;
}

interface DropdownProps {
  anchor: DOMRect;
  /** Heading of a level below the first ("‹ components"). */
  heading: string | null;
  rows: Row[] | null;
  onActivate: (index: number) => void;
  onDrill: (index: number) => void;
  onBack: (() => void) | null;
  onClose: (refocusBar: boolean) => void;
  /** The bar: clicks there don't count as "outside". */
  ignore: HTMLElement | null;
}

/** The popup list: keyboard (↑/↓, Enter, →/←, type to filter, Esc) and mouse. */
function Dropdown({ anchor, heading, rows, onActivate, onDrill, onBack, onClose, ignore }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const visible = useMemo(() => {
    const all = (rows ?? []).map((row, index) => ({ row, index }));
    const needle = filter.toLowerCase();
    return needle ? all.filter(({ row }) => row.label.toLowerCase().includes(needle)) : all;
  }, [rows, filter]);

  // Start on the current item (the file or symbol the segment shows).
  useEffect(() => {
    setFilter("");
    const current = (rows ?? []).findIndex((row) => row.current);
    setSelected(Math.max(0, current));
  }, [rows]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    ref.current?.querySelector(".breadcrumbs-dropdown-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, visible]);

  // Click outside closes it.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || ignore?.contains(target)) return;
      onClose(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [ignore, onClose]);

  const clamp = (index: number) => Math.max(0, Math.min(visible.length - 1, index));

  const onKeyDown = (event: React.KeyboardEvent) => {
    const entry = visible[clamp(selected)];
    switch (event.key) {
      case "ArrowDown":
        setSelected((index) => clamp(index + 1));
        break;
      case "ArrowUp":
        setSelected((index) => clamp(index - 1));
        break;
      case "PageDown":
        setSelected((index) => clamp(index + 10));
        break;
      case "PageUp":
        setSelected((index) => clamp(index - 10));
        break;
      case "Enter":
        if (entry) onActivate(entry.index);
        break;
      case "ArrowRight":
        if (entry?.row.hasChildren) onDrill(entry.index);
        break;
      case "ArrowLeft":
        if (onBack) onBack();
        else onClose(true);
        break;
      case "Escape":
        if (filter) setFilter("");
        else onClose(true);
        break;
      case "Backspace":
        setFilter((text) => text.slice(0, -1));
        break;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          setFilter((text) => text + event.key);
          setSelected(0);
          break;
        }
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Below the segment, kept on screen.
  const width = 300;
  const left = Math.max(8, Math.min(anchor.left - 4, window.innerWidth - width - 8));
  const top = anchor.bottom + 3;
  const maxHeight = Math.max(160, Math.min(360, window.innerHeight - top - 12));

  return (
    <div
      ref={ref}
      className="breadcrumbs-dropdown"
      style={{ left, top, maxHeight }}
      tabIndex={-1}
      role="listbox"
      onKeyDown={onKeyDown}
    >
      {heading !== null && (
        <button className="breadcrumbs-dropdown-heading" onClick={() => onBack?.()} tabIndex={-1}>
          <ChevronLeft size={13} strokeWidth={1.5} />
          <span>{heading}</span>
        </button>
      )}
      {filter && <div className="breadcrumbs-dropdown-filter">{filter}</div>}
      <div className="breadcrumbs-dropdown-list">
        {rows === null && <div className="breadcrumbs-dropdown-empty">Loading…</div>}
        {rows !== null && visible.length === 0 && <div className="breadcrumbs-dropdown-empty">{filter ? "No matches" : "Empty"}</div>}
        {visible.map(({ row, index }, position) => (
          <div
            key={row.key}
            role="option"
            aria-selected={position === clamp(selected)}
            className={`breadcrumbs-dropdown-row${position === clamp(selected) ? " selected" : ""}${row.current ? " current" : ""}`}
            title={row.detail ? `${row.label} — ${row.detail}` : row.label}
            onMouseMove={() => setSelected(position)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onActivate(index)}
          >
            {row.icon}
            <span className="breadcrumbs-dropdown-label">{row.label}</span>
            {row.detail && <span className="breadcrumbs-dropdown-detail">{row.detail}</span>}
            {row.hasChildren && (
              <button
                className="breadcrumbs-dropdown-drill"
                tabIndex={-1}
                title="Show contents"
                onClick={(event) => {
                  event.stopPropagation();
                  onDrill(index);
                }}
              >
                <ChevronRight size={13} strokeWidth={1.5} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Files shown by name: noise the Explorer also tucks away. */
const HIDDEN_NAMES = new Set([".DS_Store", ".git"]);

function FileDropdown({
  anchor,
  directory,
  current,
  onPick,
  onClose,
  ignore,
}: {
  anchor: DOMRect;
  directory: string;
  current: string | null;
  onPick: (path: string) => void;
  onClose: (refocusBar: boolean) => void;
  ignore: HTMLElement | null;
}) {
  // Folders drilled into, below the segment's own.
  const [stack, setStack] = useState<string[]>([directory]);
  const shown = stack[stack.length - 1];
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    readDirectory(shown)
      .then((list) => !cancelled && setEntries(list.filter((entry) => !HIDDEN_NAMES.has(entry.name))))
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [shown]);

  const rows = useMemo(
    () =>
      entries?.map((entry) => ({
        key: entry.path,
        label: entry.name,
        icon: <EntryIcon entry={entry} />,
        hasChildren: entry.isDirectory,
        current: entry.path === current,
      })) ?? null,
    [entries, current],
  );

  const activate = (index: number) => {
    const entry = entries?.[index];
    if (!entry) return;
    if (entry.isDirectory) setStack((levels) => [...levels, entry.path]);
    else onPick(entry.path);
  };

  return (
    <Dropdown
      anchor={anchor}
      heading={stack.length > 1 ? (shown.split(/[/\\]/).pop() ?? shown) : null}
      rows={rows}
      onActivate={activate}
      onDrill={activate}
      onBack={stack.length > 1 ? () => setStack((levels) => levels.slice(0, -1)) : null}
      onClose={onClose}
      ignore={ignore}
    />
  );
}

function SymbolDropdown({
  anchor,
  items,
  current,
  onPick,
  onClose,
  ignore,
}: {
  anchor: DOMRect;
  items: SymbolNode[];
  current: SymbolNode;
  onPick: (node: SymbolNode) => void;
  onClose: (refocusBar: boolean) => void;
  ignore: HTMLElement | null;
}) {
  const [stack, setStack] = useState<{ name: string; items: SymbolNode[] }[]>([{ name: "", items }]);
  const level = stack[stack.length - 1];
  const rows = useMemo(
    () =>
      level.items.map((node, index) => ({
        key: `${index}:${node.name}`,
        label: node.name,
        detail: node.detail || undefined,
        icon: <SymbolIcon kind={node.kind} />,
        hasChildren: node.children.length > 0,
        current: node === current,
      })),
    [level, current],
  );
  return (
    <Dropdown
      anchor={anchor}
      heading={stack.length > 1 ? level.name : null}
      rows={rows}
      onActivate={(index) => onPick(level.items[index])}
      onDrill={(index) => {
        const node = level.items[index];
        if (node.children.length) setStack((levels) => [...levels, { name: node.name, items: node.children }]);
      }}
      onBack={stack.length > 1 ? () => setStack((levels) => levels.slice(0, -1)) : null}
      onClose={onClose}
      ignore={ignore}
    />
  );
}
