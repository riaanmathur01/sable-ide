import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebugStore, type AttachTarget } from "../../store/debugStore";
import "./AttachDialog.css";

interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
}

const KINDS: { kind: AttachTarget["kind"]; label: string; by: "port" | "pid"; defaultPort?: number; hint: string }[] = [
  {
    kind: "python",
    label: "Python",
    by: "port",
    defaultPort: 5678,
    hint: "Start it with: python -m debugpy --listen 5678 your_script.py",
  },
  {
    kind: "node",
    label: "Node.js",
    by: "port",
    defaultPort: 9229,
    hint: "Start it with: node --inspect your_script.js (port 9229)",
  },
  { kind: "go", label: "Go", by: "pid", hint: "Build with -gcflags=all='-N -l' for full variable info" },
  { kind: "native", label: "C / C++ / Rust", by: "pid", hint: "Built with debug info (-g, or a Cargo debug build)" },
  {
    kind: "java",
    label: "Java",
    by: "port",
    defaultPort: 5005,
    hint: "Start the JVM with -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005 (needs a Java file open)",
  },
];

/** Run: Attach to Process… — debug a program that's already running. */
export function AttachDialog() {
  const open = useDebugStore((state) => state.attachDialogOpen);
  return open ? <Dialog /> : null;
}

function Dialog() {
  const close = () => useDebugStore.getState().setAttachDialogOpen(false);
  const [kind, setKind] = useState<AttachTarget["kind"]>("python");
  const spec = KINDS.find((candidate) => candidate.kind === kind)!;
  const [port, setPort] = useState(String(spec.defaultPort ?? ""));
  const [processes, setProcesses] = useState<ProcessInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [pid, setPid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPort(String(spec.defaultPort ?? ""));
    setPid(null);
    if (spec.by === "pid" && processes === null) {
      invoke<ProcessInfo[]>("list_processes").then(setProcesses, (failure) => setError(String(failure)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (processes ?? [])
      .filter((process) => !needle || `${process.pid} ${process.name} ${process.command}`.toLowerCase().includes(needle))
      .slice(0, 200);
  }, [processes, filter]);

  const attach = () => {
    if (spec.by === "port") {
      const value = Number(port);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) return setError("Enter a port number");
      void useDebugStore.getState().attach({ kind, port: value, label: `${spec.label} on port ${value}` });
    } else {
      const process = processes?.find((candidate) => candidate.pid === pid);
      if (!process) return setError("Choose a process");
      void useDebugStore.getState().attach({ kind, pid: process.pid, label: `${process.name} (pid ${process.pid})` });
    }
  };

  return (
    <div className="attach-backdrop" onMouseDown={close}>
      <form
        className="attach-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          attach();
        }}
        onKeyDown={(event) => event.key === "Escape" && close()}
      >
        <div className="attach-title">Attach to Process</div>
        <div className="attach-kinds">
          {KINDS.map((candidate) => (
            <button
              key={candidate.kind}
              type="button"
              className={candidate.kind === kind ? "selected" : ""}
              onClick={() => setKind(candidate.kind)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <p className="attach-hint">{spec.hint}</p>
        {spec.by === "port" ? (
          <label>
            Port
            <input autoFocus value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
          </label>
        ) : (
          <>
            <input
              autoFocus
              className="attach-filter"
              placeholder="Filter by name, command or pid"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="attach-processes">
              {processes === null && !error && <div className="attach-empty">Loading…</div>}
              {shown.map((process) => (
                <button
                  type="button"
                  key={process.pid}
                  className={process.pid === pid ? "attach-process selected" : "attach-process"}
                  onClick={() => setPid(process.pid)}
                  onDoubleClick={() => {
                    setPid(process.pid);
                    void useDebugStore
                      .getState()
                      .attach({ kind, pid: process.pid, label: `${process.name} (pid ${process.pid})` });
                  }}
                  title={process.command}
                >
                  <span className="attach-pid">{process.pid}</span>
                  <span className="attach-name">{process.name}</span>
                  <span className="attach-command">{process.command}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div className="attach-error">{error}</div>}
        <div className="attach-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Attach
          </button>
        </div>
      </form>
    </div>
  );
}
