/**
 * What Sable knows about particular agents beyond the protocol: names,
 * branding, order in the picker, per-agent hooks. Everything protocol-level
 * is generic (any ACP agent from the registry works); a profile only makes
 * an agent feel first-party. Sign-in methods and their environment live in
 * the backend's table (src-tauri/src/acp/env.rs) so Settings and the
 * agent's process agree.
 *
 * Per agent: how its own ACP sign-in methods read in the panel (`auth`),
 * what its errors mean (`explainError`), and — for proprietary downloads —
 * the notice shown before installing (`consent`).
 */

/** How one of the agent's own ACP auth methods is offered in the panel. */
export interface AuthMethodHint {
  /** The button's label (else the agent's name for it). */
  label?: string;
  description?: string;
  /** Open Settings → AI Agents on this Sable sign-in method instead of calling `authenticate`. */
  settings?: string;
  /** While `authenticate` waits (a browser sign-in): what to tell the user. */
  waiting?: string;
}

/** An error an agent returned, in words for its sign-in card. */
export interface ExplainedError {
  message: string;
  /** Show the sign-in card (rather than an error). */
  auth: boolean;
}

export interface AgentProfile {
  /** The registry id (or Sable's own entry's, src-tauri/src/acp/extra_agents.json). */
  id: string;
  /** What the product is called. */
  name: string;
  vendor: string;
  description: string;
  /** Accent for its icon. */
  color: string;
  /** Fully integrated and tested in this version (others: "Preview"). */
  integrated: boolean;
  docsUrl?: string;
  /** Extra `_meta` for session/new and session/load (e.g. per-session options). */
  sessionMeta?: (context: { cwd: string }) => Record<string, unknown> | undefined;
  /** What to call the panel's input. */
  placeholder?: string;
  /** Prompt suggestions on an empty thread. */
  suggestions?: string[];
  /** Not installed by Sable: a CLI of the user's own (found, or "get it here"). */
  cli?: { setupUrl: string };
  /** The agent's ACP auth methods, by id. */
  auth?: Record<string, AuthMethodHint>;
  /** Agent-specific errors (`provider`: the Sable sign-in method in use). */
  explainError?: (message: string, provider: string | undefined) => ExplainedError | null;
  /** Shown (and agreed to) before downloading it: proprietary software. */
  consent?: { vendor: string; termsUrl: string; size: string };
  /** The CLI's own name, when the user may have installed it themselves. */
  localCli?: string;
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    // Named as Anthropic's Agent SDK branding rules require for products
    // built on it ("Claude Agent", never Claude Code's name or marks).
    id: "claude-acp",
    name: "Claude Agent",
    vendor: "Anthropic models",
    description: "A coding agent on Anthropic's Claude Agent SDK. Use an Anthropic API key or Console account, Amazon Bedrock, Google Vertex AI, Microsoft Foundry, or your own gateway.",
    color: "#8B8BF5",
    integrated: true,
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    placeholder: "Ask Claude Agent to change, explain or run anything…  @ for context, / for commands",
    suggestions: [
      "Explain how this project is structured",
      "Find and fix the bug in the current file",
      "Write tests for the selected code",
      "Review my uncommitted changes",
    ],
  },
  {
    // The user's own installed `claude` CLI, unmodified, with its own sign-in
    // (claude_code_adapter.mjs drives it in headless mode). Plain-text name,
    // Sable's own visuals.
    id: "claude-code",
    name: "Claude Code",
    vendor: "runs your installed claude CLI",
    description: "Anthropic's Claude Code, run from the claude CLI you've installed, with your own sign-in (your Claude subscription or whatever Claude Code is set up with). Sable never handles the credentials.",
    color: "#A3A8B3",
    integrated: true,
    docsUrl: "https://code.claude.com/docs",
    cli: { setupUrl: "https://code.claude.com/docs/en/setup" },
    placeholder: "Ask Claude Code…  @ for context, / for commands",
    suggestions: ["Explain how this project is structured", "Find and fix the bug in the current file", "Write tests for the selected code", "Review my uncommitted changes"],
  },
  {
    id: "codex-acp",
    name: "Codex",
    vendor: "OpenAI",
    description:
      "OpenAI's coding agent (the Codex CLI, through the codex-acp adapter). Sign in with your ChatGPT plan, or use an OpenAI API key, Amazon Bedrock, Azure OpenAI, a local model (Ollama, LM Studio) or any OpenAI-compatible endpoint.",
    color: "#10A37F",
    integrated: true,
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
    placeholder: "Ask Codex to change, explain or run anything…  @ for context, / for commands",
    suggestions: ["Explain how this project is structured", "Find and fix the bug in the current file", "Write tests for the selected code", "/review my uncommitted changes"],
    auth: {
      "chat-gpt": { label: "Sign in with ChatGPT", description: "Opens ChatGPT's sign-in in your browser. Uses your ChatGPT plan.", waiting: "Finish signing in to ChatGPT in your browser…" },
      "chat-gpt-device-code": {
        label: "Sign in with a one-time code",
        description: "For a browser on another device: open the page, enter the code it shows here. (Device-code sign-in must be allowed in your ChatGPT security settings.)",
        waiting: "Enter the code on the ChatGPT page…",
      },
      "api-key": { label: "Use an OpenAI API key…", description: "Add a key in Settings → AI Agents; it's kept in your keychain and never written to ~/.codex.", settings: "apiKey" },
    },
    explainError: (message) =>
      /Sign-in did not complete/i.test(message)
        ? { message: "The ChatGPT sign-in didn't finish. Try again, or use a one-time code.", auth: true }
        : /device code (sign-in|authentication).*(cancel|disabled|not enabled)/i.test(message)
          ? { message: "Device-code sign-in didn't go through. It must be enabled in your ChatGPT security settings (or your workspace's).", auth: true }
          : null,
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    description:
      "Moonshot AI's coding agent (the Kimi Code CLI). Sign in with your Kimi account, or use a Kimi Platform, Anthropic, OpenAI-compatible or Gemini API key, or a local model.",
    color: "#2F6BFF",
    integrated: true,
    docsUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html",
    placeholder: "Ask Kimi Code to change, explain or run anything…  @ for context, / for commands",
    suggestions: ["Explain how this project is structured", "Find and fix the bug in the current file", "Write tests for the selected code", "Review my uncommitted changes"],
    auth: {
      login: { label: "Sign in with your Kimi account", description: "Opens a terminal running Kimi Code's sign-in: confirm the one-time code in your browser, then come back." },
    },
    explainError: (message, provider) =>
      provider && provider !== "account" && /auth(entication)? required/i.test(message)
        ? { message: "Kimi Code didn't accept the model settings. Check the API key and model in Settings → AI Agents, or sign in with your Kimi account.", auth: true }
        : null,
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    description: "Cursor's coding agent (the Cursor CLI). Sign in with your Cursor account, or use a Cursor API key. Proprietary software from Anysphere, downloaded from Cursor only when you choose to.",
    color: "#8A8A8A",
    integrated: true,
    docsUrl: "https://cursor.com/docs/cli/acp",
    placeholder: "Ask Cursor to change, explain or run anything…  @ for context, / for commands",
    suggestions: ["Explain how this project is structured", "Find and fix the bug in the current file", "Write tests for the selected code", "Review my uncommitted changes"],
    auth: {
      cursor_login: { label: "Sign in with Cursor", description: "Opens Cursor's sign-in in your browser. Uses your Cursor plan.", waiting: "Finish signing in to Cursor in your browser…" },
    },
    explainError: (message, provider) =>
      /call authenticate\(\)/i.test(message)
        ? { message: provider === "apiKey" ? "Cursor needs your API key: add it in Settings → AI Agents, or sign in with your Cursor account." : "Cursor needs you to sign in with your Cursor account before it can work.", auth: true }
        : /Failed to initialize session services/i.test(message)
        ? {
            message:
              provider === "apiKey"
                ? "Cursor didn't accept the API key (or couldn't reach Cursor). Check the key in Settings → AI Agents, or sign in with your Cursor account."
                : "Cursor couldn't start a session: sign in again, or check your connection.",
            auth: true,
          }
        : /Failed to open browser/i.test(message)
          ? { message: "Cursor couldn't open your browser from here. Sign in in a terminal instead (it prints a link to open).", auth: true }
          : null,
    consent: { vendor: "Anysphere (Cursor)", termsUrl: "https://cursor.com/terms-of-service", size: "about 170 MB (600 MB unpacked)" },
    localCli: "cursor-agent",
  },
];

