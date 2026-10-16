// Unit tests for the ACP client's pure parts: the JSON-RPC peer
// (requests both ways, notifications, errors, $/cancel_request, closing)
// and the line diff behind edit review (hunks, accept/reject of one change).
import { JsonRpcPeer, RpcError } from "../../src/lib/acp/connection";
import { acceptChange, diffLines, diffStats, hunks, joinLines, rejectChange, splitLines } from "../../src/lib/acp/lineDiff";
import { authHint, deviceCode, explainAgentError, needsConsent, profileFor } from "../../src/lib/acp/agents";

let failures = 0;
const check = (name: string, condition: unknown, detail?: unknown) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  — ${JSON.stringify(detail)}`}`);
  }
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- JsonRpcPeer ------------------------------------------------------------------------
{
  const sent: Record<string, unknown>[] = [];
  const notifications: [string, unknown][] = [];
  let aborted = false;
  const peer = new JsonRpcPeer((line) => void sent.push(JSON.parse(line)), {
    request: async (method, params, signal) => {
      if (method === "fs/read_text_file") return { content: `read ${(params as { path: string }).path}` };
      if (method === "slow") {
        return new Promise((_, reject) => signal.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted")))));
      }
      throw new RpcError(-32601, `no ${method}`);
    },
    notification: (method, params) => void notifications.push([method, params]),
  });

  const pending = peer.request<{ ok: boolean }>("initialize", { protocolVersion: 1 });
  check("a request is one JSON-RPC line", sent[0]?.jsonrpc === "2.0" && sent[0]?.method === "initialize" && sent[0]?.id === 1, sent[0]);
  peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  check("its result resolves it", (await pending).ok === true);

  const failing = peer.request("session/new", {});
  peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Authentication required", data: { reason: "x" } } }));
  try {
    await failing;
    check("an error rejects", false);
  } catch (error) {
    check("an error rejects with its code and data", error instanceof RpcError && error.code === -32000 && (error.data as { reason: string }).reason === "x", String(error));
  }

  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan", entries: [] } } }));
  check("notifications reach the handler", notifications[0]?.[0] === "session/update");

  peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "a1", method: "fs/read_text_file", params: { path: "/x" } }));
  await tick();
  const answer = sent.find((message) => message.id === "a1");
  check("the agent's requests are answered", (answer?.result as { content: string })?.content === "read /x", answer);

  peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope", params: {} }));
  await tick();
  const unknown = sent.find((message) => message.id === 7);
  check("unknown methods answer -32601", (unknown?.error as { code: number })?.code === -32601, unknown);

  peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "slow", params: {} }));
  await tick();
  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 8 } }));
  await tick();
  await tick();
  const cancelled = sent.find((message) => message.id === 8);
  check("$/cancel_request aborts the handler and answers -32800", aborted && (cancelled?.error as { code: number })?.code === -32800, cancelled);

  peer.receive("not json at all");
  check("stray output is ignored", true);

  const orphan = peer.request("session/prompt", {});
  peer.close(new Error("exited"));
  try {
    await orphan;
    check("closing fails pending requests", false);
  } catch (error) {
    check("closing fails pending requests", String(error).includes("exited"));
  }
  check("a closed peer refuses new requests", await peer.request("x").then(() => false, () => true));
}

