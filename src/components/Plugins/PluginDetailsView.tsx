import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Check, Download, ExternalLink, Puzzle, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { monaco } from "../../lib/monacoSetup";
import { pathExists, readFile, readFileBase64 } from "../../lib/ipc";
import { isNewerVersion, readmeUrlFor, usePluginStore } from "../../store/pluginStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { PERMISSION_DESCRIPTIONS } from "../../lib/plugins/types";
import "../Editor/MarkdownPreview.css";
import "./Plugins.css";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const isAbsolute = (href: string) => /^([a-z]+:|\/\/)/i.test(href);

function open(url: string) {
  void openUrl(url).catch((error) => useUiStore.getState().setLastError(String(error)));
}

/** Monaco's language id for a fence label ("ts", "js", "json"…). */
function languageFor(label: string): string | null {
  const wanted = label.toLowerCase();
  if (!wanted) return null;
  return (
    monaco.languages
      .getLanguages()
      .find(
        (candidate) =>
          candidate.id === wanted ||
          candidate.aliases?.some((alias) => alias.toLowerCase() === wanted) ||
          candidate.extensions?.includes(`.${wanted}`),
      )?.id ?? null
  );
}

/** Where the README came from: a folder on disk, or the web. */
type ReadmeSource = { kind: "folder"; dir: string } | { kind: "web"; base: string };

/**
 * A plugin's page, like VS Code's extension page: what it is, what it may
 * do, Install / Update / Uninstall, and its README. Works for installed
 * plugins (README from their folder) and marketplace ones (README from
 * GitHub).
 */
