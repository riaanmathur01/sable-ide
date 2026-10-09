import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "./tabsStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useInterpreterStore } from "./interpreterStore";
import { sourceBreakpoints, useBreakpointsStore } from "./breakpointsStore";
import { useUiStore } from "./uiStore";
import { parentDirectoryOf } from "../lib/ipc";
import {
  loadVariables,
  sendDebugRequest,
  type DebugVariable,
} from "../lib/debug/debugClient";
import { JAVA_DEBUG_MISSING, attachJavaLaunch, resolveJavaLaunch } from "../lib/debug/javaLaunch";
import { useTerminalStore } from "./terminalStore";
import { loginShellArgs } from "../lib/shell";
import { listen } from "@tauri-apps/api/event";
import { useRunConfigStore } from "./runConfigStore";
import { parseArgs, parseEnv } from "../lib/runConfig";

/**
 * Debug session state (DAP). The protocol traffic is handled by
 * lib/debug/debugClient; this store holds what the UI shows — whether
 * we're debugging/paused, the call stack, the selected frame's variables,
 * and the debug console — plus the user-facing actions (continue, step…).
 */

export interface StackFrame {
  id: number;
  name: string;
  /** Absolute file path, or null for frames without source (builtins). */
  path: string | null;
  line: number;
}

export interface ConsoleLine {
  id: number;
  category: "stdout" | "stderr" | "console" | "input" | "result" | "error";
  text: string;
}

/** Adjustments to a debug launch (see start). */
export interface DebugLaunch {
  overrides?: Record<string, unknown>;
  binary?: string;
  args?: string[];
  cwd?: string;
  /**
   * Java tests: a build tool starts the JVM. Given the port Sable waits
   * on, the command that starts it connecting there (run in a terminal).
   */
  jvm?: { command: (port: number) => Promise<string> };
}

/** What to attach to: a debugpy/--inspect/JDWP port, or a process. */
export interface AttachTarget {
  kind: "python" | "node" | "go" | "native" | "java";
  port?: number;
  pid?: number;
  /** For the console: what's being attached to. */
  label: string;
}

export interface VariableScope {
  name: string;
  variablesReference: number;
  variables: DebugVariable[];
}

/** Files Sable can debug (mirrors `debug_language` in src-tauri/src/debug.rs):
 *  Python via debugpy; JavaScript/TypeScript via js-debug; Go via Delve;
 *  C, C++, and Rust via lldb-dap; Java via java-debug in jdtls. */
const DEBUGGABLE = /\.(py|pyw|js|mjs|cjs|ts|mts|cts|go|c|cc|cpp|cxx|rs|java)$/i;

export function isDebuggable(path: string | null): boolean {
  return path != null && DEBUGGABLE.test(path);
}

/** Marker the backend returns when the interpreter lacks debugpy. */
const DEBUGPY_MISSING = "debugpy-missing:";
const JS_DEBUG_MISSING = "js-debug-missing";

/** A debugger component Sable can install with one click. */
export interface MissingTool {
  kind: "debugpy" | "js-debug" | "java-debug";
  /** What's missing, for the Run and Debug view. */
  message: string;
  /** debugpy: the interpreter to install into. */
  python?: string;
}

const INSTALL_COMMANDS: Record<MissingTool["kind"], string> = {
  debugpy: "install_debugpy",
  "js-debug": "install_js_debug",
  "java-debug": "install_java_debug",
};

export const MISSING_TOOL_LABELS: Record<MissingTool["kind"], string> = {
  debugpy: "Install debugpy",
  "js-debug": "Install JavaScript debugger",
  "java-debug": "Install Java debugger",
};

interface DebugState {
  isDebugging: boolean;
  isPaused: boolean;
  stoppedThreadId: number | null;
  /** Why execution stopped ("breakpoint", "step", "exception", …). */
  stopReason: string | null;
  /** Absolute file + 1-based line of the *selected* frame. */
  stoppedFile: string | null;
  stoppedLine: number | null;
  frames: StackFrame[];
  selectedFrameId: number | null;
  scopes: VariableScope[];
  consoleLines: ConsoleLine[];
  /** The program last launched, so Restart can relaunch it. */
  lastProgram: string | null;
  /** A debugger component that needs installing (one-click install). */
  missingTool: MissingTool | null;
  isInstallingTool: boolean;