// --- Line diffs -------------------------------------------------------------------------------
{
  const a = splitLines("one\ntwo\nthree\nfour\nfive\n");
  const b = splitLines("one\nTWO\nthree\nfour\nfive\nsix\n");
  const changes = diffLines(a, b);
  check("two changes: a replacement and an insertion", changes.length === 2, changes);
  check("the replacement's lines", changes[0].originalStartLineNumber === 2 && changes[0].originalEndLineNumber === 2 && changes[0].modifiedStartLineNumber === 2 && changes[0].modifiedEndLineNumber === 2, changes[0]);
  check("the insertion after line 5", changes[1].originalStartLineNumber === 5 && changes[1].originalEndLineNumber === 0 && changes[1].modifiedStartLineNumber === 6, changes[1]);
  check("stats", JSON.stringify(diffStats(changes)) === JSON.stringify({ added: 2, removed: 1 }), diffStats(changes));
  const kept = acceptChange(a, b, changes[0]);
  check("accepting one change moves only it into the baseline", kept.join(",") === "one,TWO,three,four,five", kept);
  const undone = rejectChange(a, b, changes, changes[0]);
  check("rejecting one change undoes only it", undone.join(",") === "one,two,three,four,five,six", undone);
  check("joinLines keeps the trailing newline", joinLines(["a", "b"], "x\n") === "a\nb\n" && joinLines(["a"], "x") === "a");
  const rows = hunks(a, b, changes, 1);
  check("hunks with context", rows.length === 2 && rows[0].rows.some((row) => row.kind === "removed" && row.text === "two") && rows[1].rows.some((row) => row.kind === "added" && row.text === "six"), rows);
  const created = diffLines([], splitLines("x\ny\n"));
  check("a new file is one insertion", created.length === 1 && created[0].modifiedEndLineNumber === 2, created);
  const deleted = diffLines(splitLines("x\ny\n"), []);
  check("an emptied file is one deletion", deleted.length === 1 && deleted[0].originalEndLineNumber === 2 && deleted[0].modifiedEndLineNumber === 0, deleted);
  const same = diffLines(a, a);
  check("no changes", same.length === 0);
  // A bigger, scattered edit.
  const big = Array.from({ length: 400 }, (_, index) => `line ${index}`);
  const edited = big.map((line, index) => (index % 50 === 0 ? `${line} edited` : line));
  check("scattered edits are found one by one", diffLines(big, edited).length === 8, diffLines(big, edited).length);
}

// --- Per-agent sign-in -----------------------------------------------------------------------------
{
  check("Codex's device code is picked out of its message", deviceCode("Sign in to ChatGPT and enter this code: ABCD-1234") === "ABCD-1234");
  check("…and a plain one", deviceCode("Enter code: K7Q2XZ") === "K7Q2XZ");
  check("no code, no match", deviceCode("Sign in to the fake service to continue.") === null && deviceCode("enter the code shown") === null);
  const cursor = { license: "proprietary", distribution: { binary: {} } };
  check("Cursor's download needs consent", needsConsent(cursor));
  check("an npm package doesn't", !needsConsent({ license: "proprietary", distribution: { npx: {} } }) && !needsConsent({ license: "MIT", distribution: { binary: {} } }));
  check("Codex's API key method opens Settings (never authenticate into ~/.codex)", authHint("codex-acp", "api-key")?.settings === "apiKey");
  check("its ChatGPT methods say what happens", Boolean(authHint("codex-acp", "chat-gpt")?.waiting) && Boolean(authHint("codex-acp", "chat-gpt-device-code")?.label));
  const rejected = explainAgentError("cursor", "Failed to initialize session services", "apiKey");
  check("Cursor rejecting a key is a sign-in problem, in words", rejected?.auth === true && /API key/.test(rejected.message), rejected);
  const noBrowser = explainAgentError("cursor", "Failed to open browser for login. Please visit: https://cursor.com/x", "account");
  check("Cursor without a browser points to the terminal", noBrowser?.auth === true && /terminal/.test(noBrowser.message), noBrowser);
  check("Cursor's developer-facing auth message is replaced", /sign in/i.test(explainAgentError("cursor", "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.", "account")?.message ?? ""));
  check("Kimi Code with a key that's refused says to check it", explainAgentError("kimi-code", "Authentication required", "platform")?.auth === true);
  check("…but not when signing in with the account", explainAgentError("kimi-code", "Authentication required", "account") === null);
  check("unknown errors are left alone", explainAgentError("codex-acp", "Something else", "chatgpt") === null && explainAgentError("opencode", "x") === null);
  check("Codex, Kimi Code and Cursor are integrated (no Preview)", ["codex-acp", "kimi-code", "cursor"].every((id) => profileFor(id)?.integrated));
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
