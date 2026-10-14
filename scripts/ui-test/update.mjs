// End-to-end test of the updater's feedback (src/lib/updates.ts), with the
// Tauri updater/process/dialog plugins stubbed in an init script (so the
// stubs survive reloads):
//
//   - "Check for Updates…" asks whether to install the
//     new version (a Yes/No plugin:dialog|message), then shows the download's progress in the status bar
//     (percent and MB, fed through the download's channel callback).
//   - A second request mid-download is refused with a status message, not
//     a second download.
//   - When the download finishes it restarts (plugin:process|restart).
//   - A failed download (after a reload: fresh state) shows an error
//     dialog (plugin:dialog|message, kind "error") and the progress item
//     goes away.
//   - No update: "Sable is up to date".
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/update.mjs
//
// with Vite and the bridge running (README → Testing, or run-all.mjs).
// Takes about 25 seconds.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, palette, waitFor, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("update");
const workspace = writeTree(path.join(tempDir("update"), "ws"), { "README.md": "# Update\n" });

// Stubs for the updater (a 12 MB download in six chunks, 500 ms apart),
// the restart and the dialogs. sessionStorage["ui-test.update"] picks the
// scenario: "ok", "fail" (the download times out half-way) or "none".
const stubs = `(() => {
  if (window !== window.top) return;
  const internals = window.__TAURI_INTERNALS__;
  const callbacks = new Map();
  const transform = internals.transformCallback;
  internals.transformCallback = (fn, once) => {
    const id = transform(fn, once);
    callbacks.set(id, fn);
    return id;
  };
  window.__dialogs = [];
  window.__downloads = 0;
  window.__restarted = false;
  const original = internals.invoke;
  internals.invoke = async (cmd, args) => {
    const scenario = sessionStorage.getItem("ui-test.update") ?? "ok";
    if (cmd === "plugin:updater|check") {
      if (scenario === "none") return null;
      return { rid: 1, currentVersion: "0.3.3", version: "0.3.4", date: null, body: "Faster.", rawJson: {} };
    }
    if (cmd === "plugin:updater|download_and_install") {
      window.__downloads++;
      const channel = args.onEvent;
      const id = typeof channel === "object" && channel !== null ? channel.id : Number(String(channel).replace("__CHANNEL__:", ""));
      const send = (index, message) => callbacks.get(id)?.({ index, message });
      const total = 12 * 1024 * 1024;
      send(0, { event: "Started", data: { contentLength: total } });
      for (let i = 1; i <= 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (scenario === "fail" && i === 3) throw "error sending request: operation timed out";
        send(i, { event: "Progress", data: { chunkLength: total / 6 } });
      }
      send(7, { event: "Finished" });
      return null;
    }
    if (cmd === "plugin:process|restart") {
      window.__restarted = true;
      return null;
    }
    if (cmd === "plugin:dialog|ask") {
      window.__dialogs.push({ cmd, ...args });
      return true;
    }
    if (cmd === "plugin:dialog|message") {
      window.__dialogs.push({ cmd, ...args });
      return args.kind === "error" ? "Ok" : "Yes";
    }
    return original(cmd, args);
  };
})()`;

const { browser, page, errors } = await openSable(workspace, { width: 1400, height: 800, init: stubs });
try {
  await sleep(1500);
  const updateText = () => page.$eval(".status-bar-update", (element) => element.textContent).catch(() => null);
  const statusBar = () => page.$eval(".status-bar", (element) => element.textContent).catch(() => "");

  // --- A successful update ------------------------------------------------------------------------
  await palette(page, "Check for Updates", 1300);
  const dialogs = await page.evaluate(() => window.__dialogs);
  // ask() is plugin:dialog|message with Yes/No buttons.
  const ask = dialogs.find((dialog) => dialog.buttons === "YesNo" || dialog.cmd === "plugin:dialog|ask");
  check("asks before installing (new and current version, release notes)", /Sable 0\.3\.4 is available \(you have 0\.3\.3\)/.test(ask?.message ?? "") && ask.message.includes("Faster."), JSON.stringify(dialogs));
  const mid = await updateText();
  check("progress shows in the status bar during the download", /Downloading Sable 0\.3\.4… \d+% \(\d+\.\d MB of 12\.0 MB\)/.test(mid ?? ""), mid);
  await page.screenshot({ path: `${shots}/progress.png` });

  // A second request mid-download is refused, not a second download.
  await palette(page, "Check for Updates", 400);
  check("a second update request is ignored (status message)", (await statusBar()).includes("already being installed"), await statusBar());
  check("…and doesn't start a second download", (await page.evaluate(() => window.__downloads)) === 1);
  check("…while the progress item stays", /Downloading Sable 0\.3\.4/.test((await updateText()) ?? ""), await updateText());

  const restarted = await waitFor(page, () => window.__restarted, [], { timeout: 8000 });
  check("then restarts into the new version", restarted === true && (await updateText())?.includes("Restarting into Sable 0.3.4"), await updateText());

  // --- A failed download (fresh page; the stubs come back with it) --------------------------------
  await page.evaluate(() => sessionStorage.setItem("ui-test.update", "fail"));
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1500);
  check("stubs survive the reload", (await page.evaluate(() => Array.isArray(window.__dialogs) && window.__restarted === false)) === true);
  await palette(page, "Check for Updates", 800);
  check("the failing download shows progress first", /Downloading Sable 0\.3\.4/.test((await updateText()) ?? ""), await updateText());
  const failure = await waitFor(page, () => window.__dialogs.find((dialog) => dialog.cmd === "plugin:dialog|message" && dialog.kind === "error"), [], { timeout: 8000 });
  check(
    "a failed download shows an error dialog",
    failure?.kind === "error" && failure.title === "Update Failed" && /Sable 0\.3\.4 couldn't be installed/.test(failure.message) && failure.message.includes("operation timed out"),
    JSON.stringify(failure),
  );
  await sleep(300);
  check("…and the progress item goes away", (await updateText()) === null, await updateText());
  check("…and it doesn't restart", (await page.evaluate(() => window.__restarted)) === false);
  await page.screenshot({ path: `${shots}/failed.png` });

  // A new request works again after the failure (not stuck "already being installed").
  await page.evaluate(() => sessionStorage.setItem("ui-test.update", "none"));
  await palette(page, "Check for Updates", 800);
  check("after a failure a new check runs (no update: up to date)", (await statusBar()).includes("Sable is up to date"), await statusBar());

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
}
finish();