/** Registry entries not worth offering (superseded by one above). */
export const HIDDEN_REGISTRY_IDS = new Set(["kimi"]);

export function profileFor(id: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((profile) => profile.id === id);
}

/** The agent's display name: its profile's, else the registry's. */
export function agentName(id: string, registryName?: string): string {
  return profileFor(id)?.name ?? registryName ?? id;
}

/** Order: featured agents first (in profile order), then by name. */
export function agentOrder(a: { id: string; name: string }, b: { id: string; name: string }): number {
  const rank = (id: string) => {
    const index = AGENT_PROFILES.findIndex((profile) => profile.id === id);
    return index < 0 ? AGENT_PROFILES.length : index;
  };
  return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
}

/** The hint for one of an agent's ACP auth methods. */
export function authHint(agentId: string, methodId: string): AuthMethodHint | undefined {
  return profileFor(agentId)?.auth?.[methodId];
}

/** Installing it downloads proprietary software from its vendor: ask first. */
export function needsConsent(entry: { license?: string; distribution: { binary?: unknown; npx?: unknown } }): boolean {
  return (entry.license ?? "").toLowerCase() === "proprietary" && Boolean(entry.distribution.binary) && !entry.distribution.npx;
}

/** "Sign in to ChatGPT and enter this code: ABCD-1234" → "ABCD-1234". */
export function deviceCode(message: string): string | null {
  const match = /\bcode\b[^A-Za-z0-9]{0,4}([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)\b/i.exec(message);
  return match && /\d|-/.test(match[1]) ? match[1] : null;
}

/** An agent error, in words (the agent's own explanation first). */
export function explainAgentError(agentId: string, message: string, provider?: string): ExplainedError | null {
  return profileFor(agentId)?.explainError?.(message, provider) ?? null;
}

/** The id of Sable's own (API-key) agent in the panel's agent picker. */
export const SABLE_AGENT_ID = "sable";
