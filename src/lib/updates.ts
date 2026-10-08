import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { getSetting } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";

/**
 * Updates: Sable's releases on GitHub publish a signed `latest.json`; the
 * updater checks it, downloads the new build, verifies its signature
 * against the public key in tauri.conf.json, installs it, and restarts.
 */

let pending: Update | null = null;

/** On startup (if enabled): only say that an update exists. */
export async function checkForUpdatesQuietly(): Promise<void> {
  if (!getSetting("updates.checkOnStartup") || import.meta.env.DEV) return;
  try {
    pending = await check();
    if (pending) {
      useUiStore.getState().showStatus(`Sable ${pending.version} is available — run “Check for Updates” to install it`);
    }
  } catch {
    // Offline, or no release yet: nothing to say.
  }
}

/** Command palette: check, and offer to install. */
export async function checkForUpdates(): Promise<void> {
  const ui = useUiStore.getState();
  ui.showStatus("Checking for updates…");
  let update: Update | null;
  try {
    update = pending ?? (await check());
  } catch (error) {
    ui.setLastError(`Couldn't check for updates: ${String(error)}`);
    return;
  }
  if (!update) {
    ui.showStatus("Sable is up to date");
    return;
  }
  const notes = update.body?.trim() ? `\n\n${update.body.trim().slice(0, 600)}` : "";
  const install = await confirmNative(
    `Sable ${update.version} is available (you have ${update.currentVersion}). Install it and restart?${notes}`,
    { title: "Update Sable", kind: "info" },
  );
  if (!install) return;
  try {
    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total) ui.showStatus(`Downloading Sable ${update.version}… ${Math.round((received / total) * 100)}%`);
      }
      if (event.event === "Finished") ui.showStatus("Installing…");
    });
    await relaunch();
  } catch (error) {
    ui.setLastError(`The update failed: ${String(error)}`);
  }
}
