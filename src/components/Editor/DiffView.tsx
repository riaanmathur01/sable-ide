import { useEffect, useRef, useState } from "react";
import { Check, Columns2, Minus, Plus, Rows2, Undo2 } from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { gitCommitFileDiff, gitFileDiff, readFile } from "../../lib/ipc";
import { getModelValue } from "../../lib/editorRegistry";
import { folderOf, useWorkspaceStore } from "../../store/workspaceStore";
import type { DiffSource } from "../../store/tabsStore";
import { monaco } from "../../lib/monacoSetup";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { cachedThemeId, themeById } from "../../lib/themes";
import { applyLineChanges, sameChange, stageHunk, unstageHunk, type LineChange } from "../../lib/git/hunks";
import { useAcpStore } from "../../store/acpStore";
import { writeFileContents } from "../../lib/fileContents";
import { useGitStore } from "../../store/gitStore";
import { attachPrReview, loadPrSides, PrDiffToolbar } from "../GitHub/prReview";
import { ProposalToolbar, loadProposalSides } from "../ClaudeCode/ProposalToolbar";
import "./DiffView.css";

type DiffEditor = MonacoTypes.editor.IStandaloneDiffEditor;

/**
 * "Stage hunk" / "Unstage hunk" above each change of a working-tree diff.
 * One CodeLens provider for every open diff, keyed by its modified model.
 */
interface HunkTarget {
  editor: DiffEditor;
  /** The lenses above each change (Stage hunk; Accept / Reject). */
  lenses: { action: string; title: string; tooltip: string }[];
  apply: (change: LineChange, action: string) => void;
}
const hunkTargets = new Map<string, HunkTarget>();
let hunkLensesChanged: MonacoTypes.Emitter<MonacoTypes.languages.CodeLensProvider> | null = null;
let hunkProvider: MonacoTypes.languages.CodeLensProvider | null = null;
let diffModelCount = 0;

