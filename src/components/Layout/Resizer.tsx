import { useRef } from "react";
import "./Resizer.css";

interface ResizerProps {
  /** "x" resizes a width (vertical bar); "y" resizes a height. */
  axis: "x" | "y";
  /** Current size of the panel being resized. */
  size: number;
  onResize: (size: number) => void;
  /** Double-click restores this size. */
  defaultSize: number;
  /**
   * The panel grows when dragging toward negative coordinates (a panel
   * on the right edge, or one docked at the bottom).
   */
  invert?: boolean;
}

/**
 * A thin drag handle between two panels. Uses pointer capture so the
 * drag keeps tracking even over Monaco/xterm canvases, and marks the
 * body while dragging so the cursor and text selection behave.
 */
export function Resizer({ axis, size, onResize, defaultSize, invert }: ResizerProps) {
  const dragStart = useRef<{ position: number; size: number } | null>(null);

  return (
    <div
      className={`resizer resizer-${axis}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStart.current = {
          position: axis === "x" ? event.clientX : event.clientY,
          size,
        };
        document.body.classList.add(`resizing-${axis}`);
      }}
      onPointerMove={(event) => {
        const start = dragStart.current;
        if (!start) return;
        const position = axis === "x" ? event.clientX : event.clientY;
        const delta = (position - start.position) * (invert ? -1 : 1);
        onResize(start.size + delta);
      }}
      onPointerUp={(event) => {
        dragStart.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove(`resizing-${axis}`);
      }}
      onDoubleClick={() => onResize(defaultSize)}
    />
  );
}
