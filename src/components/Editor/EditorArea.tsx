import { Suspense, lazy, useEffect } from "react";
import { TabBar } from "./TabBar";
import { useTabsStore } from "../../store/tabsStore";
import "./EditorArea.css";

// Monaco (and its workers) live in their own chunks, fetched the first
// time a file opens — the app shell cold-starts without any of it.
const MonacoPane = lazy(() => import("./MonacoPane"));

/**
 * Main editor region: tab bar on top, Monaco below, empty state when
 * nothing is open.
 */
export function EditorArea() {
  const hasOpenTabs = useTabsStore((state) => state.tabs.length > 0);

  // Window-level Cmd/Ctrl+S so saving works even when the editor isn't
  // focused (e.g. right after clicking around the tree).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        const { activePath, saveTab } = useTabsStore.getState();
        if (activePath) saveTab(activePath);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="editor-area">
      <TabBar />
      {hasOpenTabs ? (
        <div className="editor-surface">
          <Suspense fallback={null}>
            <MonacoPane />
          </Suspense>
        </div>
      ) : (
        <div className="editor-empty">
          <div className="editor-empty-wordmark">Sable</div>
          <div className="editor-empty-tagline">fast · minimal · dark</div>
        </div>
      )}
    </main>
  );
}
