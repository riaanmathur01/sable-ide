import { useEffect, useState } from "react";
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

  async function loadMore(skip: number) {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root || loading) return;
    setLoading(true);
    try {
      const page = await gitLog(root, PAGE_SIZE, skip);
      setCommits((current) => (skip === 0 ? page : [...current, ...page]));
      if (page.length < PAGE_SIZE) setReachedEnd(true);
    } finally {
      setLoading(false);
    }
  }

  // Load the first page when the view mounts.
  useEffect(() => {
    setCommits([]);
    setReachedEnd(false);
    void loadMore(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {commits.map((commit) => {
        const isOpen = expanded === commit.hash;
        const Chevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <div key={commit.hash} className="history-commit">
            <div
              className="history-row"
              onClick={() => toggleCommit(commit.hash)}
              title={commit.summary}
            >
              <Chevron size={13} strokeWidth={1.5} className="history-chevron" />
              <div className="history-main">
                <div className="history-summary">{commit.summary}</div>
                <div className="history-meta">
                  <span className="history-hash">{commit.shortHash}</span>
                  {commit.author} · {relativeTime(commit.timestamp)}
                </div>
              </div>
            </div>
            {isOpen && (
              <div className="history-files">
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
      {loading && <div className="history-status">Loading…</div>}
      {reachedEnd && commits.length === 0 && (
        <div className="history-status">No commits yet</div>
      )}
    </div>
  );
}
