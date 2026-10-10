import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useGitStore } from "../../store/gitStore";
import { PAGES, VIEWS, openPage, showView, useActivePage } from "./views";
import "./ActivityBar.css";

/** The hamburger View Switcher: one ☰ button listing every view. */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const changeCount = useGitStore((state) => Object.keys(state.statusByPath).length);
  const activePage = useActivePage();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="view-menu-anchor" ref={anchor}>
      <button
        className={open ? "icon-button active" : "icon-button"}
        title="Views"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Menu size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="view-menu" role="menu">
          {VIEWS.map(({ id, label, icon: Icon, shortcut }) => (
            <button
              key={id}
              role="menuitem"
              className={sidebarView === id && !activePage ? "view-menu-item active" : "view-menu-item"}
              onClick={() => choose(() => showView(id))}
            >
              <Icon size={15} strokeWidth={1.5} />
              <span className="view-menu-label">{label}</span>
              {id === "git" && changeCount > 0 && <span className="view-menu-count">{changeCount}</span>}
              {shortcut && <span className="view-menu-shortcut">{shortcut}</span>}
            </button>
          ))}
          <div className="view-menu-divider" />
          {(Object.keys(PAGES) as (keyof typeof PAGES)[]).map((page) => {
            const { label, icon: Icon } = PAGES[page];
            const shortcut = "shortcut" in PAGES[page] ? (PAGES[page] as { shortcut: string }).shortcut : undefined;
            return (
              <button
                key={page}
                role="menuitem"
                className={activePage === page ? "view-menu-item active" : "view-menu-item"}
                onClick={() => choose(() => openPage(page))}
              >
                <Icon size={15} strokeWidth={1.5} />
                <span className="view-menu-label">{label}</span>
                {shortcut && <span className="view-menu-shortcut">{shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
