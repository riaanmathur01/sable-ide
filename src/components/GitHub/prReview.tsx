import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as MonacoTypes from "monaco-editor";
import { MessageSquare } from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { github, type ReviewThread } from "../../lib/github/api";
import type { PrDiffSource } from "../../lib/github/types";
import { act, prKey, useGitHubStore } from "../../store/githubStore";
import { openPullRequest } from "../../lib/github/actions";
import { Composer, PendingView, ThreadView } from "./Thread";
import "./GitHub.css";

/**
 * Reviewing a pull request in the diff editor (DiffView with a "pr"
 * source): the file's two sides from GitHub (or the local repository), its
 * review threads inline as view zones under their lines, and a "+" in the
 * gutter of changed lines to write a new comment (on the selected lines
 * for a range) — kept as pending until the review is submitted, or posted
 * as a single comment.
 */

type DiffEditor = MonacoTypes.editor.IStandaloneDiffEditor;
type CodeEditor = MonacoTypes.editor.ICodeEditor;
type Side = "LEFT" | "RIGHT";

/** The two sides of a pull request's file. */
export async function loadPrSides(source: PrDiffSource): Promise<{ original: string; modified: string; isBinary: boolean }> {
  const store = useGitHubStore.getState();
  const key = prKey(source.root, source.number);
  if (!store.prs[key]?.threads || !store.prs[key]?.details) {
    void store.loadPr(source.root, source.number, { details: !store.prs[key]?.details, threads: true, files: !store.prs[key]?.files });
  }
  const [original, modified] = await Promise.all([
    source.status === "added" ? { text: "", binary: false } : github.fileText(source.root, source.baseSha, source.previousPath ?? source.path),
    source.status === "removed" ? { text: "", binary: false } : github.fileText(source.root, source.headSha, source.path),
  ]);
  return { original: original.text, modified: modified.text, isBinary: original.binary || modified.binary };
}

/** Where comments may go: changed lines and a little context (GitHub's diff hunks). */
function commentableLines(diffEditor: DiffEditor, side: Side): (line: number) => boolean {
  const changes = diffEditor.getLineChanges() ?? [];
  const ranges = changes.map((change) => {
    const [start, end] = side === "RIGHT" ? [change.modifiedStartLineNumber, change.modifiedEndLineNumber] : [change.originalStartLineNumber, change.originalEndLineNumber];
    // An empty side (pure insertion / deletion) has end 0: around `start`.
    return [Math.max(1, start - 3), (end || start) + 3];
  });
  return (line) => ranges.some(([from, to]) => line >= from && line <= to);
}

interface Draft {
  side: Side;
  line: number;
  startLine?: number;
}

interface Zone {
  side: Side;
  id: string;
  root: Root;
  inner: HTMLElement;
  observer: ResizeObserver;
  height: number;
  spec: MonacoTypes.editor.IViewZone;
  /** The same height on the other side, so the two sides stay aligned. */
  spacer: { id: string; spec: MonacoTypes.editor.IViewZone } | null;
}

/** The line on the other side that corresponds to `line` (after it, inside a change). */
export function counterpartLine(changes: MonacoTypes.editor.ILineChange[], line: number, from: Side): number {
  let delta = 0;
  for (const change of changes) {
    const [fromStart, fromEnd, toStart, toEnd] =
      from === "RIGHT"
        ? [change.modifiedStartLineNumber, change.modifiedEndLineNumber, change.originalStartLineNumber, change.originalEndLineNumber]
        : [change.originalStartLineNumber, change.originalEndLineNumber, change.modifiedStartLineNumber, change.modifiedEndLineNumber];
    const fromLength = fromEnd === 0 ? 0 : fromEnd - fromStart + 1;
    const toLength = toEnd === 0 ? 0 : toEnd - toStart + 1;
    const fromLast = fromEnd === 0 ? fromStart : fromEnd;
    if (fromEnd !== 0 && line >= fromStart && line <= fromEnd) return toEnd === 0 ? toStart : toEnd;
    if (line < (fromEnd === 0 ? fromStart + 1 : fromStart)) break;
    if (line >= fromLast) delta += toLength - fromLength;
  }
  return Math.max(0, line + delta);
}

