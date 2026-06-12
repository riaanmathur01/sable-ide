import { Suspense, lazy } from "react";
import { TabBar } from "./TabBar";
import { useTabsStore } from "../../store/tabsStore";
import "./EditorArea.css";

// Monaco (and its workers) live in their own chunks, fetched the first
// time a file opens — the app shell cold-starts without any of it.
// (Cmd/Ctrl+S and the rest live in lib/useGlobalKeybindings.)
const MonacoPane = lazy(() => import("./MonacoPane"));

/**
 * Main editor region: tab bar on top, Monaco below, empty state when
 * nothing is open.
 */
export function EditorArea() {
  const hasOpenTabs = useTabsStore((state) => state.tabs.length > 0);

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