  /** Debug a file. `launch` adjusts how (debugging one test: run
   *  pytest/vitest/jest/a Cargo test binary instead of the file). */
  start: (program?: string, launch?: DebugLaunch) => Promise<void>;
  /** Attach to a program that's already running. */
  attach: (target: AttachTarget) => Promise<void>;
  /** The Attach to Process dialog. */
  attachDialogOpen: boolean;
  setAttachDialogOpen: (open: boolean) => void;
  stop: () => Promise<void>;
  /** Install the missing debugger component, then retry. */
  installMissingTool: () => Promise<void>;
  restart: () => Promise<void>;
  continue: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepInto: () => Promise<void>;
  stepOut: () => Promise<void>;
  pause: () => Promise<void>;
  /** Select a call-stack frame: highlight its line, load its variables. */
  selectFrame: (frameId: number) => Promise<void>;
  /** Evaluate an expression in the selected frame (debug console input). */
  evaluate: (expression: string) => Promise<void>;
  appendConsole: (category: ConsoleLine["category"], text: string) => void;
  clearConsole: () => void;

  /** Called by the debug client when a `stopped` event resolves. */
  setStopped: (threadId: number, reason: string, frames: StackFrame[]) => void;
  /** Clear the paused highlight (on continue / step). */
  setRunning: () => void;
  /** Session ended. */
  setTerminated: () => void;
}

let consoleLineId = 0;
const MAX_CONSOLE_LINES = 5000;

const IDLE = {
  isDebugging: false,
  isPaused: false,
  stoppedThreadId: null,
  stopReason: null,
  stoppedFile: null,
  stoppedLine: null,
  frames: [],
  selectedFrameId: null,
  scopes: [],
} satisfies Partial<DebugState>;

