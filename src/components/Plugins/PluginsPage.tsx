import { useEffect, useMemo, useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { homeDir, join } from "@tauri-apps/api/path";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  Link,
  RefreshCw,
  RotateCw,
  Search,
  Store,
  Trash2,
  Wrench,
} from "lucide-react";
import { isNewerVersion, usePluginStore, type MarketplaceEntry } from "../../store/pluginStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore, type PluginsTab } from "../../store/uiStore";
import { SETTINGS_SCHEMA } from "../../store/settingsStore";
import { pluginId } from "../../lib/plugins/scaffold";
import { PERMISSION_DESCRIPTIONS, type PluginInfo, type PluginPermission } from "../../lib/plugins/types";
import { SettingRow } from "../Settings/SettingsView";
import "./Plugins.css";

const DOCS_URL = "https://github.com/riaanmathur01/sable-ide/blob/main/docs/plugins.md";
const PUBLISH_URL = "https://github.com/riaanmathur01/sable-ide/blob/main/plugins/README.md";

const TABS: { id: PluginsTab; label: string; icon: typeof Store }[] = [
  { id: "marketplace", label: "Marketplace", icon: Store },
  { id: "installed", label: "Installed", icon: Check },
  { id: "create", label: "Create", icon: Wrench },
];

function open(url: string) {
  void openUrl(url).catch((error) => useUiStore.getState().setLastError(String(error)));
}

/**
 * Settings → Plugins: the marketplace (browse and install), the installed
 * plugins (manage), and creating your own.
 */
export function PluginsPage() {
  const tab = useUiStore((state) => state.pluginsTab);
  const installedCount = usePluginStore((state) => state.plugins.length);
  return (
    <div className="plugins-page">
      <div className="plugins-page-header">
        <h2>Plugins</h2>
        <div className="plugins-tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : undefined}
              onClick={() => useUiStore.getState().showSettingsPage("plugins", id)}
            >
              <Icon size={13} strokeWidth={1.5} />
              {label}
              {id === "installed" && installedCount > 0 && <span className="plugins-tab-count">{installedCount}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === "marketplace" && <Marketplace />}
      {tab === "installed" && <Installed />}
      {tab === "create" && <Create />}
    </div>
  );
}

// --- Marketplace -----------------------------------------------------------------

