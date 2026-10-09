import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, Play, X } from "lucide-react";
import {
  isDebuggable,
  MISSING_TOOL_LABELS,
  useDebugStore,
  type VariableScope,
} from "../../store/debugStore";
import { useBreakpointsStore } from "../../store/breakpointsStore";
import { useWatchStore } from "../../store/watchStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { loadVariables, type DebugVariable } from "../../lib/debug/debugClient";
import { revealPosition } from "../../lib/editorRegistry";
import { DebugToolbar } from "./DebugToolbar";
import "./Debug.css";

/** Workspace-relative display path. */
function displayPath(path: string, root: string | null): string {
  return root && path.startsWith(root)
    ? path.slice(root.length).replace(/^[/\\]/, "")
    : path;
}

/** How a file will be debugged, for the start hint. */
function debugNote(path: string): string {
  if (/\.pyw?$/i.test(path)) return " with the selected interpreter";
  if (/\.(c|cc|cpp|cxx|rs)$/i.test(path)) return " — compiled with debug info first";
  if (/\.go$/i.test(path)) return " with Delve";
  if (/\.java$/i.test(path)) return " through jdtls";
  return " with Node";
}

/**
 * Run & Debug sidebar view: start button when idle; variables, call
 * stack, and breakpoints while debugging (breakpoints always).
 */
export function DebugPanel() {
  const isDebugging = useDebugStore((state) => state.isDebugging);
  const isPaused = useDebugStore((state) => state.isPaused);
  const stopReason = useDebugStore((state) => state.stopReason);
  const frames = useDebugStore((state) => state.frames);
  const selectedFrameId = useDebugStore((state) => state.selectedFrameId);
  const scopes = useDebugStore((state) => state.scopes);
  const lastFilePath = useTabsStore((state) => state.lastFilePath);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  const canDebug = isDebuggable(lastFilePath);
  const missingTool = useDebugStore((state) => state.missingTool);
  const isInstallingTool = useDebugStore((state) => state.isInstallingTool);

  return (
    <div className="debug-panel">
      {!isDebugging ? (
        <div className="debug-start">
          <button
            className="debug-start-button"
            disabled={!canDebug}
            onClick={() => void useDebugStore.getState().start()}
          >
            <Play size={13} strokeWidth={1.75} /> Run and Debug
          </button>
          <button
            className="debug-start-button secondary"
            onClick={() => useDebugStore.getState().setAttachDialogOpen(true)}
            title="Debug a program that's already running"
          >
            Attach to Process…
          </button>
          <div className="debug-hint">
            {canDebug
              ? `Debugs ${displayPath(lastFilePath!, rootPath)} (F5)${debugNote(lastFilePath!)}. Click the gutter to add breakpoints (F9).`
              : "Open a Python, JavaScript, TypeScript, Go, Java, C, C++, or Rust file to debug it."}
          </div>
          {missingTool && (
            <div className="debug-install">
              <div className="debug-hint">{missingTool.message}</div>
              <button
                className="debug-start-button secondary"
                disabled={isInstallingTool}
                onClick={() => void useDebugStore.getState().installMissingTool()}
              >
                {isInstallingTool ? "Installing…" : MISSING_TOOL_LABELS[missingTool.kind]}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="debug-session-bar">
          <DebugToolbar />
          <span className="debug-state">
            {isPaused ? `Paused on ${stopReason ?? "breakpoint"}` : "Running"}
          </span>
        </div>
      )}

      {isDebugging && (
        <>
          <WatchSection isPaused={isPaused} />
          <Section title="Variables">
            {!isPaused ? (
              <div className="debug-empty">Pause to inspect variables</div>
            ) : scopes.length === 0 ? (
              <div className="debug-empty">Loading…</div>
            ) : (
              scopes.map((scope) => (
                <ScopeNode key={`${selectedFrameId}:${scope.name}`} scope={scope} />
              ))
            )}
          </Section>
          <Section title="Call Stack">
            {frames.length === 0 ? (
              <div className="debug-empty">
                {isPaused ? "No frames" : "Running…"}
              </div>
            ) : (
              frames.map((frame) => (
                <div
                  key={frame.id}
                  className={
                    frame.id === selectedFrameId
                      ? "debug-row debug-frame selected"
                      : "debug-row debug-frame"
                  }
                  onClick={() => {
                    void useDebugStore.getState().selectFrame(frame.id);
                    if (frame.path) revealPosition(frame.path, frame.line);
                  }}
                  title={frame.path ?? undefined}
                >
                  <span className="debug-frame-name">{frame.name}</span>
                  <span className="debug-frame-location">
                    {frame.path
                      ? `${frame.path.split(/[/\\]/).pop()}:${frame.line}`
                      : "unknown"}
                  </span>
                </div>
              ))
            )}
          </Section>
        </>
      )}
      <BreakpointsSection rootPath={rootPath} />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="debug-section">
      <div className="debug-section-header" onClick={() => setOpen(!open)}>
        <Chevron size={13} strokeWidth={1.5} />
        {title}
      </div>
      {open && <div className="debug-section-body">{children}</div>}
    </div>
  );
}

function ScopeNode({ scope }: { scope: VariableScope }) {
  const [open, setOpen] = useState(scope.variables.length > 0);
  const [variables, setVariables] = useState<DebugVariable[]>(scope.variables);
  const Chevron = open ? ChevronDown : ChevronRight;

  async function toggle() {
    if (!open && variables.length === 0) {
      setVariables(await loadVariables(scope.variablesReference));
    }
    setOpen(!open);
  }

  return (
    <div>
      <div className="debug-row debug-scope" onClick={() => void toggle()}>
        <Chevron size={12} strokeWidth={1.5} />
        {scope.name}
      </div>
      {open &&
        variables.map((variable) => (
          <VariableNode key={variable.name} variable={variable} depth={1} />
        ))}
    </div>
  );
}

function VariableNode({
  variable,
  depth,
}: {
  variable: DebugVariable;
  depth: number;
}) {
  const [children, setChildren] = useState<DebugVariable[] | null>(null);
  const [open, setOpen] = useState(false);
  const expandable = variable.variablesReference > 0;
  const Chevron = open ? ChevronDown : ChevronRight;

  async function toggle() {
    if (!expandable) return;
    if (!open && children === null) {
      setChildren(await loadVariables(variable.variablesReference));
    }
    setOpen(!open);
  }

  return (
    <>
      <div
        className="debug-row debug-variable"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => void toggle()}
        title={`${variable.name}: ${variable.type ?? ""} = ${variable.value}`}
      >
        <span className="debug-chevron">
          {expandable && <Chevron size={12} strokeWidth={1.5} />}
        </span>
        <span className="debug-variable-name">{variable.name}</span>
        <span className="debug-variable-value">{variable.value}</span>
      </div>
      {open &&
        children?.map((child) => (
          <VariableNode key={child.name} variable={child} depth={depth + 1} />
        ))}
    </>
  );
}

/** Watch expressions: evaluated in the selected frame at every pause. */
function WatchSection({ isPaused }: { isPaused: boolean }) {
  const expressions = useWatchStore((state) => state.expressions);
  const results = useWatchStore((state) => state.results);
  const [draft, setDraft] = useState("");
  return (
    <Section title="Watch">
      {expressions.map((expression, index) => {
        const result = results[index];
        return (
          <div key={`${index}:${expression}`} className="debug-watch">
            {result && !result.error ? (
              <VariableNode variable={result} depth={0} />
            ) : (
              <div className="debug-row debug-variable" title={result?.value}>
                <span className="debug-chevron" />
                <span className="debug-variable-name">{expression}</span>
                <span className={result?.error ? "debug-variable-value debug-watch-error" : "debug-variable-value"}>
                  {result ? result.value : isPaused ? "…" : ""}
                </span>
              </div>
            )}
            <button
              className="debug-remove"
              title="Remove watch"
              onClick={() => useWatchStore.getState().remove(index)}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </div>
        );
      })}
      <input
        className="debug-watch-input"
        placeholder="Add expression to watch"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draft.trim()) {
            useWatchStore.getState().add(draft);
            setDraft("");
          }
        }}
      />
    </Section>
  );
}

