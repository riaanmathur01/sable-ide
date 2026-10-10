import { useEffect, useRef } from "react";
import { BookOpen, Bug, Columns2, Play, Puzzle, Settings, SlidersHorizontal, X } from "lucide-react";
import { MAX_GROUPS, useTabsStore, type EditorGroup } from "../../store/tabsStore";
import { isDebuggable, useDebugStore } from "../../store/debugStore";
import { runActiveFile } from "../../lib/runFile";
import { useRunConfigStore } from "../../store/runConfigStore";
import { isEmptyConfig } from "../../lib/runConfig";
import "./TabBar.css";

/**
 * Tab strip above one editor group. Dirty tabs show a dot that swaps to
 * the close button on hover (the CSS handles the swap). Middle-click
 * closes. With several groups, the focused one's strip is accented.
 */
export function TabBar({
  group,
  isFocused,
  isSplit,
}: {
  group: EditorGroup;
  isFocused: boolean;
  /** More than one group is open. */
  isSplit: boolean;
}) {
  const { tabs, activePath, lastFilePath } = group;
  const setActive = useTabsStore((state) => state.setActive);
  const closeTab = useTabsStore((state) => state.closeTab);
  const groupCount = useTabsStore((state) => state.groups.length);
  const isDebugging = useDebugStore((state) => state.isDebugging);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when switching with ⌃Tab / ⌘1… or when
  // a far-right tab opens.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activePath) return;
    const active = strip.querySelector<HTMLElement>(".editor-tab.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  if (tabs.length === 0) return null;

  const canDebug = isDebuggable(lastFilePath);
  const canSplit = lastFilePath !== null && groupCount < MAX_GROUPS;

  return (
    <div className={isSplit && isFocused ? "tab-bar focused" : "tab-bar"}>
      <div className="tab-bar-tabs" ref={stripRef}>
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={tab.path === activePath ? "editor-tab active" : "editor-tab"}
            title={tab.path}
            onClick={() => setActive(tab.path, group.id)}
            onAuxClick={(event) => {
              if (event.button === 1) void closeTab(tab.path, group.id);
            }}
          >
            {tab.kind === "settings" && (
              <Settings size={13} strokeWidth={1.5} className="editor-tab-icon" />
            )}
            {tab.kind === "plugin" && (
              <Puzzle size={13} strokeWidth={1.5} className="editor-tab-icon" />
            )}
            <span className="editor-tab-name">{tab.name}</span>
            <span
              className={tab.isDirty ? "editor-tab-close dirty" : "editor-tab-close"}
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.path, group.id);
              }}
            >
              <span className="editor-tab-dot" />
              <X size={13} strokeWidth={1.5} className="editor-tab-x" />
            </span>
          </div>
        ))}
      </div>
      <div className="tab-bar-actions">
        {group.lastFilePath && /\.(md|markdown|mdx)$/i.test(group.lastFilePath) && (
          <button
            className="tab-bar-run"
            title="Open Preview to the Side (⇧⌘V)"
            onClick={() => useTabsStore.getState().openPreview(group.lastFilePath!, true)}
          >
            <BookOpen size={14} strokeWidth={1.5} />
          </button>
        )}
        {canSplit && (
          <button
            className="tab-bar-run"
            title="Split Editor Right (⌘\)"
            onClick={() => void useTabsStore.getState().splitRight()}
          >
            <Columns2 size={14} strokeWidth={1.5} />
          </button>
        )}
        {canDebug && !isDebugging && (
          <button
            className="tab-bar-run"
            title="Debug File (F5)"
            onClick={() => void useDebugStore.getState().start()}
          >
            <Bug size={14} strokeWidth={1.5} />
          </button>
        )}
        <button className="tab-bar-run" title="Run File (⌘R)" onClick={() => runActiveFile()}>
          <Play size={14} strokeWidth={1.5} />
        </button>
        {group.lastFilePath && <RunConfigButton path={group.lastFilePath} />}
      </div>
    </div>
  );
}

/** Edit the file's run configuration; highlighted when it has one. */
function RunConfigButton({ path }: { path: string }) {
  const configured = useRunConfigStore((state) => {
    const config = state.configs[path];
    return config !== undefined && !isEmptyConfig(config);
  });
  return (
    <button
      className={configured ? "tab-bar-run configured" : "tab-bar-run"}
      title={configured ? "Run Configuration (arguments/environment set)" : "Run Configuration: arguments, environment, working directory"}
      onClick={() => useRunConfigStore.getState().edit(path)}
    >
      <SlidersHorizontal size={13} strokeWidth={1.5} />
    </button>
  );
}
