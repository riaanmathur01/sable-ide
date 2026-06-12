import { Sidebar } from "./components/Sidebar/Sidebar";
import { EditorArea } from "./components/Editor/EditorArea";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { useUiStore } from "./store/uiStore";
import "./App.css";

/**
 * Shell layout: a horizontal row of sidebar + editor, with the status bar
 * pinned underneath. The terminal panel slots into the editor column in
 * Phase 4.
 */
function App() {
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);

  return (
    <div className="app-shell">
      <div className="app-main">
        {sidebarVisible && <Sidebar />}
        <EditorArea />
      </div>
      <StatusBar />
    </div>
  );
}

export default App;