/** Attach review threads and commenting to a pull request diff. Returns a disposer. */
export function attachPrReview(diffEditor: DiffEditor, source: PrDiffSource): () => void {
  const key = prKey(source.root, source.number);
  let draft: Draft | null = null;
  const disposers: (() => void)[] = [];
  const sides: [CodeEditor, Side][] = [
    [diffEditor.getOriginalEditor(), "LEFT"],
    [diffEditor.getModifiedEditor(), "RIGHT"],
  ];
  /** Zones by item key. */
  const zones = new Map<string, Zone>();

  const editorFor = (side: Side) => (side === "LEFT" ? sides[0][0] : sides[1][0]);
  const other = (side: Side): Side => (side === "LEFT" ? "RIGHT" : "LEFT");
  /** What a widget may be wide: the visible text area of its side. */
  const widthFor = (side: Side) => {
    const layout = editorFor(side).getLayoutInfo();
    return Math.max(240, layout.contentWidth - layout.verticalScrollbarWidth - 24);
  };

  /** What should be shown, by key: threads, pending comments, the draft. */
  const wanted = () => {
    const state = useGitHubStore.getState();
    const items = new Map<string, { side: Side; line: number; render: () => React.ReactNode }>();
    const threads = (state.prs[key]?.threads?.threads ?? []).filter((thread) => thread.path === source.path && thread.line);
    for (const thread of threads) {
      items.set(`t:${thread.id}`, { side: thread.side, line: thread.line!, render: () => <LiveThread source={source} id={thread.id} /> });
    }
    for (const comment of state.pending[key] ?? []) {
      if (comment.path !== source.path) continue;
      items.set(`p:${comment.id}`, {
        side: comment.side,
        line: comment.line,
        render: () => (
          <div className="gh-zone-card">
            <PendingView root={source.root} number={source.number} comment={comment} />
          </div>
        ),
      });
    }
    if (draft) {
      const current = draft;
      items.set(`d:${current.side}:${current.startLine ?? ""}:${current.line}`, {
        side: current.side,
        line: current.line,
        render: () => (
          <DraftComment
            source={source}
            draft={current}
            onDone={() => {
              draft = null;
              sync();
            }}
          />
        ),
      });
    }
    return items;
  };

  /** Pending comments re-render when edited: their key includes the body. */
  const signature = (itemKey: string) => {
    if (!itemKey.startsWith("p:")) return itemKey;
    const comment = (useGitHubStore.getState().pending[key] ?? []).find((candidate) => `p:${candidate.id}` === itemKey);
    return `${itemKey}:${comment?.body.length ?? 0}:${comment?.body ?? ""}`;
  };
  const rendered = new Map<string, string>();

  const removeZone = (zone: Zone) => {
    editorFor(zone.side).changeViewZones((accessor) => accessor.removeZone(zone.id));
    if (zone.spacer) {
      const spacer = zone.spacer;
      editorFor(other(zone.side)).changeViewZones((accessor) => accessor.removeZone(spacer.id));
    }
    zone.observer.disconnect();
    const reactRoot = zone.root;
    queueMicrotask(() => reactRoot.unmount());
  };

  const sync = () => {
    const items = wanted();
    const changes = diffEditor.getLineChanges() ?? [];
    const sideBySide = diffEditor.getOriginalEditor().getLayoutInfo().width > 0 && diffEditor.getOriginalEditor().getDomNode()?.offsetParent !== null;
    // Remove what's gone (or changed).
    for (const [itemKey, zone] of [...zones]) {
      if (items.has(itemKey) && rendered.get(itemKey) === signature(itemKey)) continue;
      removeZone(zone);
      zones.delete(itemKey);
      rendered.delete(itemKey);
    }
    // Add what's new.
    for (const [itemKey, item] of items) {
      if (zones.has(itemKey)) continue;
      const editor = editorFor(item.side);
      const dom = document.createElement("div");
      dom.className = "gh-zone";
      dom.dataset.side = item.side;
      dom.dataset.line = String(item.line);
      const inner = document.createElement("div");
      inner.className = "gh-zone-inner";
      inner.style.width = `${widthFor(item.side)}px`;
      dom.appendChild(inner);
      // Keep the editor from taking clicks and keys meant for the widget.
      for (const type of ["mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "keypress", "contextmenu", "pointerdown", "mousemove"]) {
        dom.addEventListener(type, (event) => event.stopPropagation());
      }
      const reactRoot = createRoot(inner);
      reactRoot.render(item.render());
      const spec: MonacoTypes.editor.IViewZone = { afterLineNumber: Math.min(item.line, editor.getModel()?.getLineCount() ?? item.line), heightInPx: 40, domNode: dom };
      const zone: Zone = { side: item.side, id: "", root: reactRoot, inner, observer: new ResizeObserver(() => relayout()), height: 40, spec, spacer: null };
      const relayout = () => {
        const height = Math.ceil(inner.getBoundingClientRect().height) + 12;
        if (height <= 12 || Math.abs(height - zone.height) <= 1) return;
        zone.height = height;
        spec.heightInPx = height;
        editor.changeViewZones((accessor) => accessor.layoutZone(zone.id));
        if (zone.spacer) {
          const spacer = zone.spacer;
          spacer.spec.heightInPx = height;
          editorFor(other(item.side)).changeViewZones((accessor) => accessor.layoutZone(spacer.id));
        }
      };
      editor.changeViewZones((accessor) => {
        zone.id = accessor.addZone(spec);
      });
      if (sideBySide) {
        const spacerSpec: MonacoTypes.editor.IViewZone = { afterLineNumber: counterpartLine(changes, item.line, item.side), heightInPx: zone.height, domNode: Object.assign(document.createElement("div"), { className: "gh-zone-spacer" }) };
        editorFor(other(item.side)).changeViewZones((accessor) => {
          zone.spacer = { id: accessor.addZone(spacerSpec), spec: spacerSpec };
        });
      }
      zone.observer.observe(inner);
      zones.set(itemKey, zone);
      rendered.set(itemKey, signature(itemKey));
    }
  };

  // Widgets follow the editor's width.
  for (const [editor, side] of sides) {
    const layout = editor.onDidLayoutChange(() => {
      for (const zone of zones.values()) if (zone.side === side) zone.inner.style.width = `${widthFor(side)}px`;
    });
    disposers.push(() => layout.dispose());
  }

  // The "+" in the gutter of commentable lines, and clicking it.
  for (const [editor, side] of sides) {
    editor.updateOptions({ glyphMargin: true });
    const hover = editor.createDecorationsCollection();
    disposers.push(() => hover.clear());
    const allowed = () => {
      if (side === "LEFT" && source.status === "added") return () => false;
      if (side === "RIGHT" && source.status === "removed") return () => false;
      return commentableLines(diffEditor, side);
    };
    const showPlus = (line: number | null) => {
      if (!line || !allowed()(line)) {
        hover.clear();
        return;
      }
      hover.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "gh-add-comment-glyph", glyphMarginHoverMessage: { value: "Add a comment (select lines first for a range)" } } }]);
    };
    const move = editor.onMouseMove((event) => showPlus(event.target.position?.lineNumber ?? null));
    const leave = editor.onMouseLeave(() => hover.clear());
    const down = editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      if (!line || !allowed()(line)) return;
      event.event.preventDefault();
      const selection = editor.getSelection();
      const range = selection && !selection.isEmpty() && selection.startLineNumber !== selection.endLineNumber && line >= selection.startLineNumber && line <= selection.endLineNumber;
      draft = range ? { side, line: selection.endLineNumber, startLine: selection.startLineNumber } : { side, line };
      sync();
    });
    disposers.push(() => {
      move.dispose();
      leave.dispose();
      down.dispose();
    });
  }

  // "Add Comment on Selection" (context menu) on the new side.
  const action = diffEditor.getModifiedEditor().addAction({
    id: "sable.github.addComment",
    label: "GitHub: Add Review Comment",
    contextMenuGroupId: "navigation",
    run: (editor) => {
      const selection = editor.getSelection();
      if (!selection) return;
      const [start, end] = [selection.startLineNumber, selection.endLineNumber];
      draft = start !== end ? { side: "RIGHT", line: end, startLine: start } : { side: "RIGHT", line: end };
      sync();
    },
  });
  disposers.push(() => action.dispose());

  const unsubscribe = useGitHubStore.subscribe((state, previous) => {
    if (state.prs[key]?.threads !== previous.prs[key]?.threads || state.pending[key] !== previous.pending[key]) sync();
  });
  disposers.push(unsubscribe);
  // Diffs compute after the models are set: zones need their lines, and
  // the other side's spacers move to the lines that now correspond.
  const updated = diffEditor.onDidUpdateDiff(() => {
    const changes = diffEditor.getLineChanges() ?? [];
    for (const zone of zones.values()) {
      const spacer = zone.spacer;
      if (!spacer) continue;
      const line = counterpartLine(changes, Number(zone.spec.afterLineNumber), zone.side);
      if (line === spacer.spec.afterLineNumber) continue;
      spacer.spec.afterLineNumber = line;
      editorFor(other(zone.side)).changeViewZones((accessor) => accessor.layoutZone(spacer.id));
    }
    sync();
  });
  disposers.push(() => updated.dispose());
  sync();

  return () => {
    for (const dispose of disposers) dispose();
    for (const zone of zones.values()) {
      zone.observer.disconnect();
      const reactRoot = zone.root;
      queueMicrotask(() => reactRoot.unmount());
    }
    zones.clear();
  };
}

