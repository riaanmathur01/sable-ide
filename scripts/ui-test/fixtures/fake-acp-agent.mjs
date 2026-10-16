#!/usr/bin/env node
// A fake ACP agent for the agents UI suite (scripts/ui-test/agents.mjs):
// speaks the Agent Client Protocol (JSON-RPC 2.0, one message per line on
// stdio) like a real coding agent, scripted by keywords in the prompt:
//
//   (anything)  thinking, a plan, a streamed Markdown reply, usage
//   write       a Write tool call that asks permission, then fs/write_text_file
//   edit        an Edit of src/app.js (fs/read_text_file + fs/write_text_file)
//   run         an execute tool call through terminal/create … release
//   slow        streams slowly until session/cancel
//   mention     echoes the prompt's content blocks (resource / resource_link / image)
//   /review     a slash command
//   needauth    fails with auth required (-32000) until signed in (--login)
//   elicit      asks the client a URL elicitation
//
//   fake-acp-agent.mjs [--login]     (--login: the terminal sign-in method)
//
// FAKE_ACP_AS=codex|kimi|cursor makes it answer like that agent — its auth
// methods, sign-in flows, config options and errors, as the real ones do
// (checked against codex-acp 2.2.2, Kimi Code 2.2.0, cursor-agent
// 2026.10.14): the ChatGPT browser and device-code (URL elicitation)
// sign-ins, an API key from the environment, Codex's config.toml in
// CODEX_HOME (Bedrock, local models), Kimi Code's terminal sign-in and
// KIMI_MODEL_* keys, Cursor's browser sign-in (and its no-browser error),
// CURSOR_API_KEY. Every start is logged to $FAKE_ACP_STATE/launches.jsonl
// with the variables and config file that matter, for the suite to check.
//
// State (sessions for session/list and session/load, the login marker)
// lives in $FAKE_ACP_STATE (default: a temp folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const stateDir = process.env.FAKE_ACP_STATE ?? path.join(os.tmpdir(), "fake-acp-state");
fs.mkdirSync(stateDir, { recursive: true });
const persona = process.env.FAKE_ACP_AS ?? "claude";
const loginMarker = path.join(stateDir, persona === "claude" ? "logged-in" : `logged-in-${persona}`);
const loggedIn = () => fs.existsSync(loginMarker);
const argv = process.argv.slice(2);
const has = (...words) => words.every((word) => argv.includes(word));

// What Sable started it with (no prompt content, just the setup).
{
  const keep = /^(CODEX_HOME|CODEX_API_KEY|OPENAI_API_KEY|DEFAULT_AUTH_REQUEST|CODEX_CONFIG|MODEL_PROVIDER|CODEX_OSS_BASE_URL|AZURE_OPENAI_API_KEY|SABLE_CODEX_ENDPOINT_KEY|AWS_[A-Z_]+|KIMI_[A-Z_]+|CURSOR_[A-Z_]+|NO_BROWSER)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => keep.test(name)));
  const configFile = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : null;
  const config = configFile && fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  fs.appendFileSync(path.join(stateDir, "launches.jsonl"), `${JSON.stringify({ persona, argv, env, config })}\n`);
}

// --- Each agent's own commands (arguments in place of its ACP ones) ---------------------------
if (persona === "codex" && has("cli", "login")) {
  // `codex-acp cli login [status|--device-auth]`, `codex-acp cli logout`.
  if (has("status")) {
    process.stderr.write(loggedIn() ? "Logged in using ChatGPT\n" : "Not logged in\n");
    process.exit(loggedIn() ? 0 : 1);
  }
  process.stdout.write(has("--device-auth") ? "Open https://auth.openai.com/codex/device and enter FAKE-4821\n" : "Opening https://auth.openai.com/oauth/authorize?fake=1 in your browser…\n");
  fs.writeFileSync(loginMarker, "chatgpt");
  process.stderr.write("Successfully logged in\n");
  process.exit(0);
}
if (persona === "codex" && has("cli", "logout")) {
  fs.rmSync(loginMarker, { force: true });
  process.exit(0);
}
if (persona === "cursor" && argv[0] === "status") {
  process.stdout.write(`${JSON.stringify(loggedIn() ? { status: "authenticated", isAuthenticated: true, userInfo: { email: "dev@cursor.test" } } : { status: "unauthenticated", isAuthenticated: false, message: "Not logged in" }, null, 2)}\n`);
  process.exit(0);
}
if (persona === "cursor" && (argv[0] === "login" || argv[0] === "logout")) {
  if (argv[0] === "login") {
    process.stdout.write("Open https://cursor.com/loginDeepControl?fake=1 to sign in\n✓ Logged in as dev@cursor.test\n");
    fs.writeFileSync(loginMarker, "yes");
  } else fs.rmSync(loginMarker, { force: true });
  process.exit(0);
}
if (persona === "kimi" && has("--login")) {
  // `kimi acp --login [--region global]`: the device-code flow, in a terminal.
  const region = argv.includes("--region") ? argv[argv.indexOf("--region") + 1] : "mainland-cn";
  process.stderr.write(`Opening browser for Kimi device login: https://auth.kimi.${region === "global" ? "ai" : "com"}/device?code=K-77\n`);
  fs.writeFileSync(loginMarker, region);
  process.stdout.write("Logged in to Kimi Code.\n");
  process.exit(0);
}

