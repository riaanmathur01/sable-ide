import { Suspense, lazy } from "react";
import { TabBar } from "./TabBar";
import { useTabsStore } from "../../store/tabsStore";
import "./EditorArea.css";

// Monaco (and its workers) live in their own chunks, fetched the first
// time a file opens — the app shell cold-starts without any of it.
// (Cmd/Ctrl+S and the rest live in lib/useGlobalKeybindings.)
const MonacoPane = lazy(() => import("./MonacoPane"));
const DiffView = lazy(() => import("./DiffView"));

/**
 * Main editor region: tab bar on top, then either the Monaco editor (for
 * file tabs) or a diff view (for diff tabs). MonacoPane stays mounted
 * whenever any file tab exists — hidden behind an active diff — so its
 * models (and unsaved edits) survive switching to a diff and back.
 */
export function EditorArea() {
  const tabs = useTabsStore((state) => state.tabs);
  const activePath = useTabsStore((state) => state.activePath);

  const activeTab = tabs.find((tab) => tab.path === activePath);
  const diffActive = activeTab?.kind === "diff";
  const hasFileTab = tabs.some((tab) => tab.kind === "file");

  if (tabs.length === 0) {
    return (
      <main className="editor-area">
        <TabBar />
        <div className="editor-empty">
          <div className="editor-empty-wordmark">Sable</div>
          <div className="editor-empty-tagline">fast · minimal · dark</div>
        </div>
      </main>
    );
  }

  return (
    <main className="editor-area">
      <TabBar />
      <div className="editor-surface">
        {hasFileTab && (
          <div
            className="editor-layer"
            style={{ display: diffActive ? "none" : "block" }}
          >
            <Suspense fallback={null}>
              <MonacoPane />
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
      </div>
    </main>
  );
}
