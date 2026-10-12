import { listen as listenAnywhere, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Backend events for this window. Each window has its own workspace, and
 * the backend sends a window's terminal output, language-server messages,
 * search results… to that window only: listening on the window (instead of
 * Tauri's `listen`, which hears every window's events) keeps them apart.
 * Events sent to every window (settings changed elsewhere) arrive too.
 */
export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  let window: ReturnType<typeof getCurrentWebviewWindow> | null = null;
  try {
    window = getCurrentWebviewWindow();
  } catch {
    // Not in a Tauri window (tests): the app-wide listener.
  }
  return window ? window.listen<T>(event, handler) : listenAnywhere<T>(event, handler);
}
