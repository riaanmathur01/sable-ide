import { useUiStore } from "../../store/uiStore";
import { useGitStore } from "../../store/gitStore";
import { PAGES, VIEWS, openPage, showView, useActivePage } from "./views";
import "./ActivityBar.css";

/**
 * The VS Code-style activity bar: a vertical strip of view icons at the
 * window's left edge. Clicking the view that's showing hides the
 * sidebar; the bar itself stays.
 */
export function ActivityBar() {
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const changeCount = useGitStore((state) => Object.keys(state.statusByPath).length);
  const activePage = useActivePage();

  return (
    <nav className="activity-bar" aria-label="Views">
      <div className="activity-bar-group">
        {VIEWS.map(({ id, label, icon: Icon, shortcut }) => {
          const active = sidebarVisible && sidebarView === id;
          return (
            <button
              key={id}
              className={active ? "activity-bar-item active" : "activity-bar-item"}
              title={shortcut ? `${label} (${shortcut})` : label}
              aria-pressed={active}
              onClick={() => showView(id, true)}
            >
              <Icon size={22} strokeWidth={1.4} />
              {id === "git" && changeCount > 0 && <span className="activity-bar-badge">{changeCount > 99 ? "99+" : changeCount}</span>}
            </button>
          );
        })}
        <button
          className={activePage === "plugins" ? "activity-bar-item active" : "activity-bar-item"}
          title={PAGES.plugins.label}
          onClick={() => openPage("plugins")}
        >
          <PAGES.plugins.icon size={22} strokeWidth={1.4} />
        </button>
      </div>
      <div className="activity-bar-group">
        <button
          className={activePage === "settings" ? "activity-bar-item active" : "activity-bar-item"}
          title={`${PAGES.settings.label} (${PAGES.settings.shortcut})`}
          onClick={() => openPage("settings")}
        >
          <PAGES.settings.icon size={21} strokeWidth={1.4} />
        </button>
      </div>
    </nav>
  );
}
