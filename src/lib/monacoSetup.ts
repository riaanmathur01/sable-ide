/**
 * Monaco bootstrap. Two jobs:
 *
 * 1. Bundle Monaco locally. @monaco-editor/react loads from a CDN by
 *    default — Sable makes no network calls, so we hand the loader our
 *    own bundled copy instead. Vite splits each `?worker` import into
 *    its own chunk, fetched only when a file of that language first
 *    opens, so workers stay lazy.
 *
 * 2. Define the `sable-dark` theme from the design tokens in theme.css.
 *
 * This module is imported only by the lazy-loaded editor pane, so none
 * of Monaco's weight touches the app's cold start.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { markSavedByUri } from "./editorRegistry";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

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

// Every model starts clean: record its pristine version id the moment
// it's created so dirty tracking has a baseline.
monaco.editor.onDidCreateModel((model) => {
  markSavedByUri(model.uri.toString(), model.getAlternativeVersionId());
});

// Syntax palette: calm and desaturated so the UI accent stays the only
// loud color. Keywords borrow the accent; everything else is muted.
monaco.editor.defineTheme("sable-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5c5c66", fontStyle: "italic" },
    { token: "keyword", foreground: "7c93ff" },
    { token: "string", foreground: "a3be8c" },
    { token: "number", foreground: "d4a373" },
    { token: "regexp", foreground: "d4a373" },
    { token: "type", foreground: "8fb8d4" },
    { token: "class", foreground: "8fb8d4" },
    { token: "interface", foreground: "8fb8d4" },
    { token: "function", foreground: "b0a3e0" },
    { token: "variable", foreground: "e6e6e9" },
    { token: "constant", foreground: "d4a373" },
    { token: "tag", foreground: "7c93ff" },
    { token: "attribute.name", foreground: "8fb8d4" },
    { token: "delimiter", foreground: "8a8a93" },
  ],
  colors: {
    "editor.background": "#0d0d0f",
    "editor.foreground": "#e6e6e9",
    "editorLineNumber.foreground": "#3f3f46",
    "editorLineNumber.activeForeground": "#8a8a93",
    "editorCursor.foreground": "#7c93ff",
    "editor.selectionBackground": "#7c93ff33",
    "editor.inactiveSelectionBackground": "#7c93ff1a",
    "editor.lineHighlightBackground": "#16161866",
    "editor.lineHighlightBorder": "#00000000",
    "editorWhitespace.foreground": "#2a2a30",
    "editorIndentGuide.background1": "#1e1e22",
    "editorIndentGuide.activeBackground1": "#2a2a30",
    "editorWidget.background": "#1e1e22",
    "editorWidget.border": "#2a2a30",
    "editorSuggestWidget.background": "#1e1e22",
    "editorSuggestWidget.border": "#2a2a30",
    "editorSuggestWidget.selectedBackground": "#7c93ff26",
    "editorHoverWidget.background": "#1e1e22",
    "editorHoverWidget.border": "#2a2a30",
    "scrollbarSlider.background": "#2a2a3066",
    "scrollbarSlider.hoverBackground": "#2a2a30aa",
    "scrollbarSlider.activeBackground": "#2a2a30dd",
    "editorBracketMatch.background": "#7c93ff26",
    "editorBracketMatch.border": "#7c93ff66",
  },
});

export { monaco };