// Claude Agent's account commands (`--cli auth status --json`, `--cli auth login --console`).
if (process.argv.includes("--cli") && process.argv.includes("status")) {
  const loggedIn = fs.existsSync(loginMarker);
  process.stdout.write(`${JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "console", apiProvider: "firstParty", email: "dev@example.com" } : { loggedIn: false, authMethod: "none" })}\n`);
  process.exit(loggedIn ? 0 : 1);
}
if (process.argv.includes("--cli") && process.argv.includes("logout")) {
  fs.rmSync(loginMarker, { force: true });
  process.stdout.write("Signed out.\n");
  process.exit(0);
}
if (process.argv.includes("--login") || (process.argv.includes("--cli") && process.argv.includes("login"))) {
  process.stdout.write("Fake Console sign-in\nSigning in… done.\n");
  fs.writeFileSync(loginMarker, "yes");
  process.exit(0);
}

const sessionsFile = path.join(stateDir, "sessions.json");
const sessions = fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, "utf8")) : {};
const saveSessions = () => fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 1));
const log = (...args) => process.stderr.write(`[fake-acp] ${args.join(" ")}\n`);

let nextId = 1;
const pending = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `agent-${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const notify = (method, params) => send({ method, params });
const update = (sessionId, update) => notify("session/update", { sessionId, update });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let clientCapabilities = {};
const cancelled = new Set();
/** Codex's api-key login, held in memory (cli_auth_credentials_store = "ephemeral"). */
let apiKeyLogin = false;

/** Codex's config.toml in CODEX_HOME (only the keys the fake reads). */
function codexConfig() {
  const file = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : null;
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const top = text.split(/^\[/m)[0];
  const value = (key) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(top)?.[1];
  return { provider: value("model_provider"), model: value("model") };
}

/** Whether the agent may open a session, as each real one decides. */
function authorized() {
  if (persona === "codex") {
    // A provider that isn't OpenAI's needs no ChatGPT/API-key login.
    if (codexConfig().provider) return true;
    if (!apiKeyLogin && process.env.DEFAULT_AUTH_REQUEST && JSON.parse(process.env.DEFAULT_AUTH_REQUEST).methodId === "api-key" && process.env.CODEX_API_KEY) apiKeyLogin = true;
    return loggedIn() || apiKeyLogin;
  }
  if (persona === "kimi") return loggedIn() || Boolean(process.env.KIMI_MODEL_NAME && process.env.KIMI_MODEL_API_KEY);
  if (persona === "cursor") return loggedIn() || Boolean(process.env.CURSOR_API_KEY);
  return true;
}

function authRequired() {
  if (persona === "cursor")
    return { code: -32000, message: "Authentication required", data: { message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'." } };
  return { code: -32000, message: "Authentication required" };
}

function authMethods() {
  if (persona === "codex") {
    const methods = [{ id: "api-key", name: "API Key", description: "Use an API key to authenticate", _meta: { "api-key": { provider: "openai" } } }];
    if (!process.env.NO_BROWSER) methods.push({ id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" });
    if (clientCapabilities.elicitation?.url) methods.push({ id: "chat-gpt-device-code", name: "ChatGPT (device code)", description: "Sign in to ChatGPT by opening a verification page and entering a one-time code" });
    return methods;
  }
  if (persona === "kimi")
    return [{ id: "login", type: "terminal", name: "Login with Kimi account", description: "Open the device-code login flow in a terminal.", args: ["--login"], env: {}, _meta: { "terminal-auth": { type: "terminal", label: "Login with Kimi account", command: process.argv[1], args: ["login"], env: {} } } }];
  if (persona === "cursor") return [{ id: "cursor_login", name: "Cursor Login", description: "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in." }];
  return clientCapabilities.auth?.terminal ? [{ id: "fake-login", name: "Fake Console", description: "Sign in with a fake console account", type: "terminal", args: ["--login"] }] : [];
}

async function authenticate(params, requestId) {
  const { methodId } = params;
  if (persona === "codex") {
    if (methodId === "api-key") {
      const key = params._meta?.["api-key"]?.apiKey ?? process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!key) throw { code: -32603, message: "Internal error", data: { message: "CODEX_API_KEY or OPENAI_API_KEY is not set" } };
      apiKeyLogin = true;
      return {};
    }
    if (methodId === "chat-gpt") {
      // The real adapter opens the system browser itself, then waits for the callback.
      await sleep(400);
      fs.writeFileSync(loginMarker, "chatgpt");
      notify("_auth/status_update", { authStatus: { kind: "account", label: "ChatGPT Plus", account: { email: "dev@chatgpt.test", plan: "plus" } } });
      return {};
    }
    if (methodId === "chat-gpt-device-code") {
      const elicitationId = `login-${Date.now()}`;
      const answer = await request("elicitation/create", { mode: "url", requestId, url: "https://auth.openai.com/codex/device", message: "Sign in to ChatGPT and enter this code: FAKE-4821", elicitationId });
      if (answer?.action !== "accept") throw { code: -32800, message: "ChatGPT device code sign-in was cancelled", data: { methodId, action: answer?.action } };
      await sleep(600);
      fs.writeFileSync(loginMarker, "chatgpt-device");
      notify("elicitation/complete", { elicitationId });
      notify("_auth/status_update", { authStatus: { kind: "account", label: "ChatGPT Plus", account: { email: "dev@chatgpt.test", plan: "plus" } } });
      return {};
    }
    throw { code: -32600, message: "Invalid request" };
  }
  if (persona === "kimi") {
    if (methodId !== "login") throw { code: -32602, message: "Invalid params" };
    if (!authorized()) throw { code: -32000, message: "Authentication required" };
    return {};
  }
  if (persona === "cursor") {
    if (methodId !== "cursor_login") throw { code: -32602, message: "Invalid params", data: { message: `Unknown authentication method: ${methodId}. Supported method: cursor_login` } };
    if (loggedIn()) return {};
    if (fs.existsSync(path.join(stateDir, "no-browser"))) {
      throw { code: -32602, message: "Invalid params", data: { message: "Failed to open browser for login. Please visit: https://cursor.com/loginDeepControl?challenge=fake&mode=login" } };
    }
    await sleep(400);
    fs.writeFileSync(loginMarker, "yes");
    return {};
  }
  return {};
}

const modes = [
  { id: "default", name: "Default", description: "Ask before edits and commands" },
  { id: "acceptEdits", name: "Accept Edits", description: "Edit files without asking" },
  { id: "plan", name: "Plan", description: "Plan before changing anything" },
  { id: "bypassPermissions", name: "Bypass Permissions", description: "Never ask" },
];
function personaOptions(session) {
  const select = (id, name, category, currentValue, values) => ({ id, name, category, type: "select", currentValue, options: values.map(([value, label, description]) => ({ value, name: label, ...(description ? { description } : {}) })) });
  if (persona === "codex") {
    const { provider, model } = codexConfig();
    const models = provider?.startsWith("amazon-bedrock") ? ["global.openai.gpt-6.1-sol", "global.openai.gpt-6-sol"] : provider === "ollama" || provider === "lmstudio" ? [model ?? "gpt-oss:20b"] : ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.5"];
    const options = [
      select("mode", "Mode", "mode", session.mode, [["read-only", "Read-only"], ["workspace-write", "Workspace access"], ["agent", "Auto review"], ["agent-full-access", "Full access"]]),
      select("collaboration_mode", "Collaboration mode", "collaboration_mode", "default", [["default", "Default"], ["plan", "Plan"]]),
      select("model", "Model", "model", session.model, models.map((value) => [value, value])),
      select("reasoning_effort", "Reasoning effort", "thought_level", session.effort, [["low", "Low"], ["medium", "Medium"], ["high", "High"]]),
    ];
    if (clientCapabilities.session?.configOptions?.boolean) options.push({ id: "fast-mode", name: "Fast mode", category: "model_config", type: "boolean", currentValue: false });
    return options;
  }
  if (persona === "kimi")
    return [
      select("model", "Model", "model", session.model, [[session.model, process.env.KIMI_MODEL_DISPLAY_NAME ?? "Kimi K3"]]),
      select("thinking", "Thinking", "thought_level", session.effort, [["off", "Off"], ["on", "On"]]),
      select("mode", "Mode", "mode", session.mode, [["default", "Default"], ["plan", "Plan"], ["auto", "Auto"], ["yolo", "YOLO"]]),
    ];
  return [
    select("mode", "Mode", "mode", session.mode, [["agent", "Agent", "Full agent capabilities with tool access"], ["plan", "Plan"], ["ask", "Ask", "Q&A mode - no edits or command execution"]]),
    select("model", "Model", "model", session.model, [["auto", "Auto"], ["gpt-6.1-sol", "GPT-6.1 Sol"], ["sonnet-5-thinking", "Sonnet 5 Thinking"]]),
  ];
}

function configOptions(session) {
  if (persona !== "claude") return personaOptions(session);
  return [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode, options: modes.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: [
        { value: "fake-smart", name: "Fake Smart", description: "Thinks harder" },
        { value: "fake-fast", name: "Fake Fast", description: "Answers quickly" },
      ],
    },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: session.effort, options: ["low", "medium", "high"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })) },
  ];
}

const DEFAULTS = {
  claude: { mode: "default", model: "fake-smart", effort: "medium" },
  codex: { mode: "agent", model: "gpt-6.1-sol", effort: "medium" },
  kimi: { mode: "default", model: "kimi-code/k3", effort: "on" },
  cursor: { mode: "agent", model: "auto", effort: "medium" },
};

function newSession(cwd) {
  const sessionId = `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const defaults = { ...DEFAULTS[persona] };
  if (persona === "codex") defaults.model = codexConfig().model ?? (codexConfig().provider?.startsWith("amazon-bedrock") ? "global.openai.gpt-6.1-sol" : defaults.model);
  if (persona === "kimi" && process.env.KIMI_MODEL_NAME) defaults.model = "__kimi_env_model__";
  if (persona === "cursor") {
    const pinned = argv.indexOf("--model");
    if (pinned >= 0) defaults.model = argv[pinned + 1];
  }
  sessions[sessionId] = { sessionId, cwd, title: null, ...defaults, history: [], updatedAt: new Date().toISOString() };
  saveSessions();
  return sessions[sessionId];
}

