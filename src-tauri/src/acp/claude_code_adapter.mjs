#!/usr/bin/env node
// Sable's ACP adapter for Claude Code — the user's own installed, unmodified
// `claude` CLI. Speaks the Agent Client Protocol to Sable on stdio and runs
// `claude -p` in headless stream-json mode (documented: code.claude.com/docs
// /en/headless, /en/cli-reference):
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages --permission-mode <mode> [--model m] [--effort e]
//          --mcp-config <this adapter as an MCP server> --permission-prompt-tool mcp__sable__approve
//          (--session-id <id> | --resume <id>)
//
// Permission prompts go through the documented --permission-prompt-tool: an
// MCP tool this same script serves (run by claude as `--permission-server`),
// which asks Sable over a local socket and answers allow / deny.
//
// It never touches credentials: no auth environment or flags are passed,
// nothing is read from the keychain. Sign-in is Claude Code's own: if
// `claude auth status` says you're signed out, Sable opens a terminal running
// `claude` (this script with --cli), where you run /login yourself.
//
// Modes:
//   adapter.mjs                                   the ACP agent (Sable runs this)
//   adapter.mjs --cli [args…]                     runs `claude args…` in the terminal
//   adapter.mjs --permission-server <port> <token> <session>   the MCP permission tool

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CLAUDE = process.env.SABLE_CLAUDE_PATH || "claude";
const args = process.argv.slice(2);

// --- `--cli`: Claude Code itself, in a terminal ---------------------------------------------------
if (args[0] === "--cli") {
  const child = spawn(CLAUDE, args.slice(1), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    console.error(`Couldn't run ${CLAUDE}: ${error.message}`);
    process.exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} else if (args[0] === "--permission-server") {
  permissionServer(Number(args[1]), args[2], args[3]);
} else {
  agent();
}

// --- The MCP permission tool (claude runs this over stdio) -------------------------------------------
function permissionServer(port, token, session) {
  const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const ask = (request) =>
    new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let buffer = "";
      socket.on("connect", () => socket.write(`${JSON.stringify({ token, session, ...request })}\n`));
      socket.on("data", (data) => {
        buffer += data;
        const end = buffer.indexOf("\n");
        if (end >= 0) {
          socket.end();
          try {
            resolve(JSON.parse(buffer.slice(0, end)));
          } catch {
            resolve({ behavior: "deny", message: "Sable sent an unreadable answer." });
          }
        }
      });
      socket.on("error", () => resolve({ behavior: "deny", message: "Sable isn't available to approve this." }));
    });
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (id === undefined) return; // notifications (initialized, cancelled)
    if (method === "initialize") {
      write({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sable", version: "1.0.0" } } });
    } else if (method === "tools/list") {
      write({
        id,
        result: {
          tools: [
            {
              name: "approve",
              description: "Asks the user in Sable whether a tool may run.",
              inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
            },
          ],
        },
      });
    } else if (method === "tools/call") {
      const answer = await ask(params?.arguments ?? {});
      write({ id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } });
    } else if (method === "ping") {
      write({ id, result: {} });
    } else {
      write({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    }
  });
}

