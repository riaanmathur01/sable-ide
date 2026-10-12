import { useEffect, useRef, useState } from "react";
import { invokeLocal } from "../../lib/backend";
import { onWebviewMessage, takePendingMessages, usePluginViewsStore } from "../../store/pluginViewsStore";
import "./PluginWebviewFrame.css";

/**
 * A plugin's webview (VS Code's webview panels and webview views): its
 * HTML in a sandboxed frame — its own origin, no access to Sable — with
 * VS Code's `acquireVsCodeApi()` for messages both ways, VS Code's theme
 * variables mapped to Sable's colors, and the plugin's own files
 * (`asWebviewUri`) inlined.
 */

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", html: "text/html", wasm: "application/wasm",
};

/** VS Code's webview CSS variables, from Sable's theme. */
function themeVariables(): string {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = value("--bg-base", "#1e1e1e");
  const panel = value("--bg-panel", "#252526");
  const elevated = value("--bg-elevated", "#2d2d30");
  const text = value("--text", "#cccccc");
  const muted = value("--text-muted", "#999999");
  const accent = value("--accent", "#0e639c");
  const border = value("--border", "#3c3c3c");
  const vars: Record<string, string> = {
    "--vscode-font-family": value("--font-ui", "system-ui, sans-serif"),
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": value("--font-mono", "monospace"),
    "--vscode-editor-font-size": "13px",
    "--vscode-foreground": text,
    "--vscode-descriptionForeground": muted,
    "--vscode-editor-background": background,
    "--vscode-editor-foreground": text,
    "--vscode-sideBar-background": panel,
    "--vscode-panel-background": panel,
    "--vscode-panel-border": border,
    "--vscode-widget-border": border,
    "--vscode-focusBorder": accent,
    "--vscode-button-background": accent,
    "--vscode-button-foreground": value("--on-accent", "#ffffff"),
    "--vscode-button-hoverBackground": accent,
    "--vscode-button-secondaryBackground": elevated,
    "--vscode-button-secondaryForeground": text,
    "--vscode-input-background": elevated,
    "--vscode-input-foreground": text,
    "--vscode-input-border": border,
    "--vscode-dropdown-background": elevated,
    "--vscode-dropdown-foreground": text,
    "--vscode-dropdown-border": border,
    "--vscode-textLink-foreground": accent,
    "--vscode-textLink-activeForeground": accent,
    "--vscode-list-hoverBackground": elevated,
    "--vscode-list-activeSelectionBackground": accent,
    "--vscode-scrollbarSlider-background": "rgba(121,121,121,0.4)",
    "--vscode-errorForeground": value("--danger", "#f48771"),
    "--vscode-badge-background": accent,
    "--vscode-badge-foreground": value("--on-accent", "#ffffff"),
    "--vscode-textCodeBlock-background": elevated,
  };
  return `:root { ${Object.entries(vars).map(([name, val]) => `${name}: ${val};`).join(" ")} }
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
a { color: var(--vscode-textLink-foreground); }`;
}

/** The page's bridge: VS Code's acquireVsCodeApi(), over postMessage. */
function bridgeScript(id: string, state: unknown): string {
  return `<script>(() => {
  // A sandboxed page can't use the real storage: give it an in-memory one.
  for (const name of ["localStorage", "sessionStorage"]) {
    try { void window[name]; } catch {
      const data = new Map();
      const storage = {
        getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
        setItem: (key, value) => void data.set(String(key), String(value)),
        removeItem: (key) => void data.delete(String(key)),
        clear: () => data.clear(),
        key: (index) => [...data.keys()][index] ?? null,
        get length() { return data.size; },
      };
      try { Object.defineProperty(window, name, { configurable: true, get: () => storage }); } catch {}
    }
  }
  const id = ${JSON.stringify(id)};
  let state = ${JSON.stringify(state ?? null)};
  let acquired = false;
  window.acquireVsCodeApi = () => {
    if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
    acquired = true;
    return Object.freeze({
      postMessage: (message) => parent.postMessage({ __sableWebview: id, message }, "*"),
      getState: () => state,
      setState: (value) => { state = value; parent.postMessage({ __sableWebview: id, state: value }, "*"); return value; },
    });
  };
})();</script>`;
}

/** Saved webview state (getState/setState), per webview. */
const savedState = new Map<string, unknown>();

/** Replace `sable-resource:` links (asWebviewUri) with data: URIs. */
async function inlineResources(html: string): Promise<string> {
  const found = [...new Set(html.match(/sable-resource:[^"'\s)<>]+/g) ?? [])];
  let result = html;
  for (const reference of found) {
    const path = decodeURIComponent(reference.slice("sable-resource:".length).split(/[?#]/)[0]);
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    try {
      const data = await invokeLocal<string>("read_file_base64", { path });
      result = result.split(reference).join(`data:${MIME[extension] ?? "application/octet-stream"};base64,${data}`);
    } catch {
      // Missing file: leave the link (it just won't load).
    }
  }
  return result;
}

export function PluginWebviewFrame({ id }: { id: string }) {
  const webview = usePluginViewsStore((state) => state.webviews[id]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [document_, setDocument] = useState<string | null>(null);
  const html = webview?.html ?? "";
  const version = webview?.version ?? 0;

  useEffect(() => {
    let cancelled = false;
    void inlineResources(html).then((inlined) => {
      if (cancelled) return;
      const light = document.documentElement.style.colorScheme === "light";
      const head = `<meta charset="utf-8"><style>${themeVariables()}</style>${bridgeScript(id, savedState.get(id))}`;
      const body = /<head[^>]*>/i.test(inlined) ? inlined.replace(/<head[^>]*>/i, (match) => `${match}${head}`) : `${head}${inlined}`;
      const classed = body.replace(/<body([^>]*)>/i, (_match, attributes: string) => {
        const classes = `vscode-${light ? "light" : "dark"}`;
        return /class=/.test(attributes) ? `<body${attributes.replace(/class=(["'])/, `class=$1${classes} `)}>` : `<body${attributes} class="${classes}">`;
      });
      setDocument(classed);
    });
    return () => {
      cancelled = true;
    };
  }, [id, html, version]);

  // Page → plugin.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || event.data.__sableWebview !== id) return;
      if ("state" in event.data) savedState.set(id, event.data.state);
      else usePluginViewsStore.getState().webviews[id]?.onMessage(event.data.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  // Plugin → page (and what was posted before the page loaded).
  useEffect(() => {
    const deliver = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
    const stop = onWebviewMessage(id, deliver);
    return stop;
  }, [id]);

  if (!webview) return <div className="plugin-webview-empty">This view is closed.</div>;
  return (
    <iframe
      ref={frame}
      className="plugin-webview"
      title={webview.title}
      sandbox={webview.enableScripts ? "allow-scripts allow-forms allow-popups allow-modals" : "allow-forms"}
      srcDoc={document_ ?? ""}
      onLoad={() => {
        for (const message of takePendingMessages(id)) frame.current?.contentWindow?.postMessage(message, "*");
      }}
    />
  );
}