function BreakpointsSection({ rootPath }: { rootPath: string | null }) {
  const breakpointsByFile = useBreakpointsStore(
    (state) => state.breakpointsByFile,
  );
  const toggle = useBreakpointsStore((state) => state.toggle);
  const optionsByFile = useBreakpointsStore((state) => state.optionsByFile);
  const entries = Object.entries(breakpointsByFile).flatMap(([file, lines]) =>
    lines.map((line) => ({ file, line })),
  );
  return (
    <Section title="Breakpoints">
      {entries.length === 0 ? (
        <div className="debug-empty">
          Click the editor gutter or press F9 to add one
        </div>
      ) : (
        entries.map(({ file, line }) => (
          <div
            key={`${file}:${line}`}
            className="debug-row debug-breakpoint-row"
            onClick={async () => {
              await useTabsStore.getState().openFile(file);
              revealPosition(file, line);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              useBreakpointsStore.getState().edit(file, line, event.clientX, event.clientY);
            }}
            title={`${file} — right-click to edit`}
          >
            <Circle size={9} className="debug-breakpoint-dot" />
            <span className="debug-frame-name">
              {displayPath(file, rootPath)}
            </span>
            {optionsByFile[file]?.[line] && (
              <span className="debug-breakpoint-detail">
                {optionsByFile[file][line].logMessage
                  ? `log: ${optionsByFile[file][line].logMessage}`
                  : [optionsByFile[file][line].condition, optionsByFile[file][line].hitCondition && `hit ${optionsByFile[file][line].hitCondition}`]
                      .filter(Boolean)
                      .join(", ")}
              </span>
            )}
            <span className="debug-frame-location">{line}</span>
            <button
              className="debug-remove"
              title="Remove breakpoint"
              onClick={(event) => {
                event.stopPropagation();
                toggle(file, line);
              }}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </div>
        ))
      )}
    </Section>
  );
}
