/**
 * Editor events plugins can listen to. A dependency-free bus, so the
 * stores that raise events (tabsStore) needn't import the plugin host.
 */
export type PluginEventName = "didSave" | "didOpen";

type Listener = (name: PluginEventName, payload: { path: string }) => void;
const listeners = new Set<Listener>();

export function emitPluginEvent(name: PluginEventName, payload: { path: string }): void {
  for (const listener of listeners) listener(name, payload);
}

export function onPluginEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
