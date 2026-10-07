import { Fragment, Suspense, lazy, useRef, useState } from "react";
import { TabBar } from "./TabBar";
import { useTabsStore, type EditorGroup } from "../../store/tabsStore";
import { DebugToolbar } from "../Debug/DebugToolbar";
import { Resizer } from "../Layout/Resizer";
import "./EditorArea.css";

// Monaco (and its workers) live in their own chunks, fetched the first
// time a file opens — the app shell cold-starts without any of it.
// (Cmd/Ctrl+S and the rest live in lib/useGlobalKeybindings.)
const MonacoPane = lazy(() => import("./MonacoPane"));
const DiffView = lazy(() => import("./DiffView"));
const SettingsView = lazy(() => import("../Settings/SettingsView"));

const MIN_GROUP_WIDTH = 220;

/**
 * Main editor region: one or more editor groups side by side (⌘\
 * splits), each with its own tabs. With several groups the dividers
 * between them drag to resize (double-click to even them out).
 */
export function EditorArea() {
  const groups = useTabsStore((state) => state.groups);
  const activeGroupId = useTabsStore((state) => state.activeGroupId);
  /** Pixel widths for all but the last group (which takes the rest). */
  const [widths, setWidths] = useState<Record<string, number>>({});
  const groupElements = useRef(new Map<string, HTMLDivElement>());

  if (groups.length === 1 && groups[0].tabs.length === 0) {
    return (
      <main className="editor-area">
        <div className="editor-empty">
          <div className="editor-empty-wordmark">Sable</div>
          <div className="editor-empty-tagline">fast · minimal · dark</div>
          <div className="editor-empty-shortcuts">
            <span>Go to file</span>
            <kbd>⌘P</kbd>
            <span>Commands</span>
            <kbd>⇧⌘P</kbd>
            <span>Open folder</span>
            <kbd>⌘O</kbd>
            <span>Ask the AI agent</span>
            <kbd>⌘L</kbd>
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </div>
        </div>
      </main>
    );
  }

  const isSplit = groups.length > 1;
  return (
    <main className="editor-area editor-groups">
      {groups.map((group, index) => {
        const isLast = index === groups.length - 1;
        const width = widths[group.id];
        return (
          <Fragment key={group.id}>
            <div
              ref={(element) => {
                if (element) groupElements.current.set(group.id, element);
                else groupElements.current.delete(group.id);
              }}
              className="editor-group"
              style={
                !isLast && width !== undefined
                  ? { flex: `0 0 ${width}px` }
                  : { flex: "1 1 0" }
              }
              // Capture: focus the group before the click does anything
              // (so Run, ⌘S, … act on the group just clicked).
              onMouseDownCapture={() => useTabsStore.getState().focusGroup(group.id)}
            >
              <EditorGroupView
                group={group}
                isFocused={group.id === activeGroupId}
                isSplit={isSplit}
              />
            </div>
            {!isLast && (
              <Resizer
                axis="x"
                size={width ?? groupElements.current.get(group.id)?.offsetWidth ?? 400}
                defaultSize={-1}
                onResize={(size) => {
                  if (size < 0) {
                    // Double-click: back to even widths.
                    setWidths({});
                    return;
                  }
                  setWidths((current) => ({
                    ...current,
                    [group.id]: Math.max(MIN_GROUP_WIDTH, size),
                  }));
                }}
              />
            )}
          </Fragment>
        );
      })}
    </main>
  );
}

/**
 * One group: its tab bar, then the Monaco editor (file tabs), a diff view
 * (diff tabs), or the settings page. The editor stays mounted whenever
 * the group has any file tab — hidden behind other tab kinds — so its
 * view state survives switching away and back.
 */
function EditorGroupView({
  group,
  isFocused,
  isSplit,
}: {
  group: EditorGroup;
  isFocused: boolean;
  isSplit: boolean;
}) {
  const activeTab = group.tabs.find((tab) => tab.path === group.activePath);
  const diffActive = activeTab?.kind === "diff";
  const settingsActive = activeTab?.kind === "settings";
  const fileActive = !diffActive && !settingsActive;
  const hasFileTab = group.tabs.some((tab) => tab.kind === "file");

  return (
    <>
      <TabBar group={group} isFocused={isFocused} isSplit={isSplit} />
      <div className="editor-surface">
        {hasFileTab && (
          <div className="editor-layer" style={{ display: fileActive ? "block" : "none" }}>
            <Suspense fallback={null}>
              <MonacoPane groupId={group.id} />
            </Suspense>
          </div>
        )}
        {diffActive && activeTab.diff && (
          <div className="editor-layer">
            <Suspense fallback={null}>
              <DiffView key={activeTab.path} source={activeTab.diff} />
            </Suspense>
          </div>
        )}
        {settingsActive && (
          <div className="editor-layer">
            <Suspense fallback={null}>
              <SettingsView />
            </Suspense>
          </div>
        )}
        {fileActive && hasFileTab && isFocused && (
          <div className="editor-debug-toolbar">
            <DebugToolbar />
          </div>
        )}
      </div>
    </>
  );
}