function registerHunkLenses() {
  if (hunkProvider) return;
  hunkLensesChanged = new monaco.Emitter();
  monaco.editor.registerCommand("sable.diff.hunk", (_accessor, uri: string, index: number, action: string) => {
    const target = hunkTargets.get(uri);
    const change = target?.editor.getLineChanges()?.[index];
    if (target && change) target.apply(change, action);
  });
  hunkProvider = {
    onDidChange: hunkLensesChanged.event,
    provideCodeLenses: (model) => {
      const uri = model.uri.toString();
      const target = hunkTargets.get(uri);
      const changes = target?.editor.getLineChanges() ?? [];
      const lenses = changes.flatMap((change, index) => {
        // A deletion has no modified lines: label the line after it.
        const line = Math.max(1, change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber);
        const lineNumber = Math.min(line, model.getLineCount());
        return target!.lenses.map((lens) => ({
          range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
          command: { id: "sable.diff.hunk", title: lens.title, tooltip: lens.tooltip, arguments: [uri, index, lens.action] },
        }));
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("*", hunkProvider);
}

interface DiffViewProps {
  source: DiffSource;
}

/** A file as the editor has it (unsaved edits included), else on disk. */
async function currentText(path: string): Promise<string> {
  return getModelValue(path) ?? (await readFile(path));
}

/** The two sides of a diff. */
async function loadSides(root: string, source: DiffSource): Promise<{ original: string; modified: string; isBinary: boolean }> {
  switch (source.kind) {
    case "working":
      return gitFileDiff(root, source.filePath, source.staged);
    case "commit":
      return gitCommitFileDiff(root, source.hash, source.filePath);
    case "files":
      return { original: await currentText(source.filePath), modified: await currentText(source.other), isBinary: false };
    case "saved":
      return { original: await readFile(source.filePath), modified: await currentText(source.filePath), isBinary: false };
    case "clipboard":
      return { original: await currentText(source.filePath), modified: source.text, isBinary: false };
    case "pr":
      return loadPrSides(source);
    case "agent": {
      const entry = agentReview(source.threadId, source.filePath);
      return { original: entry?.original ?? "", modified: (await currentText(source.filePath).catch(() => "")) ?? "", isBinary: false };
    }
    case "claude":
      return loadProposalSides(source, currentText);
  }
}

/** Pick a Monaco language id from a file's extension. */
/**
 * Monaco bug workaround: every standalone code editor's constructor points
 * two globals — the hover delegate factory (used by every action bar,
 * e.g. the editor's context menu) and the markdown code-block renderer —
 * at the instantiation service it was created with. A diff editor's two
 * inner editors get the diff editor's *child* service, which is disposed
 * with it, so afterwards the context menu throws "InstantiationService
 * has been disposed" and no longer opens. Creating (and at once
 * disposing) an editor through the public API re-points both globals at
 * Monaco's root service, which is never disposed. No model: it renders
 * nothing and listeners that look at the model skip it.
 */
function reanchorEditorServices() {
  try {
    monaco.editor.create(document.createElement("div"), { model: null, automaticLayout: false }).dispose();
  } catch {
    // Best effort: worst case, the old behavior.
  }
}

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
  // Re-fetch when what's compared changes.
  const sourceKey = JSON.stringify(source);
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
  /** The right side's text now (a Claude Code proposal is editable). */
  const modifiedText = useRef<() => string | null>(() => null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The repository of the folder the file is in (multi-root workspaces).
    const root = folderOf(filePath) ?? useWorkspaceStore.getState().rootPath;
    if (!root) return;

    let originalModel: ReturnType<typeof monaco.editor.createModel> | null =
      null;
    let modifiedModel: ReturnType<typeof monaco.editor.createModel> | null =
      null;
    let disposed = false;
    /** Review threads and commenting on a pull request's file. */
    let detachReview: (() => void) | null = null;

    const fetchDiff = loadSides(root, source);

    fetchDiff
      .then((diff) => {
        if (disposed) return;
        if (diff.isBinary) {
          setMessage("Binary file — diff not shown");
          return;
        }
        if (source.kind === "agent" && (!agentReview(source.threadId, source.filePath) || diff.original === diff.modified)) {
          setMessage("No agent changes waiting in this file");
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
            ? themeById(getSetting("workbench.colorTheme")).id
            : cachedThemeId(),
          // A proposed change can be touched up before accepting it.
          readOnly: source.kind !== "claude",
          originalEditable: false,
          // Monaco hides CodeLens in diff editors by default; the
          // "Stage hunk" / "Unstage hunk" actions are CodeLens.
          diffCodeLens: source.kind === "working" || source.kind === "agent",
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
        const modified = modifiedModel;
        modifiedText.current = () => (modified.isDisposed() ? null : modified.getValue());
        const modifiedEditor = diffEditor.getModifiedEditor();
        modifiedEditor.setScrollTop(scrollTop.current);
        modifiedEditor.onDidScrollChange((event) => {
          scrollTop.current = event.scrollTop;
        });

        if (source.kind === "pr") detachReview = attachPrReview(diffEditor, source);

        if (source.kind === "agent") {
          registerHunkLenses();
          const original = originalModel;
          const modified = modifiedModel;
          hunkTargets.set(modified.uri.toString(), {
            editor: diffEditor,
            lenses: [
              { action: "accept", title: "✓ Accept", tooltip: "Keep this change" },
              { action: "reject", title: "↺ Reject", tooltip: "Undo this change in the file" },
            ],
            apply: (change, action) => {
              const all = diffEditor.getLineChanges() ?? [];
              const before = original.getLinesContent();
              const after = modified.getLinesContent();
              if (action === "accept") {
                // The change joins the baseline: it's no longer "the agent's".
                const baseline = applyLineChanges(before, after, [change]).join(original.getEOL()) + (original.getValue().endsWith("\n") || modified.getValue().endsWith("\n") ? original.getEOL() : "");
                if (all.length <= 1 || baseline === modified.getValue()) useAcpStore.getState().acceptFile(source.threadId, source.filePath);
                else setAgentReviewOriginal(source.threadId, source.filePath, baseline);
                setReloadToken((token) => token + 1);
              } else {
                const kept = applyLineChanges(before, after, all.filter((other) => !sameChange(other, change)));
                const text = kept.join(modified.getEOL()) + (modified.getValue().endsWith("\n") ? modified.getEOL() : "");
                void writeFileContents(source.filePath, text).then(() => setReloadToken((token) => token + 1));
              }
            },
          });
          diffEditor.onDidUpdateDiff(() => hunkLensesChanged?.fire(hunkProvider!));
        }

        if (source.kind === "working") {
          registerHunkLenses();
          const original = originalModel;
          const modified = modifiedModel;
          const staged = source.staged;
          hunkTargets.set(modified.uri.toString(), {
            editor: diffEditor,
            lenses: [
              staged
                ? { action: "unstage", title: "Unstage hunk", tooltip: "Take this change out of the next commit" }
                : { action: "stage", title: "Stage hunk", tooltip: "Put just this change in the next commit" },
            ],
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
      detachReview?.();
      const hadEditor = diffEditorRef.current !== null;
      diffEditorRef.current?.dispose();
      diffEditorRef.current = null;
      if (hadEditor) reanchorEditorServices();
      // A diff still being computed in the worker fails ("no diff result
      // available") if its models go first — e.g. a Claude Code proposal
      // closed right after it opened. Let it finish.
      const models = [originalModel, modifiedModel];
      setTimeout(() => models.forEach((model) => model?.dispose()), 1000);
    };
    // Re-fetch only when the target changes; the toggle is handled below.
    // (EditorArea also keys this component by the diff's tab id.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sourceKey, reloadToken]);

  // Apply the side-by-side / inline toggle without re-fetching.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        {source.kind === "pr" && <PrDiffToolbar source={source} />}
        {source.kind === "agent" && <AgentDiffToolbar threadId={source.threadId} path={source.filePath} onChange={() => setReloadToken((token) => token + 1)} />}
        {source.kind === "claude" && <ProposalToolbar source={source} modifiedText={() => modifiedText.current()} />}
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

function agentReview(threadId: string, path: string) {
  return useAcpStore.getState().threads[threadId]?.review[path];
}

/** Accepting one change: the file's baseline moves forward. */
function setAgentReviewOriginal(threadId: string, path: string, original: string) {
  useAcpStore.setState((state) => {
    const thread = state.threads[threadId];
    const entry = thread?.review[path];
    if (!thread || !entry) return {};
    return { threads: { ...state.threads, [threadId]: { ...thread, review: { ...thread.review, [path]: { ...entry, original } } } } };
  });
}

/** Accept / reject the whole file, for an agent's changes. */
function AgentDiffToolbar({ threadId, path, onChange }: { threadId: string; path: string; onChange: () => void }) {
  const pending = useAcpStore((state) => Boolean(state.threads[threadId]?.review[path]));
  const touched = useAcpStore((state) => state.threads[threadId]?.review[path]?.touchedAt);
  useEffect(() => {
    onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched]);
  if (!pending) return null;
  return (
    <>
      <button className="diff-toggle diff-stage-file" title="Undo all of the agent's changes to this file" onClick={() => void useAcpStore.getState().rejectFile(threadId, path).then(onChange)}>
        <Undo2 size={14} strokeWidth={1.5} />
        <span>Reject file</span>
      </button>
      <button className="diff-toggle diff-stage-file" title="Keep all of the agent's changes to this file" onClick={() => {
        useAcpStore.getState().acceptFile(threadId, path);
        onChange();
      }}>
        <Check size={14} strokeWidth={1.5} />
        <span>Accept file</span>
      </button>
    </>
  );
}