function Marketplace() {
  const marketplace = usePluginStore((state) => state.marketplace);
  const error = usePluginStore((state) => state.marketplaceError);
  const loading = usePluginStore((state) => state.marketplaceLoading);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const busy = usePluginStore((state) => state.busy);
  const store = usePluginStore.getState();

  useEffect(() => {
    if (usePluginStore.getState().marketplace === null) void usePluginStore.getState().loadMarketplace();
  }, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (marketplace ?? []).filter((entry) => {
      const haystack = `${entry.name} ${entry.description} ${entry.author} ${entry.tags.join(" ")} ${entry.id}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [marketplace, query]);

  const marketplaceSpec = SETTINGS_SCHEMA.find((spec) => spec.key === "plugins.marketplaceUrl");

  return (
    <div className="plugins-tab-body">
      <div className="marketplace-toolbar">
        <div className="marketplace-search">
          <Search size={14} strokeWidth={1.5} />
          <input placeholder="Search plugins" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <button className="plugins-button" disabled={loading} onClick={() => void store.loadMarketplace()} title="Reload the marketplace">
          <RefreshCw size={13} strokeWidth={1.5} className={loading ? "spinning" : undefined} />
        </button>
      </div>

      {error ? (
        <div className="plugins-notice error">
          {error}
          <button className="plugins-button" onClick={() => void store.loadMarketplace()}>
            Try again
          </button>
        </div>
      ) : marketplace === null ? (
        <div className="plugins-notice">Loading the marketplace…</div>
      ) : shown.length === 0 ? (
        <div className="plugins-notice">{query ? `No plugins match “${query}”.` : "The marketplace is empty."}</div>
      ) : (
        <div className="marketplace-grid">
          {shown.map((entry) => (
            <MarketplaceCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      <div className="plugins-section">
        <h3>Install from elsewhere</h3>
        <div className="plugins-url">
          <Link size={13} strokeWidth={1.5} />
          <input
            placeholder="GitHub repository, or a link to a .zip / .tar.gz"
            value={url}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={async (event) => {
              if (event.key === "Enter" && url.trim() && (await store.installFromUrl(url))) setUrl("");
            }}
          />
          <button
            className="plugins-button"
            disabled={busy || !url.trim()}
            onClick={async () => {
              if (await store.installFromUrl(url)) setUrl("");
            }}
          >
            <Download size={13} strokeWidth={1.5} /> Install
          </button>
          <button
            className="plugins-button"
            disabled={busy}
            onClick={async () => {
              const folder = await openNativeDialog({ directory: true, title: "Install Plugin from Folder" });
              if (typeof folder === "string") await store.installFromFolder(folder, false);
            }}
          >
            <FolderOpen size={13} strokeWidth={1.5} /> From Folder…
          </button>
        </div>
      </div>

      {marketplaceSpec && (
        <div className="plugins-section">
          <SettingRow spec={marketplaceSpec} />
        </div>
      )}
    </div>
  );
}

function MarketplaceCard({ entry }: { entry: MarketplaceEntry }) {
  const installed = usePluginStore((state) => state.plugins.find((plugin) => plugin.manifest.id === entry.id));
  const busy = usePluginStore((state) => state.busy);
  const [working, setWorking] = useState(false);
  const update = installed && !installed.linked && isNewerVersion(entry.version, installed.manifest.version);

  const install = async () => {
    setWorking(true);
    try {
      await usePluginStore.getState().installFromUrl(entry.url);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="marketplace-card">
      <div className="marketplace-card-title">
        <span className="marketplace-card-name">{entry.name}</span>
        <span className="plugin-version">{entry.version}</span>
      </div>
      {entry.author && <div className="marketplace-card-author">by {entry.author}</div>}
      <p className="marketplace-card-description">{entry.description}</p>
      <div className="plugin-permissions">
        {entry.permissions.map((permission) => (
          <span key={permission} className="plugin-permission" title={PERMISSION_DESCRIPTIONS[permission]}>
            {permission}
          </span>
        ))}
        {entry.tags.map((tag) => (
          <span key={tag} className="marketplace-tag">
            {tag}
          </span>
        ))}
      </div>
      <div className="marketplace-card-actions">
        {entry.homepage && (
          <button className="plugins-link-button" onClick={() => open(entry.homepage!)}>
            Details
          </button>
        )}
        <span className="plugins-spacer" />
        {installed && !update ? (
          <span className="marketplace-installed">
            <Check size={13} strokeWidth={2} /> Installed
          </span>
        ) : (
          <button className="plugins-button primary" disabled={busy} onClick={() => void install()}>
            {working ? (
              "Installing…"
            ) : update ? (
              <>
                <RefreshCw size={12} strokeWidth={1.5} /> Update to {entry.version}
              </>
            ) : (
              <>
                <Download size={12} strokeWidth={1.5} /> Install
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// --- Installed ---------------------------------------------------------------------

function Installed() {
  const plugins = usePluginStore((state) => state.plugins);
  if (plugins.length === 0) {
    return (
      <div className="plugins-tab-body">
        <div className="plugins-notice">
          No plugins installed yet.
          <button className="plugins-button primary" onClick={() => useUiStore.getState().showSettingsPage("plugins", "marketplace")}>
            <Store size={13} strokeWidth={1.5} /> Browse the Marketplace
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="plugins-tab-body">
      <div className="installed-toolbar">
        <span>
          {plugins.length} plugin{plugins.length === 1 ? "" : "s"} · {plugins.filter((plugin) => plugin.enabled).length} on
        </span>
        <button className="plugins-button" onClick={() => void usePluginStore.getState().reloadAll()}>
          <RotateCw size={12} strokeWidth={1.5} /> Reload All
        </button>
      </div>
      <div className="installed-list">
        {plugins.map((plugin) => (
          <PluginRow key={plugin.manifest.id} plugin={plugin} />
        ))}
      </div>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const { manifest } = plugin;
  const state = usePluginStore((store) => store.states[manifest.id] ?? (plugin.enabled ? "starting" : "stopped"));
  const error = usePluginStore((store) => store.errors[manifest.id]);
  const logs = usePluginStore((store) => store.logs[manifest.id]);
  const busy = usePluginStore((store) => store.busy);
  const [expanded, setExpanded] = useState(false);
  const store = usePluginStore.getState();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const status = !plugin.enabled ? "disabled" : state === "error" ? "error" : state === "running" ? "running" : state;

  return (
    <div className={`plugin-row ${status}`}>
      <div className="plugin-header" onClick={() => setExpanded(!expanded)}>
        <Chevron size={13} strokeWidth={1.5} className="plugin-chevron" />
        <div className="plugin-title">
          <span className="plugin-name">{manifest.name}</span>
          <span className="plugin-version">{manifest.version}</span>
          {manifest.author && <span className="plugin-author">by {manifest.author}</span>}
          {plugin.linked && <span className="plugin-badge">dev</span>}
          {status === "error" && <span className="plugin-badge error">error</span>}
        </div>
        <label className="plugin-toggle" title={plugin.enabled ? "Turn off" : "Turn on"} onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={plugin.enabled}
            disabled={busy}
            onChange={(event) => void store.setEnabled(manifest.id, event.target.checked)}
          />
          <span className="plugin-toggle-track" />
        </label>
      </div>
      {manifest.description && <div className="plugin-description">{manifest.description}</div>}
      {error && status === "error" && <div className="plugin-error">{error.split("\n")[0]}</div>}
      {expanded && (
        <div className="plugin-details">
          <div className="plugin-meta">
            <span title={plugin.path}>
              {plugin.linked ? "Linked from " : "Installed in "}
              {plugin.path}
            </span>
            {plugin.source && <span title={plugin.source}>From {plugin.source}</span>}
          </div>
          <div className="plugin-permissions">
            {manifest.permissions.length === 0 ? (
              <span className="plugin-permission">no special permissions</span>
            ) : (
              manifest.permissions.map((permission) => (
                <span key={permission} className="plugin-permission" title={PERMISSION_DESCRIPTIONS[permission]}>
                  {permission}
                </span>
              ))
            )}
          </div>
          <div className="plugin-buttons">
            <button disabled={!plugin.enabled} onClick={() => void store.reload(manifest.id)} title="Restart the plugin">
              <RotateCw size={12} strokeWidth={1.5} /> Reload
            </button>
            {plugin.source && !plugin.linked && (
              <button disabled={busy} onClick={() => void store.update(manifest.id)} title={`Download again from ${plugin.source}`}>
                <RefreshCw size={12} strokeWidth={1.5} /> Update
              </button>
            )}
            {plugin.linked && (
              <button onClick={() => void useTabsStore.getState().openFile(`${plugin.path}/${manifest.main}`)}>Edit main.js</button>
            )}
            <button className="danger" disabled={busy} onClick={() => void store.uninstall(manifest.id)}>
              <Trash2 size={12} strokeWidth={1.5} /> {plugin.linked ? "Remove" : "Uninstall"}
            </button>
          </div>
          <div className="plugin-log">
            {(logs ?? []).length === 0 ? (
              <div className="plugin-log-line muted">No output. console.log() in the plugin shows here.</div>
            ) : (
              logs!.map((line, index) => (
                <div key={index} className={`plugin-log-line ${line.level}`}>
                  {line.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Create ---------------------------------------------------------------------------

function Create() {
  const busy = usePluginStore((state) => state.busy);
  const [name, setName] = useState("My Plugin");
  const [id, setId] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const [permissions, setPermissions] = useState<PluginPermission[]>(["editor"]);

  useEffect(() => {
    void homeDir()
      .then((home) => join(home, "sable-plugins"))
      .then(setParent)
      .catch(() => {});
  }, []);

  const effectiveId = id ?? pluginId(name);
  const idValid = /^[a-z0-9][a-z0-9.-]{0,63}$/.test(effectiveId) && !effectiveId.includes("..");
  const canCreate = !busy && name.trim() !== "" && idValid && parent.trim() !== "";

  const create = () => {
    if (!canCreate) return;
    void usePluginStore.getState().createPlugin({ name: name.trim(), id: effectiveId, parent: parent.trim(), permissions });
  };

  return (
    <div className="plugins-tab-body">
      <form
        className="plugins-section create-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h3>New plugin</h3>
        <p className="plugins-note">
          Sable writes a working plugin (a command, a word counter and a formatter, with typings for autocomplete),
          loads it in development mode and opens <code>main.js</code>. It reloads every time you save it, and its
          console output shows under Installed.
        </p>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>ID {!idValid && <em className="plugin-dialog-problem">: lowercase letters, digits, '-' and '.'</em>}</span>
          <input value={effectiveId} spellCheck={false} onChange={(event) => setId(event.target.value)} />
        </label>
        <label>
          <span>Location</span>
          <div className="plugin-dialog-row">
            <input value={parent} spellCheck={false} onChange={(event) => setParent(event.target.value)} />
            <button
              type="button"
              className="plugins-button"
              onClick={async () => {
                const folder = await openNativeDialog({ directory: true, title: "Create the Plugin In" });
                if (typeof folder === "string") setParent(folder);
              }}
            >
              Choose…
            </button>
          </div>
          <small>Creates {parent ? `${parent.replace(/[/\\]+$/, "")}/${effectiveId}` : "…"}</small>
        </label>
        <fieldset>
          <legend>Permissions (change them any time in sable-plugin.json)</legend>
          {(Object.keys(PERMISSION_DESCRIPTIONS) as PluginPermission[]).map((permission) => (
            <label key={permission} className="plugin-dialog-check">
              <input
                type="checkbox"
                checked={permissions.includes(permission)}
                onChange={(event) =>
                  setPermissions((current) =>
                    event.target.checked ? [...current, permission] : current.filter((existing) => existing !== permission),
                  )
                }
              />
              <code>{permission}</code> {PERMISSION_DESCRIPTIONS[permission]}
            </label>
          ))}
        </fieldset>
        <div className="create-actions">
          <button type="submit" className="plugins-button primary" disabled={!canCreate}>
            <Wrench size={13} strokeWidth={1.5} /> Create Plugin
          </button>
        </div>
      </form>

      <div className="plugins-section">
        <h3>Working on a plugin already?</h3>
        <p className="plugins-note">
          Load its folder in development mode: Sable runs it from there and reloads it whenever you save one of its
          files.
        </p>
        <button
          className="plugins-button"
          disabled={busy}
          onClick={async () => {
            const folder = await openNativeDialog({ directory: true, title: "Load Plugin Folder (Development)" });
            if (typeof folder === "string") await usePluginStore.getState().installFromFolder(folder, true);
          }}
        >
          <FolderOpen size={13} strokeWidth={1.5} /> Load Plugin Folder…
        </button>
      </div>

      <div className="plugins-section">
        <h3>Learn and share</h3>
        <div className="create-links">
          <button className="plugins-button" onClick={() => open(DOCS_URL)}>
            <BookOpen size={13} strokeWidth={1.5} /> Plugin guide and API reference
          </button>
          <button className="plugins-button" onClick={() => open(PUBLISH_URL)}>
            <Store size={13} strokeWidth={1.5} /> List your plugin in the Marketplace
          </button>
        </div>
      </div>
    </div>
  );
}
