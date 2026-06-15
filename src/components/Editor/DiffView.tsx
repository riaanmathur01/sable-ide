import { useEffect, useRef, useState } from "react";
import { Columns2, Rows2 } from "lucide-react";
import { gitCommitFileDiff, gitFileDiff } from "../../lib/ipc";
import { useWorkspaceStore } from "../../store/workspaceStore";
import type { DiffSource } from "../../store/tabsStore";
import { monaco } from "../../lib/monacoSetup";
import "./DiffView.css";

interface DiffViewProps {
  source: DiffSource;
}

/** Pick a Monaco language id from a file's extension. */
function languageForPath(path: string): string {
  const extension = "." + (path.split(".").pop()?.toLowerCase() ?? "");
  const language = monaco.languages
    .getLanguages()
    .find((lang) => lang.extensions?.includes(extension));
  return language?.id ?? "plaintext";
}

/**
 * Read-only side-by-side diff of a changed file, powered by Monaco's
 * built-in diff editor. Rust (git2) supplies the two versions; Monaco
 * computes and renders the diff itself.
 */
export default function DiffView({ source }: DiffViewProps) {
  const filePath = source.filePath;
  const containerRef = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [message, setMessage] = useState<string | null>("Loading diff…");
  // Hold the editor so the side-by-side toggle can update it.
  const diffEditorRef = useRef<ReturnType<
    typeof monaco.editor.createDiffEditor
  > | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;

    let originalModel: ReturnType<typeof monaco.editor.createModel> | null =
      null;
    let modifiedModel: ReturnType<typeof monaco.editor.createModel> | null =
      null;
    let disposed = false;

    const fetchDiff =
      source.kind === "working"
        ? gitFileDiff(root, source.filePath, source.staged)
        : gitCommitFileDiff(root, source.hash, source.filePath);

    fetchDiff
      .then((diff) => {
        if (disposed) return;
        if (diff.isBinary) {
          setMessage("Binary file — diff not shown");
          return;
        }
        setMessage(null);
        const language = languageForPath(filePath);
        originalModel = monaco.editor.createModel(diff.original, language);
        modifiedModel = monaco.editor.createModel(diff.modified, language);

        const diffEditor = monaco.editor.createDiffEditor(container, {
          theme: "sable-dark",
          readOnly: true,
          originalEditable: false,
          renderSideBySide: sideBySide,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily:
            '"JetBrains Mono", "SF Mono", "Cascadia Code", monospace',
          fontSize: 13,
          lineHeight: 1.6,
          scrollBeyondLastLine: false,
        });
        diffEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        });
        diffEditorRef.current = diffEditor;
      })
      .catch((error) => {
        if (!disposed) setMessage(String(error));
      });

    return () => {
      disposed = true;
      diffEditorRef.current?.dispose();
      diffEditorRef.current = null;
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
    // Re-fetch only when the target changes; the toggle is handled below.
    // (EditorArea also keys this component by the diff's tab id.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filePath,
    source.kind,
    source.kind === "working" ? source.staged : source.hash,
  ]);

  // Apply the side-by-side / inline toggle without re-fetching.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button
          className="diff-toggle"
          title={sideBySide ? "Inline view" : "Side-by-side view"}
          onClick={() => setSideBySide((value) => !value)}
        >
          {sideBySide ? (
            <Rows2 size={14} strokeWidth={1.5} />
          ) : (
            <Columns2 size={14} strokeWidth={1.5} />
          )}
        </button>
      </div>
      <div className="diff-body">
        {/* Always mounted so the effect has a container to attach to. */}
        <div ref={containerRef} className="diff-surface" />
        {message && <div className="diff-message">{message}</div>}
      </div>
    </div>
  );
}
