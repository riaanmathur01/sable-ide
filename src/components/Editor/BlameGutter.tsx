import { useEffect, useState } from "react";
import {
  getScrollMetrics,
  onEditorViewChange,
  type EditorScrollMetrics,
} from "../../lib/editorRegistry";
import { useTabsStore } from "../../store/tabsStore";
import type { BlameLine } from "../../lib/ipc";
import "./BlameGutter.css";

/** Format the hover tooltip for a blame line. */
function blameTooltip(line: BlameLine): string | undefined {
  if (!line.hash) return "Uncommitted change";
  const date = new Date(line.timestamp * 1000).toLocaleString();
  return `${line.shortHash} · ${line.author} · ${date}\n\n${line.summary}\n\n(click to open this commit's diff)`;
}

/** Compact relative time for the gutter. */
function relativeTime(unixSeconds: number): string {
  if (unixSeconds === 0) return "uncommitted";
  const days = (Date.now() / 1000 - unixSeconds) / 86400;
  if (days < 1) return "today";
  if (days < 30) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * A blame column rendered as our own DOM (Monaco's injected-text
 * decorations don't paint in this build). It sits to the left of the
 * editor and stays vertically in sync with the editor's scroll, drawing
 * only the lines currently in view.
 */
export function BlameGutter({
  lines,
  filePath,
}: {
  lines: BlameLine[];
  filePath: string;
}) {
  const openDiff = useTabsStore((state) => state.openDiff);
  const [metrics, setMetrics] = useState<EditorScrollMetrics | null>(
    getScrollMetrics(),
  );

  useEffect(() => {
    const sync = () => setMetrics(getScrollMetrics());
    sync();
    // The editor mounts slightly after this; poll briefly until metrics
    // are available, then rely on scroll/layout events.
    const timer = setInterval(() => {
      if (getScrollMetrics()) {
        sync();
        clearInterval(timer);
      }
    }, 50);
    const unsubscribe = onEditorViewChange(sync);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  if (!metrics) return <div className="blame-gutter" />;
  const { scrollTop, lineHeight, paddingTop, viewportHeight } = metrics;

  // Only render the lines visible in the viewport (plus a small overscan).
  const firstVisible = Math.max(
    0,
    Math.floor((scrollTop - paddingTop) / lineHeight) - 2,
  );
  const lastVisible = Math.min(
    lines.length,
    Math.ceil((scrollTop + viewportHeight - paddingTop) / lineHeight) + 2,
  );

  const rows = [];
  for (let index = firstVisible; index < lastVisible; index++) {
    const line = lines[index];
    if (!line) continue;
    const top = paddingTop + index * lineHeight - scrollTop;
    rows.push(
      <div
        key={index}
        className={
          line.hash ? "blame-gutter-row clickable" : "blame-gutter-row"
        }
        style={{ top, height: lineHeight }}
        title={blameTooltip(line)}
        onClick={
          line.hash
            ? () =>
                openDiff({
                  kind: "commit",
                  filePath,
                  hash: line.hash,
                  shortHash: line.shortHash,
                })
            : undefined
        }
      >
        <span className="blame-gutter-hash">{line.shortHash}</span>
        <span className="blame-gutter-author">{line.author}</span>
        <span className="blame-gutter-time">
          {relativeTime(line.timestamp)}
        </span>
      </div>,
    );
  }

  return <div className="blame-gutter">{rows}</div>;
}
