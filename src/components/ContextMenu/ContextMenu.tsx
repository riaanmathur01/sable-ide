import { useEffect, useRef } from "react";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Minimal custom context menu, positioned at the cursor and clamped to
 * the window. Closes on outside click or Escape.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Clamp so the menu never overflows the window edge.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    if (bounds.right > window.innerWidth) {
      menu.style.left = `${x - bounds.width}px`;
    }
    if (bounds.bottom > window.innerHeight) {
      menu.style.top = `${y - bounds.height}px`;
    }
  }, [x, y]);

  return (
    <div
      className="context-menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: x, top: y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            className={
              item.danger ? "context-menu-item danger" : "context-menu-item"
            }
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
