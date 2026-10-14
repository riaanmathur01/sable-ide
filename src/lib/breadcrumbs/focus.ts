import { useTabsStore } from "../../store/tabsStore";

/**
 * "Focus Breadcrumbs" (⇧⌘.): each group's breadcrumb bar registers how
 * to focus itself; the command focuses the focused group's. Kept apart
 * from the bar so the shortcut table doesn't pull in the editor.
 */
const focusers = new Map<string, () => void>();

export function registerBreadcrumbsFocus(groupId: string, focus: () => void): () => void {
  focusers.set(groupId, focus);
  return () => {
    if (focusers.get(groupId) === focus) focusers.delete(groupId);
  };
}

export function focusBreadcrumbs(): boolean {
  const focus = focusers.get(useTabsStore.getState().activeGroupId);
  focus?.();
  return !!focus;
}
