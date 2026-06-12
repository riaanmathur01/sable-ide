import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useSearchStore } from "../../store/searchStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
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
  const fileNameMatches = matches.filter((match) => match.kind === "file");
  const contentMatches = matches.filter((match) => match.kind === "content");
  const rows: ResultRow[] = [];

  if (fileNameMatches.length > 0) {
    rows.push({ kind: "section", label: "Files" });
    for (const match of fileNameMatches) {
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
  const openFile = useTabsStore((state) => state.openFile);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Debounce: search as the user types, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(container.clientHeight),
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(
    () => buildRows(matches, rootPath),
    [matches, rootPath],
  );

  async function jumpToMatch(match: SearchMatch) {
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
      <div className="search-input-wrap">
        <Search size={13} strokeWidth={1.5} className="search-input-icon" />
        <input
          className="search-input"
          autoFocus
          placeholder="Search in workspace"
          value={query}
          disabled={!rootPath}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {!rootPath ? (
        <div className="search-hint">Open a folder to search it.</div>
      ) : query.trim() === "" ? (
        <div className="search-hint">Type to search across the project.</div>
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
                      return <FileHeaderRow key={`h:${row.path}`} row={row} />;
                    case "match":
                      return (
                        <MatchRow
                          key={`m:${row.match.path}:${row.match.lineNumber}:${row.match.preview}`}
                          match={row.match}
                          onJump={() => jumpToMatch(row.match)}
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
  const FileIcon = iconForFile(row.match.preview);
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
}: {
  row: Extract<ResultRow, { kind: "file" }>;
}) {
  const FileIcon = iconForFile(row.fileName);
  return (
    <div className="search-file-row" title={row.path}>
      <FileIcon size={13} strokeWidth={1.5} className="search-file-icon" />
      <span className="search-file-name">{row.fileName}</span>
      <span className="search-file-count">{row.matchCount}</span>
    </div>
  );
}

function MatchRow({
  match,
  onJump,
}: {
  match: SearchMatch;
  onJump: () => void;
}) {
  return (
    <div className="search-match-row" onClick={onJump} title={match.preview}>
      <span className="search-match-line">{match.lineNumber}</span>
      <span className="search-match-preview">{match.preview.trim()}</span>
    </div>
  );
}
