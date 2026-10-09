import { useEffect, useMemo, useState } from "react";
import { layoutGraph, type GraphRow } from "../../lib/git/graph";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  gitCommitFiles,
  gitLog,
  type CommitFile,
  type CommitInfo,
} from "../../lib/ipc";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useGitStore } from "../../store/gitStore";
import { useTabsStore } from "../../store/tabsStore";
import { iconForFile } from "../../lib/fileIcons";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { useUiStore } from "../../store/uiStore";
import "./HistoryPanel.css";

const PAGE_SIZE = 50;

/** "3 days ago" style relative time from a Unix-seconds timestamp. */
function relativeTime(unixSeconds: number): string {
  const seconds = Math.floor(Date.now() / 1000 - unixSeconds);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "min"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2629800, "month"],
    [31557600, "year"],
  ];
  let chosen = units[0];
  for (const unit of units) {
    if (seconds >= unit[0]) chosen = unit;
  }
  const value = Math.floor(seconds / chosen[0]);
  return `${value} ${chosen[1]}${value === 1 ? "" : "s"} ago`;
}

/**
 * Read-only commit history. Loads pages of commits (load-more), expands a
 * commit to its changed files, and opens a file's diff in the shared
 * diff viewer.
 */
export function HistoryPanel() {
  const isRepo = useGitStore((state) => state.isRepo);
  const openDiff = useTabsStore((state) => state.openDiff);

  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, CommitFile[]>>(
    {},
  );
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const cherryPick = useGitStore((state) => state.cherryPick);
  const revertCommit = useGitStore((state) => state.revertCommit);
  const branch = useGitStore((state) => state.branch);
  const branches = useGitStore((state) => state.branches);
  const loadBranches = useGitStore((state) => state.loadBranches);
  /** Another branch's history (null: the current branch). */
  const [viewing, setViewing] = useState<string | null>(null);

  /** Right-click a commit: cherry-pick, revert, copy its hash. */
  function commitMenu(commit: CommitInfo): ContextMenuItem[] {
    const reload = () => {
      setCommits([]);
      setReachedEnd(false);
      void loadMore(0);
    };
    return [
      // Picking from the branch you're on would re-apply its own commit.
      ...(viewing
        ? [
            {
              label: `Cherry-Pick onto ${branch ?? "HEAD"}`,
              onSelect: () => void cherryPick(commit.hash),
            },
            {
              label: `Rebase ${branch ?? "HEAD"} onto This Commit`,
              onSelect: () => void useGitStore.getState().rebase(commit.hash),
            },
          ]
        : []),
      {
        label: "Revert Commit",
        onSelect: () =>
          void confirmNative(`Make a new commit that undoes “${commit.summary}”?`, {
            title: "Revert Commit",
            kind: "warning",
          }).then((yes) => {
            if (yes) void revertCommit(commit.hash).then(reload);
          }),
      },
      // Rewrite what's above this commit on the current branch.
      ...(!viewing
        ? [
            {
              label: "Interactive Rebase from Here…",
              onSelect: () => {
                const index = commits.findIndex((candidate) => candidate.hash === commit.hash);
                const above = commits.slice(0, index).reverse();
                if (above.length === 0) {
                  useUiStore.getState().showStatus("Choose an older commit — the rebase rewrites the commits after it");
                } else if (above.some((candidate) => candidate.parents.length > 1)) {
                  useUiStore.getState().showStatus("Those commits include a merge — interactive rebase works on a straight line of commits");
                } else {
                  useGitStore.getState().setRebaseDialog({ base: commit.hash, commits: above });
                }
              },
            },
          ]
        : []),
      {
        label: "Copy Hash",
        onSelect: () => {
          void navigator.clipboard.writeText(commit.hash);
          useUiStore.getState().showStatus(`Copied ${commit.shortHash}`);
        },
      },
    ];
  }

  async function loadMore(skip: number) {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root || loading) return;
    setLoading(true);
    try {
      const page = await gitLog(root, PAGE_SIZE, skip, viewing);
      setCommits((current) => (skip === 0 ? page : [...current, ...page]));
      if (page.length < PAGE_SIZE) setReachedEnd(true);
    } finally {
      setLoading(false);
    }
  }

  // Load the first page when the view mounts (or the branch changes).
  useEffect(() => {
    setCommits([]);
    setReachedEnd(false);
    setExpanded(null);
    void loadMore(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  async function toggleCommit(hash: string) {
    if (expanded === hash) {
      setExpanded(null);
      return;
    }
    setExpanded(hash);
    if (!filesByHash[hash]) {
      const root = useWorkspaceStore.getState().rootPath;
      if (!root) return;
      try {
        const files = await gitCommitFiles(root, hash);
        setFilesByHash((current) => ({ ...current, [hash]: files }));
      } catch {
        setFilesByHash((current) => ({ ...current, [hash]: [] }));
      }
    }
  }

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const graphWidth = Math.min(8, Math.max(1, ...graph.map((row) => row.width)));

  if (!isRepo) {
    return <div className="history-empty">This folder isn’t a Git repository.</div>;
  }

  return (
    <div
      className="history-panel"
      onScroll={(event) => {
        const el = event.currentTarget;
        if (
          !reachedEnd &&
          !loading &&
          el.scrollHeight - el.scrollTop - el.clientHeight < 200
        ) {
          void loadMore(commits.length);
        }
      }}
    >
      {branches.length > 1 && (
        <div className="history-branch">
          <select
            value={viewing ?? ""}
            onChange={(event) => setViewing(event.target.value || null)}
            title="Show another branch's commits — right-click one to cherry-pick it"
          >
            <option value="">{branch ?? "HEAD"} (current)</option>
            <option value="*">All branches</option>
            {branches
              .filter((candidate) => !candidate.isCurrent)
              .map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
          </select>
        </div>
      )}
      {commits.map((commit, index) => {
        const isOpen = expanded === commit.hash;
        const Chevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <div key={commit.hash} className="history-commit">
            <div
              className="history-row"
              onClick={() => toggleCommit(commit.hash)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, items: commitMenu(commit) });
              }}
              title={`${commit.summary} — right-click for Cherry-Pick, Revert…`}
            >
              {graph[index] && <GraphCell row={graph[index]} width={graphWidth} />}
              <Chevron size={13} strokeWidth={1.5} className="history-chevron" />
              <div className="history-main">
                <div className="history-summary">
                  {commit.refs.map((ref) => (
                    <span key={ref} className={ref.startsWith("tag: ") ? "history-ref tag" : ref === branch ? "history-ref head" : "history-ref"}>
                      {ref.replace(/^tag: /, "")}
                    </span>
                  ))}
                  {commit.summary}
                </div>
                <div className="history-meta">
                  <span className="history-hash">{commit.shortHash}</span>
                  {commit.author} · {relativeTime(commit.timestamp)}
                </div>
              </div>
            </div>
            {isOpen && (
              <div className="history-files" style={{ paddingLeft: 24 + graphWidth * LANE }}>
                {graph[index] && <GraphContinuation row={graph[index]} />}
                {(filesByHash[commit.hash] ?? []).map((file) => {
                  const name =
                    file.path.split(/[/\\]/).filter(Boolean).pop() ?? file.path;
                  const FileIcon = iconForFile(name);
                  return (
                    <div
                      key={file.path}
                      className="history-file"
                      title={file.path}
                      onClick={() =>
                        openDiff({
                          kind: "commit",
                          filePath: file.path,
                          hash: commit.hash,
                          shortHash: commit.shortHash,
                        })
                      }
                    >
                      <FileIcon
                        size={13}
                        strokeWidth={1.5}
                        className="history-file-icon"
                      />
                      <span className="history-file-name">{name}</span>
                      <span className={`history-file-badge git-${file.status}`}>
                        {file.status[0].toUpperCase()}
                      </span>
                    </div>
                  );
                })}
                {filesByHash[commit.hash]?.length === 0 && (
                  <div className="history-file-empty">No file changes</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {loading && <div className="history-status">Loading…</div>}
      {reachedEnd && commits.length === 0 && (
        <div className="history-status">No commits yet</div>
      )}
    </div>
  );
}

/** Pixels per graph lane. */
const LANE = 12;
const ROW_HEIGHT = 44;
const LANE_COLORS = ["#7c93ff", "#6cc070", "#d6a55c", "#e879a6", "#4fc1d6", "#f87171", "#a78bfa", "#9ca3af"];
const laneColor = (index: number) => LANE_COLORS[index % LANE_COLORS.length];
const laneX = (column: number) => LANE / 2 + column * LANE;

/** One row of the commit graph: lines to the rows above and below, and
 *  the commit's dot. */
function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const visible = (column: number) => column < 8;
  return (
    <svg className="history-graph" width={width * LANE} height={ROW_HEIGHT} aria-hidden>
      {row.segments
        .filter((segment) => visible(segment.x1) && visible(segment.x2))
        .map((segment, index) => {
          const x1 = laneX(segment.x1);
          const x2 = laneX(segment.x2);
          const y1 = segment.y1 * ROW_HEIGHT;
          const y2 = segment.y2 * ROW_HEIGHT;
          const d =
            x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
          return <path key={index} d={d} stroke={laneColor(segment.color)} strokeWidth={1.5} fill="none" />;
        })}
      {visible(row.column) && (
        <circle cx={laneX(row.column)} cy={ROW_HEIGHT / 2} r={3.5} fill={laneColor(row.color)} stroke="var(--bg-base)" strokeWidth={1.5} />
      )}
    </svg>
  );
}

/** The lanes running past an expanded commit's file list. */
function GraphContinuation({ row }: { row: GraphRow }) {
  return (
    <>
      {row.lanesBelow
        .filter((lane) => lane.column < 8)
        .map((lane) => (
          <span
            key={lane.column}
            className="history-graph-lane"
            style={{ left: 8 + laneX(lane.column) - 0.75, background: laneColor(lane.color) }}
          />
        ))}
    </>
  );
}
