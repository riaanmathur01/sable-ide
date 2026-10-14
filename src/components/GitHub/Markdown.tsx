import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { monaco } from "../../lib/monacoSetup";
import { openExternal } from "./common";
import "../Editor/MarkdownPreview.css";

function languageFor(label: string): string | null {
  const wanted = label.toLowerCase();
  if (!wanted) return null;
  return (
    monaco.languages
      .getLanguages()
      .find((candidate) => candidate.id === wanted || candidate.aliases?.some((alias) => alias.toLowerCase() === wanted) || candidate.extensions?.includes(`.${wanted}`))?.id ??
    null
  );
}

/** `#123` and `@user` as links (outside code), as GitHub shows them. */
function linkReferences(markdown: string, repoUrl: string | undefined): string {
  if (!repoUrl) return markdown;
  const host = repoUrl.replace(/\/[^/]+\/[^/]+\/?$/, "");
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/(^|[\s(])#(\d+)\b/g, (_match, before: string, number: string) => `${before}[#${number}](${repoUrl}/issues/${number})`)
            .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g, (_match, before: string, login: string) => `${before}[@${login}](${host}/${login})`),
    )
    .join("");
}

/**
 * GitHub-flavored Markdown (a description or comment): sanitized, code in
 * the editor's colors, links open in the browser.
 */
export function Markdown({ text, repoUrl, className }: { text: string; repoUrl?: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    element.innerHTML = DOMPurify.sanitize(marked.parse(linkReferences(text, repoUrl), { gfm: true, breaks: true, async: false }) as string);
    let cancelled = false;
    for (const code of element.querySelectorAll("pre > code")) {
      const language = languageFor(/language-([\w+#-]+)/.exec(code.className)?.[1] ?? "");
      if (!language) continue;
      void monaco.editor.colorize(code.textContent ?? "", language, { tabSize: 4 }).then((colored) => {
        if (!cancelled) code.innerHTML = colored.replace(/(<br\s*\/?>\s*)+$/, "");
      });
    }
    for (const box of element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.disabled = true;
    return () => {
      cancelled = true;
    };
  }, [text, repoUrl]);
  return (
    <div
      ref={container}
      className={`markdown-body gh-markdown ${className ?? ""}`}
      onClick={(event) => {
        const link = (event.target as Element).closest("a");
        const href = link?.getAttribute("href");
        if (!link || !href) return;
        event.preventDefault();
        if (/^https?:/i.test(href)) openExternal(href);
      }}
    />
  );
}
