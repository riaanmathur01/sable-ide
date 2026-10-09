import type * as MonacoTypes from "monaco-editor";
import { accelerationAt, planMotion, positionAt, snapTarget, velocityAt, type Motion } from "./scrollMotion";
import { getSetting } from "../store/settingsStore";
import { StandardWheelEvent } from "monaco-editor/esm/vs/base/browser/mouseEvent.js";

/**
 * Eased wheel scrolling for every editor: each wheel event scrolls exactly
 * as far as it normally would, but along a bell-shaped speed curve (see
 * scrollMotion.ts), coming to rest on a whole line.
 */

type Editor = MonacoTypes.editor.ICodeEditor;

/** One notch of a mouse wheel; a stream of events (a trackpad, or a fast
 *  spin) follows more tightly. */
const NOTCH_MS = 240;
const STREAM_MS = 140;
/** Events closer together than this are one continuous gesture. */
const STREAM_GAP_MS = 50;

/** Monaco's pixels per wheel "notch" (SCROLL_WHEEL_SENSITIVITY). */
const PIXELS_PER_NOTCH = 50;
const isMac = /mac/i.test(navigator.userAgent);

/**
 * How far Monaco would scroll for this wheel event, in pixels (positive =
 * down / right) — the same steps as its scrollbar: normalized deltas,
 * sensitivity, the predominant axis, ⇧ for sideways (macOS does that
 * itself), ⌥ for fast, 50 px a notch, small movements rounded up.
 */
function normalScroll(event: WheelEvent, editor: Editor, monaco: typeof MonacoTypes): { dx: number; dy: number } {
  const standard = new StandardWheelEvent(event);
  const sensitivity = editor.getOption(monaco.editor.EditorOption.mouseWheelScrollSensitivity);
  let deltaY = standard.deltaY * sensitivity;
  let deltaX = standard.deltaX * sensitivity;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) deltaX = 0;
  else deltaY = 0;
  if (!isMac && event.shiftKey && !deltaX) [deltaX, deltaY] = [deltaY, 0];
  if (event.altKey) {
    const fast = editor.getOption(monaco.editor.EditorOption.fastScrollSensitivity);
    deltaX *= fast;
    deltaY *= fast;
  }
  const pixels = (delta: number) => {
    const scroll = PIXELS_PER_NOTCH * delta;
    return -(scroll < 0 ? Math.floor(scroll) : Math.ceil(scroll));
  };
  return { dx: deltaX ? pixels(deltaX) : 0, dy: deltaY ? pixels(deltaY) : 0 };
}

/** Widgets inside the editor that scroll themselves. */
const SELF_SCROLLING = ".suggest-widget, .monaco-hover, .parameter-hints-widget, .find-widget, .rename-box, .zone-widget";

interface Axis {
  motion: Motion | null;
  startedAt: number;
  /** Where the scroll is heading, before snapping (wheel deltas add up here). */
  target: number;
  /** Where the last motion came to rest (snapped), if nothing has moved
   *  the view since: the next scroll carries on from `target`, so
   *  rounding to lines never adds up to scrolling less than usual. */
  landed: number | null;
}

