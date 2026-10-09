import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useBreakpointsStore, type BreakpointOptions } from "../../store/breakpointsStore";
import { useCoverageStore } from "../../store/coverageStore";
import { useDebugStore } from "../../store/debugStore";
import { useColorTheme, useSettingsStore } from "../../store/settingsStore";
import {
  modelUriFor,
  registerEditor,
  unregisterEditor,
} from "../../lib/editorRegistry";
import { changeDocument } from "../../lib/lsp/lspClient";
import { fetchBlame } from "../../lib/blame";
import { BlameGutter } from "./BlameGutter";
import { editorOptionsFromSettings, monaco } from "../../lib/monacoSetup";
import type * as MonacoTypes from "monaco-editor";
import type { BlameLine } from "../../lib/ipc";
import { installKeyRepeatAcceleration } from "../../lib/keyRepeatAcceleration";
import { installRecentTracking } from "../../lib/recentTracking";
import "./MonacoPane.css";

const NO_BREAKPOINTS: number[] = [];
const NO_OPTIONS: Record<number, BreakpointOptions> = {};

/** A breakpoint's hover text. */
function describeBreakpoint(options: BreakpointOptions | undefined): string {
  if (!options) return "Breakpoint — right-click for a condition, hit count or log message";
  const parts = [
    options.logMessage && `Logpoint: \`${options.logMessage}\``,
    options.condition && `When \`${options.condition}\``,
    options.hitCondition && `Hit count ${options.hitCondition}`,
  ].filter(Boolean);
  return parts.join(" · ") + " — right-click to edit";
}

/** Report the active model's language + indentation to the status bar. */
function publishEditorInfo(editor: MonacoTypes.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  if (!model) {
    useUiStore.getState().setEditorInfo(null);
    return;
  }
  const options = model.getOptions();
  useUiStore.getState().setEditorInfo({
    language: model.getLanguageId(),
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  });
}

/**
 * The Monaco surface. One editor instance for all tabs: the `path` prop
 * keys a model per file, and @monaco-editor/react swaps models (and
 * preserves scroll/cursor per tab) when the active path changes.
 * Language is inferred from the file extension via the model URI.
 *
 * This component is lazy-loaded (React.lazy in EditorArea) so Monaco's
 * bundle is only fetched when the first file opens.
 */
