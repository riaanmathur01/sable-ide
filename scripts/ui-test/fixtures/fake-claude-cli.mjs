#!/usr/bin/env node
// A fake `claude` CLI for the agents UI suite: just enough of Claude Code's
// documented headless interface for Sable's Claude Code adapter
// (src-tauri/src/acp/claude_code_adapter.mjs):
//
//   claude --version
//   claude auth status --json | auth logout
//   claude                                  (interactive: "type /login"; signs in)
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages --permission-mode M [--model X] [--effort E]
//          --mcp-config JSON --permission-prompt-tool mcp__sable__approve
//          (--session-id ID | --resume ID)
//
// In -p mode each stream-json user message on stdin is a turn: system/init,
// streamed thinking and text (stream_event), assistant messages with
// tool_use, user messages with tool_result, and a result with usage. Tools
// that need permission ask through the MCP permission tool from
// --mcp-config, the way Claude Code does. Prompt keywords: write, edit,
// bash, todo, slow, image (else: a Markdown answer).
//
// State (login marker, launches.jsonl) in $FAKE_CLAUDE_STATE; transcripts
// under $CLAUDE_CONFIG_DIR/projects when it's set.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const state = process.env.FAKE_CLAUDE_STATE ?? path.join(os.tmpdir(), "fake-claude-state");
fs.mkdirSync(state, { recursive: true });
const marker = path.join(state, "logged-in");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(state, "launches.jsonl"), `${JSON.stringify({ argv, cwd: process.cwd(), authEnv: Object.keys(process.env).filter((name) => /ANTHROPIC|CLAUDE_CODE_OAUTH/.test(name)) })}\n`);

if (argv[0] === "--version" || argv[0] === "-v") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = fs.existsSync(marker);
  console.log(JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "dev@example.com", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2));
  process.exit(loggedIn ? 0 : 1);
}
if (argv[0] === "auth" && argv[1] === "logout") {
  fs.rmSync(marker, { force: true });
  console.log("Logged out.");
  process.exit(0);
}
if (!argv.includes("-p")) {
  // Interactive: the user would run /login here.
  console.log("Fake Claude Code — type /login to sign in");
  fs.writeFileSync(marker, "yes");
  console.log("Login successful.");
  process.exit(0);
}

const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session";
const mode = flag("--permission-mode") ?? "default";
const model = flag("--model") ?? "claude-fake-1";
const emit = (event) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...event })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

// The permission tool: the MCP server from --mcp-config, over stdio.
let mcp = null;
async function permission(toolName, input, toolUseId) {
  const tool = flag("--permission-prompt-tool");
  if (!tool || mode === "bypassPermissions" || (mode === "acceptEdits" && ["Write", "Edit", "MultiEdit"].includes(toolName))) return { behavior: "allow", updatedInput: input };
  if (!mcp) {
    const config = JSON.parse(flag("--mcp-config"));
    const [serverName, server] = Object.entries(config.mcpServers)[0];
    const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
    const waiting = new Map();
    let next = 1;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    });
    const call = (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "9.9.9" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { result } = await call("tools/list", {});
    if (!result.tools.some((entry) => `mcp__${serverName}__${entry.name}` === tool)) throw new Error(`no permission tool ${tool}`);
    mcp = { call, serverName, child };
  }
  const name = tool.replace(`mcp__${mcp.serverName}__`, "");
  const response = await mcp.call("tools/call", { name, arguments: { tool_name: toolName, input, tool_use_id: toolUseId } });
  return JSON.parse(response.result.content[0].text);
}

let turn = 0;
async function streamText(messageId, text, kind = "text") {
  emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: messageId } } });
  for (const piece of text.match(/.{1,12}/gs) ?? []) {
    if (interrupted) return false;
    emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: kind === "thinking" ? { type: "thinking_delta", thinking: piece } : { type: "text_delta", text: piece } } });
    await sleep(6);
  }
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: messageId, role: "assistant", content: [kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text }] } });
  return true;
}

