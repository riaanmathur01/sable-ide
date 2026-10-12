import { useEffect, useState } from "react";
import { Check, CircleSlash, Download, Upload, X } from "lucide-react";
import { invokeLocal } from "../../lib/backend";
import { db, type DbValue } from "../../lib/database/api";
import { pickOpenPath, pickSavePath, toast } from "../../lib/database/databaseStore";
import { base64Bytes, bytesBase64, formatBytes, hexDump, isBlob, kindOf, prettyJson, valueText } from "../../lib/database/values";
import type { GridColumn } from "./DataGrid";

type Mode = "text" | "json" | "hex" | "image";

const KIND_LABEL = { null: "NULL", integer: "INTEGER", real: "REAL", text: "TEXT", blob: "BLOB" } as const;
const isMac = navigator.platform.toLowerCase().includes("mac");

/**
 * The Edit Cell pane: the focused cell in full — text (or pretty JSON),
 * a hex view or the image for blobs — with Apply, Set as NULL, and blob
 * import/export from/to a file.
 */
export function EditCellPane({
  path,
  table,
  column,
  value,
  rowKey,
  editable,
  onStore,
  onClose,
}: {
  path: string;
  table: string | null;
  column: GridColumn | undefined;
  value: DbValue | undefined;
  rowKey: DbValue[] | null;
  editable: boolean;
  onStore: (value: DbValue | { text: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("text");
  const [draft, setDraft] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [mime, setMime] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const kind = value === undefined ? null : kindOf(value);
  const identity = JSON.stringify([table, column?.name, rowKey, value === undefined ? "∅" : isBlob(value) ? { b: value.b, d: value.d?.slice(0, 64) } : value]);

  useEffect(() => {
    setBytes(null);
    setMime(null);
    setNatural(null);
    if (value === undefined) {
      setDraft("");
      return;
    }
    if (isBlob(value)) {
      setMime(value.m ?? null);
      setMode(value.m ? "image" : "hex");
      if (value.d !== undefined) setBytes(base64Bytes(value.d));
      else if (table && column && rowKey) {
        void db.blobGet(path, table, rowKey, column.name).then(
          (blob) => {
            setBytes(base64Bytes(blob.d));
            setMime(blob.m);
          },
          (error) => toast(path, String(error), "error"),
        );
      }
      setDraft("");
      return;
    }
    const text = valueText(value);
    const json = prettyJson(text);
    setMode(json ? "json" : "text");
    setDraft(json ?? text);
  }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps

  const original = value === undefined || isBlob(value) ? null : valueText(value);
  const changed =
    value !== undefined && !isBlob(value) && (mode === "json" ? (() => {
      try {
        return JSON.stringify(JSON.parse(draft)) !== JSON.stringify(JSON.parse(original ?? "null"));
      } catch {
        return true;
      }
    })() : draft !== original || (value === null && draft === "" ? false : value === null));

  const apply = async () => {
    let text = draft;
    if (mode === "json") {
      try {
        text = JSON.stringify(JSON.parse(draft));
      } catch (error) {
        toast(path, `Not valid JSON: ${String(error)}`, "error");
        return;
      }
    }
    await onStore({ text });
  };

  const importBlob = async () => {
    const file = await pickOpenPath(path, "All Files", ["*"]);
    if (!file) return;
    try {
      const data = await invokeLocal<string>("read_file_base64", { path: file });
      await onStore({ b: 0, d: data });
    } catch (error) {
      toast(path, String(error), "error");
    }
  };

  const exportValue = async () => {
    if (value === undefined || value === null) return;
    const extension = isBlob(value) ? (mime?.split("/")[1]?.replace("jpeg", "jpg") ?? "bin") : mode === "json" ? "json" : "txt";
    const file = await pickSavePath(`${path.replace(/[/\\][^/\\]*$/, "")}/${column?.name ?? "cell"}.${extension}`, "File", [extension]);
    if (!file) return;
    try {
      if (isBlob(value)) {
        const data = value.d ?? (table && column && rowKey ? (await db.blobGet(path, table, rowKey, column.name)).d : "");
        await invokeLocal("write_file_base64", { path: file, data });
      } else {
        await invokeLocal("write_file", { path: file, contents: mode === "json" ? draft : valueText(value) });
      }
      toast(path, `Saved ${file.split(/[/\\]/).pop()}.`);
    } catch (error) {
      toast(path, String(error), "error");
    }
  };

  const modes: Mode[] = kind === "blob" ? (mime ? ["image", "hex"] : ["hex"]) : ["text", "json"];
  return (
    <div className="db-cellpane">
      <div className="db-cellpane-head">
        <span className="db-cellpane-title">Edit Cell</span>
        <div className="db-seg">
          {modes.map((candidate) => (
            <button key={candidate} className={mode === candidate ? "on" : ""} onClick={() => {
              if (candidate === "json") {
                const json = prettyJson(draft);
                if (json) setDraft(json);
              }
              setMode(candidate);
            }}>
              {candidate === "text" ? "Text" : candidate === "json" ? "JSON" : candidate === "hex" ? "Hex" : "Image"}
            </button>
          ))}
        </div>
        <button className="db-icon" title="Close" onClick={onClose}>
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
      {value === undefined ? (
        <div className="db-cellpane-empty">Select a cell to see it here.</div>
      ) : (
        <>
          <div className="db-cellpane-meta">
            <span className="db-cellpane-column">{column?.name}</span>
            {column?.type && column.type.toUpperCase() !== (kind ? KIND_LABEL[kind] : "") && <span className="db-chip" title="Declared type">{column.type}</span>}
            <span className={`db-chip kind-${kind}`} title="Stored as">{kind ? KIND_LABEL[kind] : ""}</span>
            {isBlob(value) && (
              <span className="db-cellpane-size">
                {natural && mode === "image" ? `${natural.width} × ${natural.height} ${mime?.split("/")[1]?.toUpperCase() ?? ""} · ` : ""}
                {formatBytes(value.b)}
              </span>
            )}
            {!isBlob(value) && value !== null && <span className="db-cellpane-size">{formatCount(valueText(value).length)} chars</span>}
          </div>
          <div className="db-cellpane-body">
            {kind === "blob" ? (
              mode === "image" && bytes && mime ? (
                <div className="db-cellpane-image">
                  <img
                    src={`data:${mime};base64,${bytesBase64(bytes)}`}
                    alt=""
                    className={natural && Math.max(natural.width, natural.height) < 96 ? "small" : ""}
                    style={natural && Math.max(natural.width, natural.height) < 96 ? { width: natural.width * Math.floor(128 / Math.max(natural.width, natural.height)) } : undefined}
                    onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                    onError={() => setMode("hex")}
                  />
                </div>
              ) : (
                <pre className="db-hex">{bytes ? hexDump(bytes) : "Loading…"}</pre>
              )
            ) : (
              <textarea
                className={`db-cellpane-text${value === null && !draft ? " is-null" : ""}`}
                value={draft}
                placeholder={value === null ? "NULL" : ""}
                spellCheck={false}
                readOnly={!editable}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter" && (isMac ? event.metaKey : event.ctrlKey)) {
                    event.preventDefault();
                    void apply();
                  }
                }}
              />
            )}
          </div>
          <div className="db-cellpane-actions">
            <button className="db-button" title="Set this cell to NULL" disabled={!editable || value === null} onClick={() => void onStore(null)}>
              <CircleSlash size={12} strokeWidth={1.8} /> Set as NULL
            </button>
            <button className="db-button icon" title="Import from a file: store its bytes in this cell (a blob)" disabled={!editable} onClick={() => void importBlob()}>
              <Upload size={13} strokeWidth={1.8} />
            </button>
            <button className="db-button icon" title="Export this value to a file" disabled={value === null} onClick={() => void exportValue()}>
              <Download size={13} strokeWidth={1.8} />
            </button>
            <span className="db-toolbar-spacer" />
            <button className="db-button primary" title={`Apply (${isMac ? "⌘" : "Ctrl+"}↵)`} disabled={!editable || kind === "blob" || !changed} onClick={() => void apply()}>
              <Check size={12} strokeWidth={2} /> Apply
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const formatCount = (count: number) => count.toLocaleString("en-US");
