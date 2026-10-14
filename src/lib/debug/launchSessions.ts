import { invoke } from "../backend";
import { handleStopped, setDebugRouter, type DapMessage } from "./debugClient";
import { useDebugStore } from "../../store/debugStore";
import { useTerminalStore } from "../../store/terminalStore";
import { useUiStore } from "../../store/uiStore";
import { useLaunchStore, type LaunchSession } from "../../store/launchStore";

/**
 * Several debug sessions at once (launch.json compounds). Sessions
 * started from launch.json are named; their events carry
 * `sableSession`. The *focused* one is the window's ordinary session: its
 * events take the usual path (debugClient → debugStore). The others run
 * in the background: their output goes to the debug console prefixed with
 * their name, and one that stops (a breakpoint) takes the focus, as in VS
 * Code. When the focused session ends, another takes over — or, for a
 * compound with `stopAll`, they all stop.
 */

type Payload = { sableSession?: string } & Record<string, unknown>;

const live = () => useLaunchStore.getState().sessions.filter((session) => session.state !== "ended");
const find = (id: string) => useLaunchStore.getState().sessions.find((session) => session.id === id);

/** Make `id` the session the debug view and controls drive. */
export async function focusSession(id: string): Promise<void> {
  const session = find(id);
  if (!session || session.state === "ended") return;
  const store = useLaunchStore.getState();
  if (store.focusedSession === id && useDebugStore.getState().isDebugging) return;
  await invoke("debug_config_focus", { session: id });
  useLaunchStore.setState({ focusedSession: id });
  useDebugStore.setState({ isDebugging: true });
  useDebugStore.getState().setRunning();
  if (session.state === "paused" && session.threadId !== null) {
    await handleStopped({ threadId: session.threadId, reason: session.reason ?? "breakpoint" });
  }
}

/** A session ended: forget it, run its postDebugTask, and with a
 *  `stopAll` compound stop the rest. */
function sessionEnded(session: LaunchSession): void {
  if (session.state === "ended") return;
  useLaunchStore.getState().updateSession(session.id, { state: "ended" });
  void invoke("debug_config_stop", { session: session.id }).catch(() => {});
  if (session.postDebugTask) {
    const label = session.postDebugTask;
    void import("./launchRunner").then(({ runNamedTask }) =>
      runNamedTask(label, session.source).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        useDebugStore.getState().appendConsole("error", message);
        useUiStore.getState().setLastError(message);
      }),
    );
  }
  const { compound } = useLaunchStore.getState();
  if (compound?.stopAll && live().length) void stopAllLaunchSessions(true);
}

/** Stop every launch.json session (a new launch, or `stopAll`). */
export async function stopAllLaunchSessions(endFocused = false): Promise<void> {
  const { sessions, focusedSession } = useLaunchStore.getState();
  if (!sessions.some((session) => session.state !== "ended")) {
    useLaunchStore.setState({ sessions: [], focusedSession: null });
    return;
  }
  useLaunchStore.setState({
    sessions: sessions.map((session) => ({ ...session, state: "ended" as const })),
    focusedSession: null,
  });
  await invoke("debug_config_stop_all").catch(() => {});
  if (endFocused && focusedSession && useDebugStore.getState().isDebugging) useDebugStore.getState().setTerminated();
}

