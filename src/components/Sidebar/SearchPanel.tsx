import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Folder,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WholeWord,
} from "lucide-react";
import { useSearchStore } from "../../store/searchStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { revealPosition } from "../../lib/editorRegistry";
import { iconForFile } from "../../lib/fileIcons";
import type { SearchMatch } from "../../lib/ipc";
import "./SearchPanel.css";

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 10;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Results flattened for virtualization. File-name matches always render
 * in their own section above content matches, whatever order they
 * streamed in.
 */
type ResultRow =
  | { kind: "section"; label: string }
  | { kind: "fileName"; match: SearchMatch; relativePath: string }
  | { kind: "file"; path: string; fileName: string; matchCount: number }
  | { kind: "match"; match: SearchMatch };

function buildRows(
  matches: SearchMatch[],
  rootPath: string | null,
): ResultRow[] {
  const nameMatches = matches.filter((match) => match.kind !== "content");
  const contentMatches = matches.filter((match) => match.kind === "content");
  const rows: ResultRow[] = [];

  if (nameMatches.length > 0) {
    rows.push({ kind: "section", label: "Files & Folders" });
    for (const match of nameMatches) {
      let relativePath = match.path;
      if (rootPath && relativePath.startsWith(rootPath)) {
        relativePath = relativePath
          .slice(rootPath.length)
          .replace(/^[/\\]/, "");
      }
      rows.push({ kind: "fileName", match, relativePath });
    }
  }

  if (contentMatches.length > 0) {
    rows.push({ kind: "section", label: "Content" });
    let currentPath: string | null = null;
    let currentHeaderIndex = -1;
    for (const match of contentMatches) {
      if (match.path !== currentPath) {
        currentPath = match.path;
        currentHeaderIndex = rows.length;
        rows.push({
          kind: "file",
          path: match.path,
          fileName:
            match.path.split(/[/\\]/).filter(Boolean).pop() ?? match.path,
          matchCount: 0,
        });
      }
      const header = rows[currentHeaderIndex];
      if (header.kind === "file") header.matchCount += 1;
      rows.push({ kind: "match", match });
    }
  }
  return rows;
}

/**
 * Project-wide search: debounced input, results streamed from Rust,
 * grouped by file in a virtualized list. Click a match to jump there.
 */
