import { useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Download, FilePlus2, FolderOpen, Puzzle, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { usePluginStore } from "../../store/pluginStore";
import { useTabsStore } from "../../store/tabsStore";
import { PERMISSION_DESCRIPTIONS, type PluginInfo } from "../../lib/plugins/types";
import "./Plugins.css";

/**
 * The Plugins view: install (from a URL or a folder), create, and manage
 * plugins — enable/disable, reload, update, uninstall, and each plugin's
 * permissions and log.
 */
export function PluginsPanel() {
  const plugins = usePluginStore((state) => state.plugins);
  const busy = usePluginStore((state) => state.busy);
  const [url, setUrl] = useState("");
  const store = usePluginStore.getState();

  const installUrl = async () => {
    if (!url.trim()) return;
    if (await store.installFromUrl(url)) setUrl("");
  };

  const chooseFolder = async (link: boolean) => {
    const folder = await openNativeDialog({ directory: true, title: link ? "Load Plugin Folder (Development)" : "Install Plugin from Folder" });
    if (typeof folder === "string") await store.installFromFolder(folder, link);
  };

  return (
    <div className="plugins-panel">
      <div className="plugins-install">
        <div className="plugins-url">
          <input
            placeholder="GitHub repo or .zip / .tar.gz URL"
            value={url}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void installUrl();
            }}
          />
          <button title="Install from URL" disabled={busy || !url.trim()} onClick={() => void installUrl()}>
            <Download size={13} strokeWidth={1.5} />
          </button>
        </div>
        <div className="plugins-actions">
          <button disabled={busy} onClick={() => void chooseFolder(false)} title="Copy a plugin folder into Sable">
            <FolderOpen size={13} strokeWidth={1.5} /> From Folder…
          </button>
          <button disabled={busy} onClick={() => store.setCreateDialogOpen(true)} title="Start a new plugin">
            <FilePlus2 size={13} strokeWidth={1.5} /> Create…
          </button>
        </div>
        <button className="plugins-link" disabled={busy} onClick={() => void chooseFolder(true)}>
          Load a plugin you're developing (linked, reloads on save)…
        </button>
      </div>

      {plugins.length === 0 ? (
        <div className="plugins-empty">
          <Puzzle size={26} strokeWidth={1.25} aria-hidden />
          <p>No plugins yet</p>
          <p className="plugins-hint">
            Plugins add commands, formatters, completions, linters and status-bar items. Create one to see how — it
            takes a minute.
          </p>
        </div>
      ) : (
        <div className="plugins-list">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.manifest.id} plugin={plugin} />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const { manifest } = plugin;
  const state = usePluginStore((store) => store.states[manifest.id] ?? (plugin.enabled ? "starting" : "stopped"));
  const error = usePluginStore((store) => store.errors[manifest.id]);
  const logs = usePluginStore((store) => store.logs[manifest.id]);
  const busy = usePluginStore((store) => store.busy);
  const [open, setOpen] = useState(false);
  const store = usePluginStore.getState();
  const Chevron = open ? ChevronDown : ChevronRight;
  const status = !plugin.enabled ? "disabled" : state === "error" ? "error" : state === "running" ? "running" : state;

  return (
    <div className={`plugin-row ${status}`}>
      <div className="plugin-header" onClick={() => setOpen(!open)}>
        <Chevron size={13} strokeWidth={1.5} className="plugin-chevron" />
        <div className="plugin-title">
          <span className="plugin-name">{manifest.name}</span>
          <span className="plugin-version">{manifest.version}</span>
          {plugin.linked && <span className="plugin-badge">dev</span>}
          {status === "error" && <span className="plugin-badge error">error</span>}
        </div>
        <label className="plugin-toggle" title={plugin.enabled ? "Disable" : "Enable"} onClick={(event) => event.stopPropagation()}>
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
      {open && (
        <div className="plugin-details">
          <div className="plugin-meta">
            {manifest.author && <span>by {manifest.author}</span>}
            <span title={plugin.path}>{plugin.linked ? "linked from " : ""}{plugin.path}</span>
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
              <button onClick={() => void useTabsStore.getState().openFile(`${plugin.path}/${manifest.main}`)}>Edit</button>
            )}
            <button className="danger" disabled={busy} onClick={() => void store.uninstall(manifest.id)}>
              <Trash2 size={12} strokeWidth={1.5} /> {plugin.linked ? "Remove" : "Uninstall"}
            </button>
          </div>
          <div className="plugin-log">
            {(logs ?? []).length === 0 ? (
              <div className="plugin-log-line muted">No output — console.log() in the plugin shows here.</div>
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
