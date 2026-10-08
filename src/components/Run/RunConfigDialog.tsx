import { useEffect, useState } from "react";
import { useRunConfigStore } from "../../store/runConfigStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useDebugStore } from "../../store/debugStore";
import { runFile } from "../../lib/runFile";
import { parseArgs, parseEnv, type RunConfig } from "../../lib/runConfig";
import "./RunConfigDialog.css";

/**
 * Edit Run Configuration: arguments, environment variables and working
 * directory for one file — used by Run (⌘R) and Debug (F5).
 */
export function RunConfigDialog() {
  const path = useRunConfigStore((state) => state.editingPath);
  if (!path) return null;
  return <DialogInner key={path} path={path} />;
}

function DialogInner({ path }: { path: string }) {
  const { configFor, save, closeEditor } = useRunConfigStore.getState();
  const [config, setConfig] = useState<RunConfig>(() => configFor(path));
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const name = path.split(/[/\\]/).pop() ?? path;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeEditor]);

  const commit = (then?: "run" | "debug") => {
    save(path, config);
    closeEditor();
    if (then === "run") void runFile(path);
    if (then === "debug") void useDebugStore.getState().start(path);
  };

  const args = parseArgs(config.args);
  const envCount = Object.keys(parseEnv(config.env)).length;

  return (
    <div className="run-config-backdrop" onMouseDown={closeEditor}>
      <form
        className="run-config"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <h2>Run Configuration — {name}</h2>
        <label>
          <span>Program arguments</span>
          <input
            autoFocus
            value={config.args}
            placeholder={'e.g. --verbose "two words" input.txt'}
            onChange={(event) => setConfig({ ...config, args: event.target.value })}
          />
          {args.length > 0 && (
            <small>
              {args.length} argument{args.length === 1 ? "" : "s"}: {args.map((arg) => `“${arg}”`).join(" ")}
            </small>
          )}
        </label>
        <label>
          <span>Environment variables</span>
          <textarea
            rows={4}
            value={config.env}
            placeholder={"One per line, e.g.\nDEBUG=1\nAPI_URL=http://localhost:8000"}
            onChange={(event) => setConfig({ ...config, env: event.target.value })}
          />
          {envCount > 0 && <small>{envCount} variable{envCount === 1 ? "" : "s"}</small>}
        </label>
        <label>
          <span>Working directory</span>
          <input
            value={config.cwd}
            placeholder={rootPath ?? "The project folder"}
            onChange={(event) => setConfig({ ...config, cwd: event.target.value })}
          />
        </label>
        <p className="run-config-note">
          Run (⌘R) and Debug (F5) use these. While debugging, the program runs in the Debug terminal tab, so it can
          read keyboard input.
        </p>
        <div className="run-config-actions">
          <button type="button" onClick={closeEditor}>
            Cancel
          </button>
          <button type="button" onClick={() => commit("debug")}>
            Save &amp; Debug
          </button>
          <button type="button" onClick={() => commit("run")}>
            Save &amp; Run
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
