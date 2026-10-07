import { Fragment, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { revealPosition } from "../../lib/editorRegistry";

/**
 * A deliberately small Markdown renderer for agent replies: fenced code
 * blocks (with copy), headings, lists, blockquotes, paragraphs, and
 * inline code/bold/italic/links. Inline code that looks like a workspace
 * path (`src/app.ts:42`) is clickable and opens the file at that line.
 * Everything renders as React text nodes — no HTML injection.
 */

type Block =
  | { kind: "code"; language: string; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      index++; // closing fence (or end of input while streaming)
      blocks.push({ kind: "code", language: fence[1], code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
        let item = lines[index].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        index++;
        // Indented continuation lines belong to the item.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
          item += " " + lines[index].trim();
          index++;
        }
        items.push(item);
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      blocks.push({ kind: "quote", text: quote.join(" ") });
      continue;
    }
    if (line.trim() === "") {
      index++;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^\s*```/.test(lines[index]) &&
      !/^#{1,4}\s/.test(lines[index]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !/^>/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

const PATH_LIKE = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.\w+(?::(\d+))?$/;

function InlineCode({ text }: { text: string }) {
  const match = text.match(PATH_LIKE);
  if (!match || !text.includes(".")) return <code>{text}</code>;
  const [filePart, line] = text.split(":");
  return (
    <code
      className="md-path"
      title="Open file"
      onClick={async () => {
        const root = useWorkspaceStore.getState().rootPath;
        if (!root) return;
        const path = filePart.startsWith("/")
          ? filePart
          : `${root}/${filePart.replace(/^\.\//, "")}`;
        await useTabsStore.getState().openFile(path);
        if (line) revealPosition(path, Number(line));
      }}
    >
      {text}
    </code>
  );
}

/** Inline formatting: `code`, **bold**, *italic*, [text](url). */
function Inline({ text }: { text: string }) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          return <InlineCode key={index} text={part.slice(1, -1)} />;
        }
        if ((part.startsWith("**") || part.startsWith("__")) && part.length > 4) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
          return <em key={index}>{part.slice(1, -1)}</em>;
        }
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) {
          return (
            <span key={index} className="md-link" title={link[2]}>
              {link[1]}
            </span>
          );
        }
        // Preserve single newlines inside a paragraph.
        return (
          <Fragment key={index}>
            {part.split("\n").map((segment, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {segment}
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-header">
        <span>{language || "text"}</span>
        <button
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      {parseBlocks(source).map((block, index) => {
        switch (block.kind) {
          case "code":
            return <CodeBlock key={index} language={block.language} code={block.code} />;
          case "heading":
            return (
              <div key={index} className={`md-heading md-h${block.level}`}>
                <Inline text={block.text} />
              </div>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Inline text={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "quote":
            return (
              <blockquote key={index}>
                <Inline text={block.text} />
              </blockquote>
            );
          case "paragraph":
            return (
              <p key={index}>
                <Inline text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