export const useDebugStore = create<DebugState>((set, get) => {
  /** Run a thread-scoped execution control request (continue/next/…). */
  async function control(command: string) {
    const { isDebugging, isPaused, stoppedThreadId } = get();
    if (!isDebugging || !isPaused) return;
    get().setRunning();
    await sendDebugRequest(command, { threadId: stoppedThreadId ?? 0 });
  }

  /** A start/attach that failed: offer a missing tool, else show why. */
  function reportStartError(error: unknown) {
    set({ isDebugging: false });
    const message = error instanceof Error ? error.message : String(error);
    const missing: MissingTool | null = message.startsWith(DEBUGPY_MISSING)
      ? {
          kind: "debugpy",
          python: message.slice(DEBUGPY_MISSING.length),
          message: `debugpy isn't installed for ${message.slice(DEBUGPY_MISSING.length)}.`,
        }
      : message === JS_DEBUG_MISSING
        ? {
            kind: "js-debug",
            message: "JavaScript/TypeScript debugging uses VS Code's js-debug (about 10 MB download).",
          }
        : message === JAVA_DEBUG_MISSING
          ? {
              kind: "java-debug",
              message: "Java debugging uses Microsoft's java-debug plugin for jdtls (about 1 MB download).",
            }
          : null;
    if (missing) {
      set({ missingTool: missing });
      get().appendConsole(
        "error",
        `${missing.message} Use “${MISSING_TOOL_LABELS[missing.kind]}” in the Run and Debug view.`,
      );
      useUiStore.getState().setSidebarView("debug");
      return;
    }
    get().appendConsole("error", message);
    useUiStore.getState().setLastError(message);
  }

  return {
    ...IDLE,
    attachDialogOpen: false,
    setAttachDialogOpen: (open) => set({ attachDialogOpen: open }),

    attach: async (target) => {
      if (get().isDebugging) await get().stop();
      set({ ...IDLE, isDebugging: true, lastProgram: null, missingTool: null, attachDialogOpen: false });
      get().clearConsole();
      get().appendConsole("console", `Attaching to ${target.label}`);
      useUiStore.getState().setBottomPanel("debug");
      const breakpoints = Object.fromEntries(
        Object.keys(useBreakpointsStore.getState().breakpointsByFile).map((file) => [file, sourceBreakpoints(file)]),
      );
      try {
        if (target.kind === "java") {
          const { port, launch } = await attachJavaLaunch(target.label, target.port ?? 0, (line) =>
            get().appendConsole("console", line),
          );
          await invoke("start_java_debug", { port, launch, breakpoints });
        } else {
          await invoke("start_attach", { target: { kind: target.kind, port: target.port, pid: target.pid }, breakpoints });
        }
        get().appendConsole("console", "Attached — stopping the debugger detaches and leaves the program running");
      } catch (error) {
        reportStartError(error);
      }
    },
    consoleLines: [],
    lastProgram: null,
    missingTool: null,
    isInstallingTool: false,

    start: async (programOverride, launch) => {
      if (get().isDebugging) {
        // F5 while paused means "continue".
        if (get().isPaused) await get().continue();
        return;
      }
      const program = programOverride ?? useTabsStore.getState().lastFilePath;
      if (!program) {
        useUiStore.getState().setLastError("Open a file to debug");
        return;
      }
      if (!isDebuggable(program)) {
        useUiStore
          .getState()
          .setLastError(
            "Debugging supports Python, JavaScript, TypeScript, Go, Java, C, C++, and Rust files",
          );
        return;
      }
      // Debug what's on screen, not a stale file.
      await useTabsStore.getState().saveTab(program);
      const isPython = /\.pyw?$/i.test(program);
      const python = isPython
        ? (useInterpreterStore.getState().selectedPath ?? "python3")
        : null;
      const config = useRunConfigStore.getState().configFor(program);
      const cwd =
        config.cwd.trim() || (useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(program));
      // Arguments, environment and working directory from the run
      // configuration; the program runs in a terminal tab so it can read
      // keyboard input.
      const options = {
        args: launch?.args ?? parseArgs(config.args),
        env: parseEnv(config.env),
        cwd: launch?.cwd ?? cwd,
        terminal: true,
        binary: launch?.binary,
        overrides: launch?.overrides,
      };
      // Each file's breakpoints, with their conditions / logpoints.
      const breakpoints = Object.fromEntries(
        Object.keys(useBreakpointsStore.getState().breakpointsByFile).map((file) => [file, sourceBreakpoints(file)]),
      );

      set({ ...IDLE, isDebugging: true, lastProgram: program, missingTool: null });
      get().clearConsole();
      get().appendConsole("console", `Debugging ${program}`);
      useUiStore.getState().setBottomPanel("debug");
      try {
        if (launch?.jvm) {
          await startJvmTest(program, launch.jvm, options.cwd, breakpoints, (line) => get().appendConsole("console", line));
        } else if (/\.java$/i.test(program)) {
          const { port, launch } = await resolveJavaLaunch(
            program,
            useWorkspaceStore.getState().rootPath ?? cwd,
            (line) => get().appendConsole("console", line),
            options,
          );
          await invoke("start_java_debug", { port, launch, breakpoints });
        } else {
          await invoke("start_debug", { python, program, cwd, breakpoints, options });
        }
      } catch (error) {
        reportStartError(error);
      }
    },

    installMissingTool: async () => {
      const tool = get().missingTool;
      if (!tool || get().isInstallingTool) return;
      set({ isInstallingTool: true });
      get().appendConsole(
        "console",
        tool.python ? `Installing ${tool.kind} into ${tool.python}…` : `Installing ${tool.kind}…`,
      );
      try {
        await invoke(INSTALL_COMMANDS[tool.kind], tool.python ? { python: tool.python } : {});
        get().appendConsole("console", `${tool.kind} installed.`);
        set({ missingTool: null });
        // jdtls loads java-debug only at startup.
        if (tool.kind === "java-debug") {
          const { restartLanguageServers } = await import("../lib/lsp/lspClient");
          await restartLanguageServers();
        }
        const program = get().lastProgram;
        if (program) await get().start(program);
      } catch (error) {
        get().appendConsole("error", String(error));
        useUiStore.getState().setLastError(String(error));
      } finally {
        set({ isInstallingTool: false });
      }
    },

    stop: async () => {
      await invoke("debug_stop").catch(() => {});
      set(IDLE);
    },

    restart: async () => {
      const program = get().lastProgram;
      await get().stop();
      if (program) await get().start(program);
    },

    continue: () => control("continue"),
    stepOver: () => control("next"),
    stepInto: () => control("stepIn"),
    stepOut: () => control("stepOut"),

    pause: async () => {
      if (!get().isDebugging || get().isPaused) return;
      await sendDebugRequest("pause", { threadId: get().stoppedThreadId ?? 1 });
    },

    selectFrame: async (frameId) => {
      const frame = get().frames.find((candidate) => candidate.id === frameId);
      if (!frame) return;
      set({
        selectedFrameId: frameId,
        stoppedFile: frame.path,
        stoppedLine: frame.line,
      });
      // Make sure the frame's file is the visible editor so the
      // highlight shows.
      if (frame.path) void useTabsStore.getState().openFile(frame.path);

      const response = await sendDebugRequest("scopes", { frameId });
      const rawScopes =
        (response?.body as
          | { scopes?: { name: string; variablesReference: number }[] }
          | undefined)?.scopes ?? [];
      // Load the first scope (locals) eagerly; others on demand.
      const scopes: VariableScope[] = await Promise.all(
        rawScopes.map(async (scope, index) => ({
          name: scope.name,
          variablesReference: scope.variablesReference,
          variables:
            index === 0 ? await loadVariables(scope.variablesReference) : [],
        })),
      );
      // Ignore if the user moved on (stepped, picked another frame).
      if (get().selectedFrameId === frameId) set({ scopes });
    },

    evaluate: async (expression) => {
      const trimmed = expression.trim();
      if (!trimmed) return;
      get().appendConsole("input", trimmed);
      if (!get().isPaused) {
        get().appendConsole("error", "Pause the program to evaluate expressions");
        return;
      }
      const response = await sendDebugRequest("evaluate", {
        expression: trimmed,
        frameId: get().selectedFrameId ?? undefined,
        context: "repl",
      });
      if (!response) {
        get().appendConsole("error", "No response from debugger");
      } else if (!response.success) {
        get().appendConsole(
          "error",
          String((response as { message?: string }).message ?? "Error"),
        );
      } else {
        const result = (response.body as { result?: string } | undefined)
          ?.result;
        get().appendConsole("result", result ?? "");
      }
    },

    appendConsole: (category, text) =>
      set((state) => {
        const lines = [
          ...state.consoleLines,
          { id: ++consoleLineId, category, text },
        ];
        return {
          consoleLines:
            lines.length > MAX_CONSOLE_LINES
              ? lines.slice(lines.length - MAX_CONSOLE_LINES)
              : lines,
        };
      }),

    clearConsole: () => set({ consoleLines: [] }),

    setStopped: (threadId, reason, frames) => {
      const top = frames[0];
      set({
        isPaused: true,
        stoppedThreadId: threadId,
        stopReason: reason,
        frames,
        stoppedFile: top?.path ?? null,
        stoppedLine: top?.line ?? null,
        selectedFrameId: null,
        scopes: [],
      });
      if (top) void get().selectFrame(top.id);
      // Show the Run & Debug view so variables/stack are visible.
      useUiStore.getState().setSidebarView("debug");
    },

    setRunning: () =>
      set({
        isPaused: false,
        stoppedFile: null,
        stoppedLine: null,
        stopReason: null,
        frames: [],
        selectedFrameId: null,
        scopes: [],
      }),

    setTerminated: () => {
      if (get().isDebugging) {
        get().appendConsole("console", "Session ended");
      }
      set(IDLE);
    },
  };
});

