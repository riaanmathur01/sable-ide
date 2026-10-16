import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface MenuOption {
  value: string;
  label: string;
  description?: string | null;
  icon?: ReactNode;
  /** Shown at the right (a tag, a shortcut). */
  trailing?: ReactNode;
  disabled?: boolean;
  /** Starts a new group with this heading. */
  group?: string;
  /** Checked (default: it's the value). */
  checked?: boolean;
}

/**
 * A compact dropdown that opens upward or downward to fit (the composer
 * sits at the bottom of the panel), with a check on the current value and
 * descriptions under the names — like Zed's and Cursor's model pickers.
 */
export function Dropdown({
  value,
  options,
  onChange,
  label,
  title,
  className,
  icon,
  footer,
  testId,
  align = "left",
}: {
  value: string | null;
  options: MenuOption[];
  onChange: (value: string) => void;
  label: ReactNode;
  title?: string;
  className?: string;
  icon?: ReactNode;
  footer?: ReactNode;
  testId?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(true);

  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    setUp(rect.top > window.innerHeight - rect.bottom);
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (option: MenuOption | undefined) => {
    if (!option || option.disabled) return;
    setOpen(false);
    onChange(option.value);
  };

  return (
    <div className={`acp-dropdown${className ? ` ${className}` : ""}`} ref={root} data-testid={testId}>
      <button
        className={open ? "acp-dropdown-button open" : "acp-dropdown-button"}
        title={title}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (index + step + options.length) % options.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(options[active]);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {icon}
        <span className="acp-dropdown-label">{label}</span>
        <ChevronDown size={11} className="acp-dropdown-chevron" />
      </button>
      {open && (
        <div className={`acp-menu ${up ? "up" : "down"} ${align}`} role="listbox">
          {options.map((option, index) => (
            <div key={option.value}>
              {option.group && <div className="acp-menu-group">{option.group}</div>}
              <button
                role="option"
                aria-selected={option.checked ?? option.value === value}
                className={`acp-menu-item${index === active ? " active" : ""}${option.disabled ? " disabled" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="acp-menu-check">{(option.checked ?? option.value === value) && <Check size={12} />}</span>
                {option.icon}
                <span className="acp-menu-text">
                  <span className="acp-menu-label">{option.label}</span>
                  {option.description && <span className="acp-menu-description">{option.description}</span>}
                </span>
                {option.trailing}
              </button>
            </div>
          ))}
          {footer && <div className="acp-menu-footer">{footer}</div>}
        </div>
      )}
    </div>
  );
}
