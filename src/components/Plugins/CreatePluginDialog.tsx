import { useEffect, useState } from "react";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { usePluginStore } from "../../store/pluginStore";
import { pluginId } from "../../lib/plugins/scaffold";
import { PERMISSION_DESCRIPTIONS, type PluginPermission } from "../../lib/plugins/types";
import "./Plugins.css";

/** Plugins: Create New Plugin… — a working plugin to start from. */
export function CreatePluginDialog() {
  const open = usePluginStore((state) => state.createDialogOpen);
  return open ? <Dialog /> : null;
}

function Dialog() {
  const close = () => usePluginStore.getState().setCreateDialogOpen(false);
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

  const create = () => {
    if (!name.trim() || !idValid || !parent.trim() || busy) return;
    void usePluginStore.getState().createPlugin({ name: name.trim(), id: effectiveId, parent: parent.trim(), permissions });
  };

  return (
    <div className="plugin-dialog-backdrop" onMouseDown={close}>
      <form
        className="plugin-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && close()}
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h2>Create Plugin</h2>
        <label>
          <span>Name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>ID {!idValid && <em className="plugin-dialog-problem">— lowercase letters, digits, '-' and '.'</em>}</span>
          <input value={effectiveId} spellCheck={false} onChange={(event) => setId(event.target.value)} />
        </label>
        <label>
          <span>Location</span>
          <div className="plugin-dialog-row">
            <input value={parent} spellCheck={false} onChange={(event) => setParent(event.target.value)} />
            <button
              type="button"
              onClick={async () => {
                const folder = await openNativeDialog({ directory: true, title: "Create the Plugin In" });
                if (typeof folder === "string") setParent(folder);
              }}
            >
              Choose…
            </button>
          </div>
          <small>The plugin goes in {parent ? `${parent.replace(/[/\\]+$/, "")}/${effectiveId}` : "…"}</small>
        </label>
        <fieldset>
          <legend>Permissions (you can change them later in sable-plugin.json)</legend>
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
        <p className="plugin-dialog-note">
          Sable writes a working example (a command, a word counter and a formatter), loads it in development mode and
          opens main.js. It reloads every time you save.
        </p>
        <div className="plugin-dialog-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !idValid || !parent.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
