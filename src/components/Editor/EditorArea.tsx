import "./EditorArea.css";

/**
 * Main editor region. Phase 0 shows the empty state; Phase 2 adds the
 * tab bar and Monaco instances here.
 */
export function EditorArea() {
  return (
    <main className="editor-area">
      <div className="editor-empty">
        <div className="editor-empty-wordmark">Sable</div>
        <div className="editor-empty-tagline">fast · minimal · dark</div>
      </div>
    </main>
  );
}
