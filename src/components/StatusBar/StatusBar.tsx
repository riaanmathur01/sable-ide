import "./StatusBar.css";

/**
 * Status bar pinned to the bottom of the window. Phase 0 shows static
 * placeholders; later phases wire in cursor position, language, and
 * workspace info.
 */
export function StatusBar() {
  return (
    <footer className="status-bar">
      <div className="status-bar-group">
        <span className="status-bar-item">No folder opened</span>
      </div>
      <div className="status-bar-group">
        <span className="status-bar-item">Sable 0.1.0</span>
      </div>
    </footer>
  );
}
