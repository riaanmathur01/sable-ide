import { Play, X } from "lucide-react";
import { useTabsStore } from "../../store/tabsStore";
import { runActiveFile } from "../../lib/runFile";
import "./TabBar.css";

/**
 * Tab strip above the editor. Dirty tabs show a dot that swaps to the
 * close button on hover (the CSS handles the swap). Middle-click closes.
 */
export function TabBar() {
  const tabs = useTabsStore((state) => state.tabs);
  const activePath = useTabsStore((state) => state.activePath);
  const setActive = useTabsStore((state) => state.setActive);
  const closeTab = useTabsStore((state) => state.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      <div className="tab-bar-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={
              tab.path === activePath ? "editor-tab active" : "editor-tab"
            }
            title={tab.path}
            onClick={() => setActive(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(tab.path);
            }}
          >
            <span className="editor-tab-name">{tab.name}</span>
            <span
              className={
                tab.isDirty ? "editor-tab-close dirty" : "editor-tab-close"
              }
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.path);
              }}
            >
              <span className="editor-tab-dot" />
              <X size={13} strokeWidth={1.5} className="editor-tab-x" />
            </span>
          </div>
        ))}
      </div>
      <div className="tab-bar-actions">
        <button
          className="tab-bar-run"
          title="Run File (⌘R)"
          onClick={() => runActiveFile()}
        >
          <Play size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
