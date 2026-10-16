import { CANCEL_REQUEST, ErrorCode } from "./protocol";

/**
 * JSON-RPC 2.0 over newline-delimited lines, both ways: ACP agents call
 * the client too (permission prompts, files, terminals). Transport-free —
 * `send` writes a line, `receive` is fed each line that arrives — so it
 * runs the same over Sable's Rust relay and in tests.
 */

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface IncomingHandlers {
  /** An agent → client request; resolve with the result or throw RpcError. */
  request: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  notification: (method: string, params: unknown) => void;
}

type Id = number | string;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private incoming = new Map<Id, AbortController>();
  private closed: Error | null = null;
  /** Every line both ways (for the agent log view and tests). */
  onTraffic: ((direction: "in" | "out", line: string) => void) | null = null;

  constructor(
    private send: (line: string) => void | Promise<void>,
    private handlers: IncomingHandlers,
  ) {}

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private write(message: object) {
    const line = JSON.stringify(message);
    this.onTraffic?.("out", line);
    void Promise.resolve(this.send(line)).catch((error) => this.close(error instanceof Error ? error : new Error(String(error))));
  }

  /** Call the agent. */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      signal?.addEventListener("abort", () => {
        if (!this.pending.has(id)) return;
        // The agent still answers (with a result or -32800).
        this.notify(CANCEL_REQUEST, { requestId: id });
      });
    });
  }

  notify(method: string, params?: unknown) {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /** One line from the agent. */
  receive(line: string) {
    this.onTraffic?.("in", line);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Agents must only write JSON-RPC to stdout; ignore stray output.
    }
    if (!message || typeof message !== "object") return;
    const { id, method } = message as { id?: Id; method?: string };
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        if (method === CANCEL_REQUEST) {
          const target = (message.params as { requestId?: Id } | undefined)?.requestId;
          if (target !== undefined) this.incoming.get(target)?.abort();
          return;
        }
        try {
          this.handlers.notification(method, message.params);
        } catch (error) {
          console.error(`ACP notification ${method} failed`, error);
        }
        return;
      }
      void this.answer(id, method, message.params);
      return;
    }
    if (id === undefined || id === null) return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if ("error" in message && message.error) {
      const error = message.error as { code?: number; message?: string; data?: unknown };
      waiting.reject(new RpcError(error.code ?? ErrorCode.internal, error.message ?? "The agent reported an error", error.data));
    } else {
      waiting.resolve(message.result);
    }
  }

  private async answer(id: Id, method: string, params: unknown) {
    const controller = new AbortController();
    this.incoming.set(id, controller);
    try {
      const result = await this.handlers.request(method, params, controller.signal);
      if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      if (this.closed) return;
      const rpc =
        error instanceof RpcError
          ? error
          : controller.signal.aborted
            ? new RpcError(ErrorCode.cancelled, "Cancelled")
            : new RpcError(ErrorCode.internal, error instanceof Error ? error.message : String(error));
      this.write({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message, ...(rpc.data !== undefined ? { data: rpc.data } : {}) } });
    } finally {
      this.incoming.delete(id);
    }
  }

  /** The agent went away: fail what's waiting. */
  close(reason: Error) {
    if (this.closed) return;
    this.closed = reason;
    for (const waiting of this.pending.values()) waiting.reject(reason);
    this.pending.clear();
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
  }
}
