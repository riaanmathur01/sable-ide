import { useEffect, useRef, useState } from "react";
import { useBreakpointsStore, type BreakpointOptions } from "../../store/breakpointsStore";
import "./BreakpointEditor.css";

/**
 * Right-click a breakpoint's line in the gutter: when it stops (a
 * condition, a hit count), or whether it only logs a message.
 */
export function BreakpointEditor() {
  const editing = useBreakpointsStore((state) => state.editing);
  if (!editing) return null;
  return <Editor key={`${editing.file}:${editing.line}`} />;
}

function Editor() {
  const editing = useBreakpointsStore((state) => state.editing)!;
  const existing = useBreakpointsStore((state) => state.optionsByFile[editing.file]?.[editing.line]);
  const hasBreakpoint = useBreakpointsStore((state) =>
    (state.breakpointsByFile[editing.file] ?? []).includes(editing.line),
  );
  const [options, setOptions] = useState<BreakpointOptions>(existing ?? {});
  const [logOnly, setLogOnly] = useState(!!existing?.logMessage);
  const panel = useRef<HTMLFormElement>(null);

  // Keep it on screen.
  useEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box || !panel.current) return;
    if (box.right > window.innerWidth - 8) panel.current.style.left = `${window.innerWidth - box.width - 8}px`;
    if (box.bottom > window.innerHeight - 8) panel.current.style.top = `${editing.y - box.height - 8}px`;
  }, [editing]);

  const store = useBreakpointsStore.getState();
  const save = () => {
    store.setOptions(editing.file, editing.line, {
      condition: options.condition,
      hitCondition: options.hitCondition,
      logMessage: logOnly ? options.logMessage || "Reached line " + editing.line : undefined,
    });
    store.closeEditor();
  };
  const field = (key: keyof BreakpointOptions) => ({
    value: options[key] ?? "",
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setOptions({ ...options, [key]: event.target.value }),
  });

  return (
    <div className="bp-editor-backdrop" onMouseDown={() => store.closeEditor()}>
      <form
        ref={panel}
        className="bp-editor"
        style={{ left: editing.x + 8, top: editing.y + 8 }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") store.closeEditor();
        }}
      >
        <div className="bp-editor-title">
          Breakpoint · {editing.file.split(/[/\\]/).pop()}:{editing.line}
        </div>
        <label>
          Condition
          <input autoFocus placeholder="e.g. i == 4" spellCheck={false} {...field("condition")} />
        </label>
        <label>
          Hit count
          <input placeholder="e.g. 3 (stop on the 3rd time)" spellCheck={false} {...field("hitCondition")} />
        </label>
        <label className="bp-editor-check">
          <input type="checkbox" checked={logOnly} onChange={(event) => setLogOnly(event.target.checked)} />
          Log a message instead of stopping
        </label>
        {logOnly && (
          <label>
            Message
            <input placeholder="e.g. i = {i}, total = {total}" spellCheck={false} {...field("logMessage")} />
          </label>
        )}
        <p className="bp-editor-note">
          {logOnly
            ? "Shown in the Debug Console. {expressions} are evaluated."
            : "Empty fields: stop every time."}
        </p>
        <div className="bp-editor-actions">
          {hasBreakpoint && (
            <button
              type="button"
              className="danger"
              onClick={() => {
                store.toggle(editing.file, editing.line);
                store.closeEditor();
              }}
            >
              Remove
            </button>
          )}
          <span className="bp-editor-spacer" />
          <button type="button" onClick={() => store.closeEditor()}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {hasBreakpoint ? "Done" : "Add Breakpoint"}
          </button>
        </div>
      </form>
    </div>
  );
}
