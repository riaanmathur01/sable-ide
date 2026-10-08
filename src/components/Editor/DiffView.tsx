import { useEffect, useRef, useState } from "react";
import { Columns2, Minus, Plus, Rows2 } from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { gitCommitFileDiff, gitFileDiff } from "../../lib/ipc";
import { useWorkspaceStore } from "../../store/workspaceStore";
import type { DiffSource } from "../../store/tabsStore";
import { monaco } from "../../lib/monacoSetup";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { cachedThemeId } from "../../lib/themes";
import { stageHunk, unstageHunk, type LineChange } from "../../lib/git/hunks";
import { useGitStore } from "../../store/gitStore";
import "./DiffView.css";

type DiffEditor = MonacoTypes.editor.IStandaloneDiffEditor;

/**
 * "Stage hunk" / "Unstage hunk" above each change of a working-tree diff.
 * One CodeLens provider for every open diff, keyed by its modified model.
 */
interface HunkTarget {
  editor: DiffEditor;
  staged: boolean;
  apply: (change: LineChange) => void;
}
const hunkTargets = new Map<string, HunkTarget>();
let hunkLensesChanged: MonacoTypes.Emitter<MonacoTypes.languages.CodeLensProvider> | null = null;
let hunkProvider: MonacoTypes.languages.CodeLensProvider | null = null;
let diffModelCount = 0;

function registerHunkLenses() {
  if (hunkProvider) return;
  hunkLensesChanged = new monaco.Emitter();
  monaco.editor.registerCommand("sable.diff.hunk", (_accessor, uri: string, index: number) => {
    const target = hunkTargets.get(uri);
    const change = target?.editor.getLineChanges()?.[index];
    if (target && change) target.apply(change);
  });
  hunkProvider = {
    onDidChange: hunkLensesChanged.event,
    provideCodeLenses: (model) => {
      const uri = model.uri.toString();
      const target = hunkTargets.get(uri);
      const changes = target?.editor.getLineChanges() ?? [];
      const lenses = changes.map((change, index) => {
        // A deletion has no modified lines: label the line after it.
        const line = Math.max(1, change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber);
        const lineNumber = Math.min(line, model.getLineCount());
        return {
          range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
          command: {
            id: "sable.diff.hunk",
            title: target!.staged ? "Unstage hunk" : "Stage hunk",
            tooltip: target!.staged ? "Take this change out of the next commit" : "Put just this change in the next commit",
            arguments: [uri, index],
          },
        };
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("*", hunkProvider);
}

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
  /** Bumped after staging a hunk: re-read both sides. */
  const [reloadToken, setReloadToken] = useState(0);
  /** Kept across reloads so staging a hunk doesn't jump to the top. */
  const scrollTop = useRef(0);
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
        if (source.kind === "working" && diff.original === diff.modified) {
          setMessage(source.staged ? "Nothing staged in this file" : "No unstaged changes left in this file");
          return;
        }
        setMessage(null);
        const language = languageForPath(filePath);
        const id = ++diffModelCount;
        originalModel = monaco.editor.createModel(
          diff.original,
          language,
          monaco.Uri.from({ scheme: "sable-diff", path: `/${id}/original` }),
        );
        modifiedModel = monaco.editor.createModel(
          diff.modified,
          language,
          monaco.Uri.from({ scheme: "sable-diff", path: `/${id}/modified` }),
        );

        const diffEditor = monaco.editor.createDiffEditor(container, {
          theme: useSettingsStore.getState().loaded
            ? getSetting("workbench.colorTheme")
            : cachedThemeId(),
          readOnly: true,
          originalEditable: false,
          // Monaco hides CodeLens in diff editors by default; the
          // "Stage hunk" / "Unstage hunk" actions are CodeLens.
          diffCodeLens: source.kind === "working",
          renderSideBySide: sideBySide,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: getSetting("editor.fontFamily"),
          fontSize: getSetting("editor.fontSize"),
          fontWeight: getSetting("editor.fontWeight"),
          lineHeight: getSetting("editor.lineHeight"),
          fontLigatures: getSetting("editor.fontLigatures"),
          scrollBeyondLastLine: false,
        });
        diffEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        });
        diffEditorRef.current = diffEditor;
        const modifiedEditor = diffEditor.getModifiedEditor();
        modifiedEditor.setScrollTop(scrollTop.current);
        modifiedEditor.onDidScrollChange((event) => {
          scrollTop.current = event.scrollTop;
        });

        if (source.kind === "working") {
          registerHunkLenses();
          const original = originalModel;
          const modified = modifiedModel;
          const staged = source.staged;
          hunkTargets.set(modified.uri.toString(), {
            editor: diffEditor,
            staged,
            apply: (change) => {
              const changes = diffEditor.getLineChanges() ?? [];
              const lines = staged
                ? unstageHunk(original.getLinesContent(), modified.getLinesContent(), changes, change)
                : stageHunk(original.getLinesContent(), modified.getLinesContent(), change);
              // The staged text keeps the staged side's line endings.
              const eol = staged ? modified.getEOL() : original.getEOL();
              void useGitStore
                .getState()
                .stageContent(source.filePath, lines.join(eol))
                .then((ok) => ok && setReloadToken((token) => token + 1));
            },
          });
          diffEditor.onDidUpdateDiff(() => hunkLensesChanged?.fire(hunkProvider!));
        }
      })
      .catch((error) => {
        if (!disposed) setMessage(String(error));
      });

    return () => {
      disposed = true;
      if (modifiedModel) hunkTargets.delete(modifiedModel.uri.toString());
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
    reloadToken,
  ]);

  // Apply the side-by-side / inline toggle without re-fetching.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        {source.kind === "working" && (
          <button
            className="diff-toggle diff-stage-file"
            title={source.staged ? "Unstage the whole file" : "Stage the whole file"}
            onClick={() => {
              const git = useGitStore.getState();
              void (source.staged ? git.unstage(source.filePath) : git.stage(source.filePath)).then(() =>
                setReloadToken((token) => token + 1),
              );
            }}
          >
            {source.staged ? <Minus size={14} strokeWidth={1.5} /> : <Plus size={14} strokeWidth={1.5} />}
            <span>{source.staged ? "Unstage file" : "Stage file"}</span>
          </button>
        )}
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
