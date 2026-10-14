import { Play, Plus, Settings, Square } from "lucide-react";
import { useDebugStore } from "../../store/debugStore";
import { useTabsStore } from "../../store/tabsStore";
import { AUTO_FILE_KEY, useLaunchStore } from "../../store/launchStore";
import { addConfiguration, openLaunchJson, startDebugging } from "../../lib/debug/launchRunner";
import { focusSession } from "../../lib/debug/launchSessions";
import { invoke } from "../../lib/backend";
import "./LaunchConfigBar.css";

const ADD_CONFIGURATION = "__add__";

/**
 * Run and Debug's configuration picker (VS Code's): the launch.json
 * configurations and compounds, then Sable's own "Current File", with
 * ▶ to start the selection (F5), the gear to open launch.json, and +
 * to add a configuration. Without a launch.json: a link to create one.
 */
export function LaunchConfigBar() {
  const entries = useLaunchStore((state) => state.entries);
  const selectedKey = useLaunchStore((state) => state.selectedKey);
  const launching = useLaunchStore((state) => state.launching);
  const isDebugging = useDebugStore((state) => state.isDebugging);
  const lastFilePath = useTabsStore((state) => state.lastFilePath);

  if (entries.length === 0) {
    return (
      <div className="launch-create">
        <button className="launch-link" onClick={() => void openLaunchJson()}>
          Create a launch.json file
        </button>{" "}
        to customize Run and Debug (VS Code configurations work as they are).
      </div>
    );
  }

  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const value = selected?.key ?? AUTO_FILE_KEY;
  const configs = entries.filter((entry) => entry.kind === "config");
  const compounds = entries.filter((entry) => entry.kind === "compound");
  const fileName = lastFilePath?.split(/[/\\]/).pop();
  const detail = selected
    ? selected.kind === "compound"
      ? `Compound: ${selected.compound.configurations.map((member) => (typeof member === "string" ? member : member.name)).join(" + ")}`
      : [selected.config.type, selected.config.request, selected.config.preLaunchTask && `runs “${selected.config.preLaunchTask}” first`]
          .filter(Boolean)
          .join(" · ")
    : fileName
      ? `Debugs ${fileName} with Sable's defaults`
      : "Debugs the open file with Sable's defaults";

  return (
    <div className="launch-bar-wrap">
      <div className="launch-bar">
        <button
          className="launch-start"
          title={isDebugging ? "Already debugging" : "Start Debugging (F5)"}
          aria-label="Start Debugging"
          disabled={isDebugging || launching !== null}
          onClick={() => void startDebugging()}
        >
          <Play size={13} strokeWidth={2} fill="currentColor" />
        </button>
        <select
          className="launch-select"
          aria-label="Debug configuration"
          value={value}
          title={selected?.label ?? "Current File"}
          onChange={(event) => {
            const key = event.target.value;
            if (key === ADD_CONFIGURATION) {
              void addConfiguration();
              return;
            }
            useLaunchStore.getState().select(key);
          }}
        >
          <optgroup label="launch.json">
            {configs.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </optgroup>
          {compounds.length > 0 && (
            <optgroup label="Compounds">
              {compounds.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Sable">
            <option value={AUTO_FILE_KEY}>Current File{fileName ? ` (${fileName})` : ""}</option>
          </optgroup>
          <option value={ADD_CONFIGURATION}>Add Configuration…</option>
        </select>
        <button className="launch-icon" title="Open launch.json" aria-label="Open launch.json" onClick={() => void openLaunchJson(selected?.source.folder ?? undefined)}>
          <Settings size={14} strokeWidth={1.6} />
        </button>
        <button className="launch-icon" title="Add Configuration…" aria-label="Add Configuration" onClick={() => void addConfiguration()}>
          <Plus size={15} strokeWidth={1.6} />
        </button>
      </div>
      <div className="launch-detail">{launching ?? detail}</div>
    </div>
  );
}

/** The sessions of a running compound: click one to inspect it. */
export function LaunchSessions() {
  const sessions = useLaunchStore((state) => state.sessions);
  const focused = useLaunchStore((state) => state.focusedSession);
  const live = sessions.filter((session) => session.state !== "ended");
  if (live.length < 2) return null;
  return (
    <div className="launch-sessions">
      <div className="launch-sessions-title">Sessions</div>
      {live.map((session) => (
        <div
          key={session.id}
          className={session.id === focused ? "launch-session focused" : "launch-session"}
          onClick={() => void focusSession(session.id)}
          title="Show this session's call stack and variables"
        >
          <span className={`launch-session-dot ${session.state}`} />
          <span className="launch-session-name">{session.name}</span>
          <span className="launch-session-state" title={session.reason ? `Paused on ${session.reason}` : undefined}>
            {session.state === "paused" ? "paused" : "running"}
          </span>
          <button
            className="launch-icon small"
            title="Stop this session"
            onClick={(event) => {
              event.stopPropagation();
              if (session.id === focused) void useDebugStore.getState().stop();
              else {
                useLaunchStore.getState().updateSession(session.id, { state: "ended" });
                void invoke("debug_config_stop", { session: session.id });
              }
            }}
          >
            <Square size={10} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
