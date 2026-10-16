// A stand-in for Anthropic's `claude` CLI on the IDE side of its protocol —
// what the real CLI does when it connects to an IDE (Sable, VS Code…):
//
//   - finds the IDE's lock file in <config>/ide/<port>.lock (config =
//     CLAUDE_CONFIG_DIR), by CLAUDE_CODE_SSE_PORT or by workspace folder;
//   - opens a WebSocket to 127.0.0.1:<port> (subprotocol "mcp") with the
//     lock file's token in X-Claude-Code-Ide-Authorization;
//   - speaks MCP: initialize, notifications/initialized, ide_connected,
//     tools/list, tools/call…; and receives the IDE's notifications
//     (selection_changed, at_mentioned).
//
// It never talks to Anthropic. Used by claude-code-cli.mjs:
//
//   import { connectFakeCli } from "./fixtures/fake-claude-ide-cli.mjs";
//   const cli = await connectFakeCli({ configDir, workspace });
//   const folders = await cli.tool("getWorkspaceFolders");
//
// or on its own (prints what it found):
//
//   CLAUDE_CONFIG_DIR=/tmp/x node fake-claude-ide-cli.mjs <workspace>
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** Every IDE lock file in <configDir>/ide, newest first. */
export function readLocks(configDir) {
  const dir = path.join(configDir, "ide");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".lock"))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const lock = JSON.parse(fs.readFileSync(file, "utf8"));
        return { ...lock, port: Number(name.replace(/\.lock$/, "")), file, mtime: fs.statSync(file).mtimeMs, mode: fs.statSync(file).mode & 0o777 };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/** The lock file the CLI would pick: the env's port, else one whose folder contains `workspace`. */
export function findLock(configDir, { workspace, port } = {}) {
  const locks = readLocks(configDir);
  if (port) return locks.find((lock) => lock.port === Number(port)) ?? null;
  return (
    locks.find((lock) => (lock.workspaceFolders ?? []).some((folder) => workspace === folder || workspace.startsWith(folder + path.sep))) ?? null
  );
}

/** A raw WebSocket handshake; resolves to { socket, status, headers, rest }. */
function handshake(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const key = crypto.randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("connect", () => {
      const lines = [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: mcp",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const head = buffer.subarray(0, end).toString();
      const [statusLine, ...headerLines] = head.split("\r\n");
      const responseHeaders = Object.fromEntries(headerLines.map((line) => [line.split(":")[0].toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
      const expected = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      resolve({
        socket,
        status: Number(statusLine.split(" ")[1]),
        headers: responseHeaders,
        acceptOk: responseHeaders["sec-websocket-accept"] === expected,
        rest: buffer.subarray(end + 4),
      });
    };
    socket.on("data", onData);
    socket.once("close", () => resolve({ socket, status: 0, headers: {}, rest: Buffer.alloc(0) }));
  });
}

/** Try a handshake with a given token (or none); the HTTP status. */
export async function tryToken(port, token) {
  const { socket, status } = await handshake(port, token === undefined ? {} : { "X-Claude-Code-Ide-Authorization": token });
  socket.destroy();
  return status;
}

function encodeFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Connect as the CLI does. Returns { lock, call, tool, notify, notifications,
 * waitForNotification, close, closed }.
 */
export async function connectFakeCli({ configDir, workspace, port, token } = {}) {
  const lock = findLock(configDir, { workspace, port });
  if (!lock) throw new Error(`no IDE lock file for ${workspace ?? port} in ${configDir}/ide`);
  const { socket, status, headers, acceptOk, rest } = await handshake(lock.port, {
    "X-Claude-Code-Ide-Authorization": token ?? lock.authToken,
    "User-Agent": "fake-claude-ide-cli",
  });
  if (status !== 101) {
    socket.destroy();
    throw new Error(`the IDE refused the connection: HTTP ${status}`);
  }
  let buffer = rest;
  let fragments = [];
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  let nextId = 0;
  let closed = false;
  const closedPromise = new Promise((resolve) => socket.once("close", () => {
    closed = true;
    resolve();
  }));

  const deliver = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      notifications.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.method === message.method && waiter.predicate(message.params)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
    }
  };
  const parse = () => {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x9) socket.write(encodeFrame(0xa, payload));
      else if (opcode === 0x8) socket.end();
      else if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          deliver(text);
        }
      }
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  parse();

  const send = (message) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));
  /** A JSON-RPC request; resolves to the whole response. */
  const call = (method, params = {}, { timeout = 15000 } = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timeout ? setTimeout(() => reject(new Error(`${method} timed out`)), timeout) : null;
      pending.set(id, (message) => {
        if (timer) clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params = {}) => send({ jsonrpc: "2.0", method, params });
  /** tools/call; resolves to the tool's result ({ content, isError? }). */
  const tool = async (name, args = {}, options) => {
    const response = await call("tools/call", { name, arguments: args }, options);
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    return response.result;
  };
  /** The id the next request will use (to cancel it). */
  const peekId = () => nextId;
  const waitForNotification = (method, predicate = () => true, timeout = 10000) => {
    const seen = notifications.find((message) => message.method === method && predicate(message.params));
    if (seen) return Promise.resolve(seen.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
          reject(new Error(`no ${method} notification in time`));
        }
      }, timeout);
    });
  };

  const initialized = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: {} },
    clientInfo: { name: "fake-claude-ide-cli", version: "0.0.0" },
  });
  notify("notifications/initialized");
  notify("ide_connected", { pid: process.pid });

  return {
    lock,
    protocol: headers["sec-websocket-protocol"],
    acceptOk,
    initialized: initialized.result,
    call,
    tool,
    notify,
    peekId,
    notifications,
    waitForNotification,
    close: () => {
      socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
      return closedPromise;
    },
    get closed() {
      return closed;
    },
  };
}

// On its own: connect, list the tools and the workspace, and print them.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) {
    console.error("Set CLAUDE_CONFIG_DIR (never point this at your real ~/.claude)");
    process.exit(2);
  }
  const workspace = process.argv[2] ?? process.cwd();
  const cli = await connectFakeCli({ configDir, workspace, port: process.env.CLAUDE_CODE_SSE_PORT });
  const tools = await cli.call("tools/list");
  const folders = await cli.tool("getWorkspaceFolders");
  console.log(JSON.stringify({ ide: cli.lock.ideName, port: cli.lock.port, tools: tools.result.tools.map((tool) => tool.name), folders: JSON.parse(folders.content[0].text) }, null, 2));
  await cli.close();
}