async function useTool(name, input, run) {
  const id = `toolu_${process.pid}_${turn}_${name}`;
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_tool_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const decision = await permission(name, input, id);
  if (decision.behavior !== "allow") {
    emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: decision.message ?? "Permission denied" }] } });
    return false;
  }
  const output = await run(decision.updatedInput ?? input);
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] } });
  return true;
}

async function handleTurn(message) {
  turn += 1;
  const blocks = message.message?.content ?? [];
  // What the user typed (the first text block; context blocks follow).
  const text = typeof blocks === "string" ? blocks : (blocks.find((block) => block.type === "text" && !block.text.startsWith("<context"))?.text ?? "");
  const images = Array.isArray(blocks) ? blocks.filter((block) => block.type === "image").length : 0;
  emit({ type: "system", subtype: "init", cwd: process.cwd(), model, permissionMode: mode, tools: ["Read", "Write", "Edit", "Bash", "TodoWrite"], slash_commands: ["review", "compact", "init", "login"], mcp_servers: [{ name: "sable", status: "connected" }] });
  if (!fs.existsSync(marker)) {
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: {} });
    return;
  }
  await streamText(`msg_think_${turn}`, "Let me look at what's being asked.", "thinking");
  let reply;
  if (/slow/.test(text)) {
    for (let index = 0; index < 300 && !interrupted; index++) {
      emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `step ${index} ` } } });
      await sleep(40);
    }
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Interrupted", usage: {} });
    process.exit(130);
  } else if (/write/.test(text)) {
    const file = path.join(process.cwd(), "cc-notes.md");
    const ok = await useTool("Write", { file_path: file, content: "# Notes from Claude Code\n\n- written by the CLI itself\n" }, (input) => (fs.writeFileSync(input.file_path, input.content), `File created successfully at: ${input.file_path}`));
    reply = ok ? "I created `cc-notes.md`." : "Understood — I didn't write it.";
  } else if (/edit/.test(text)) {
    const file = path.join(process.cwd(), "src", "app.js");
    const before = fs.readFileSync(file, "utf8");
    const old = before.split("\n").find((line) => line.includes("return")) ?? before.split("\n")[0];
    const ok = await useTool("Edit", { file_path: file, old_string: old, new_string: "  return `Hi, ${name}!`; // edited by Claude Code" }, (input) => {
      fs.writeFileSync(input.file_path, fs.readFileSync(input.file_path, "utf8").replace(input.old_string, input.new_string));
      return "The file has been updated.";
    });
    reply = ok ? "Edited `src/app.js`." : "Left it unchanged.";
  } else if (/bash/.test(text)) {
    await useTool("Bash", { command: "echo hello from bash", description: "Say hello" }, () => "hello from bash");
    reply = "The command printed `hello from bash`.";
  } else if (/todo/.test(text)) {
    emit({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_todo_${turn}`, role: "assistant", content: [{ type: "tool_use", id: `toolu_todo_${turn}`, name: "TodoWrite", input: { todos: [{ content: "Read the code", status: "completed", activeForm: "Reading" }, { content: "Fix the bug", status: "in_progress", activeForm: "Fixing" }, { content: "Run the tests", status: "pending", activeForm: "Testing" }] } }] } });
    emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_todo_${turn}`, content: "Todos updated" }] } });
    reply = "Here's the plan.";
  } else if (images) {
    reply = `I can see ${images} image${images === 1 ? "" : "s"}.`;
  } else {
    reply = `## Claude Code here\n\nRunning in **${mode}** mode with \`${model}\`.\n\n\`\`\`sh\nclaude -p\n\`\`\``;
  }
  await streamText(`msg_reply_${turn}`, reply);
  // A transcript where Claude Code keeps them (only with CLAUDE_CONFIG_DIR: tests).
  if (process.env.CLAUDE_CONFIG_DIR) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [{ type: "user", message: { role: "user", content: text } }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } }];
    fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reply,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 1200, outputTokens: 80, contextWindow: 200000 } },
  });
}

let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "user") queue = queue.then(() => handleTurn(message));
});
process.stdin.on("end", () => queue.then(() => setTimeout(() => process.exit(0), 50)));
