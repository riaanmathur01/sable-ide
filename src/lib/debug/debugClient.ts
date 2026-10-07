import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDebugStore, type StackFrame } from "../../store/debugStore";

/**
 * Frontend side of the DAP bridge. Rust owns the debugpy process and
 * relays every adapter message as a `debug:message` event; this module
 * correlates responses to requests by `request_seq` and dispatches events
 * (stopped / continued / output / terminated). The launch handshake
 * itself lives in Rust (src-tauri/src/debug.rs).
 */

export interface DapMessage {
  type: "response" | "event" | "request";
  request_seq?: number;
  success?: boolean;
  message?: string;
  command?: string;
  body?: unknown;
  event?: string;
}

/** One variable row; `variablesReference > 0` means it can expand. */
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

// Frontend-minted seqs start high so they never collide with the seqs
// Rust uses during the handshake (initialize/launch/setBreakpoints/...).
let seqCounter = 100000;
const pending = new Map<number, (response: DapMessage) => void>();
const REQUEST_TIMEOUT_MS = 5000;

/** Send a DAP request and await its response (null on timeout/error). */
export function sendDebugRequest(
  command: string,
  args: Record<string, unknown> = {},
): Promise<DapMessage | null> {
  const seq = ++seqCounter;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(seq);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pending.set(seq, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    invoke("debug_request", { seq, command, arguments: args }).catch(() => {
      clearTimeout(timer);
      pending.delete(seq);
      resolve(null);
    });
  });
}

/** Fetch the children of a scope or structured variable. */
export async function loadVariables(
  variablesReference: number,
): Promise<DebugVariable[]> {
  if (variablesReference <= 0) return [];
  const response = await sendDebugRequest("variables", { variablesReference });
  const variables =
    (response?.body as { variables?: DebugVariable[] } | undefined)
      ?.variables ?? [];
  // debugpy lists "special variables"/"function variables" groups first;
  // they're noise for everyday debugging.
  return variables.filter(
    (variable) =>
      variable.name !== "special variables" &&
      variable.name !== "function variables",
  );
}

/**
 * A `stopped` event only carries a threadId — ask for the stack to learn
 * where (lines are 1-based, matching Monaco).
 */
async function handleStopped(body: {
  threadId?: number;
  reason?: string;
  description?: string;
  text?: string;
}): Promise<void> {
  const threadId = body.threadId ?? 0;
  const response = await sendDebugRequest("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 50,
  });
  const rawFrames =
    (response?.body as
      | {
          stackFrames?: {
            id: number;
            name: string;
            line: number;
            source?: { path?: string };
          }[];
        }
      | undefined)?.stackFrames ?? [];
  const frames: StackFrame[] = rawFrames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    path: frame.source?.path ?? null,
    line: frame.line,
  }));
  const reason = body.reason ?? "pause";
  if (reason === "exception") {
    useDebugStore
      .getState()
      .appendConsole(
        "error",
        `Paused on exception: ${body.text ?? body.description ?? ""}`.trim(),
      );
  }
  useDebugStore.getState().setStopped(threadId, reason, frames);
}

let listenersReady = false;

export function initDebugListeners(): void {
  if (listenersReady) return;
  listenersReady = true;

  listen<DapMessage>("debug:message", (event) => {
    const message = event.payload;
    if (message.type === "response" && message.request_seq != null) {
      const resolver = pending.get(message.request_seq);
      if (resolver) {
        pending.delete(message.request_seq);
        resolver(message);
      }
      return;
    }
    if (message.type !== "event") return;
    const store = useDebugStore.getState();
    switch (message.event) {
      case "stopped":
        void handleStopped(
          (message.body ?? {}) as { threadId?: number; reason?: string },
        );
        break;
      case "continued":
        if (store.isPaused) store.setRunning();
        break;
      case "output": {
        const body = (message.body ?? {}) as {
          category?: string;
          output?: string;
        };
        // "telemetry" is adapter chatter, not user output.
        if (!body.output || body.category === "telemetry") break;
        const category =
          body.category === "stderr"
            ? "stderr"
            : body.category === "stdout"
              ? "stdout"
              : "console";
        store.appendConsole(category, body.output.replace(/\n$/, ""));
        break;
      }
      case "terminated":
      case "exited": {
        if (message.event === "exited") {
          const exitCode = (message.body as { exitCode?: number } | undefined)
            ?.exitCode;
          if (exitCode != null) {
            store.appendConsole("console", `Process exited with code ${exitCode}`);
          }
        }
        store.setTerminated();
        // Reap the adapter process too.
        void invoke("debug_stop").catch(() => {});
        break;
      }
    }
  });

  listen<{ state: string }>("debug:status", (event) => {
    if (event.payload.state === "terminated") {
      useDebugStore.getState().setTerminated();
    }
  });
}