// Breakpoints toggled mid-session go to the adapter immediately (DAP's
// setBreakpoints replaces the full list for one file).
useBreakpointsStore.subscribe((state, previous) => {
  if (!useDebugStore.getState().isDebugging) return;
  const files = new Set([
    ...Object.keys(state.breakpointsByFile),
    ...Object.keys(previous.breakpointsByFile),
  ]);
  for (const file of files) {
    if (
      state.breakpointsByFile[file] === previous.breakpointsByFile[file] &&
      state.optionsByFile[file] === previous.optionsByFile[file]
    ) {
      continue;
    }
    void sendDebugRequest("setBreakpoints", { source: { path: file }, breakpoints: sourceBreakpoints(file) });
  }
});

/**
 * Debug a Java test: Sable waits for the test JVM, the build tool starts
 * it (in the Debug terminal) connecting to Sable, and java-debug attaches
 * through Sable's relay.
 */
async function startJvmTest(
  program: string,
  jvm: NonNullable<DebugLaunch["jvm"]>,
  cwd: string,
  breakpoints: unknown,
  report: (line: string) => void,
) {
  const port = await invoke<number>("jvm_debug_listen");
  let unlisten: (() => void) | undefined;
  try {
    const command = await jvm.command(port);
    report(`Starting the test: ${command}`);
    const started = useTerminalStore
      .getState()
      .startCommandSession({ args: loginShellArgs(command), cwd, env: null }, "Debug test", "debug");
    const terminalId = useTerminalStore.getState().activeId;
    const buildEnded = new Promise<never>((_, reject) => {
      void listen<string>("terminal:exit", (event) => {
        if (event.payload === terminalId) {
          reject(new Error("The build ended before the test started — see the terminal"));
        }
      }).then((stop) => (unlisten = stop));
    });
    await started;
    report("Waiting for the test JVM (the build compiles first)…");
    const attachPort = await Promise.race([invoke<number>("jvm_debug_accept", { port, timeoutSecs: 900 }), buildEnded]);
    const { port: debugPort, launch } = await attachJavaLaunch(program, attachPort, report);
    await invoke("start_java_debug", { port: debugPort, launch, breakpoints });
  } catch (error) {
    void invoke("jvm_debug_cancel", { port });
    throw error;
  } finally {
    unlisten?.();
  }
}
