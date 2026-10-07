import {
  createDirectory,
  deletePath,
  isDirectory,
  listWorkspaceFiles,
  readDirectory,
  runShell,
  searchText,
} from "../ipc";
import { readCurrentText, writeFileContents } from "../fileContents";
import { useTabsStore } from "../../store/tabsStore";
import { useBreakpointsStore } from "../../store/breakpointsStore";
import { useGitStore } from "../../store/gitStore";
import { getSetting } from "../../store/settingsStore";
import type { ToolCall, ToolDefinition } from "./types";

/**
 * The agent's tools: definitions sent to the model, plus executors that
 * run them against the workspace through the same Rust commands the UI
 * uses. Paths are workspace-relative and confined to the workspace.
 */

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_directory",
    description:
      "List the entries of a directory in the workspace. Directories end with '/'.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the workspace root. Defaults to the root.",
        },
      },
    },
  },
  {
    name: "find_files",
    description:
      "Find files by name or path. Accepts a substring (case-insensitive) or a glob like '**/*.test.ts'. Respects .gitignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Substring or glob pattern." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search",
    description:
      "Search file contents across the workspace (ripgrep engine, respects .gitignore). Smart case: case-insensitive unless the query has uppercase. Returns path:line: text.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text (or regex if regex=true) to find." },
        regex: { type: "boolean", description: "Treat query as a regular expression." },
        max_results: { type: "integer", description: "Maximum matches (default 100)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file. Output lines are prefixed with their line number and a tab ('12\\t'); that prefix is NOT part of the file. Reflects unsaved editor changes. Reads up to 2000 lines per call — use start_line/end_line for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        start_line: { type: "integer", description: "First line to read (1-based)." },
        end_line: { type: "integer", description: "Last line to read (inclusive)." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true — include enough surrounding lines to make it unique. Prefer this over write_file for changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a file, or overwrite an existing one with the complete new content. Parent directories are created as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "The full file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or directory (recursively). Use with care.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace root (the user's login shell; non-interactive, no stdin; killed after a timeout). Use for builds, tests, linters, package managers. Do not start servers or watchers that never exit.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        timeout_seconds: {
          type: "integer",
          description: "Override the timeout (default from settings, max 1800).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "git",
    description:
      "Run git in the workspace with the given arguments, e.g. [\"status\"], [\"diff\", \"--stat\"], [\"commit\", \"-m\", \"msg\"]. Uses the user's git config and credentials.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments after 'git'.",
        },
      },
      required: ["args"],
    },
  },
  {
    name: "github",
    description:
      "Run the GitHub CLI (gh) in the workspace, e.g. [\"pr\", \"create\", \"--title\", \"…\", \"--body\", \"…\"], [\"issue\", \"list\"], [\"pr\", \"view\", \"12\"]. Requires gh to be installed and authenticated.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments after 'gh'.",
        },
      },
      required: ["args"],
    },
  },
];

/** What a successful file-changing call did, for the chat's Revert. */
export interface FileEdit {
  path: string;
  /** Content before the change; null if the file didn't exist. */
  before: string | null;
  /** Content after; null if the call deleted it. */
  after: string | null;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  edit?: FileEdit;
}

/** Which approval policy a call falls under (null = never ask). */
export function approvalCategory(call: ToolCall): "edit" | "command" | null {
  switch (call.name) {
    case "edit_file":
    case "write_file":
    case "delete_path":
      return "edit";
    case "run_command":
      return "command";
    case "git":
      return isReadOnlyGit(stringArray(call.args.args)) ? null : "command";
    case "github":
      return isReadOnlyGh(stringArray(call.args.args)) ? null : "command";
    default:
      return null;
  }
}

const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files",
  "shortlog", "describe", "grep", "reflog", "cat-file", "ls-tree",
]);
/** These list things when given only flags (`git branch -a`). */
const LISTING_GIT = new Set(["branch", "remote", "tag", "stash"]);

function isReadOnlyGit(args: string[]): boolean {
  const [subcommand, ...rest] = args;
  if (!subcommand) return false;
  if (READ_ONLY_GIT.has(subcommand)) return true;
  if (LISTING_GIT.has(subcommand)) {
    if (subcommand === "stash") return rest[0] === "list";
    return rest.every((arg) =>
      ["-a", "-r", "-v", "-vv", "--list", "--all", "--show-current"].includes(arg),
    );
  }
  return false;
}