function announceCommands(sessionId) {
  update(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "review", description: "Review the uncommitted changes" },
      { name: "test", description: "Run the project's tests", input: { hint: "[pattern]" } },
      { name: "explain", description: "Explain the selected code" },
    ],
  });
}

async function streamText(sessionId, text, kind = "agent_message_chunk", delay = 8) {
  const words = text.split(/(\s+)/);
  for (let index = 0; index < words.length; index += 3) {
    if (cancelled.has(sessionId)) return false;
    update(sessionId, { sessionUpdate: kind, content: { type: "text", text: words.slice(index, index + 3).join("") } });
    await sleep(delay);
  }
  return true;
}

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function askPermission(sessionId, toolCall) {
  const response = await request("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  return response.outcome?.outcome === "selected" && response.outcome.optionId !== "reject";
}

let turn = 0;
async function prompt(params) {
  const { sessionId } = params;
  turn += 1;
  const id = (name) => `${name}-${process.pid}-${turn}`;
  const session = sessions[sessionId];
  if (!session) throw { code: -32002, message: `No session ${sessionId}` };
  cancelled.delete(sessionId);
  const text = promptText(params.prompt);
  session.history.push({ role: "user", text });
  session.title ??= text.slice(0, 40) || "Untitled";
  session.updatedAt = new Date().toISOString();
  saveSessions();
  const say = async (reply) => {
    session.history.push({ role: "agent", text: reply });
    saveSessions();
    return streamText(sessionId, reply);
  };
  const cwd = session.cwd;

  if (/subscriptiononly/.test(text)) {
    // What claude-agent-acp says (with --hide-claude-auth) when the only login is a claude.ai plan.
    throw { code: -32000, message: "Authentication required: Claude Agent can't use a claude.ai subscription" };
  }

  if ((/needauth/.test(text) || process.env.FAKE_ACP_REQUIRE_LOGIN) && !fs.existsSync(loginMarker)) {
    throw { code: -32000, message: "Authentication required" };
  }

  if (/^\/review/.test(text.trim())) {
    await say("Reviewing your changes: **2 files** look good. One suggestion: add a test for `greet()`.");
    return { stopReason: "end_turn" };
  }

  if (/mention/.test(text)) {
    const parts = params.prompt.map((block) => {
      if (block.type === "resource") return `resource ${path.basename(decodeURI(block.resource.uri.replace(/^file:\/\//, "").replace(/#.*$/, "")))} (${block.resource.text.length} chars${/#L/.test(block.resource.uri) ? `, ${block.resource.uri.replace(/^.*#/, "")}` : ""})`;
      if (block.type === "resource_link") return `link ${block.name}`;
      if (block.type === "image") return `image ${block.mimeType}`;
      return `text`;
    });
    await say(`Received: ${parts.join("; ")}.`);
    return { stopReason: "end_turn" };
  }

  if (/elicit/.test(text)) {
    const answer = await request("elicitation/create", { sessionId, mode: "url", message: "Sign in to the fake service to continue.", elicitationId: "e1", url: "https://example.com/device?code=FAKE-1234" });
    await say(`The elicitation was answered: ${answer.action}.`);
    return { stopReason: "end_turn" };
  }

  if (/slow/.test(text)) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "This is going to take a while." } });
    for (let index = 0; index < 400; index++) {
      if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tick ${index} ` } });
      await sleep(50);
    }
    return { stopReason: "end_turn" };
  }

  // Thinking first, then a plan.
  await streamText(sessionId, "The user wants something done. Let me look at the workspace and plan the steps.", "agent_thought_chunk", 12);
  const entries = [
    { content: "Look at the workspace", priority: "medium", status: "completed" },
    { content: "Make the change", priority: "high", status: "in_progress" },
    { content: "Check the result", priority: "low", status: "pending" },
  ];
  update(sessionId, { sessionUpdate: "plan", entries });

  if (/write/.test(text)) {
    const file = path.join(cwd, "notes.md");
    const content = "# Notes\n\nWritten by the fake agent.\n- one\n- two\n";
    const toolCall = { toolCallId: id("write"), title: "Write notes.md", kind: "edit", status: "pending", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: null, newText: content }] };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const allowed = await askPermission(sessionId, toolCall);
    if (!allowed) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("write"), status: "failed", content: [{ type: "content", content: { type: "text", text: "The user rejected this change." } }] });
      await say("Okay — I won't write the file.");
      return { stopReason: "end_turn" };
    }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("write"), status: "in_progress" });
    await request("fs/write_text_file", { sessionId, path: file, content });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("write"), status: "completed" });
    update(sessionId, { sessionUpdate: "plan", entries: entries.map((entry) => ({ ...entry, status: "completed" })) });
    await say("I wrote `notes.md` with a short list.");
    update(sessionId, { sessionUpdate: "usage_update", used: 42_000, size: 200_000, cost: { amount: 0.12, currency: "USD" } });
    return { stopReason: "end_turn", usage: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } };
  }

  if (/edit/.test(text)) {
    const file = path.join(cwd, "src", "app.js");
    const read = await request("fs/read_text_file", { sessionId, path: file });
    const before = read.content;
    const after = before.replace("return 'hi ' + name;", "return `Hello, ${name}!`;").replace("// TODO", "// Greets people by name.");
    const toolCall = { toolCallId: id("edit"), title: "Edit src/app.js", kind: "edit", status: "pending", locations: [{ path: file, line: 2 }], content: [{ type: "diff", path: file, oldText: before, newText: after }] };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const allowed = await askPermission(sessionId, toolCall);
    if (!allowed) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("edit"), status: "failed" });
      await say("Okay, leaving it as it is.");
      return { stopReason: "end_turn" };
    }
    await request("fs/write_text_file", { sessionId, path: file, content: after });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("edit"), status: "completed" });
    await say("Updated the greeting in `src/app.js`.");
    return { stopReason: "end_turn" };
  }

  if (/run/.test(text)) {
    const toolCall = { toolCallId: id("run"), title: "echo hello from the terminal", kind: "execute", status: "pending", rawInput: { command: "echo hello from the terminal" } };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const { terminalId } = await request("terminal/create", { sessionId, command: "sh", args: ["-c", "echo hello from the terminal; echo second line; exit 0"], cwd, outputByteLimit: 10000 });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("run"), status: "in_progress", content: [{ type: "terminal", terminalId }] });
    const exit = await request("terminal/wait_for_exit", { sessionId, terminalId });
    const output = await request("terminal/output", { sessionId, terminalId });
    await request("terminal/release", { sessionId, terminalId });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("run"), status: exit.exitCode === 0 ? "completed" : "failed" });
    await say(`The command printed ${output.output.trim().split("\n").length} lines and exited with ${exit.exitCode}.`);
    return { stopReason: "end_turn" };
  }

  // Reading, then a Markdown answer.
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: id("read"), title: "Read README.md", kind: "read", status: "in_progress", locations: [{ path: path.join(cwd, "README.md"), line: 1 }] });
  await sleep(30);
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id("read"), status: "completed", content: [{ type: "content", content: { type: "text", text: "# Demo\nA small demo project." } }] });
  update(sessionId, { sessionUpdate: "plan", entries: entries.map((entry, index) => ({ ...entry, status: index < 2 ? "completed" : "in_progress" })) });
  const ok = await say(
    "Here's what I found:\n\n## Summary\n\nThe project has a **README** and a `src/app.js` module.\n\n```js\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n```\n\n- It's small\n- It's tidy\n\nAnything else?",
  );
  update(sessionId, { sessionUpdate: "usage_update", used: 12_345, size: 200_000 });
  return { stopReason: ok ? "end_turn" : "cancelled", usage: { totalTokens: 900, inputTokens: 700, outputTokens: 200 } };
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      clientCapabilities = params.clientCapabilities ?? {};
      const info = { codex: { name: "@agentclientprotocol/codex-acp", title: "Codex", version: "2.2.2" }, kimi: { name: "Kimi Code CLI", version: "2.2.0" }, cursor: { name: "cursor-agent", version: "2026.10.14" } }[persona];
      return {
        protocolVersion: 1,
        agentInfo: info ?? { name: "fake-acp-agent", title: "Fake Agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, close: {} },
          ...(persona === "codex" || persona === "kimi" ? { auth: { logout: {} } } : {}),
        },
        authMethods: authMethods(),
      };
    }
    case "authenticate":
      return authenticate(params, id);
    case "logout":
      fs.rmSync(loginMarker, { force: true });
      apiKeyLogin = false;
      return {};
    case "session/new": {
      if (!authorized()) throw authRequired();
      if (persona === "cursor" && process.env.CURSOR_API_KEY === "key_bad") throw { code: -32603, message: "Internal error", data: { message: "Failed to initialize session services" } };
      const session = newSession(params.cwd);
      setTimeout(() => announceCommands(session.sessionId), 20);
      return { sessionId: session.sessionId, modes: { currentModeId: session.mode, availableModes: modes }, configOptions: configOptions(session) };
    }
    case "session/load": {
      if (!authorized()) throw authRequired();
      const session = sessions[params.sessionId];
      if (!session) throw { code: -32002, message: "No such session" };
      for (const entry of session.history) {
        update(session.sessionId, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
      }
      setTimeout(() => announceCommands(session.sessionId), 20);
      return { modes: { currentModeId: session.mode, availableModes: modes }, configOptions: configOptions(session) };
    }
    case "session/list":
      return { sessions: Object.values(sessions).filter((session) => !params.cwd || session.cwd === params.cwd).filter((session) => session.history.length).map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt })) };
    case "session/close":
      return {};
    case "session/set_mode": {
      const session = sessions[params.sessionId];
      session.mode = params.modeId;
      saveSessions();
      update(session.sessionId, { sessionUpdate: "current_mode_update", currentModeId: session.mode });
      return {};
    }
    case "session/set_config_option": {
      const session = sessions[params.sessionId];
      if (params.configId === "mode") session.mode = params.value;
      if (params.configId === "model") session.model = params.value;
      if (params.configId === "effort" || params.configId === "reasoning_effort" || params.configId === "thinking") session.effort = params.value;
      saveSessions();
      return { configOptions: configOptions(session) };
    }
    case "session/prompt":
      return prompt(params);
    default:
      if (id !== undefined) throw { code: -32601, message: `Method not found: ${method}` };
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log("bad line", line);
    return;
  }
  if (message.method === undefined) {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (!waiting) return;
    if (message.error) waiting.reject(message.error);
    else waiting.resolve(message.result);
    return;
  }
  if (message.method === "session/cancel") {
    cancelled.add(message.params.sessionId);
    return;
  }
  if (message.id === undefined) return;
  Promise.resolve(handle(message))
    .then((result) => send({ id: message.id, result: result ?? null }))
    .catch((error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error), ...(error.data ? { data: error.data } : {}) } }));
});
lines.on("close", () => process.exit(0));
log("ready");