export function SearchPanel() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const query = useSearchStore((state) => state.query);
  const setQuery = useSearchStore((state) => state.setQuery);
  const runSearch = useSearchStore((state) => state.runSearch);
  const matches = useSearchStore((state) => state.matches);
  const isSearching = useSearchStore((state) => state.isSearching);
  const limitHit = useSearchStore((state) => state.limitHit);
  const error = useSearchStore((state) => state.error);
  const replacement = useSearchStore((state) => state.replacement);
  const showReplace = useSearchStore((state) => state.showReplace);
  const matchCase = useSearchStore((state) => state.matchCase);
  const wholeWord = useSearchStore((state) => state.wholeWord);
  const useRegex = useSearchStore((state) => state.useRegex);
  const isReplacing = useSearchStore((state) => state.isReplacing);
  const store = useSearchStore.getState();
  const openFile = useTabsStore((state) => state.openFile);
  const revealPath = useWorkspaceStore((state) => state.revealPath);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Debounce: search as the user types, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // The results container only exists while a query is active, so the
  // observer must re-attach whenever it (re)appears — not just on mount.
  const resultsContainerExists = Boolean(rootPath && query.trim() !== "");
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    setViewportHeight(container.clientHeight);
    const observer = new ResizeObserver(() =>
      setViewportHeight(container.clientHeight),
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [resultsContainerExists]);

  const rows = useMemo(
    () => buildRows(matches, rootPath),
    [matches, rootPath],
  );

  async function jumpToMatch(match: SearchMatch) {
    if (match.kind === "folder") {
      // Expand the tree down to the folder and show the explorer.
      await revealPath(match.path);
      setSidebarView("files");
      return;
    }
    await openFile(match.path);
    if (match.kind === "content") {
      revealPosition(match.path, match.lineNumber);
    }
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

  return (
    <div className="search-panel">
      <div className="search-fields">
        <button
          className="search-replace-toggle"
          title={showReplace ? "Hide Replace" : "Show Replace"}
          aria-expanded={showReplace}
          onClick={store.toggleReplace}
        >
          {showReplace ? (
            <ChevronDown size={13} strokeWidth={1.5} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.5} />
          )}
        </button>
        <div className="search-field-stack">
          <div className="search-input-wrap">
            <Search size={13} strokeWidth={1.5} className="search-input-icon" />
            <input
              className="search-input"
              autoFocus
              placeholder="Search"
              value={query}
              disabled={!rootPath}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="search-toggles">
              <button
                className={matchCase ? "search-toggle active" : "search-toggle"}
                title="Match Case"
                aria-pressed={matchCase}
                onClick={() => store.toggleOption("matchCase")}
              >
                <CaseSensitive size={14} strokeWidth={1.5} />
              </button>
              <button
                className={wholeWord ? "search-toggle active" : "search-toggle"}
                title="Match Whole Word"
                aria-pressed={wholeWord}
                onClick={() => store.toggleOption("wholeWord")}
              >
                <WholeWord size={14} strokeWidth={1.5} />
              </button>
              <button
                className={useRegex ? "search-toggle active" : "search-toggle"}
                title="Use Regular Expression"
                aria-pressed={useRegex}
                onClick={() => store.toggleOption("useRegex")}
              >
                <Regex size={14} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          {showReplace && (
            <div className="search-input-wrap">
              <Replace size={13} strokeWidth={1.5} className="search-input-icon" />
              <input
                className="search-input"
                placeholder={useRegex ? "Replace ($1 for groups)" : "Replace"}
                value={replacement}
                disabled={!rootPath}
                spellCheck={false}
                onChange={(event) => store.setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    void store.replaceAll();
                  }
                }}
              />
              <div className="search-toggles">
                <button
                  className="search-toggle"
                  title="Replace All (⌘Enter)"
                  disabled={!query || matches.length === 0 || isReplacing}
                  onClick={() => void store.replaceAll()}
                >
                  <ReplaceAll size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {!rootPath ? (
        <div className="search-hint">Open a folder to search it.</div>
      ) : query.trim() === "" ? (
        <div className="search-hint">Type to search across the project.</div>
      ) : error ? (
        <div className="search-hint search-error">{error}</div>
      ) : (
        <>
          <div className="search-summary">
            {isSearching
              ? "Searching…"
              : `${matches.length}${limitHit ? "+" : ""} result${matches.length === 1 ? "" : "s"}`}
            {limitHit && " (showing first 500)"}
          </div>
          <div
            ref={scrollContainerRef}
            className="search-results"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative", overflow: "hidden" }}>
              <div
                style={{ transform: `translateY(${firstVisibleIndex * ROW_HEIGHT}px)` }}
              >
                {visibleRows.map((row) => {
                  switch (row.kind) {
                    case "section":
                      return (
                        <div key={`s:${row.label}`} className="search-section-row">
                          {row.label}
                        </div>
                      );
                    case "fileName":
                      return (
                        <FileNameRow
                          key={`f:${row.match.path}`}
                          row={row}
                          onJump={() => jumpToMatch(row.match)}
                        />
                      );
                    case "file":
                      return (
                        <FileHeaderRow
                          key={`h:${row.path}`}
                          row={row}
                          onReplace={
                            showReplace && !isReplacing
                              ? () => void store.replaceInFile(row.path)
                              : undefined
                          }
                        />
                      );
                    case "match":
                      return (
                        <MatchRow
                          key={`m:${row.match.path}:${row.match.lineNumber}:${row.match.preview}`}
                          match={row.match}
                          onJump={() => jumpToMatch(row.match)}
                          onReplace={
                            showReplace && !isReplacing
                              ? () =>
                                  void store.replaceInLine(
                                    row.match.path,
                                    row.match.lineNumber,
                                  )
                              : undefined
                          }
                        />
                      );
                  }
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FileNameRow({
  row,
  onJump,
}: {
  row: Extract<ResultRow, { kind: "fileName" }>;
  onJump: () => void;
}) {
  const FileIcon =
    row.match.kind === "folder" ? Folder : iconForFile(row.match.preview);
  return (
    <div className="search-filename-row" onClick={onJump} title={row.match.path}>
      <FileIcon size={13} strokeWidth={1.5} className="search-file-icon" />
      <span className="search-file-name">{row.match.preview}</span>
      <span className="search-filename-path">{row.relativePath}</span>
    </div>
  );
}

function FileHeaderRow({
  row,
  onReplace,
}: {
  row: Extract<ResultRow, { kind: "file" }>;
  /** Present when the replace field is open. */
  onReplace?: () => void;
}) {
  const FileIcon = iconForFile(row.fileName);
  return (
    <div className="search-file-row" title={row.path}>
      <FileIcon size={13} strokeWidth={1.5} className="search-file-icon" />
      <span className="search-file-name">{row.fileName}</span>
      {onReplace && (
        <button className="search-row-action" title="Replace in this file" onClick={onReplace}>
          <ReplaceAll size={13} strokeWidth={1.5} />
        </button>
      )}
      <span className="search-file-count">{row.matchCount}</span>
    </div>
  );
}

function MatchRow({
  match,
  onJump,
  onReplace,
}: {
  match: SearchMatch;
  onJump: () => void;
  /** Present when the replace field is open. */
  onReplace?: () => void;
}) {
  return (
    <div className="search-match-row" onClick={onJump} title={match.preview}>
      <span className="search-match-line">{match.lineNumber}</span>
      <span className="search-match-preview">{match.preview.trim()}</span>
      {onReplace && (
        <button
          className="search-row-action"
          title="Replace on this line"
          onClick={(event) => {
            event.stopPropagation();
            onReplace();
          }}
        >
          <Replace size={13} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