function isReadOnlyGh(args: string[]): boolean {
  const [group, action] = args;
  const readOnly: Record<string, string[]> = {
    pr: ["view", "list", "status", "diff", "checks"],
    issue: ["view", "list", "status"],
    repo: ["view"],
    run: ["list", "view"],
    auth: ["status"],
    release: ["list", "view"],
  };
  return Boolean(group && action && readOnly[group]?.includes(action));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** POSIX single-quote an argument for the login shell. */
function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** One-line, human-readable description of a call for the chat UI. */
export function describeCall(call: ToolCall): string {
  const args = call.args;
  switch (call.name) {
    case "list_directory":
      return `List ${String(args.path ?? ".")}`;
    case "find_files":
      return `Find files “${String(args.pattern ?? "")}”`;
    case "search":
      return `Search “${String(args.query ?? "")}”`;
    case "read_file": {
      const range =
        args.start_line != null
          ? `:${args.start_line}-${args.end_line ?? ""}`
          : "";
      return `Read ${String(args.path ?? "")}${range}`;
    }
    case "edit_file":
      return `Edit ${String(args.path ?? "")}`;
    case "write_file":
      return `Write ${String(args.path ?? "")}`;
    case "delete_path":
      return `Delete ${String(args.path ?? "")}`;
    case "run_command":
      return `$ ${String(args.command ?? "")}`;
    case "git":
      return `git ${stringArray(args.args).join(" ")}`;
    case "github":
      return `gh ${stringArray(args.args).join(" ")}`;
    default:
      return call.name;
  }
}

class ToolError extends Error {}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new ToolError(`Missing required string argument "${key}"`);
  }
  return value;
}

/**
 * Resolve a model-supplied path against the workspace root, normalizing
 * `.`/`..`, and refuse anything that escapes the workspace.
 */