function backgroundMessage(session: LaunchSession, message: DapMessage): void {
  if (message.type !== "event") return;
  const debug = useDebugStore.getState();
  const body = (message.body ?? {}) as Record<string, unknown>;
  switch (message.event) {
    case "output": {
      const output = typeof body.output === "string" ? body.output.replace(/\n$/, "") : "";
      if (!output || body.category === "telemetry") return;
      const category = body.category === "stderr" ? "stderr" : body.category === "stdout" ? "stdout" : "console";
      debug.appendConsole(category, `[${session.name}] ${output}`);
      return;
    }
    case "stopped": {
      const threadId = typeof body.threadId === "number" ? body.threadId : 0;
      const reason = typeof body.reason === "string" ? body.reason : "pause";
      useLaunchStore.getState().updateSession(session.id, { state: "paused", threadId, reason });
      // Like VS Code: a session that stops takes the focus (unless the
      // focused one is paused too — then say so).
      if (!debug.isPaused) void focusSession(session.id);
      else useUiStore.getState().showStatus(`“${session.name}” paused (${reason}) — select it under Sessions`);
      return;
    }
    case "continued":
      useLaunchStore.getState().updateSession(session.id, { state: "running", threadId: null, reason: null });
      return;
    case "terminated":
    case "exited":
      if (message.event === "exited" && typeof body.exitCode === "number") {
        debug.appendConsole("console", `[${session.name}] Process exited with code ${body.exitCode}`);
      }
      sessionEnded(session);
      return;
  }
}

/** A named session asks to start its program in a terminal tab. */
async function runInTerminal(session: LaunchSession, payload: Payload): Promise<void> {
  const { id, args, cwd, env } = payload as { id: number; args: string[]; cwd?: string; env?: Record<string, string | null> };
  try {
    const pid = await useTerminalStore
      .getState()
      .startCommandSession({ args, cwd: cwd ?? null, env: env ?? null }, `Debug: ${session.name}`, `debug:${session.name}`);
    if (id !== 0) await invoke("debug_config_terminal_started", { session: session.id, id, processId: pid });
  } catch (error) {
    if (id !== 0) await invoke("debug_config_terminal_started", { session: session.id, id, error: String(error) });
    useDebugStore.getState().appendConsole("error", `Couldn't start the program in a terminal: ${String(error)}`);
  }
}

function route(channel: "message" | "status" | "terminal", raw: unknown): boolean {
  const payload = raw as Payload;
  const id = payload?.sableSession;
  if (!id) return false;
  const session = find(id);
  // A session already stopped (or replaced): ignore its stragglers.
  if (!session || session.state === "ended") return true;
  if (channel === "terminal") {
    void runInTerminal(session, payload);
    return true;
  }
  const focused = useLaunchStore.getState().focusedSession === id;
  // The adapter refused the launch/attach request: say why.
  const reply = payload as unknown as DapMessage;
  if (channel === "message" && reply.type === "response" && (reply.command === "launch" || reply.command === "attach") && reply.success === false) {
    const message = `“${session.name}”: ${reply.message || `the debugger couldn't ${reply.command}`}`;
    useDebugStore.getState().appendConsole("error", message);
    useUiStore.getState().setLastError(message);
  }
  if (focused) {
    // The usual path; just keep track of where it is.
    if (channel === "message") {
      const message = payload as unknown as DapMessage;
      if (message.type === "event" && message.event === "stopped") {
        const body = (message.body ?? {}) as { threadId?: number; reason?: string };
        useLaunchStore.getState().updateSession(id, { state: "paused", threadId: body.threadId ?? 0, reason: body.reason ?? null });
      } else if (message.type === "event" && message.event === "continued") {
        useLaunchStore.getState().updateSession(id, { state: "running", threadId: null });
      }
    }
    return false;
  }
  if (channel === "status") {
    if (payload.state === "terminated") sessionEnded(session);
    return true;
  }
  backgroundMessage(session, payload as unknown as DapMessage);
  return true;
}

let installed = false;

export function installSessionRouting(): void {
  if (installed) return;
  installed = true;
  setDebugRouter(route);
  // The focused session ended (or was stopped): another takes over.
  useDebugStore.subscribe((state, previous) => {
    if (!previous.isDebugging || state.isDebugging) return;
    const { focusedSession } = useLaunchStore.getState();
    if (!focusedSession) return;
    const session = find(focusedSession);
    useLaunchStore.setState({ focusedSession: null });
    if (session) sessionEnded(session);
    setTimeout(() => {
      if (useDebugStore.getState().isDebugging) return;
      const next = live()[0];
      if (next) void focusSession(next.id);
    }, 250);
  });
}
