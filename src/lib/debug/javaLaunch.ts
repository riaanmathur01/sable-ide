import { invoke } from "@tauri-apps/api/core";
import { pathToUri, restartLanguageServers, sendRequest } from "../lsp/lspClient";

/**
 * Java debugging goes through jdtls: the java-debug plugin (loaded into
 * jdtls as a bundle) resolves the main class and classpath from the
 * project jdtls already understands (Maven, Gradle, or loose files), then
 * starts a DAP server inside jdtls and reports its port. Rust connects to
 * that port (`start_java_debug`).
 */

/** Marker error: the java-debug plugin isn't installed yet. */
export const JAVA_DEBUG_MISSING = "java-debug-missing";

interface MainClass {
  mainClass: string;
  projectName: string;
  filePath?: string;
}

function execute(command: string, args: unknown[], timeoutMs = 30_000) {
  return sendRequest(
    "java",
    "workspace/executeCommand",
    { command, arguments: args },
    timeoutMs,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attach to a JVM (a test the build tool started) through java-debug.
 * jdtls only has to be running — the JVM already has its classpath.
 */
export async function attachJavaLaunch(
  program: string,
  jvmPort: number,
  report: (message: string) => void,
): Promise<{ port: number; launch: Record<string, unknown> }> {
  if (!(await invoke<boolean>("java_debug_installed"))) throw new Error(JAVA_DEBUG_MISSING);
  let restarted = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = await execute("vscode.java.startDebugSession", [], 15_000);
    if (typeof port === "number") {
      return {
        port,
        launch: {
          type: "java",
          name: `Sable: Debug ${program.split(/[/\\]/).pop()}`,
          request: "attach",
          hostName: "127.0.0.1",
          port: jvmPort,
          timeout: 30_000,
        },
      };
    }
    if (attempt === 0) report("Waiting for the Java language server…");
    if (port === null && attempt >= 2 && !restarted) {
      restarted = true;
      report("Restarting jdtls to load the Java debugger…");
      await restartLanguageServers();
    }
    await sleep(1000);
  }
  throw new Error("jdtls didn't start the Java debugger");
}

export async function resolveJavaLaunch(
  program: string,
  root: string,
  report: (message: string) => void,
  options: { args: string[]; env: Record<string, string>; cwd: string; terminal: boolean },
): Promise<{ port: number; launch: Record<string, unknown> }> {
  if (!(await invoke<boolean>("java_debug_installed"))) throw new Error(JAVA_DEBUG_MISSING);

  // jdtls may still be importing the project; poll for main classes.
  let candidates: MainClass[] = [];
  let restarted = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await execute("vscode.java.resolveMainClass", [pathToUri(root)], 15_000);
    if (Array.isArray(result) && result.length > 0) {
      candidates = result as MainClass[];
      break;
    }
    if (attempt === 0) report("Waiting for the Java language server…");
    // No answer at all usually means jdtls started before java-debug was
    // installed, so it lacks the commands; restart it once to load them.
    if (result === null && attempt >= 2 && !restarted) {
      restarted = true;
      report("Restarting jdtls to load the Java debugger…");
      await restartLanguageServers();
    }
    await sleep(1000);
  }
  if (candidates.length === 0) {
    throw new Error("No main method found — add `public static void main(String[] args)`");
  }
  const main =
    candidates.find((candidate) => candidate.filePath === program) ?? candidates[0];

  const classpath = await execute("vscode.java.resolveClasspath", [
    main.mainClass,
    main.projectName,
  ]);
  if (!Array.isArray(classpath)) throw new Error("Could not resolve the Java classpath");
  const javaExec = await execute("vscode.java.resolveJavaExecutable", [
    main.mainClass,
    main.projectName,
  ]);
  const port = await execute("vscode.java.startDebugSession", []);
  if (typeof port !== "number") throw new Error("jdtls didn't start the Java debugger");

  return {
    port,
    launch: {
      type: "java",
      name: "Sable: Debug",
      request: "launch",
      mainClass: main.mainClass,
      projectName: main.projectName,
      modulePaths: classpath[0] ?? [],
      classPaths: classpath[1] ?? [],
      ...(typeof javaExec === "string" ? { javaExec } : {}),
      cwd: options.cwd || root,
      args: options.args,
      env: options.env,
      // In a terminal tab, so the program can read keyboard input.
      console: options.terminal ? "integratedTerminal" : "internalConsole",
    },
  };
}