export function resolveWorkspacePath(root: string, input: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const cleaned = input.trim().replace(/\\/g, "/");
  const rootNormalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const isAbsolute = cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned);
  const joined = isAbsolute ? cleaned : `${rootNormalized}/${cleaned}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const prefix = rootNormalized.startsWith("/") ? "/" : "";
  const resolved = prefix + segments.join("/");
  if (resolved !== rootNormalized && !resolved.startsWith(`${rootNormalized}/`)) {
    throw new ToolError(`Path "${input}" is outside the workspace`);
  }
  return separator === "\\" ? resolved.replace(/\//g, "\\") : resolved;
}

function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") || "." : path;
}

async function ensureParentDirectories(root: string, path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = path.slice(0, separatorIndex);
  if (parent.length <= root.length) return;
  const relative = parent.slice(root.length).split(/[/\\]/).filter(Boolean);
  let current = root;
  for (const segment of relative) {
    current = `${current}/${segment}`;
    if (!(await isDirectory(current))) await createDirectory(current);
  }
}

/** Undo an agent edit (Revert button). */
export async function revertEdit(edit: FileEdit) {
  if (edit.before === null) {
    await deletePath(edit.path);
    useTabsStore.getState().closeTabsUnder(edit.path);
  } else {
    await writeFileContents(edit.path, edit.before);
  }
  useGitStore.getState().refresh();
}

const MAX_TOOL_OUTPUT = 30_000;

/** Keep the head and tail of oversized output (errors are usually last). */
function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const half = MAX_TOOL_OUTPUT / 2;
  return `${text.slice(0, half)}\n\n… [${text.length - MAX_TOOL_OUTPUT} characters omitted] …\n\n${text.slice(-half)}`;
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

async function runAndFormat(command: string, root: string, timeout?: number) {
  const output = await runShell(
    command,
    root,
    timeout ?? getSetting("ai.commandTimeout"),
  );
  // git/gh/scripts can change the tree or repo state.
  useGitStore.getState().refresh();
  const parts: string[] = [];
  parts.push(
    output.timedOut
      ? "Timed out"
      : `Exit code: ${output.exitCode ?? "unknown"}`,
  );
  if (output.stdout.trim()) parts.push(`stdout:\n${output.stdout.trimEnd()}`);
  if (output.stderr.trim()) parts.push(`stderr:\n${output.stderr.trimEnd()}`);
  if (!output.stdout.trim() && !output.stderr.trim()) parts.push("(no output)");
  return {
    content: clip(parts.join("\n")),
    isError: output.timedOut || (output.exitCode ?? 1) !== 0,
  };
}

/** Glob → RegExp over '/'-separated relative paths. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index++;
        if (glob[index + 1] === "/") index++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A pattern without '/' matches the file name anywhere.
  return new RegExp(glob.includes("/") ? `^${pattern}$` : `(^|/)${pattern}$`, "i");
}

export async function executeTool(
  call: ToolCall,
  root: string,
): Promise<ToolOutcome> {
  try {
    const args = call.args;
    if ("__invalidJson" in args) {
      throw new ToolError("Tool arguments were not valid JSON; please retry.");
    }
    switch (call.name) {
      case "list_directory": {
        const path = resolveWorkspacePath(root, String(args.path ?? "."));
        const entries = await readDirectory(path);
        const shown = entries.slice(0, 500);
        const lines = shown.map((entry) =>
          entry.isDirectory ? `${entry.name}/` : entry.name,
        );
        if (entries.length > shown.length) {
          lines.push(`… and ${entries.length - shown.length} more`);
        }
        return { content: lines.join("\n") || "(empty directory)", isError: false };
      }

      case "find_files": {
        const pattern = requireString(args, "pattern");
        const files = await listWorkspaceFiles(root);
        const relative = files.map((file) => relativeTo(root, file).replace(/\\/g, "/"));
        const isGlob = /[*?]/.test(pattern);
        const regex = isGlob ? globToRegExp(pattern) : null;
        const needle = pattern.toLowerCase();
        const hits = relative.filter((path) =>
          regex ? regex.test(path) : path.toLowerCase().includes(needle),
        );
        const shown = hits.slice(0, 200);
        const suffix = hits.length > shown.length ? `\n… ${hits.length - shown.length} more` : "";
        return {
          content: shown.length ? shown.join("\n") + suffix : "No files found",
          isError: false,
        };
      }

      case "search": {
        const query = requireString(args, "query");
        const max = typeof args.max_results === "number" ? args.max_results : 100;
        const matches = await searchText(root, query, args.regex === true, max);
        if (matches.length === 0) return { content: "No matches", isError: false };
        const lines = matches.map(
          (match) =>
            `${relativeTo(root, match.path)}:${match.lineNumber}: ${match.preview.trim()}`,
        );
        if (matches.length >= max) lines.push(`(stopped at ${max} matches)`);
        return { content: clip(lines.join("\n")), isError: false };
      }

      case "read_file": {
        const path = resolveWorkspacePath(root, requireString(args, "path"));
        const text = await readCurrentText(path);
        if (text === null) throw new ToolError(`File not found: ${args.path}`);
        const lines = text.split("\n");
        const start = Math.max(1, Number(args.start_line ?? 1));
        const requestedEnd = Number(args.end_line ?? start + 1999);
        const end = Math.min(lines.length, requestedEnd, start + 1999);
        const body = lines
          .slice(start - 1, end)
          .map((line, index) => {
            const clipped = line.length > 2000 ? `${line.slice(0, 2000)}… [line truncated]` : line;
            return `${start + index}\t${clipped}`;
          })
          .join("\n");
        const more =
          end < lines.length
            ? `\n(showing lines ${start}-${end} of ${lines.length}; use start_line to read more)`
            : "";
        return { content: (body || "(empty file)") + more, isError: false };
      }

      case "edit_file": {
        const path = resolveWorkspacePath(root, requireString(args, "path"));
        const oldString = requireString(args, "old_string");
        const newString = requireString(args, "new_string");
        if (oldString === newString) throw new ToolError("old_string and new_string are identical");
        const before = await readCurrentText(path);
        if (before === null) throw new ToolError(`File not found: ${args.path}`);
        if (oldString === "") throw new ToolError("old_string is empty; use write_file to create files");
        const occurrences = before.split(oldString).length - 1;
        if (occurrences === 0) {
          throw new ToolError(
            "old_string was not found in the file. Re-read the file and match it exactly (whitespace and indentation included, without line-number prefixes).",
          );
        }
        if (occurrences > 1 && args.replace_all !== true) {
          throw new ToolError(
            `old_string appears ${occurrences} times. Include more surrounding context to make it unique, or set replace_all.`,
          );
        }
        const after =
          args.replace_all === true
            ? before.split(oldString).join(newString)
            : before.replace(oldString, () => newString);
        await writeFileContents(path, after);
        const delta = countLines(after) - countLines(before);
        return {
          content: `Edited ${relativeTo(root, path)} (${occurrences > 1 ? `${occurrences} replacements, ` : ""}${delta >= 0 ? "+" : ""}${delta} lines)`,
          isError: false,
          edit: { path, before, after },
        };
      }

      case "write_file": {
        const path = resolveWorkspacePath(root, requireString(args, "path"));
        const content = requireString(args, "content");
        if (await isDirectory(path)) throw new ToolError(`${args.path} is a directory`);
        const before = await readCurrentText(path);
        await ensureParentDirectories(root, path);
        await writeFileContents(path, content);
        return {
          content: `${before === null ? "Created" : "Overwrote"} ${relativeTo(root, path)} (${countLines(content)} lines)`,
          isError: false,
          edit: { path, before, after: content },
        };
      }

      case "delete_path": {
        const path = resolveWorkspacePath(root, requireString(args, "path"));
        if (path.replace(/[/\\]+$/, "") === root.replace(/[/\\]+$/, "")) {
          throw new ToolError("Refusing to delete the workspace root");
        }
        const directory = await isDirectory(path);
        const before = directory ? null : await readCurrentText(path);
        await deletePath(path);
        useTabsStore.getState().closeTabsUnder(path);
        useBreakpointsStore.getState().removeUnder(path);
        useGitStore.getState().refresh();
        return {
          content: `Deleted ${relativeTo(root, path)}${directory ? " (directory)" : ""}`,
          isError: false,
          // Only single files can be restored.
          edit: directory ? undefined : { path, before, after: null },
        };
      }

      case "run_command": {
        const command = requireString(args, "command");
        const timeout =
          typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;
        return await runAndFormat(command, root, timeout);
      }

      case "git":
      case "github": {
        const argv = stringArray(args.args);
        if (argv.length === 0) throw new ToolError("args must be a non-empty array");
        const program = call.name === "git" ? "git" : "gh";
        return await runAndFormat(
          [program, ...argv].map(shellQuote).join(" "),
          root,
        );
      }

      default:
        throw new ToolError(`Unknown tool: ${call.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: message, isError: true };
  }
}
