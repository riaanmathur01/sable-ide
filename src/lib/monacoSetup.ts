/**
 * Monaco bootstrap. Two jobs:
 *
 * 1. Bundle Monaco locally. @monaco-editor/react loads from a CDN by
 *    default — Sable makes no network calls, so we hand the loader our
 *    own bundled copy instead. Vite splits each `?worker` import into
 *    its own chunk, fetched only when a file of that language first
 *    opens, so workers stay lazy.
 *
 * 2. Register every color theme from themes.ts with Monaco.
 *
 * This module is imported only by the lazy-loaded editor pane, so none
 * of Monaco's weight touches the app's cold start.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import {
  markSavedByUri,
  pathFromUri,
  revealPosition,
  setMonacoInstance,
} from "./editorRegistry";
import { registerLspProviders } from "./lsp/monacoLsp";
import { useTabsStore } from "../store/tabsStore";
import { useProblemsStore, type Problem } from "../store/problemsStore";
import type { Settings } from "../store/settingsStore";
import { THEMES, cachedThemeId, semanticRules } from "./themes";
import { installShikiHighlighting } from "./shikiMonaco";
import { onServerConnection } from "./lsp/lspClient";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { registerFormatting } from "./formatting";
import { registerTestCodeLenses } from "./testing/codeLens";
import { registerConflictSupport } from "./git/conflictEditor";
import { registerPythonRefactorings } from "./refactor";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
setMonacoInstance(monaco);

// Every model starts clean: record its pristine version id the moment
// it's created so dirty tracking has a baseline.
monaco.editor.onDidCreateModel((model) => {
  markSavedByUri(model.uri.toString(), model.getAlternativeVersionId());
});

// Wire LSP-backed language features (completions, hover, definitions,
// signature help) onto Monaco.
registerLspProviders(monaco);
registerFormatting(monaco);
registerTestCodeLenses(monaco);
registerConflictSupport(monaco);
registerPythonRefactorings(monaco);

// Cross-file navigation (go to definition, peek → open): Monaco asks us
// to open the target; route it through the tab store so it becomes a
// normal tab, then move the cursor there.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (resource.scheme !== "file") return false;
    const path = pathFromUri(resource);
    const line =
      selectionOrPosition == null
        ? 1
        : "startLineNumber" in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : selectionOrPosition.lineNumber;
    void useTabsStore
      .getState()
      .openFile(path)
      .then(() => revealPosition(path, line));
    return true;
  },
});

/** Map user settings onto Monaco editor options. */
export function editorOptionsFromSettings(
  settings: Settings,
): monaco.editor.IStandaloneEditorConstructionOptions {
  const autoClose = settings["editor.autoClosingBrackets"]
    ? "languageDefined"
    : "never";
  const rulers = settings["editor.rulers"]
    .split(",")
    .map((column) => Number(column.trim()))
    .filter((column) => Number.isInteger(column) && column > 0);
  return {
    fontFamily: settings["editor.fontFamily"],
    fontSize: settings["editor.fontSize"],
    fontWeight: settings["editor.fontWeight"],
    // Values below 8 are a multiple of the font size.
    lineHeight: settings["editor.lineHeight"],
    fontLigatures: settings["editor.fontLigatures"],
    tabSize: settings["editor.tabSize"],
    insertSpaces: settings["editor.insertSpaces"],
    detectIndentation: settings["editor.detectIndentation"],
    wordWrap: settings["editor.wordWrap"],
    inlayHints: { enabled: settings["editor.inlayHints"] ? "onUnlessPressed" : "off" },
    minimap: {
      enabled: settings["editor.minimap"],
      // Real characters at twice the default size, capped so long lines
      // don't widen it.
      renderCharacters: true,
      scale: 2,
      maxColumn: 80,
      // The visible-area slider is always shown (colors in shikiMonaco).
      showSlider: "always",
      // `// MARK: Section` comments label the minimap.
      showMarkSectionHeaders: true,
      showRegionSectionHeaders: true,
    },
    lineNumbers: settings["editor.lineNumbers"],
    rulers,
    renderWhitespace: settings["editor.renderWhitespace"],
    cursorStyle: settings["editor.cursorStyle"],
    cursorBlinking: settings["editor.cursorBlinking"],
    cursorSmoothCaretAnimation: settings["editor.smoothCaret"] ? "on" : "off",
    bracketPairColorization: {
      enabled: settings["editor.bracketPairColorization"],
    },
    guides: {
      indentation: true,
      highlightActiveIndentation: true,
      bracketPairs: settings["editor.bracketPairGuides"] ? "active" : false,
    },
    stickyScroll: { enabled: settings["editor.stickyScroll"] },
    smoothScrolling: settings["editor.smoothScrolling"],
    autoClosingBrackets: autoClose,
    autoClosingQuotes: autoClose,
    linkedEditing: settings["editor.linkedEditing"],
    mouseWheelZoom: settings["editor.mouseWheelZoom"],
    formatOnPaste: settings["editor.formatOnPaste"],
    // Fixed choices that make the editor comfortable regardless of
    // settings.
    glyphMargin: true, // breakpoint dots live here
    padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    automaticLayout: true,
    showFoldingControls: "mouseover",
    matchBrackets: "always",
    suggest: { preview: true, showStatusBar: true },
    inlineSuggest: { enabled: true },
    parameterHints: { enabled: true },
    quickSuggestions: { other: true, comments: false, strings: false },
    occurrencesHighlight: "singleFile",
    // Quick fixes: a lightbulb on lines with available fixes (⌘. opens
    // the menu anywhere); hover a squiggle for the message + "Quick Fix…".
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
    hover: { delay: 300, sticky: true },
    renderValidationDecorations: "on",
    // Colors from the language server's understanding of the code
    // (parameters, self, builtins, …) on top of the grammar's.
    "semanticHighlighting.enabled": settings["editor.semanticHighlighting"],
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  };
}