// --- The ACP agent -----------------------------------------------------------------------------------
function agent() {
  const sessions = new Map();
  let clientCapabilities = {};
  let nextId = 1;
  const pending = new Map();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `cc-${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
  const log = (...parts) => process.stderr.write(`[claude-code] ${parts.join(" ")}\n`);
  const authError = (message) => Object.assign(new Error(message), { code: -32000 });

  // Permission answers arrive from the MCP tool over this socket.
  const token = randomUUID();
  let port = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (data) => {
      buffer += data;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let question;
      try {
        question = JSON.parse(buffer.slice(0, end));
      } catch {
        socket.end();
        return;
      }
      if (question.token !== token) {
        socket.end(`${JSON.stringify({ behavior: "deny", message: "Not allowed." })}\n`);
        return;
      }
      const answer = await decide(question).catch((error) => ({ behavior: "deny", message: String(error?.message ?? error) }));
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  const listening = new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((port = server.address().port))));

  // --- Running claude ---------------------------------------------------------------------------------
  function run(command, commandArgs, timeout = 20000) {
    return new Promise((resolve) => {
      const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      const timer = setTimeout(() => child.kill(), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function authStatus() {
    const result = await run(CLAUDE, ["auth", "status", "--json"]);
    if (result.code === -1) throw new Error(`Couldn't run ${CLAUDE}: ${result.stderr}`);
    try {
      return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    } catch {
      return { loggedIn: result.code === 0 };
    }
  }

  const MODES = [
    { id: "default", name: "Ask", description: "Ask before edits and commands" },
    { id: "acceptEdits", name: "Accept edits", description: "Edit files without asking" },
    { id: "plan", name: "Plan", description: "Plan first, change nothing" },
    { id: "bypassPermissions", name: "Bypass permissions", description: "Never ask (use with care)" },
  ];
  const MODELS = [
    { value: "default", name: "Default", description: "Your Claude Code default" },
    { value: "opus", name: "Opus", description: "Most capable" },
    { value: "sonnet", name: "Sonnet", description: "Fast and capable" },
    { value: "haiku", name: "Haiku", description: "Fastest" },
  ];
  const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
  function configOptions(session) {
    const models = session.model !== "default" && !MODELS.some((model) => model.value === session.model) ? [...MODELS, { value: session.model, name: session.model }] : MODELS;
    return [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode, options: MODES.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: models },
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: session.effort, options: EFFORTS.map((value) => ({ value, name: value === "default" ? "Default effort" : value[0].toUpperCase() + value.slice(1) })) },
    ];
  }

  function makeSession(cwd, id = randomUUID(), started = false) {
    const session = { id, cwd, mode: "default", model: "default", effort: "default", started, proc: null, dirty: false, turn: null, always: new Set(), streamed: new Set(), tools: new Map(), commands: [] };
    sessions.set(id, session);
    return session;
  }

  async function spawnClaude(session) {
    await listening;
    const mcp = { mcpServers: { sable: { type: "stdio", command: process.execPath, args: [process.argv[1], "--permission-server", String(port), token, session.id] } } };
    const flags = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      session.mode,
      "--mcp-config",
      JSON.stringify(mcp),
      "--permission-prompt-tool",
      "mcp__sable__approve",
    ];
    if (session.model !== "default") flags.push("--model", session.model);
    if (session.effort !== "default") flags.push("--effort", session.effort);
    flags.push(session.started ? "--resume" : "--session-id", session.id);
    const child = spawn(CLAUDE, flags, { cwd: session.cwd, stdio: ["pipe", "pipe", "pipe"] });
    session.proc = child;
    session.dirty = false;
    session.stderr = [];
    child.stderr.on("data", (data) => {
      session.stderr.push(...String(data).split("\n").filter(Boolean));
      session.stderr = session.stderr.slice(-30);
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      try {
        onEvent(session, event);
      } catch (error) {
        log("event failed", error?.stack ?? error);
      }
    });
    child.on("error", (error) => session.turn?.proc === child && finishTurn(session, null, new Error(`Couldn't run ${CLAUDE}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (session.proc === child) session.proc = null;
      // A process replaced after a mode change closes too: only its own turn ends.
      if (session.turn && session.turn.proc === child) {
        if (session.turn.cancelled) finishTurn(session, { stopReason: "cancelled" });
        else {
          const tail = session.stderr.join("\n");
          finishTurn(session, null, /log ?in|not logged|authenticat/i.test(tail) ? authError("Sign in to Claude Code to continue.") : new Error(`claude exited (${signal ?? code})${tail ? `:\n${tail}` : ""}`));
        }
      }
    });
    session.started = true;
    return child;
  }

  function finishTurn(session, response, error) {
    const turn = session.turn;
    if (!turn) return;
    session.turn = null;
    for (const [id, tool] of session.tools) {
      if (tool.open) {
        tool.open = false;
        update(session.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: response?.stopReason === "cancelled" ? "failed" : "completed" });
      }
    }
    if (error) turn.reject(error);
    else turn.resolve(response);
  }

  // --- Mapping Claude Code's stream to ACP --------------------------------------------------------------
  const KINDS = { Read: "read", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit", Bash: "execute", BashOutput: "execute", KillShell: "execute", Grep: "search", Glob: "search", LS: "search", WebFetch: "fetch", WebSearch: "fetch", Task: "think", Agent: "think", ExitPlanMode: "switch_mode" };
  const rel = (session, file) => (file && session.cwd && file.startsWith(`${session.cwd}/`) ? file.slice(session.cwd.length + 1) : file);

  function toolFacts(session, name, input = {}) {
    const file = input.file_path ?? input.notebook_path ?? input.path;
    const facts = { kind: KINDS[name] ?? (name.startsWith("mcp__") ? "other" : "other"), title: name, locations: file ? [{ path: file }] : [], content: [] };
    switch (name) {
      case "Read":
        facts.title = `Read ${rel(session, file) ?? ""}`.trim();
        if (input.offset) facts.locations = [{ path: file, line: input.offset }];
        break;
      case "Edit":
        facts.title = `Edit ${rel(session, file)}`;
        if (typeof input.old_string === "string") facts.content = [{ type: "diff", path: file, oldText: input.old_string || null, newText: input.new_string ?? "" }];
        break;
      case "MultiEdit":
        facts.title = `Edit ${rel(session, file)}`;
        facts.content = (input.edits ?? []).map((edit) => ({ type: "diff", path: file, oldText: edit.old_string || null, newText: edit.new_string ?? "" }));
        break;
      case "Write": {
        facts.title = `Write ${rel(session, file)}`;
        let before = null;
        try {
          before = fs.readFileSync(file, "utf8");
        } catch {
          before = null;
        }
        facts.content = [{ type: "diff", path: file, oldText: before, newText: input.content ?? "" }];
        break;
      }
      case "Bash":
        facts.title = input.command ?? "Run a command";
        break;
      case "Grep":
        facts.title = `Search for ${input.pattern ?? ""}${input.path ? ` in ${rel(session, input.path)}` : ""}`;
        break;
      case "Glob":
        facts.title = `Find ${input.pattern ?? "files"}`;
        break;
      case "WebFetch":
        facts.title = `Fetch ${input.url ?? ""}`;
        break;
      case "WebSearch":
        facts.title = `Search the web for ${input.query ?? ""}`;
        break;
      case "Task":
      case "Agent":
        facts.title = input.description ?? "Run a subagent";
        break;
      case "ExitPlanMode":
        facts.title = "Ready to code?";
        if (input.plan) facts.content = [{ type: "content", content: { type: "text", text: input.plan } }];
        break;
      default:
        if (name.startsWith("mcp__")) facts.title = name.replace(/^mcp__/, "").replace(/__/, ": ");
    }
    return facts;
  }

  function resultText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    return "";
  }

  function onEvent(session, event) {
    const id = session.id;
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          if (Array.isArray(event.slash_commands) && event.slash_commands.length) {
            const hidden = new Set(["login", "logout", "clear", "exit", "quit"]);
            session.commands = event.slash_commands.filter((name) => !hidden.has(name));
            update(id, { sessionUpdate: "available_commands_update", availableCommands: session.commands.map((name) => ({ name, description: `Claude Code /${name}` })) });
          }
          if (event.model) session.liveModel = event.model;
        }
        return;
      case "stream_event": {
        if (event.parent_tool_use_id) return;
        const inner = event.event ?? {};
        if (inner.type === "message_start") session.currentMessage = inner.message?.id;
        if (inner.type === "content_block_delta") {
          if (session.currentMessage) session.streamed.add(session.currentMessage);
          if (inner.delta?.type === "text_delta") update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta.text } });
          else if (inner.delta?.type === "thinking_delta") update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.delta.thinking } });
        }
        return;
      }
      case "assistant": {
        const message = event.message ?? {};
        const streamed = message.id && session.streamed.has(message.id);
        for (const block of message.content ?? []) {
          if (block.type === "text" && !streamed && !event.parent_tool_use_id) update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
          else if (block.type === "thinking" && !streamed && !event.parent_tool_use_id) update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
          else if (block.type === "tool_use") {
            if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
              update(id, { sessionUpdate: "plan", entries: block.input.todos.map((todo) => ({ content: todo.content ?? todo.activeForm ?? "", priority: "medium", status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending" })) });
              session.tools.set(block.id, { name: block.name, hidden: true });
              continue;
            }
            if (session.tools.has(block.id)) continue;
            const facts = toolFacts(session, block.name, block.input);
            session.tools.set(block.id, { name: block.name, input: block.input, open: true, facts });
            update(id, { sessionUpdate: "tool_call", toolCallId: block.id, status: "pending", rawInput: block.input, ...facts });
          }
        }
        return;
      }
      case "user": {
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const tool = session.tools.get(block.tool_use_id);
          if (!tool || tool.hidden) continue;
          tool.open = false;
          const text = resultText(block.content);
          const fields = { sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed", rawOutput: text.length > 20000 ? `${text.slice(0, 20000)}…` : text };
          if (tool.name === "Bash" || block.is_error) {
            const shown = text.trim() ? text.split("\n").slice(-200).join("\n") : "";
            if (shown) fields.content = [...(tool.facts?.content ?? []), { type: "content", content: { type: "text", text: tool.name === "Bash" ? `\`\`\`console\n${shown}\n\`\`\`` : shown } }];
          } else if (tool.name === "Grep" || tool.name === "Glob") {
            const shown = text.split("\n").slice(0, 60).join("\n");
            if (shown.trim()) fields.content = [{ type: "content", content: { type: "text", text: shown } }];
          }
          update(id, fields);
        }
        return;
      }
      case "result": {
        const usage = event.usage ?? {};
        const model = event.modelUsage ? Object.values(event.modelUsage)[0] : null;
        const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
        if (model?.contextWindow) update(id, { sessionUpdate: "usage_update", used, size: model.contextWindow, cost: typeof event.total_cost_usd === "number" ? { amount: event.total_cost_usd, currency: "USD" } : null });
        session.streamed.clear();
        if (session.turn?.cancelled) return finishTurn(session, { stopReason: "cancelled" });
        if (event.is_error) {
          const text = typeof event.result === "string" ? event.result : (event.errors ?? []).join("\n") || event.subtype;
          if (/\/login|not logged in|log in|invalid api key|authenticat/i.test(text)) return finishTurn(session, null, authError(`Sign in to Claude Code: ${text}`));
          if (event.subtype === "error_max_turns") return finishTurn(session, { stopReason: "max_turn_requests" });
          return finishTurn(session, null, new Error(text || "Claude Code stopped with an error"));
        }
        return finishTurn(session, {
          stopReason: "end_turn",
          usage: { totalTokens: used, inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cachedReadTokens: usage.cache_read_input_tokens ?? 0 },
        });
      }
      default:
        return;
    }
  }

  // --- Permission prompts (from the MCP tool) -------------------------------------------------------------
  async function decide({ session: sessionId, tool_name: name, input = {}, tool_use_id }) {
    const session = sessions.get(sessionId);
    if (!session) return { behavior: "deny", message: "The session is gone." };
    if (session.always.has(name)) return { behavior: "allow", updatedInput: input };
    const known = tool_use_id && session.tools.get(tool_use_id);
    const facts = known?.facts ?? toolFacts(session, name, input);
    const toolCallId = tool_use_id ?? `perm-${randomUUID()}`;
    if (!known) {
      session.tools.set(toolCallId, { name, input, open: true, facts });
      update(session.id, { sessionUpdate: "tool_call", toolCallId, status: "pending", rawInput: input, ...facts });
    }
    const options =
      name === "ExitPlanMode"
        ? [
            { optionId: "accept", name: "Yes, and accept edits", kind: "allow_always" },
            { optionId: "allow", name: "Yes, ask before edits", kind: "allow_once" },
            { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
          ]
        : [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: `Always allow ${name}`, kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ];
    const answer = await request("session/request_permission", { sessionId: session.id, toolCall: { toolCallId, rawInput: input, ...facts }, options });
    const choice = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : "reject";
    if (choice === "reject") {
      update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      const tool = session.tools.get(toolCallId);
      if (tool) tool.open = false;
      return { behavior: "deny", message: "The user rejected this in Sable." };
    }
    if (name === "ExitPlanMode") {
      session.mode = choice === "accept" ? "acceptEdits" : "default";
      session.dirty = true; // the next turn runs in the new mode
      update(session.id, { sessionUpdate: "current_mode_update", currentModeId: session.mode });
    } else if (choice === "always") session.always.add(name);
    update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    return { behavior: "allow", updatedInput: input };
  }

  // --- Prompts --------------------------------------------------------------------------------------------
  function promptContent(blocks) {
    const content = [];
    const images = [];
    for (const block of blocks ?? []) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") images.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
      else if (block.type === "resource" && typeof block.resource?.text === "string") {
        const uri = block.resource.uri ?? "";
        const file = decodeURI(uri.replace(/^file:\/\//, ""));
        content.push({ type: "text", text: `<context ref="${file}">\n${block.resource.text}\n</context>` });
      } else if (block.type === "resource_link") {
        const file = decodeURI(String(block.uri).replace(/^file:\/\//, ""));
        content.push({ type: "text", text: `@${file}` });
      }
    }
    return [...content, ...images];
  }

  async function prompt({ sessionId, prompt: blocks }) {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error(`No session ${sessionId}`), { code: -32002 });
    if (session.turn) throw new Error("Claude Code is still working on the last message");
    if (session.dirty && session.proc) {
      session.proc.stdin.end();
      session.proc = null;
    }
    const child = session.proc ?? (await spawnClaude(session));
    const done = new Promise((resolve, reject) => (session.turn = { resolve, reject, cancelled: false, proc: child }));
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: promptContent(blocks) } })}\n`);
    return done;
  }

  // --- History: Claude Code's own transcripts ---------------------------------------------------------------
  const projectDir = (cwd) => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  function transcript(cwd, id) {
    try {
      return fs
        .readFileSync(path.join(projectDir(cwd), `${id}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return null;
    }
  }
  const firstText = (entry) => {
    const content = entry?.message?.content;
    if (typeof content === "string") return content;
    return (content ?? []).find((part) => part.type === "text")?.text ?? "";
  };

  async function handle(method, params) {
    switch (method) {
      case "initialize":
        clientCapabilities = params?.clientCapabilities ?? {};
        return {
          protocolVersion: 1,
          agentInfo: { name: "sable-claude-code", title: "Claude Code", version: "1.0.0" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, close: {} } },
          authMethods: clientCapabilities.auth?.terminal
            ? [{ id: "claude-code-login", name: "Sign in to Claude Code", description: "Opens a terminal running your claude — type /login there", type: "terminal", args: ["--cli"] }]
            : [],
        };
      case "authenticate":
        return {};
      case "session/new": {
        const status = await authStatus();
        if (!status.loggedIn) throw authError("Claude Code isn't signed in. Run /login in Claude Code to sign in.");
        const session = makeSession(params.cwd);
        return { sessionId: session.id, modes: { currentModeId: session.mode, availableModes: MODES }, configOptions: configOptions(session) };
      }
      case "session/load": {
        const entries = transcript(params.cwd, params.sessionId);
        if (!entries) throw Object.assign(new Error("Claude Code has no such session here"), { code: -32002 });
        const session = makeSession(params.cwd, params.sessionId, true);
        for (const entry of entries) {
          if (entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) continue;
          const content = entry.message?.content;
          const parts = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
          for (const part of parts) {
            if (part.type === "text" && part.text && !part.text.startsWith("<")) update(session.id, { sessionUpdate: entry.type === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: part.text } });
            else if (part.type === "tool_use") {
              const facts = toolFacts(session, part.name, part.input);
              update(session.id, { sessionUpdate: "tool_call", toolCallId: part.id, status: "completed", rawInput: part.input, ...facts });
            }
          }
        }
        return { modes: { currentModeId: session.mode, availableModes: MODES }, configOptions: configOptions(session) };
      }
      case "session/list": {
        const cwd = params?.cwd;
        if (!cwd) return { sessions: [] };
        let files = [];
        try {
          files = fs.readdirSync(projectDir(cwd)).filter((name) => name.endsWith(".jsonl"));
        } catch {
          return { sessions: [] };
        }
        const list = files
          .map((name) => {
            const file = path.join(projectDir(cwd), name);
            const stat = fs.statSync(file);
            const head = fs.readFileSync(file, "utf8").split("\n", 40).map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            });
            const first = head.find((entry) => entry?.type === "user" && !entry.isSidechain && firstText(entry) && !firstText(entry).startsWith("<"));
            return first ? { sessionId: name.replace(/\.jsonl$/, ""), cwd, title: firstText(first).split("\n")[0].slice(0, 80), updatedAt: stat.mtime.toISOString() } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 50);
        return { sessions: list };
      }
      case "session/close": {
        const session = sessions.get(params.sessionId);
        session?.proc?.stdin.end();
        sessions.delete(params.sessionId);
        return {};
      }
      case "session/set_mode":
      case "session/set_config_option": {
        const session = sessions.get(params.sessionId);
        if (!session) throw Object.assign(new Error("No such session"), { code: -32002 });
        const configId = method === "session/set_mode" ? "mode" : params.configId;
        const value = method === "session/set_mode" ? params.modeId : params.value;
        if (configId === "mode") session.mode = value;
        else if (configId === "model") session.model = value;
        else if (configId === "effort") session.effort = value;
        // Takes effect from the next message (claude restarts with --resume).
        session.dirty = true;
        if (session.proc && !session.turn) {
          session.proc.stdin.end();
          session.proc = null;
        }
        if (configId === "mode") update(session.id, { sessionUpdate: "current_mode_update", currentModeId: session.mode });
        return method === "session/set_mode" ? {} : { configOptions: configOptions(session) };
      }
      case "session/prompt":
        return prompt(params);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method === "session/cancel") {
      const session = sessions.get(message.params?.sessionId);
      if (session?.turn) {
        session.turn.cancelled = true;
        // SIGINT ends the turn (documented); the process then exits.
        session.proc?.kill("SIGINT");
        setTimeout(() => session.turn?.cancelled && finishTurn(session, { stopReason: "cancelled" }), 5000);
      }
      return;
    }
    if (message.id === undefined) return;
    Promise.resolve()
      .then(() => handle(message.method, message.params))
      .then((result) => send({ id: message.id, result: result ?? null }))
      .catch((error) => send({ id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } }));
  });
  process.stdin.on("end", () => {
    for (const session of sessions.values()) session.proc?.kill("SIGTERM");
    process.exit(0);
  });
}