/** A thread, re-read from the store as replies arrive. */
function LiveThread({ source, id }: { source: PrDiffSource; id: string }) {
  const thread: ReviewThread | undefined = useGitHubStore((state) => state.prs[prKey(source.root, source.number)]?.threads?.threads.find((candidate) => candidate.id === id));
  const repoUrl = useGitHubStore((state) => state.status?.repo?.url);
  if (!thread) return null;
  return (
    <div className="gh-zone-card">
      <ThreadView root={source.root} number={source.number} thread={thread} repoUrl={repoUrl} />
    </div>
  );
}

/** Writing a new line comment. */
function DraftComment({ source, draft, onDone }: { source: PrDiffSource; draft: Draft; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const key = prKey(source.root, source.number);
  const pendingCount = useGitHubStore((state) => state.pending[key]?.length ?? 0);
  const comment = { path: source.path, line: draft.line, startLine: draft.startLine, side: draft.side, body };

  const addToReview = () => {
    if (!body.trim()) return;
    useGitHubStore.getState().addPending(key, comment);
    onDone();
  };
  const postNow = async () => {
    setBusy(true);
    const done = await act(() => github.review(source.root, source.number, "comment", "", source.headSha, [{ ...comment, id: "single" }]), "Comment posted");
    setBusy(false);
    if (done !== undefined) {
      onDone();
      await useGitHubStore.getState().loadPr(source.root, source.number, { threads: true });
    }
  };

  return (
    <div className="gh-zone-card gh-draft-comment" data-draft="true">
      <div className="gh-draft-where gh-muted">
        <MessageSquare size={12} strokeWidth={1.75} />
        {draft.startLine ? `Comment on lines ${draft.startLine}–${draft.line}` : `Comment on line ${draft.line}`}
        {draft.side === "LEFT" ? " (original)" : ""}
      </div>
      <Composer placeholder="Leave a comment (Markdown)" value={body} onChange={setBody} onSubmit={addToReview} autoFocus rows={3} />
      <div className="gh-buttons">
        <span className="gh-actions-spacer" />
        <button className="gh-button" onClick={onDone}>
          Cancel
        </button>
        <button className="gh-button" disabled={busy || !body.trim()} onClick={() => void postNow()}>
          Add single comment
        </button>
        <button className="gh-button primary" disabled={busy || !body.trim()} onClick={addToReview}>
          {pendingCount ? "Add review comment" : "Start a review"}
        </button>
      </div>
    </div>
  );
}

/** The diff's toolbar for a pull request file: Viewed, and the pending review. */
export function PrDiffToolbar({ source }: { source: PrDiffSource }) {
  const key = prKey(source.root, source.number);
  const pending = useGitHubStore((state) => state.pending[key]?.length ?? 0);
  const viewed = useGitHubStore((state) => state.prs[key]?.threads?.viewed[source.path] ?? false);
  const pullId = useGitHubStore((state) => state.prs[key]?.threads?.pullId ?? "");
  const title = useGitHubStore((state) => state.prs[key]?.details?.title);
  const setViewed = async (value: boolean) => {
    useGitHubStore.setState((state) => {
      const current = state.prs[key];
      if (!current?.threads) return {};
      return { prs: { ...state.prs, [key]: { ...current, threads: { ...current.threads, viewed: { ...current.threads.viewed, [source.path]: value } } } } };
    });
    await act(() => github.markViewed(source.root, pullId, source.path, value));
  };
  return (
    <div className="gh-diff-toolbar">
      <span className="gh-diff-path" title={source.previousPath ? `${source.previousPath} → ${source.path}` : source.path}>
        #{source.number} · {source.path}
      </span>
      <label className="gh-viewed" title="Mark as viewed">
        <input type="checkbox" checked={viewed} disabled={!pullId} onChange={(event) => void setViewed(event.target.checked)} />
        Viewed
      </label>
      <button className="gh-button small" onClick={() => openPullRequest(source.number, title, source.root)} title="Submit the review from the pull request's page">
        {pending ? `Finish review (${pending} pending)` : "Review"}
      </button>
    </div>
  );
}