// TypeScript/JavaScript: Monaco's built-in TS service only sees open
// files, not node_modules or the project's tsconfig. Configure it like a
// typical modern project and silence the errors that only mean "I can't
// see the rest of your project" — otherwise every import is a red
// squiggle. Real type errors still show.
const PROJECT_CONTEXT_DIAGNOSTICS = [
  2307, // Cannot find module '…'
  2792, // Cannot find module '…'. Did you mean to set moduleResolution?
  7016, // Could not find a declaration file for module '…'
  2875, // JSX tag requires the module path 'react/jsx-runtime'
  2580, 2591, 2592, // Cannot find name 'require'/'process'/… (needs @types/node)
  2582, 2593, // Cannot find name 'describe'/'it'/… (needs test-runner types)
  2503, // Cannot find namespace 'JSX'
];
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setCompilerOptions({
    ...defaults.getCompilerOptions(),
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
  });
  defaults.setDiagnosticsOptions({
    ...defaults.getDiagnosticsOptions(),
    diagnosticCodesToIgnore: PROJECT_CONTEXT_DIAGNOSTICS,
  });
}

// When typescript-language-server is running it understands the whole
// project (tsconfig, node_modules), so its diagnostics, completions,
// hover, definitions, signature help and fixes replace the built-in
// service's (which only sees open files) — otherwise you'd get two of
// everything; so do rename, references, document symbols and highlights
// (project-wide instead of open files). Formatting stays built-in. If the server stops (or isn't installed), the built-in
// service comes back.
function useBuiltinTypeScript(enabled: boolean) {
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      completionItems: enabled,
      hovers: enabled,
      definitions: enabled,
      diagnostics: enabled,
      signatureHelp: enabled,
      codeActions: enabled,
      inlayHints: enabled,
      // The server renames across the whole project.
      rename: enabled,
      // …and finds usages, outlines and highlights from the whole project.
      references: enabled,
      documentSymbols: enabled,
      documentHighlights: enabled,
    });
  }
}
onServerConnection((serverId, connected) => {
  if (serverId === "typescript") useBuiltinTypeScript(!connected);
});

// Mirror every squiggle into the Problems panel: Monaco markers cover
// LSP diagnostics *and* Monaco's own language services (TS, JSON, CSS).
const MARKER_SEVERITY: Record<number, Problem["severity"] | undefined> = {
  [monaco.MarkerSeverity.Error]: "error",
  [monaco.MarkerSeverity.Warning]: "warning",
  [monaco.MarkerSeverity.Info]: "info",
};
monaco.editor.onDidChangeMarkers((uris) => {
  const { setMarkers } = useProblemsStore.getState();
  for (const uri of uris) {
    if (uri.scheme !== "file") continue;
    const path = pathFromUri(uri);
    const model = monaco.editor.getModel(uri);
    if (!model || model.isDisposed()) {
      setMarkers(path, null);
      continue;
    }
    const problems: Problem[] = [];
    for (const marker of monaco.editor.getModelMarkers({ resource: uri })) {
      const severity = MARKER_SEVERITY[marker.severity];
      if (!severity) continue; // hints render faded; not "problems"
      problems.push({
        path,
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity,
        message: marker.message,
        source: marker.source,
        code: typeof marker.code === "string" ? marker.code : marker.code?.value,
      });
    }
    setMarkers(path, problems);
  }
});
// A closed file's live markers no longer apply; fall back to the LSP's.
monaco.editor.onWillDisposeModel((model) => {
  if (model.uri.scheme === "file") {
    useProblemsStore.getState().setMarkers(pathFromUri(model.uri), null);
  }
});

// Every color theme (src/lib/themes.ts) as a Monaco theme, keyed by id.
for (const theme of Object.values(THEMES)) {
  monaco.editor.defineTheme(theme.id, {
    ...theme.editor,
    rules: [...theme.editor.rules, ...semanticRules(theme)],
  });
}

// Monaco measures character widths when an editor is created; if the
// bundled font finishes loading after that, the cursor and selections
// drift from the text. Re-measure once the font (both styles) is ready,
// and whenever another web font finishes loading.
void Promise.all([
  document.fonts.load('400 13px "JetBrains Mono"'),
  document.fonts.load('italic 400 13px "JetBrains Mono"'),
]).then(() => monaco.editor.remeasureFonts());
document.fonts.addEventListener("loadingdone", () => monaco.editor.remeasureFonts());

// Precise syntax colors from VS Code's TextMate grammars (the Monarch
// theme rules above cover the moment before they load, and languages
// without a grammar).
installShikiHighlighting(monaco, cachedThemeId());

export { monaco };
