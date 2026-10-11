/**
 * Editor events plugins can listen to. A dependency-free bus, so the
 * stores and editors that raise events needn't import the plugin host.
 */
export type PluginEventName = "didSave" | "didOpen" | "didChange" | "didChangeActiveEditor" | "didChangeSelection";

export type PluginEventPayload = { path: string | null } & Record<string, unknown>;

type Listener = (name: PluginEventName, payload: PluginEventPayload) => void;
const listeners = new Set<Listener>();

export function emitPluginEvent(name: PluginEventName, payload: PluginEventPayload): void {
  for (const listener of listeners) listener(name, payload);
}

export function onPluginEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
