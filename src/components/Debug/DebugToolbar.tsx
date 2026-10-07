import {
  ArrowDownToDot,
  ArrowUpFromDot,
  Pause,
  Play,
  RotateCcw,
  Redo2,
  Square,
} from "lucide-react";
import { useDebugStore } from "../../store/debugStore";
import "./Debug.css";

/**
 * Floating execution controls shown over the editor while debugging —
 * the same set and shortcuts as VS Code.
 */
export function DebugToolbar() {
  const isDebugging = useDebugStore((state) => state.isDebugging);
  const isPaused = useDebugStore((state) => state.isPaused);
  const debug = useDebugStore.getState();

  if (!isDebugging) return null;

  return (
    <div className="debug-toolbar" role="toolbar" aria-label="Debug controls">
      {isPaused ? (
        <button title="Continue (F5)" onClick={() => void debug.continue()}>
          <Play size={14} strokeWidth={1.75} />
        </button>
      ) : (
        <button title="Pause (F6)" onClick={() => void debug.pause()}>
          <Pause size={14} strokeWidth={1.75} />
        </button>
      )}
      <button
        title="Step Over (F10)"
        disabled={!isPaused}
        onClick={() => void debug.stepOver()}
      >
        <Redo2 size={14} strokeWidth={1.75} />
      </button>
      <button
        title="Step Into (F11)"
        disabled={!isPaused}
        onClick={() => void debug.stepInto()}
      >
        <ArrowDownToDot size={14} strokeWidth={1.75} />
      </button>
      <button
        title="Step Out (⇧F11)"
        disabled={!isPaused}
        onClick={() => void debug.stepOut()}
      >
        <ArrowUpFromDot size={14} strokeWidth={1.75} />
      </button>
      <button title="Restart (⇧⌘F5)" onClick={() => void debug.restart()}>
        <RotateCcw size={14} strokeWidth={1.75} />
      </button>
      <button
        className="danger"
        title="Stop (⇧F5)"
        onClick={() => void debug.stop()}
      >
        <Square size={13} strokeWidth={1.75} />
      </button>
    </div>
  );
}
