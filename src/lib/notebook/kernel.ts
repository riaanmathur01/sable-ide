import { listen } from "../events";
import { invoke } from "../backend";

/**
 * A notebook's connection to its Jupyter kernel: a helper process in the
 * backend (src-tauri/src/notebook.rs + notebook_helper.py) that relays
 * Jupyter's messaging protocol. Commands go out with `notebook_send`;
 * everything the kernel says comes back as `notebook:message` events,
 * tagged with the request (`req`) it answers.
 */

/** What the helper prints (see notebook_helper.py). */
export interface KernelMessage {
  type: "ready" | "status" | "started" | "restarted" | "iopub" | "reply" | "input_request" | "missing" | "error" | "log" | "exited" | "specs";
  req?: string | null;
  msg_type?: string;
  // Jupyter message content: shape depends on msg_type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
  metadata?: Record<string, unknown>;
  state?: string;
  kernel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info?: any;
  prompt?: string;
  password?: boolean;
  packages?: string[];
  python?: string;
  message?: string;
  text?: string;
  stderr?: string;
}

export interface KernelSpecs {
  specs: Record<string, { display_name: string; language: string }>;
  missing: string[];
  python: string;
}

const handlers = new Map<string, (message: KernelMessage) => void>();
let listening: Promise<unknown> | null = null;

function ensureListening(): Promise<unknown> {
  listening ??= listen<{ session: string; message: KernelMessage }>("notebook:message", (event) => {
    handlers.get(event.payload.session)?.(event.payload.message);
  });
  return listening;
}

let counter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

/** The kernels the interpreter's Jupyter knows. */
export function listKernelSpecs(python: string | null): Promise<KernelSpecs> {
  return invoke<KernelSpecs>("notebook_kernelspecs", { python });
}

/** `pip install ipykernel` into the interpreter. */
export function installIpykernel(python: string | null): Promise<void> {
  return invoke("notebook_install_ipykernel", { python });
}

export class KernelConnection {
  /** A fresh session per start, so a dying helper can't be confused with its successor. */
  readonly session = uniqueId("nb");
  private replies = new Map<string, { resolve: (message: KernelMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;

  constructor(private readonly onMessage: (message: KernelMessage) => void) {}

  async start(python: string | null, kernel: string, cwd: string | null): Promise<void> {
    await ensureListening();
    handlers.set(this.session, (message) => this.dispatch(message));
    try {
      await invoke("notebook_start", { session: this.session, python, kernel, cwd });
    } catch (error) {
      handlers.delete(this.session);
      throw error;
    }
  }

  private dispatch(message: KernelMessage) {
    if (message.type === "reply" && message.req) {
      const waiting = this.replies.get(message.req);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.replies.delete(message.req);
        waiting.resolve(message);
      }
    }
    if (message.type === "exited") {
      handlers.delete(this.session);
      for (const [, waiting] of this.replies) {
        clearTimeout(waiting.timer);
        waiting.resolve({ type: "reply", content: { status: "error" } });
      }
      this.replies.clear();
      if (this.stopped) return;
    }
    this.onMessage(message);
  }

  send(message: Record<string, unknown>): Promise<void> {
    return invoke("notebook_send", { session: this.session, message });
  }

  /** Run code; its messages arrive (tagged with the returned id) through onMessage. */
  execute(code: string): string {
    const req = uniqueId("exec");
    void this.send({ op: "execute", req, code }).catch((error) =>
      this.onMessage({ type: "reply", req, msg_type: "execute_reply", content: { status: "error", ename: "Kernel", evalue: String(error) } }),
    );
    return req;
  }

  /** A complete_request / inspect_request, answered (or null) within `timeoutMs`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request(op: "complete" | "inspect", fields: Record<string, unknown>, timeoutMs = 2000): Promise<any | null> {
    const req = uniqueId(op);
    const reply = new Promise<KernelMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.replies.delete(req);
        resolve(null);
      }, timeoutMs);
      this.replies.set(req, { resolve, timer });
    });
    try {
      await this.send({ op, req, ...fields });
    } catch {
      this.replies.delete(req);
      return null;
    }
    const message = await reply;
    return message?.content?.status === "ok" ? message.content : null;
  }

  inputReply(value: string): Promise<void> {
    return this.send({ op: "input_reply", value });
  }

  interrupt(): Promise<void> {
    return this.send({ op: "interrupt" });
  }

  restart(): Promise<void> {
    return this.send({ op: "restart" });
  }

  /** Shut the kernel down and end the helper. */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await invoke("notebook_stop", { session: this.session });
    } finally {
      handlers.delete(this.session);
    }
  }
}
