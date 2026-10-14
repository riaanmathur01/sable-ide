/**
 * Running tasks.json tasks for launch.json's `preLaunchTask` /
 * `postDebugTask`: each in its own terminal tab, dependencies first.
 * The terminal reports only that a program ended, so the command is
 * wrapped to print its exit status as an (invisible) escape sequence.
 */

import { listen } from "../events";
import { loginShellArgs } from "../shell";
import { useTerminalStore } from "../../store/terminalStore";
import { exitStatusIn, taskCommandLine, TaskFailed, withExitReport, type TaskDefinition } from "./launchJson";

export { TaskFailed, runTaskPlan } from "./launchJson";

const isWindows = () => typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

/**
 * Run one (already substituted) task in a terminal tab; resolves to its
 * exit code. A background task (`isBackground`, a watcher or server)
 * counts as started once it prints something.
 */
export async function runTaskInTerminal(task: TaskDefinition, defaultCwd: string | null): Promise<number | null> {
  const commandLine = taskCommandLine(task);
  if (!commandLine) throw new TaskFailed(task.label, null, `The task “${task.label}” has no command`);
  const windows = isWindows();
  let terminalId: string | null = null;
  let output = "";
  let settle: (code: number | null) => void = () => {};
  const finished = new Promise<number | null>((resolve) => (settle = resolve));
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  const stopOutput = await listen<{ id: string; data: string }>("terminal:output", (event) => {
    if (event.payload.id !== terminalId) return;
    output = (output + event.payload.data).slice(-4096);
    const code = exitStatusIn(output);
    if (code !== null) settle(code);
    if (task.isBackground && backgroundTimer === undefined) backgroundTimer = setTimeout(() => settle(0), 1500);
  });
  const stopExit = await listen<string>("terminal:exit", (event) => {
    if (event.payload !== terminalId) return;
    // Give the last output event a moment to arrive.
    setTimeout(() => settle(exitStatusIn(output) ?? (windows ? 0 : null)), 150);
  });
  try {
    const started = useTerminalStore.getState().startCommandSession(
      {
        args: loginShellArgs(windows ? commandLine : withExitReport(commandLine)),
        cwd: task.options?.cwd ?? defaultCwd,
        env: task.options?.env ?? null,
      },
      `Task: ${task.label}`,
      `task:launch:${task.label}`,
    );
    terminalId = useTerminalStore.getState().activeId;
    try {
      await started;
    } catch (error) {
      throw new TaskFailed(task.label, null, `The task “${task.label}” couldn't start: ${String(error)}`);
    }
    // A background task that prints nothing still counts as started.
    if (task.isBackground) setTimeout(() => settle(0), 5000);
    return await finished;
  } finally {
    clearTimeout(backgroundTimer);
    stopOutput();
    stopExit();
  }
}