export default function MonacoPane({ groupId }: { groupId: string }) {
  // The editor follows its group's last active *file* tab; diff and
  // settings tabs render elsewhere, so the pane keeps its model meanwhile.
  const activePath = useTabsStore(
    (state) => state.groups.find((group) => group.id === groupId)?.lastFilePath ?? null,
  );
  const isFocusedGroup = useTabsStore((state) => state.activeGroupId === groupId);
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const initialContentByPath = useTabsStore(
    (state) => state.initialContentByPath,
  );
  const syncDirtyState = useTabsStore((state) => state.syncDirtyState);
  const scheduleAutoSave = useTabsStore((state) => state.scheduleAutoSave);
  const setCursorPosition = useUiStore((state) => state.setCursorPosition);
  const blameEnabled = useUiStore((state) => state.blameEnabled);
  const settings = useSettingsStore((state) => state.values);
  const colorTheme = useColorTheme();
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [editorReady, setEditorReady] = useState(false);

  const options = useMemo(() => editorOptionsFromSettings(settings), [settings]);

  // Breakpoints for this file, and the line where the debugger is paused
  // (only when it's paused in *this* file).
  const breakpointLines = useBreakpointsStore(
    (state) =>
      (activePath && state.breakpointsByFile[activePath]) || NO_BREAKPOINTS,
  );
  const breakpointOptions = useBreakpointsStore(
    (state) => (activePath && state.optionsByFile[activePath]) || NO_OPTIONS,
  );
  const stoppedLine = useDebugStore((state) =>
    state.stoppedFile === activePath ? state.stoppedLine : null,
  );

  // Breakpoint glyphs, as decorations. Monaco moves decorations with the
  // text, so after every edit the breakpoints' new lines are read back
  // into the store — a breakpoint stays on its statement when lines are
  // added or removed above it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor || !activePath) return;
    const collection = editor.createDecorationsCollection(
      breakpointLines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: breakpointOptions[line]?.logMessage
            ? "debug-breakpoint logpoint"
            : breakpointOptions[line]
              ? "debug-breakpoint conditional"
              : "debug-breakpoint",
          glyphMarginHoverMessage: { value: describeBreakpoint(breakpointOptions[line]) },
          minimap: { color: { id: "editorError.foreground" }, position: monaco.editor.MinimapPosition.Gutter },
          overviewRuler: { color: { id: "editorError.foreground" }, position: monaco.editor.OverviewRulerLane.Left },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    const tracking = editor.onDidChangeModelContent(() => {
      const lines = collection.getRanges().map((range) => range.startLineNumber);
      useBreakpointsStore.getState().setLines(activePath, lines);
    });
    return () => {
      tracking.dispose();
      collection.clear();
    };
  }, [breakpointLines, breakpointOptions, activePath, editorReady]);

  // Test coverage: a bar beside each line that ran (green), partly ran
  // (amber) or didn't (red).
  const coverage = useCoverageStore((state) => (activePath && state.visible ? state.byFile[activePath] : undefined));
  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor || !coverage) return;
    const bar = (lines: number[], className: string, ruler?: string) =>
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: className,
          ...(ruler && {
            overviewRuler: { color: ruler, position: monaco.editor.OverviewRulerLane.Left },
          }),
        },
      }));
    const collection = editor.createDecorationsCollection([
      ...bar(coverage.covered, "coverage-covered"),
      ...bar(coverage.partial, "coverage-partial", "#d6a55c99"),
      ...bar(coverage.uncovered, "coverage-uncovered", "#f8717199"),
    ]);
    return () => collection.clear();
  }, [coverage, activePath, editorReady]);

  // The line where the debugger is paused.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor || stoppedLine == null) return;
    const collection = editor.createDecorationsCollection([
      {
        range: new monaco.Range(stoppedLine, 1, stoppedLine, 1),
        options: {
          isWholeLine: true,
          className: "debug-stopped-line",
          glyphMarginClassName: "debug-stopped-arrow",
          minimap: { color: { id: "editorWarning.foreground" }, position: monaco.editor.MinimapPosition.Inline },
          overviewRuler: { color: { id: "editorWarning.foreground" }, position: monaco.editor.OverviewRulerLane.Full },
        },
      },
    ]);
    editor.revealLineInCenterIfOutsideViewport(stoppedLine);
    return () => collection.clear();
  }, [stoppedLine, activePath, editorReady]);

  // Status bar info follows the focused group's model.
  useEffect(() => {
    const editor = editorRef.current;
    if (editorReady && editor && isFocusedGroup) publishEditorInfo(editor);
  }, [activePath, editorReady, isFocusedGroup]);

  // Unregister this group's editor when the group closes.
  useEffect(
    () => () => {
      if (editorRef.current) unregisterEditor(groupId, editorRef.current);
    },
    [groupId],
  );

  // Fetch git blame for the active file when blame is on.
  useEffect(() => {
    if (!blameEnabled || !activePath) {
      setBlameLines([]);
      return;
    }
    let cancelled = false;
    void fetchBlame(activePath).then((lines) => {
      if (!cancelled) setBlameLines(lines);
    });
    return () => {
      cancelled = true;
    };
  }, [blameEnabled, activePath]);

  if (!activePath) return null;

  const showBlame = blameEnabled && blameLines.length > 0;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerEditor(editor, monaco, groupId);
    setEditorReady(true);
    // Clicking/typing in this editor makes its group the focused one
    // (Run, ⌘S, the status bar, … then act on it).
    editor.onDidFocusEditorText(() => {
      useTabsStore.getState().focusGroup(groupId);
      publishEditorInfo(editor);
    });

    // Click the gutter (glyph margin OR line-number area) to toggle a
    // breakpoint on that line — the glyph margin alone is easy to miss.
    editor.onMouseDown((event) => {
      const targetType = event.target.type;
      const inGutter =
        targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        targetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
      // Left button only: right-click opens the breakpoint editor.
      if (inGutter && event.target.position && event.event.leftButton) {
        const path =
          useTabsStore.getState().groups.find((group) => group.id === groupId)
            ?.lastFilePath ?? null;
        if (path) {
          useBreakpointsStore
            .getState()
            .toggle(path, event.target.position.lineNumber);
        }
      }
    });

    // Right-click the gutter: edit that line's breakpoint (condition, hit
    // count, log message). Caught before Monaco's own context menu.
    editor.getDomNode()?.addEventListener(
      "contextmenu",
      (event) => {
        if (!(event.target instanceof Element) || !event.target.closest(".margin")) return;
        const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
        const path = useTabsStore.getState().groups.find((group) => group.id === groupId)?.lastFilePath ?? null;
        if (!target?.position || !path) return;
        event.preventDefault();
        event.stopPropagation();
        useBreakpointsStore.getState().edit(path, target.position.lineNumber, event.clientX, event.clientY);
      },
      true,
    );

    // Held cursor keys (Backspace, Delete, arrows) speed up the longer
    // they're held.
    editor.onDidDispose(installKeyRepeatAcceleration(editor));
    // Recent Files (⌘E) and Recent Locations (⇧⌘E).
    editor.onDidDispose(installRecentTracking(editor));

    // ⌥Z toggles word wrap (persisted as a setting), like VS Code.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
      const { values, set } = useSettingsStore.getState();
      set("editor.wordWrap", values["editor.wordWrap"] === "on" ? "off" : "on");
    });

    // Status bar (cursor, language, indentation) reflects the focused group.
    const focused = () => useTabsStore.getState().activeGroupId === groupId;
    editor.onDidChangeCursorPosition((event) => {
      if (!focused()) return;
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    const publishIfFocused = () => {
      if (focused()) publishEditorInfo(editor);
    };
    editor.onDidChangeModel(publishIfFocused);
    editor.onDidChangeModelLanguage(publishIfFocused);
    editor.onDidChangeModelOptions(publishIfFocused);
    publishIfFocused();
  };

  return (
    <div className="monaco-pane">
      {showBlame && (
        <BlameGutter lines={blameLines} filePath={activePath} editor={editorRef.current} />
      )}
      <div className="monaco-pane-editor">
        <Editor
          theme={colorTheme}
          path={modelUriFor(activePath)}
          defaultValue={initialContentByPath[activePath] ?? ""}
          onMount={handleMount}
          onChange={(value) => {
            syncDirtyState(activePath);
            // Auto-save: content hits the disk shortly after typing stops.
            scheduleAutoSave(activePath);
            // Keep the language server's buffer current so diagnostics and
            // completions reflect what's on screen.
            void changeDocument(activePath, value ?? "");
          }}
          saveViewState
          // Models are shared between split groups and owned by the tabs
          // store (disposed when no group shows the file) — never let an
          // unmounting editor dispose one.
          keepCurrentModel
          options={options}
        />
      </div>
    </div>
  );
}
