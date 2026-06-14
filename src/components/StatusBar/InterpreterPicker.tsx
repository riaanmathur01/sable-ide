import { useEffect, useState } from "react";
import { Check, FolderPlus } from "lucide-react";
import { useInterpreterStore } from "../../store/interpreterStore";
import type { Interpreter } from "../../lib/ipc";
import "./InterpreterPicker.css";

/**
 * Popover for choosing the Python interpreter Run uses: pick a local
 * interpreter, or create a new virtualenv. Anchored above the status-bar
 * button that opens it.
 */
export function InterpreterPicker({ onClose }: { onClose: () => void }) {
  const interpreters = useInterpreterStore((state) => state.interpreters);
  const selectedPath = useInterpreterStore((state) => state.selectedPath);
  const select = useInterpreterStore((state) => state.select);
  const discover = useInterpreterStore((state) => state.discover);
  const createVenv = useInterpreterStore((state) => state.createVenv);
  const isCreating = useInterpreterStore((state) => state.isCreating);

  const [choosingBase, setChoosingBase] = useState(false);

  // Re-scan when opened so freshly created venvs / installs show up.
  useEffect(() => {
    void discover();
  }, [discover]);

  function onPick(interpreter: Interpreter) {
    select(interpreter.path);
    onClose();
  }

  async function onCreateFrom(base: Interpreter) {
    await createVenv(base.path);
    onClose();
  }

  // Only real (non-venv) interpreters can serve as a venv base.
  const baseChoices = interpreters.filter((i) => i.kind !== "venv");

  return (
    <div className="interp-backdrop" onMouseDown={onClose}>
      <div
        className="interp-popover"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="interp-header">
          {choosingBase ? "Create environment from…" : "Select Python Interpreter"}
        </div>

        {choosingBase ? (
          <>
            {baseChoices.map((interpreter) => (
              <button
                key={interpreter.path}
                className="interp-item"
                onClick={() => onCreateFrom(interpreter)}
              >
                <span className="interp-check" />
                <span className="interp-label">{interpreter.label}</span>
              </button>
            ))}
            <button
              className="interp-item interp-muted"
              onClick={() => setChoosingBase(false)}
            >
              ← Back
            </button>
          </>
        ) : (
          <>
            {interpreters.length === 0 && (
              <div className="interp-empty">No interpreters found</div>
            )}
            {interpreters.map((interpreter) => (
              <button
                key={interpreter.path}
                className="interp-item"
                onClick={() => onPick(interpreter)}
                title={interpreter.path}
              >
                <span className="interp-check">
                  {interpreter.path === selectedPath && (
                    <Check size={13} strokeWidth={2} />
                  )}
                </span>
                <span className="interp-label">{interpreter.label}</span>
                <span className="interp-path">{interpreter.path}</span>
              </button>
            ))}
            <div className="interp-divider" />
            <button
              className="interp-item"
              disabled={isCreating || baseChoices.length === 0}
              onClick={() => setChoosingBase(true)}
            >
              <span className="interp-check">
                <FolderPlus size={13} strokeWidth={1.5} />
              </span>
              <span className="interp-label">
                {isCreating ? "Creating environment…" : "Create new environment"}
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
