import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { monaco } from "../../lib/monacoSetup";
import { ensureModel } from "../../lib/lsp/monacoLsp";
import { readFileBase64 } from "../../lib/ipc";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import "./MarkdownPreview.css";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

/** A path in the document, relative to the file (or absolute). */
function resolve(base: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (/^([/\\]|[A-Za-z]:)/.test(clean)) return clean;
  const separator = base.includes("\\") ? "\\" : "/";
  const parts = `${base}${separator}${clean}`.split(/[/\\]/);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join(separator);
}

const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");

/** Monaco's language id for a fence label ("ts", "py", "rust"…). */
function languageFor(label: string): string | null {
  const wanted = label.toLowerCase();
  if (!wanted) return null;
  const language = monaco.languages
    .getLanguages()
    .find(
      (candidate) =>
        candidate.id === wanted ||
        candidate.aliases?.some((alias) => alias.toLowerCase() === wanted) ||
        candidate.extensions?.includes(`.${wanted}`),
    );
  return language?.id ?? null;
}

/**
 * A Markdown file rendered (GitHub-flavored), following the editor as you
 * type: code in the editor's colors, the file's images, links that open
 * in Sable (other files) or the browser (the web).
 */
export default function MarkdownPreview({ filePath }: { filePath: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);

  // The file's text, live from its editor model.
  useEffect(() => {
    let disposed = false;
    let listener: { dispose(): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void ensureModel(monaco, filePath).then((uri) => {
      const model = monaco.editor.getModel(uri);
      if (disposed || !model) return;
      setSource(model.getValue());
      listener = model.onDidChangeContent(() => {
        clearTimeout(timer);
        timer = setTimeout(() => setSource(model.getValue()), 120);
      });
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      listener?.dispose();
    };
  }, [filePath]);

  // Render, then fill in code colors and local images.
  useEffect(() => {
    const element = container.current;
    if (!element || source === null) return;
    const html = DOMPurify.sanitize(marked.parse(source, { gfm: true, async: false }) as string);
    const scrollTop = element.scrollTop;
    element.innerHTML = html;
    element.scrollTop = scrollTop;
    for (const heading of element.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      heading.id ||= slug(heading.textContent ?? "");
    }
    let cancelled = false;
    for (const code of element.querySelectorAll("pre > code")) {
      const label = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? "";
      const language = languageFor(label);
      if (!language) continue;
      void monaco.editor.colorize(code.textContent ?? "", language, { tabSize: 4 }).then((colored) => {
        // (Monaco ends its output with a line break.)
        if (!cancelled) code.innerHTML = colored.replace(/(<br\s*\/?>\s*)+$/, "");
      });
    }
    for (const image of element.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (!src || isExternal(src) || src.startsWith("data:")) continue;
      const path = resolve(dirOf(filePath), src);
      const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
      if (!type) continue;
      void readFileBase64(path).then(
        (data) => {
          if (!cancelled) image.src = `data:${type};base64,${data}`;
        },
        () => image.classList.add("missing"),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [source, filePath]);

  // Links: the web in the browser, files in Sable, #anchors in place.
  const onClick = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    if (isExternal(href)) {
      void openUrl(href).catch((error) => useUiStore.getState().setLastError(String(error)));
    } else if (href.startsWith("#")) {
      container.current?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView({ behavior: "smooth" });
    } else {
      const path = resolve(dirOf(filePath), href);
      void useTabsStore.getState().openFile(path);
    }
  };

  return (
    <div className="markdown-preview" onClick={onClick}>
      <div ref={container} className="markdown-body" />
      {source === null && <div className="diff-message">Loading…</div>}
    </div>
  );
}