export default function PluginDetailsView({ pluginId }: { pluginId: string }) {
  const installed = usePluginStore((state) => state.plugins.find((plugin) => plugin.manifest.id === pluginId));
  const entry = usePluginStore((state) => state.marketplace?.find((candidate) => candidate.id === pluginId));
  const busy = usePluginStore((state) => state.busy);
  const status = usePluginStore((state) => state.states[pluginId]);
  const error = usePluginStore((state) => state.errors[pluginId]);
  const container = useRef<HTMLDivElement>(null);
  const [readme, setReadme] = useState<{ text: string; source: ReadmeSource } | null | undefined>(undefined);
  const [working, setWorking] = useState<"install" | null>(null);

  // The catalogue may not be loaded yet (opened from Installed).
  useEffect(() => {
    if (!usePluginStore.getState().marketplace) void usePluginStore.getState().loadMarketplace();
  }, []);

  const installedPath = installed?.path;
  const readmeUrl = entry ? readmeUrlFor(entry) : null;

  // The README: from the plugin's folder if installed, else the web.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (installedPath) {
        const file = `${installedPath}/README.md`;
        if (await pathExists(file).catch(() => false)) {
          const text = await readFile(file).catch(() => null);
          if (text !== null) {
            if (!cancelled) setReadme({ text, source: { kind: "folder", dir: installedPath } });
            return;
          }
        }
      }
      if (readmeUrl) {
        const text = await invoke<string | null>("plugin_fetch_readme", { url: readmeUrl }).catch(() => null);
        if (text !== null) {
          if (!cancelled) setReadme({ text, source: { kind: "web", base: readmeUrl.slice(0, readmeUrl.lastIndexOf("/") + 1) } });
          return;
        }
      }
      if (!cancelled) setReadme(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [installedPath, readmeUrl]);

  // Render it: sanitized, code in the editor's colors, images resolved.
  useEffect(() => {
    const element = container.current;
    if (!element || !readme) return;
    element.innerHTML = DOMPurify.sanitize(marked.parse(readme.text, { gfm: true, async: false }) as string);
    // The page header already shows the name.
    const first = element.firstElementChild;
    if (first?.tagName === "H1") first.remove();
    let cancelled = false;
    for (const code of element.querySelectorAll("pre > code")) {
      const language = languageFor(/language-([\w+#-]+)/.exec(code.className)?.[1] ?? "");
      if (!language) continue;
      void monaco.editor.colorize(code.textContent ?? "", language, { tabSize: 4 }).then((colored) => {
        if (!cancelled) code.innerHTML = colored.replace(/(<br\s*\/?>\s*)+$/, "");
      });
    }
    for (const image of element.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) continue;
      if (readme.source.kind === "web") {
        if (!isAbsolute(src)) image.src = new URL(src, readme.source.base).href;
      } else if (!isAbsolute(src)) {
        const path = `${readme.source.dir}/${src.replace(/^\.\//, "")}`;
        const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
        if (!type) continue;
        void readFileBase64(path).then(
          (data) => {
            if (!cancelled) image.src = `data:${type};base64,${data}`;
          },
          () => image.classList.add("missing"),
        );
      }
    }
    return () => {
      cancelled = true;
    };
  }, [readme]);

  const onReadmeClick = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      [...(container.current?.querySelectorAll("h1, h2, h3, h4") ?? [])]
        .find((heading) => (heading.textContent ?? "").trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-") === id)
        ?.scrollIntoView({ behavior: "smooth" });
    } else if (isAbsolute(href)) {
      open(href);
    } else if (readme?.source.kind === "web") {
      open(new URL(href, readme.source.base).href);
    } else if (readme?.source.kind === "folder") {
      void useTabsStore.getState().openFile(`${readme.source.dir}/${href.replace(/^\.\//, "")}`);
    }
  };

  const manifest = installed?.manifest;
  const name = manifest?.name ?? entry?.name ?? pluginId;
  const version = manifest?.version ?? entry?.version;
  const author = manifest?.author ?? entry?.author;
  const description = manifest?.description ?? entry?.description;
  const permissions = manifest?.permissions ?? entry?.permissions ?? [];
  const homepage = manifest?.homepage ?? entry?.homepage ?? (entry?.url.startsWith("https://github.com/") ? entry.url : undefined);
  const update = installed && entry && !installed.linked && isNewerVersion(entry.version, installed.manifest.version);
  const state = !installed ? null : !installed.enabled ? "Off" : status === "error" ? "Error" : status === "running" ? "Running" : "Starting";

  const install = async () => {
    if (!entry) return;
    setWorking("install");
    try {
      await usePluginStore.getState().installFromUrl(entry.url);
    } finally {
      setWorking(null);
    }
  };

  if (!installed && !entry) {
    return (
      <div className="plugin-page">
        <div className="plugins-notice">
          {usePluginStore.getState().marketplaceLoading ? "Loading…" : `${pluginId} isn't installed or in the marketplace.`}
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-page">
      <header className="plugin-page-header">
        <div className="plugin-page-icon">
          <Puzzle size={40} strokeWidth={1.25} />
        </div>
        <div className="plugin-page-heading">
          <div className="plugin-page-title">
            <h1>{name}</h1>
            {version && <span className="plugin-version">v{version}</span>}
            {installed?.linked && <span className="plugin-badge">dev</span>}
          </div>
          <div className="plugin-page-sub">
            {author && <span>{author}</span>}
            <span className="plugin-page-id">{pluginId}</span>
            {state && <span className={`plugin-page-state ${state.toLowerCase()}`}>{state}</span>}
          </div>
          {description && <p className="plugin-page-description">{description}</p>}
          <div className="plugin-page-actions">
            {!installed && entry && (
              <button className="plugins-button primary" disabled={busy} onClick={() => void install()}>
                <Download size={12} strokeWidth={1.5} /> {working ? "Installing…" : "Install"}
              </button>
            )}
            {update && (
              <button className="plugins-button primary" disabled={busy} onClick={() => void install()}>
                <RefreshCw size={12} strokeWidth={1.5} /> {working ? "Updating…" : `Update to ${entry!.version}`}
              </button>
            )}
            {installed && (
              <>
                <button
                  className="plugins-button"
                  disabled={busy}
                  onClick={() => void usePluginStore.getState().setEnabled(pluginId, !installed.enabled)}
                >
                  {installed.enabled ? "Turn Off" : "Turn On"}
                </button>
                {installed.enabled && (
                  <button className="plugins-button" onClick={() => void usePluginStore.getState().reload(pluginId)}>
                    <RotateCw size={12} strokeWidth={1.5} /> Reload
                  </button>
                )}
                <button className="plugins-button danger" disabled={busy} onClick={() => void usePluginStore.getState().uninstall(pluginId)}>
                  <Trash2 size={12} strokeWidth={1.5} /> {installed.linked ? "Remove" : "Uninstall"}
                </button>
                {!update && !installed.linked && (
                  <span className="marketplace-installed">
                    <Check size={13} strokeWidth={2} /> Installed
                  </span>
                )}
              </>
            )}
            {homepage && (
              <button className="plugins-link-button" onClick={() => open(homepage)}>
                <ExternalLink size={12} strokeWidth={1.5} /> Repository
              </button>
            )}
          </div>
          {error && state === "Error" && <div className="plugin-error">{error.split("\n")[0]}</div>}
        </div>
      </header>
      <div className="plugin-page-body">
        <div className="plugin-page-readme markdown-preview" onClick={onReadmeClick}>
          {readme === undefined && <div className="plugins-notice">Loading README…</div>}
          {readme === null && <div className="plugins-notice">This plugin has no README.</div>}
          <div ref={container} className="markdown-body" style={readme ? undefined : { display: "none" }} />
        </div>
        <aside className="plugin-page-aside">
          <h3>Permissions</h3>
          {permissions.length === 0 ? (
            <p className="plugin-page-muted">None — it only adds commands and reacts to the editor.</p>
          ) : (
            <ul className="plugin-page-permissions">
              {permissions.map((permission) => (
                <li key={permission}>
                  <code>{permission}</code>
                  <span>{PERMISSION_DESCRIPTIONS[permission] ?? "Unknown permission"}</span>
                </li>
              ))}
            </ul>
          )}
          {entry && entry.tags.length > 0 && (
            <>
              <h3>Tags</h3>
              <div className="plugin-permissions">
                {entry.tags.map((tag) => (
                  <span key={tag} className="marketplace-tag">
                    {tag}
                  </span>
                ))}
              </div>
            </>
          )}
          <h3>More Info</h3>
          <dl className="plugin-page-info">
            {version && (
              <>
                <dt>Version</dt>
                <dd>{version}</dd>
              </>
            )}
            {entry && installed && entry.version !== installed.manifest.version && (
              <>
                <dt>Latest</dt>
                <dd>{entry.version}</dd>
              </>
            )}
            {manifest?.minSableVersion && (
              <>
                <dt>Needs Sable</dt>
                <dd>{manifest.minSableVersion}+</dd>
              </>
            )}
            {installed && (
              <>
                <dt>{installed.linked ? "Linked from" : "Installed in"}</dt>
                <dd title={installed.path}>{installed.path}</dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}
