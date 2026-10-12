import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronsDown, ChevronsUp, Copy, Eraser } from "lucide-react";
import { parseAnsi, stripAnsi } from "../../lib/notebook/ansi";
import type { MimeBundle, NbOutput } from "../../lib/notebook/nbformat";
import { clearOutputs, submitInput, toggleOutputCollapsed, toggleOutputExpanded } from "../../lib/notebook/notebookStore";
import { useUiStore } from "../../store/uiStore";

/** Mimetypes in the order Jupyter front ends prefer them. */
const MIME_ORDER = [
  "application/vnd.jupyter.widget-view+json",
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
];

/** Outputs taller than this scroll (until expanded). */
const SCROLL_HEIGHT = 520;

export function pickMime(data: MimeBundle): string | null {
  return MIME_ORDER.find((mime) => data[mime] !== undefined) ?? Object.keys(data).find((mime) => mime.startsWith("text/")) ?? null;
}

/** Text with ANSI colors. */
function AnsiText({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((segment, index) => {
        const style: React.CSSProperties = {};
        if (segment.fg) style.color = segment.fg;
        if (segment.bg) style.backgroundColor = segment.bg;
        if (segment.bold) style.fontWeight = 600;
        if (segment.dim) style.opacity = 0.7;
        if (segment.italic) style.fontStyle = "italic";
        if (segment.underline) style.textDecoration = "underline";
        return Object.keys(style).length === 0 ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span key={index} style={style}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

/** The theme's colors, for HTML outputs rendered in their own frame. */
function frameStyles(): string {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return `
    :root { color-scheme: ${document.documentElement.style.colorScheme === "light" ? "light" : "dark"}; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body { color: ${token("--text", "#e6e6e9")}; font: 13px/1.5 ${token("--font-ui", "system-ui")}; overflow-x: auto; overflow-y: hidden; }
    a { color: ${token("--accent", "#7c93ff")}; }
    table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
    th, td { padding: 4px 10px; border: none; border-bottom: 1px solid ${token("--border", "#2a2a30")}; text-align: right; }
    th { font-weight: 600; }
    thead th { border-bottom-color: ${token("--text-muted", "#8a8a93")}; }
    tbody tr:nth-child(odd) { background: ${token("--bg-panel", "#161618")}; }
    pre, code { font-family: ${token("--font-mono", "monospace")}; }
  `;
}

/** Reports the frame's height to Sable, so the frame fits its content. */
const SIZE_SCRIPT = `<script>(function(){var last=0;function post(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({sableFrame:window.name,height:h},"*");}}
new ResizeObserver(post).observe(document.documentElement);window.addEventListener("load",post);setInterval(post,500);post();})();</script>`;

let frameCounter = 0;

/**
 * HTML with scripts (Plotly, Bokeh, …) in a sandboxed frame: scripts run,
 * but in an opaque origin with no access to Sable. Sized to its content.
 */
function HtmlFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [name] = useState(() => `sable-output-${(frameCounter += 1)}`);
  const [height, setHeight] = useState(40);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.sableFrame !== name) return;
      const next = Number(event.data.height);
      if (Number.isFinite(next)) setHeight(Math.min(Math.max(next, 20), 4000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name]);
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${frameStyles()}</style></head><body>${html}${SIZE_SCRIPT}</body></html>`;
  return (
    <iframe
      ref={frame}
      name={name}
      className="nb-output-frame"
      title="Output"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
      srcDoc={srcdoc}
      style={{ height }}
    />
  );
}

/** Script-free HTML (most tables) renders in place, in Sable's colors. */
const needsFrame = (html: string) => /<script|<iframe|<object|<embed|\bon[a-z]+\s*=|javascript:/i.test(html);

function SafeHtml({ html, className }: { html: string; className: string }) {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "button"] });
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} onClick={openLinksOutside} />;
}

function openLinksOutside(event: React.MouseEvent) {
  const link = (event.target as Element).closest("a");
  const href = link?.getAttribute("href");
  if (!link || !href) return;
  event.preventDefault();
  if (/^(https?:|mailto:)/i.test(href)) {
    void openUrl(href).catch((error) => useUiStore.getState().setLastError(String(error)));
  }
}

function imageSize(metadata: Record<string, unknown>, mime: string): React.CSSProperties {
  const meta = (metadata?.[mime] ?? metadata) as { width?: number; height?: number } | undefined;
  const style: React.CSSProperties = {};
  if (typeof meta?.width === "number") style.width = meta.width;
  if (typeof meta?.height === "number") style.height = meta.height;
  return style;
}

function MimeOutput({ data, metadata }: { data: MimeBundle; metadata: Record<string, unknown> }) {
  const mime = pickMime(data);
  if (!mime) return <div className="nb-output-note">(no displayable output)</div>;
  const value = data[mime];
  const text = typeof value === "string" ? value : "";
  switch (mime) {
    case "application/vnd.jupyter.widget-view+json":
      return (
        <div className="nb-output-widget">
          <div className="nb-output-note">Interactive widgets (ipywidgets) aren't supported in Sable.</div>
          {typeof data["text/plain"] === "string" && (
            <pre className="nb-output-text">
              <AnsiText text={data["text/plain"] as string} />
            </pre>
          )}
        </div>
      );
    case "text/html":
      return needsFrame(text) ? <HtmlFrame html={text} /> : <SafeHtml html={text} className="nb-output-html" />;
    case "image/svg+xml":
      return <img className="nb-output-image" alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} style={imageSize(metadata, mime)} />;
    case "image/png":
    case "image/jpeg":
    case "image/gif":
      return <img className="nb-output-image" alt="" src={`data:${mime};base64,${text.replace(/\s/g, "")}`} style={imageSize(metadata, mime)} />;
    case "text/markdown":
      return <SafeHtml html={marked.parse(text, { gfm: true, async: false }) as string} className="nb-output-markdown markdown-body" />;
    case "application/json":
      return <pre className="nb-output-text">{JSON.stringify(value, null, 2)}</pre>;
    case "text/latex":
      // No TeX renderer bundled: the source, readable.
      return <pre className="nb-output-text nb-output-latex">{text}</pre>;
    default:
      return (
        <pre className="nb-output-text">
          <AnsiText text={text} />
        </pre>
      );
  }
}

function OutputItem({ output }: { output: NbOutput }) {
  switch (output.output_type) {
    case "stream":
      return (
        <pre className={output.name === "stderr" ? "nb-output-text nb-stderr" : "nb-output-text"}>
          <AnsiText text={String(output.text)} />
        </pre>
      );
    case "error": {
      const traceback = output.traceback.length > 0 ? output.traceback.join("\n") : `${output.ename}: ${output.evalue}`;
      return (
        <pre className="nb-output-text nb-error">
          <AnsiText text={traceback} />
        </pre>
      );
    }
    case "display_data":
    case "execute_result":
      return <MimeOutput data={output.data} metadata={output.metadata} />;
    default:
      return null;
  }
}

/** Plain text of the outputs (Copy Output). */
export function outputsText(outputs: NbOutput[]): string {
  return outputs
    .map((output) => {
      if (output.output_type === "stream") return stripAnsi(String(output.text));
      if (output.output_type === "error") return stripAnsi(output.traceback.join("\n") || `${output.ename}: ${output.evalue}`);
      const plain = output.data["text/plain"];
      return typeof plain === "string" ? stripAnsi(plain) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function InputPrompt({ path, prompt, password }: { path: string; prompt: string; password: boolean }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      className="nb-stdin"
      onSubmit={(event) => {
        event.preventDefault();
        submitInput(path, value);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {prompt && <span className="nb-stdin-prompt">{prompt}</span>}
      <input
        ref={input}
        type={password ? "password" : "text"}
        value={value}
        spellCheck={false}
        placeholder="Input for the program — Enter to send"
        onChange={(event) => setValue(event.target.value)}
      />
    </form>
  );
}

/** A code cell's outputs: scroll box for long ones, collapse, copy, clear. */
export const CellOutputs = memo(function CellOutputs({
  path,
  cellKey,
  outputs,
  collapsed,
  expanded,
  input,
}: {
  path: string;
  cellKey: string;
  outputs: NbOutput[];
  collapsed: boolean;
  expanded: boolean;
  input: { prompt: string; password: boolean } | null;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > SCROLL_HEIGHT + 4);
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of element.children) observer.observe(child);
    observer.observe(element);
    return () => observer.disconnect();
  }, [outputs, collapsed]);
  // Long streaming output: follow the end, unless scrolled up.
  useEffect(() => {
    const element = body.current;
    if (!element || expanded || !overflowing) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) element.scrollTop = element.scrollHeight;
  }, [outputs, expanded, overflowing]);

  if (outputs.length === 0 && !input) return null;
  const copy = () => {
    void navigator.clipboard.writeText(outputsText(outputs)).then(
      () => useUiStore.getState().showStatus("Output copied"),
      () => useUiStore.getState().setLastError("Couldn't copy the output"),
    );
  };
  return (
    <div className="nb-outputs">
      <div
        className="nb-outputs-gutter"
        title={collapsed ? "Show output" : "Collapse output"}
        onClick={() => toggleOutputCollapsed(path, cellKey)}
      />
      {collapsed ? (
        <div className="nb-outputs-collapsed" onClick={() => toggleOutputCollapsed(path, cellKey)}>
          Output collapsed — click to show
        </div>
      ) : (
        <div className="nb-outputs-main">
          <div
            ref={body}
            className={overflowing && !expanded ? "nb-outputs-body scrolled" : "nb-outputs-body"}
            style={overflowing && !expanded ? { maxHeight: SCROLL_HEIGHT } : undefined}
          >
            {outputs.map((output, index) => (
              <div key={index} className="nb-output">
                <OutputItem output={output} />
              </div>
            ))}
            {input && <InputPrompt path={path} prompt={input.prompt} password={input.password} />}
          </div>
          {outputs.length > 0 && (
            <div className="nb-outputs-actions">
              {overflowing && (
                <button title={expanded ? "Scroll long output" : "Show all output"} onClick={() => toggleOutputExpanded(path, cellKey)}>
                  {expanded ? <ChevronsUp size={13} strokeWidth={1.6} /> : <ChevronsDown size={13} strokeWidth={1.6} />}
                </button>
              )}
              <button title="Copy output" onClick={copy}>
                <Copy size={12} strokeWidth={1.6} />
              </button>
              <button title="Clear output" onClick={() => clearOutputs(path, cellKey)}>
                <Eraser size={12} strokeWidth={1.6} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
