import { ExternalLink, Plus, X } from "lucide-react";
import { openForwardedPort, useRemoteStore } from "../../store/remoteStore";
import "./PortsPanel.css";

/**
 * Bottom panel → Ports (remote windows): the remote's ports that are
 * reachable here, and the ones listening that aren't (yet).
 */
export function PortsPanel() {
  const label = useRemoteStore((state) => state.label);
  const listening = useRemoteStore((state) => state.listening);
  const forwarded = useRemoteStore((state) => state.forwarded);
  const notForwarded = listening.filter((port) => !forwarded.some((entry) => entry.remotePort === port));
  const store = useRemoteStore.getState();

  return (
    <div className="ports-panel">
      <div className="ports-toolbar">
        <span>
          Ports on {label} — forwarded ones open at <code>localhost</code> here
        </span>
        <button className="ports-button" onClick={() => void store.promptForwardPort()}>
          <Plus size={12} strokeWidth={1.75} /> Forward a Port…
        </button>
      </div>
      {forwarded.length === 0 && notForwarded.length === 0 ? (
        <div className="ports-empty">
          No ports yet. When a program on the remote starts listening (a dev server, say), it's forwarded here by itself.
        </div>
      ) : (
        <table className="ports-table">
          <thead>
            <tr>
              <th>Port</th>
              <th>Local address</th>
              <th>How</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {forwarded.map((port) => (
              <tr key={port.remotePort}>
                <td>
                  <span className={listening.includes(port.remotePort) ? "ports-dot on" : "ports-dot"} />
                  {port.remotePort}
                </td>
                <td>
                  <button className="ports-link" title="Open in the browser" onClick={() => openForwardedPort(port)}>
                    localhost:{port.localPort}
                  </button>
                </td>
                <td className="ports-muted">{port.auto ? "automatic" : "by you"}</td>
                <td className="ports-actions">
                  <button title="Open in the browser" onClick={() => openForwardedPort(port)}>
                    <ExternalLink size={13} strokeWidth={1.5} />
                  </button>
                  <button title="Stop forwarding" onClick={() => void store.stopForwarding(port.remotePort)}>
                    <X size={13} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
            ))}
            {notForwarded.map((port) => (
              <tr key={`listening-${port}`} className="ports-idle">
                <td>
                  <span className="ports-dot on" />
                  {port}
                </td>
                <td className="ports-muted">not forwarded</td>
                <td className="ports-muted">listening</td>
                <td className="ports-actions">
                  <button className="ports-forward" onClick={() => void store.forwardPort(port)}>
                    Forward
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
