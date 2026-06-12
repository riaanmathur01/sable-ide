import { FolderOpen } from "lucide-react";
import "./Sidebar.css";

/**
 * File explorer sidebar. Phase 0 shows the empty state; Phase 1 replaces
 * the placeholder with a virtualized tree fed by the Rust backend.
 */
export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">Explorer</div>
      <div className="sidebar-empty">
        <FolderOpen size={28} strokeWidth={1.25} aria-hidden />
        <p>No folder opened</p>
        <p className="sidebar-empty-hint">
          Open a folder to start browsing files
        </p>
      </div>
    </aside>
  );
}