export function installEasedScrolling(editor: Editor, monaco: typeof MonacoTypes): () => void {
  const node = editor.getDomNode();
  if (!node) return () => {};
  const vertical: Axis = { motion: null, startedAt: 0, target: 0, landed: null };
  const horizontal: Axis = { motion: null, startedAt: 0, target: 0, landed: null };
  let frame = 0;
  let lastWheel = 0;
  /** Scroll positions we set ourselves (to tell other scrolling apart). */
  let expectedTop: number | null = null;
  let expectedLeft: number | null = null;

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    vertical.motion = horizontal.motion = null;
    vertical.landed = horizontal.landed = null;
    expectedTop = expectedLeft = null;
  };

  const tick = () => {
    const now = performance.now();
    let moving = false;
    if (vertical.motion) {
      const elapsed = now - vertical.startedAt;
      expectedTop = positionAt(vertical.motion, elapsed);
      editor.setScrollTop(expectedTop, monaco.editor.ScrollType.Immediate);
      if (elapsed >= vertical.motion.duration) vertical.motion = null;
      else moving = true;
    }
    if (horizontal.motion) {
      const elapsed = now - horizontal.startedAt;
      expectedLeft = positionAt(horizontal.motion, elapsed);
      editor.setScrollLeft(expectedLeft, monaco.editor.ScrollType.Immediate);
      if (elapsed >= horizontal.motion.duration) horizontal.motion = null;
      else moving = true;
    }
    frame = moving ? requestAnimationFrame(tick) : 0;
    if (!moving) expectedTop = expectedLeft = null;
  };

  /** Head `axis` a further `delta` pixels, continuing smoothly. */
  const push = (axis: Axis, current: number, delta: number, max: number, lineHeight: number, duration: number) => {
    const now = performance.now();
    const elapsed = now - axis.startedAt;
    const moving = axis.motion !== null && elapsed < axis.motion.duration;
    // Wheel deltas add up: the next one heads on from where the last was
    // going (unrounded), unless something else moved the view meanwhile.
    const continuing = moving || (axis.landed !== null && Math.abs(current - axis.landed) < 1);
    axis.target = (continuing ? axis.target : current) + delta;
    axis.target = Math.min(Math.max(0, axis.target), Math.max(0, max));
    const to = snapTarget(axis.target, lineHeight, max);
    const from = moving ? positionAt(axis.motion!, elapsed) : current;
    if (Math.abs(to - from) < 0.5) return;
    axis.landed = to;
    axis.motion = planMotion(
      from,
      moving ? velocityAt(axis.motion!, elapsed) : 0,
      moving ? accelerationAt(axis.motion!, elapsed) : 0,
      to,
      duration,
    );
    axis.startedAt = now;
  };

  const onWheel = (event: WheelEvent) => {
    if (!getSetting("editor.smoothScrolling")) return;
    // Pinch / ⌘-wheel zoom, and widgets with their own scrolling, as usual.
    if (event.ctrlKey || event.metaKey) return;
    if (event.target instanceof Element && event.target.closest(SELF_SCROLLING)) return;
    const layout = editor.getLayoutInfo();
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const { dx, dy } = normalScroll(event, editor, monaco);
    if (dx === 0 && dy === 0) return;
    event.preventDefault();
    event.stopPropagation();

    const now = performance.now();
    const duration = now - lastWheel < STREAM_GAP_MS ? STREAM_MS : NOTCH_MS;
    lastWheel = now;
    if (dy) {
      push(vertical, editor.getScrollTop(), dy, editor.getScrollHeight() - layout.height, lineHeight, duration);
    }
    if (dx) {
      push(horizontal, editor.getScrollLeft(), dx, editor.getScrollWidth() - layout.contentWidth, 0, duration);
    }
    if (!frame && (vertical.motion || horizontal.motion)) frame = requestAnimationFrame(tick);
  };

  node.addEventListener("wheel", onWheel, { capture: true, passive: false });
  // Anything else that scrolls (a jump, the scrollbar, typing) takes over.
  const scrolled = editor.onDidScrollChange((event) => {
    const ours =
      (expectedTop === null || Math.abs(event.scrollTop - expectedTop) < 1) &&
      (expectedLeft === null || Math.abs(event.scrollLeft - expectedLeft) < 1);
    if (!ours) {
      if (frame) stop();
      else vertical.landed = horizontal.landed = null;
    }
  });
  const modelChanged = editor.onDidChangeModel(stop);
  return () => {
    stop();
    node.removeEventListener("wheel", onWheel, { capture: true });
    scrolled.dispose();
    modelChanged.dispose();
  };
}

export function registerEasedScrolling(monaco: typeof MonacoTypes) {
  monaco.editor.onDidCreateEditor((editor) => {
    // The DOM node exists once the editor is set up.
    queueMicrotask(() => {
      const uninstall = installEasedScrolling(editor, monaco);
      editor.onDidDispose(uninstall);
    });
  });
}
