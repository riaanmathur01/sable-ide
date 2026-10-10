import { Bug, Files, GitBranch, History, Puzzle, Search, Settings, type LucideIcon } from "lucide-react";
import type { SidebarView } from "../../store/uiStore";
import { useUiStore } from "../../store/uiStore";
import { SETTINGS_TAB_KEY, useTabsStore } from "../../store/tabsStore";

/**
 * The views you switch between — shared by every View Switcher style
 * (activity bar, sidebar-header icons, hamburger menu).
 */
export interface ViewItem {
  id: SidebarView;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

export const VIEWS: ViewItem[] = [
  { id: "files", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search, shortcut: "⇧⌘F" },
  { id: "git", label: "Source Control", icon: GitBranch, shortcut: "⇧⌘G" },
  { id: "history", label: "History", icon: History },
  { id: "debug", label: "Run and Debug", icon: Bug, shortcut: "⇧⌘D" },
];

/** Pages of the Settings tab that sit beside the views. */
export const PAGES = {
  plugins: { label: "Plugins", icon: Puzzle },
  settings: { label: "Settings", icon: Settings, shortcut: "⌘," },
} as const;

/**
 * Show a view. With `toggle` (the activity bar, as in VS Code), choosing
 * the view that's already showing hides the sidebar.
 */
export function showView(view: SidebarView, toggle = false) {
  const ui = useUiStore.getState();
  if (toggle && ui.sidebarVisible && ui.sidebarView === view) ui.toggleSidebar();
  else ui.setSidebarView(view);
}

export function openPage(page: keyof typeof PAGES) {
  useTabsStore.getState().openSettings(page === "plugins" ? "plugins" : "settings");
}

/** Which Settings page is in front (for highlighting), if any. */
export function useActivePage(): keyof typeof PAGES | null {
  const settingsActive = useTabsStore((state) => state.activePath === SETTINGS_TAB_KEY);
  const page = useUiStore((state) => state.settingsPage);
  return settingsActive ? page : null;
}
