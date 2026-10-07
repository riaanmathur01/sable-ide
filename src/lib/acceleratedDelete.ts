import type * as MonacoTypes from "monaco-editor";

/**
 * Holding Backspace or Delete speeds up the longer it's held.
 *
 * The first press, the OS's key-repeat delay and the first moments of
 * repeating are untouched (that's when the OS's repeat rate is measured).
 * Then Sable takes over: it ignores the OS's fixed-rate repeats and
 * deletes on its own timer, starting at that measured rate — so there's
 * no jolt — and accelerating smoothly up to a cap. It's always one
 * character per step (plain deleteLeft/deleteRight, so the smooth caret
 * animation and undo grouping behave as usual) — only the pace changes.
 * Releasing the key, or the editor losing focus, resets it.
 */

/** How long the OS's own repeats run (to measure their rate). */
const MEASURE_MS = 300;
/** Assumed repeat interval if it couldn't be measured (≈ 25/s). */
const DEFAULT_INTERVAL_MS = 40;
/** The cap: the shortest delay between deletions (≈ 83/s). */
const MIN_INTERVAL_MS = 12;
/** How long it takes to reach the cap. */
const RAMP_MS = 1800;

/** Delay before the next deletion, `elapsed` ms after taking over from a
 *  repeat interval of `start` ms. Eases in, so the speed-up feels gradual
 *  rather than sudden. Never slower than the start. */
export function deleteInterval(elapsed: number, start = DEFAULT_INTERVAL_MS): number {
  const from = Math.max(start, MIN_INTERVAL_MS);
  const progress = Math.min(1, Math.max(0, elapsed / RAMP_MS));
  const eased = progress * progress * (3 - 2 * progress); // smoothstep
  return from - (from - MIN_INTERVAL_MS) * eased;
}

const COMMANDS: Record<string, string> = {
  Backspace: "deleteLeft",
  Delete: "deleteRight",
};

export function installAcceleratedDelete(editor: MonacoTypes.editor.IStandaloneCodeEditor): () => void {
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
    const command = COMMANDS[event.key];
    // Plain Backspace/Delete only: modified ones (word/line delete) and
    // IME composition keep their normal behavior.
    if (!command || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) {
      if (heldKey) stop();
      return;
    }
    if (!event.repeat) {
      stop(); // a fresh press: the editor handles it normally
      return;
    }
    if (editor.getRawOptions().readOnly) return;
    if (timer && heldKey === event.key) {
      // Already driving: swallow the OS's repeats.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (heldKey !== event.key) {
      stop();
      heldKey = event.key;
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
    if (event.key === heldKey) stop();
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
