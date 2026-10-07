import type * as MonacoTypes from "monaco-editor";

/**
 * Holding a cursor key — Backspace, Delete or an arrow (with or without
 * Shift, to extend the selection) — speeds up the longer it's held.
 *
 * The first press, the OS's key-repeat delay and the first moments of
 * repeating are untouched (that's when the OS's repeat rate is measured).
 * Then Sable takes over: it ignores the OS's fixed-rate repeats and
 * deletes on its own timer, starting at that measured rate — so there's
 * no jolt — and accelerating up to a cap. It's always one character or
 * line per step (the editor's own commands, so the smooth caret
 * animation and undo grouping behave as usual) — only the pace changes.
 * Releasing the key, or the editor losing focus, resets it.
 */

/** How long the OS's own repeats run (to measure their rate). */
const MEASURE_MS = 300;
/** Assumed repeat interval if it couldn't be measured (≈ 25/s). */
const DEFAULT_INTERVAL_MS = 40;
/** The cap: 30 deletions per second. */
const MAX_PER_SECOND = 30;
/** How long it takes to reach the cap. */
const RAMP_MS = 5000;

/**
 * Delay before the next deletion, `elapsed` ms after taking over from a
 * repeat interval of `start` ms. The speed grows with the square of the
 * time held — slowly at first, then faster and faster — until it reaches
 * the cap at RAMP_MS. Never slower than the start.
 */
export function deleteInterval(elapsed: number, start = DEFAULT_INTERVAL_MS): number {
  const startSpeed = Math.min(1000 / start, MAX_PER_SECOND);
  const progress = Math.min(1, Math.max(0, elapsed / RAMP_MS));
  const speed = startSpeed + (MAX_PER_SECOND - startSpeed) * progress * progress;
  return 1000 / speed;
}

/** The editor command each held key repeats (with Shift: extend the
 *  selection). */
const COMMANDS: Record<string, { plain: string; shift?: string }> = {
  Backspace: { plain: "deleteLeft" },
  Delete: { plain: "deleteRight" },
  ArrowLeft: { plain: "cursorLeft", shift: "cursorLeftSelect" },
  ArrowRight: { plain: "cursorRight", shift: "cursorRightSelect" },
  ArrowUp: { plain: "cursorUp", shift: "cursorUpSelect" },
  ArrowDown: { plain: "cursorDown", shift: "cursorDownSelect" },
};

/** Up/Down belong to an open suggestion list or signature help. */
function popupOwnsKey(container: HTMLElement, key: string): boolean {
  if (key !== "ArrowUp" && key !== "ArrowDown") return false;
  return Boolean(container.querySelector(".suggest-widget.visible, .parameter-hints-widget.visible"));
}

export function installKeyRepeatAcceleration(editor: MonacoTypes.editor.IStandaloneCodeEditor): () => void {
  const container = editor.getContainerDomNode();
  let heldKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Times of the OS repeats seen so far for the held key. */
  let repeats: number[] = [];

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    heldKey = null;
    repeats = [];
  };

  const run = (command: string, startedAt: number, start: number) => {
    editor.trigger("keyboard", command, null);
    timer = setTimeout(() => run(command, startedAt, start), deleteInterval(performance.now() - startedAt, start));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const commands = COMMANDS[event.key];
    const command = commands && (event.shiftKey ? commands.shift : commands.plain);
    // Word/line jumps and deletes (⌥/⌘), IME composition, text fields
    // inside the editor (find, rename) and open popups keep their
    // normal behavior.
    if (
      !command ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing ||
      !editor.hasTextFocus() ||
      popupOwnsKey(container, event.key)
    ) {
      if (heldKey) stop();
      return;
    }
    // Shift pressed or released mid-hold is a different action.
    const identity = `${event.shiftKey ? "shift+" : ""}${event.key}`;
    if (!event.repeat) {
      stop(); // a fresh press: the editor handles it normally
      return;
    }
    // Read-only views can't be edited, but the cursor can still move.
    if (editor.getRawOptions().readOnly && command.startsWith("delete")) return;
    if (timer && heldKey === identity) {
      // Already driving: swallow the OS's repeats.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (heldKey !== identity) {
      stop();
      heldKey = identity;
    }
    // Let the OS's repeats through briefly to measure their rate…
    const now = performance.now();
    repeats.push(now);
    if (now - repeats[0] < MEASURE_MS) return;
    // …then take over at that rate and accelerate.
    event.preventDefault();
    event.stopPropagation();
    const measured = repeats.length > 1 ? (now - repeats[0]) / (repeats.length - 1) : DEFAULT_INTERVAL_MS;
    run(command, now, measured);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    // Releasing the held key (or Shift during a Shift+arrow) resets.
    if (heldKey && (heldKey.endsWith(event.key) || event.key === "Shift")) stop();
  };

  container.addEventListener("keydown", onKeyDown, true);
  container.addEventListener("keyup", onKeyUp, true);
  const blur = editor.onDidBlurEditorText(stop);
  window.addEventListener("blur", stop);
  return () => {
    stop();
    container.removeEventListener("keydown", onKeyDown, true);
    container.removeEventListener("keyup", onKeyUp, true);
    blur.dispose();
    window.removeEventListener("blur", stop);
  };
}
