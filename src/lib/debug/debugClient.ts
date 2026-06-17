import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDebugStore } from "../../store/debugStore";
import { useTabsStore } from "../../store/tabsStore";

/**
 * Frontend side of the DAP bridge. Rust owns the debugpy process and
 * relays every adapter message as a `debug:message` event; this module
 * correlates responses to requests by `request_seq` and dispatches events
 * (stopped / terminated / output). The launch handshake itself lives in
 * Rust (src-tauri/src/debug.rs).
 */

interface DapMessage {
  type: "response" | "event" | "request";
  request_seq?: number;
  success?: boolean;
  command?: string;
  body?: unknown;
  event?: string;
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

/**
 * A `stopped` event only carries a threadId — ask for the top stack frame
 * to learn the file + line, then highlight it (lines are 1-based, matching
 * Monaco).
 */
async function handleStopped(body: {
  threadId?: number;
  reason?: string;
}): Promise<void> {
  const threadId = body.threadId ?? 0;
  const response = await sendDebugRequest("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 1,
  });
  const frame = (
    response?.body as
      | { stackFrames?: { line: number; source?: { path?: string } }[] }
      | undefined
  )?.stackFrames?.[0];
  if (!frame) return;
  const path = frame.source?.path ?? null;
  // Make sure the stopped file is the visible editor so the highlight shows.
  if (path) void useTabsStore.getState().openFile(path);
  useDebugStore.getState().setStopped(threadId, path, frame.line);
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
    if (message.type === "event") {
      switch (message.event) {
        case "stopped":
          void handleStopped(
            (message.body ?? {}) as { threadId?: number; reason?: string },
          );
          break;
        case "terminated":
        case "exited":
          useDebugStore.getState().setTerminated();
          break;
        // output events are handled in Stage D (debug console).
      }
    }
  });

  listen<{ state: string }>("debug:status", (event) => {
    if (event.payload.state === "terminated") {
      useDebugStore.getState().setTerminated();
    }
  });
}
