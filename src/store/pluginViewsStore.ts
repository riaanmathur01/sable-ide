import { create } from "zustand";

/**
 * What plugins show beyond the editor: webview panels (editor tabs),
 * and the views they contribute — tree views and webview views — in the
 * Plugin Views sidebar. The plugin host (lib/plugins/host.ts) fills it;
 * the components render it and send what the user does back through the
 * callbacks registered here.
 */

export interface PluginWebview {
  id: string;
  pluginId: string;
  title: string;
  html: string;
  /** Bumped when html changes (re-renders the frame). */
  version: number;
  enableScripts: boolean;
  /** A message from the page (acquireVsCodeApi().postMessage). */
  onMessage: (message: unknown) => void;
  /** The tab was closed by the user. */
  onDispose?: () => void;
  /** Webview views: the view became visible and needs its content. */
}

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** 0 none, 1 collapsed, 2 expanded. */
  collapsible: number;
  icon?: string;
  command?: { id: string; title?: string; arguments?: unknown[] };
}

export interface PluginView {
  id: string;
  pluginId: string;
  pluginName: string;
  name: string;
  kind: "tree" | "webview";
  /** Tree views: children of a node (undefined: the roots). */
  children?: (nodeId?: string) => Promise<TreeNode[]>;
  /** Tree views: bumped when the plugin says the data changed. */
  version: number;
  /** Webview views: ask the plugin to fill the view's webview. */
  resolve?: () => Promise<void>;
  /** Run a node's command. */
  run?: (command: NonNullable<TreeNode["command"]>) => void;
}

/** Messages for a webview page, delivered by its frame component. */
type FrameListener = (message: unknown) => void;
const frameListeners = new Map<string, Set<FrameListener>>();

export function onWebviewMessage(id: string, listener: FrameListener): () => void {
  if (!frameListeners.has(id)) frameListeners.set(id, new Set());
  frameListeners.get(id)!.add(listener);
  return () => frameListeners.get(id)?.delete(listener);
}

/** Pending messages for pages not shown yet. */
const pendingMessages = new Map<string, unknown[]>();

export function postToWebview(id: string, message: unknown): boolean {
  const listeners = frameListeners.get(id);
  if (!listeners || listeners.size === 0) {
    pendingMessages.set(id, [...(pendingMessages.get(id) ?? []), message].slice(-200));
    return false;
  }
  for (const listener of listeners) listener(message);
  return true;
}

export function takePendingMessages(id: string): unknown[] {
  const messages = pendingMessages.get(id) ?? [];
  pendingMessages.delete(id);
  return messages;
}

interface PluginViewsState {
  webviews: Record<string, PluginWebview>;
  views: PluginView[];
  upsertWebview: (webview: Omit<PluginWebview, "version"> & { version?: number }) => void;
  updateWebview: (id: string, change: Partial<Pick<PluginWebview, "html" | "title" | "enableScripts">>) => void;
  removeWebview: (id: string) => void;
  declareViews: (pluginId: string, views: PluginView[]) => void;
  updateView: (id: string, change: Partial<PluginView>) => void;
  /** Everything of one plugin (it stopped). */
  removePlugin: (pluginId: string) => void;
}

export const usePluginViewsStore = create<PluginViewsState>((set) => ({
  webviews: {},
  views: [],
  upsertWebview: (webview) =>
    set((state) => ({
      webviews: {
        ...state.webviews,
        [webview.id]: { ...state.webviews[webview.id], ...webview, version: (state.webviews[webview.id]?.version ?? 0) + 1 },
      },
    })),
  updateWebview: (id, change) =>
    set((state) => {
      const current = state.webviews[id];
      if (!current) return {};
      return { webviews: { ...state.webviews, [id]: { ...current, ...change, version: current.version + (change.html !== undefined ? 1 : 0) } } };
    }),
  removeWebview: (id) =>
    set((state) => {
      const { [id]: _removed, ...webviews } = state.webviews;
      return { webviews };
    }),
  declareViews: (pluginId, views) =>
    set((state) => ({ views: [...state.views.filter((view) => view.pluginId !== pluginId), ...views] })),
  updateView: (id, change) =>
    set((state) => ({ views: state.views.map((view) => (view.id === id ? { ...view, ...change } : view)) })),
  removePlugin: (pluginId) =>
    set((state) => ({
      views: state.views.filter((view) => view.pluginId !== pluginId),
      webviews: Object.fromEntries(Object.entries(state.webviews).filter(([, webview]) => webview.pluginId !== pluginId)),
    })),
}));
