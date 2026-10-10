import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask as confirmNative, message as messageNative } from "@tauri-apps/plugin-dialog";
import { getSetting } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";

/**
 * Updates: Sable's releases on GitHub publish a signed `latest.json`; the
 * updater checks it, downloads the new build, verifies its signature
 * against the public key in tauri.conf.json, installs it, and restarts.
 *
 * While it works, the status bar shows a progress item that nothing else
 * replaces (downloads can take minutes on a slow connection), and a
 * failure is reported in a dialog rather than a passing message.
 */

let pending: Update | null = null;
let updating = false;

function progress(text: string | null) {
  useUiStore.getState().setUpdateProgress(text);
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
  if (updating) {
    ui.showStatus("An update is already being installed — see the status bar");
    return;
  }
  updating = true;
  try {
    progress("Checking for updates…");
    let update: Update | null;
    try {
      update = pending ?? (await check());
    } catch (error) {
      progress(null);
      await messageNative(`Couldn't check for updates:\n\n${String(error)}`, { title: "Update Sable", kind: "error" });
      return;
    }
    progress(null);
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
    const version = update.version;
    progress(`Downloading Sable ${version}…`);
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          progress(
            total
              ? `Downloading Sable ${version}… ${Math.round((received / total) * 100)}% (${megabytes(received)} of ${megabytes(total)})`
              : `Downloading Sable ${version}… ${megabytes(received)}`,
          );
        }
        if (event.event === "Finished") progress(`Installing Sable ${version}…`);
      });
      pending = null;
      progress(`Restarting into Sable ${version}…`);
      await relaunch();
    } catch (error) {
      progress(null);
      await messageNative(
        `Sable ${version} couldn't be installed:\n\n${String(error)}\n\nYou can download it from the Releases page instead: https://github.com/riaanmathur01/sable-ide/releases/latest`,
        { title: "Update Failed", kind: "error" },
      );
    }
  } finally {
    updating = false;
  }
}
