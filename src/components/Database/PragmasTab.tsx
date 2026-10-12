import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { db, type DbValue } from "../../lib/database/api";
import { refreshSchema, toast, useDatabaseStore } from "../../lib/database/databaseStore";
import { valueText } from "../../lib/database/values";

type Field =
  | { name: string; label: string; kind: "bool"; help?: string }
  | { name: string; label: string; kind: "number"; help?: string }
  | { name: string; label: string; kind: "select"; options: [string, string][]; help?: string }
  | { name: string; label: string; kind: "info"; help?: string };

const SECTIONS: { title: string; note: string; fields: Field[] }[] = [
  {
    title: "Database file",
    note: "Stored in the file.",
    fields: [
      { name: "journal_mode", label: "Journal Mode", kind: "select", options: [["delete", "Delete"], ["truncate", "Truncate"], ["persist", "Persist"], ["memory", "Memory"], ["wal", "WAL"], ["off", "Off"]] },
      { name: "page_size", label: "Page Size", kind: "select", options: ["512", "1024", "2048", "4096", "8192", "16384", "32768", "65536"].map((size) => [size, `${Number(size).toLocaleString("en-US")} bytes`]), help: "Takes effect after a VACUUM (run automatically)." },
      { name: "auto_vacuum", label: "Auto Vacuum", kind: "select", options: [["0", "None"], ["1", "Full"], ["2", "Incremental"]], help: "Changing it runs a VACUUM." },
      { name: "user_version", label: "User Version", kind: "number" },
      { name: "application_id", label: "Application ID", kind: "number" },
      { name: "encoding", label: "Encoding", kind: "info" },
    ],
  },
  {
    title: "Connection",
    note: "For this session.",
    fields: [
      { name: "foreign_keys", label: "Foreign Keys", kind: "bool", help: "Enforce foreign key constraints." },
      { name: "recursive_triggers", label: "Recursive Triggers", kind: "bool" },
      { name: "ignore_check_constraints", label: "Ignore Check Constraints", kind: "bool" },
      { name: "automatic_index", label: "Automatic Index", kind: "bool" },
      { name: "secure_delete", label: "Secure Delete", kind: "bool" },
      { name: "synchronous", label: "Synchronous", kind: "select", options: [["0", "Off"], ["1", "Normal"], ["2", "Full"], ["3", "Extra"]] },
      { name: "temp_store", label: "Temp Store", kind: "select", options: [["0", "Default"], ["1", "File"], ["2", "Memory"]] },
      { name: "locking_mode", label: "Locking Mode", kind: "select", options: [["normal", "Normal"], ["exclusive", "Exclusive"]] },
      { name: "cache_size", label: "Cache Size", kind: "number", help: "Pages; negative: KiB." },
      { name: "busy_timeout", label: "Busy Timeout", kind: "number", help: "Milliseconds." },
      { name: "journal_size_limit", label: "Journal Size Limit", kind: "number" },
      { name: "wal_autocheckpoint", label: "WAL Auto Checkpoint", kind: "number" },
      { name: "max_page_count", label: "Max Page Count", kind: "number" },
      { name: "fullfsync", label: "Full FSYNC", kind: "bool" },
      { name: "checkpoint_fullfsync", label: "Checkpoint Full FSYNC", kind: "bool" },
    ],
  },
  {
    title: "Statistics",
    note: "Read-only.",
    fields: [
      { name: "page_count", label: "Page Count", kind: "info" },
      { name: "freelist_count", label: "Free Pages", kind: "info" },
      { name: "schema_version", label: "Schema Version", kind: "info" },
      { name: "data_version", label: "Data Version", kind: "info" },
    ],
  },
];

const text = (value: DbValue | undefined) => (value === undefined || value === null ? "" : valueText(value).toLowerCase());

/** Edit Pragmas: the common pragmas as a form; Save applies the changed ones. */
export function PragmasTab({ path }: { path: string }) {
  const dataVersion = useDatabaseStore((state) => state.docs[path]?.dataVersion ?? 0);
  const dirty = useDatabaseStore((state) => state.docs[path]?.dirty ?? false);
  const readOnly = useDatabaseStore((state) => state.docs[path]?.readOnly ?? false);
  const [values, setValues] = useState<Record<string, DbValue> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void db.pragmasGet(path).then(
      (result) => {
        if (cancelled) return;
        setValues(result.pragmas);
        setDraft({});
      },
      (error) => toast(path, String(error), "error"),
    );
    return () => {
      cancelled = true;
    };
  }, [path, dataVersion]);

  if (!values) return <div className="db-empty-page">Reading pragmas…</div>;
  const valueOf = (name: string) => draft[name] ?? text(values[name]);
  const changed = Object.entries(draft).filter(([name, value]) => value !== text(values[name]));

  const save = async () => {
    setSaving(true);
    try {
      const result = await db.pragmasSet(path, Object.fromEntries(changed));
      setValues(result.pragmas);
      setDraft({});
      await refreshSchema(path, false);
      toast(path, `Pragmas saved (${changed.map(([name]) => name).join(", ")}).`);
    } catch (error) {
      toast(path, String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="db-pragmas">
      <div className="db-subbar">
        <button className="db-tool" disabled={changed.length === 0 || saving} title="Apply the changed pragmas" onClick={() => void save()}>
          <Save size={13} strokeWidth={1.6} /> <span>Save</span>
        </button>
        <button className="db-tool" disabled={changed.length === 0} title="Undo your edits to the form" onClick={() => setDraft({})}>
          <RotateCcw size={13} strokeWidth={1.6} /> <span>Reset</span>
        </button>
        <div className="db-toolbar-spacer" />
        {dirty && changed.length > 0 && <span className="db-subbar-note warn">Write or revert your changes before saving pragmas.</span>}
        {readOnly && <span className="db-subbar-note">Read-only: only connection pragmas can change.</span>}
      </div>
      <div className="db-pragmas-scroll">
        <div className="db-pragmas-grid">
          {SECTIONS.map((section) => (
            <section key={section.title} className="db-pragma-section">
              <h3>
                {section.title} <span>{section.note}</span>
              </h3>
              {section.fields.map((field) => {
                const value = valueOf(field.name);
                const isChanged = draft[field.name] !== undefined && draft[field.name] !== text(values[field.name]);
                const set = (next: string) => setDraft((current) => ({ ...current, [field.name]: next }));
                return (
                  <label key={field.name} className={`db-pragma${isChanged ? " changed" : ""}`} title={field.help ?? `PRAGMA ${field.name}`} data-pragma={field.name}>
                    <span className="db-pragma-label">
                      {field.label}
                      <code>{field.name}</code>
                    </span>
                    {field.kind === "bool" ? (
                      <input type="checkbox" checked={value === "1"} onChange={(event) => set(event.target.checked ? "1" : "0")} />
                    ) : field.kind === "select" ? (
                      <select value={value} onChange={(event) => set(event.target.value)}>
                        {!field.options.some(([option]) => option === value) && <option value={value}>{value}</option>}
                        {field.options.map(([option, label]) => (
                          <option key={option} value={option}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : field.kind === "number" ? (
                      <input type="number" value={value} onChange={(event) => set(event.target.value)} />
                    ) : (
                      <span className="db-pragma-info">{valueText(values[field.name] ?? null) || "—"}</span>
                    )}
                  </label>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
