import { useMemo, useState } from "react";
import { FileJson, Keyboard, RotateCcw, X } from "lucide-react";
import {
  COMMANDS,
  EDITOR_ACTIONS,
  FIXED_SHORTCUTS,
  defaultKeysFor,
  keybindingsPath,
  keysFor,
  useShortcutStore,
} from "../../lib/shortcuts";
import { formatKey, keyFromEvent } from "../../lib/plugins/keybindings";
import { paletteCommands } from "../CommandPalette/CommandPalette";
import { useTabsStore } from "../../store/tabsStore";
import { pathExists, writeFile } from "../../lib/ipc";
import "./ShortcutsEditor.css";

interface Row {
  id: string;
  title: string;
  whenLabel?: string;
  kind: "sable" | "editor" | "palette";
}

function allRows(): Row[] {
  const rows: Row[] = [
    ...COMMANDS.map((command) => ({ id: command.id, title: command.title, whenLabel: command.whenLabel, kind: "sable" as const })),
    ...EDITOR_ACTIONS.map((action) => ({ id: action.id, title: action.title, whenLabel: "editor", kind: "editor" as const })),
  ];
  const known = new Set(rows.map((row) => row.id));
  const titles = new Set(rows.map((row) => row.title.toLowerCase()));
  for (const command of paletteCommands()) {
    // Palette entries that are the same as a built-in command aren't listed twice.
    if (!known.has(command.id) && !titles.has(command.label.toLowerCase())) {
      rows.push({ id: command.id, title: command.label, kind: "palette" });
    }
  }
  return rows;
}

/**
 * Settings → Keyboard Shortcuts: every command with its keys. Change one
 * by pressing the new key; it's written to keybindings.json (VS Code's
 * format), which can also be edited by hand.
 */
export function ShortcutsEditor({ query }: { query: string }) {
  const user = useShortcutStore((state) => state.user);
  const error = useShortcutStore((state) => state.error);
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const rows = useMemo(allRows, []);
  const search = (query || filter).trim().toLowerCase();

  // Which commands each key is on (to point out clashes).
  const owners = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      for (const key of keysFor(row.id, user)) {
        const normalized = key.toLowerCase();
        map.set(normalized, [...(map.get(normalized) ?? []), row.title]);
      }
    }
    return map;
  }, [rows, user]);

  const visible = rows.filter((row) => {
    if (!search) return true;
    const keys = keysFor(row.id, user).map(formatKey).join(" ").toLowerCase();
    return row.title.toLowerCase().includes(search) || row.id.toLowerCase().includes(search) || keys.includes(search);
  });
  if (query && visible.length === 0) return null;

  const openFile = async () => {
    const path = keybindingsPath();
    if (!path) return;
    if (!(await pathExists(path))) await writeFile(path, "// Your keyboard shortcuts (VS Code's format).\n[\n]\n");
    await useTabsStore.getState().openFile(path);
  };

  return (
    <section id="settings-section-Keyboard Shortcuts" className="settings-section shortcuts-editor">
      <h2>Keyboard Shortcuts</h2>
      <div className="shortcuts-toolbar">
        {!query && (
          <input
            className="settings-input"
            placeholder="Search commands or keys"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <button className="shortcuts-button" onClick={() => void openFile()}>
          <FileJson size={13} strokeWidth={1.5} /> Open keybindings.json
        </button>
      </div>
      {error && <div className="shortcuts-error">{error}</div>}
      <div className="shortcuts-list">
        {visible.map((row) => {
          const keys = keysFor(row.id, user);
          const modified = user.some((entry) => entry.command === row.id || entry.command === `-${row.id}`);
          const clashes = keys.flatMap((key) => (owners.get(key.toLowerCase()) ?? []).filter((title) => title !== row.title));
          return (
            <div key={row.id} className={modified ? "shortcuts-row modified" : "shortcuts-row"}>
              <div className="shortcuts-title">
                <span>{row.title}</span>
                <span className="shortcuts-id">
                  {row.id}
                  {row.whenLabel ? ` · when ${row.whenLabel}` : ""}
                </span>
                {clashes.length > 0 && <span className="shortcuts-clash">Also: {[...new Set(clashes)].join(", ")}</span>}
              </div>
              {recording === row.id ? (
                <div
                  className="shortcuts-recorder"
                  tabIndex={0}
                  data-recording-shortcut
                  ref={(element) => element?.focus()}
                  onBlur={() => setRecording(null)}
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Escape") {
                      setRecording(null);
                      return;
                    }
                    const key = keyFromEvent(event.nativeEvent);
                    if (!key) return;
                    setRecording(null);
                    void useShortcutStore.getState().setKeys(row.id, [key]);
                  }}
                >
                  Press the new shortcut… (Esc to cancel)
                </div>
              ) : (
                <button className="shortcuts-keys" title="Change" onClick={() => setRecording(row.id)}>
                  {keys.length ? keys.map((key) => <kbd key={key}>{formatKey(key)}</kbd>) : <span className="shortcuts-none">Add</span>}
                </button>
              )}
              <div className="shortcuts-actions">
                {keys.length > 0 && (
                  <button title="Remove the shortcut" onClick={() => void useShortcutStore.getState().setKeys(row.id, [])}>
                    <X size={12} strokeWidth={1.75} />
                  </button>
                )}
                {modified && (
                  <button
                    title={`Back to the default${defaultKeysFor(row.id).length ? ` (${defaultKeysFor(row.id).map(formatKey).join(", ")})` : ""}`}
                    onClick={() => void useShortcutStore.getState().setKeys(row.id, null)}
                  >
                    <RotateCcw size={12} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!search && (
        <div className="shortcuts-fixed">
          <Keyboard size={13} strokeWidth={1.5} />
          {FIXED_SHORTCUTS.map((shortcut) => `${shortcut.keys}: ${shortcut.title}`).join(" · ")}
        </div>
      )}
    </section>
  );
}
