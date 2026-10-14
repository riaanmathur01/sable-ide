// End-to-end test of the Pets plugin (plugins/pets) — a webview plugin in
// the sidebar and in an editor tab:
//
//   - installed (a copy of plugins/pets, through the plugin store with the
//     install confirmation answered Yes), it runs;
//   - its commands (Throw Ball, Add Pet…, Start Pet Coding Session…) are in
//     the command palette;
//   - the activity bar gets Plugin Views, which shows the Pets view: a
//     webview whose canvas has pets drawn on it;
//   - Throw Ball (run from the palette) puts the ball on the canvas;
//   - Start Pet Coding Session opens a Pets editor tab, with pets drawn too.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/pets.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, texts } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, copyFolder, PLUGINS, bridge, tauriStandins, waitFor, palette, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("pets");
const root = tempDir("pets");
const workspace = writeTree(path.join(root, "ws"), { "README.md": "# Pets\n", "src/a.ts": "export const a = 1;\n" });
const plugin = copyFolder(path.join(PLUGINS, "pets"), path.join(root, "pets"));

const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 880,
  init: tauriStandins({ "plugin:dialog|ask": true, "plugin:dialog|confirm": true, "plugin:dialog|message": "Yes" }),
});

/** In a webview frame: [painted pixels (sampled), ball-coloured pixels] on its canvas. */
const canvasStats = (frame) =>
  frame
    .evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas || !canvas.width || !canvas.height) return null;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4 * 37) if (data[i] > 0) painted++;
      // The ball's colours (its sprite in plugins/pets/main.js).
      const ballColours = new Set(["255,90,79", "255,210,204", "200,50,42"]);
      let ball = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && ballColours.has(`${data[i]},${data[i + 1]},${data[i + 2]}`)) ball++;
      return { painted, ball };
    })
    .catch(() => null);
const webviewFrames = () => page.frames().filter((frame) => frame !== page.mainFrame());
/** The frame of the webview in the sidebar (inSidebar) or elsewhere (an editor tab). */
const webviewFrame = async (inSidebar) => {
  for (const frame of webviewFrames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.evaluate((iframe) => Boolean(iframe.closest(".sidebar")))) === inSidebar) return frame;
  }
  return null;
};

try {
  await sleep(1200);
  const installed = await page.evaluate(async (folder) => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().installFromFolder(folder), plugin);
  check("Pets installs (confirmed)", installed === true);
  const state = await waitFor(page, async () => {
    const value = (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states.pets;
    return value === "running" || value === "error" ? value : null;
  });
  check("Pets runs", state === "running", state);
  const commands = await page.evaluate(async () =>
    (await import("/src/store/pluginStore.ts")).usePluginStore.getState().commands.filter((c) => c.pluginId === "pets").map((c) => c.command.title),
  );
  check("its commands are registered", ["Throw Ball", "Add Pet…", "Start Pet Coding Session"].every((title) => commands.includes(title)), commands.join(", "));
  await page.mouse.move(5, 870);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await sleep(300);
  await page.keyboard.type("Throw Ball");
  await sleep(400);
  const offered = await texts(page, "[data-index]");
  check("…and in the command palette", offered.some((item) => /Throw Ball/.test(item)), offered.slice(0, 3).join(" | "));
  await page.keyboard.press("Escape");
  await sleep(300);

  // --- The sidebar view ---------------------------------------------------------------------
  const viewsButton = await waitFor(page, () => Boolean(document.querySelector('.activity-bar-item[title^="Plugin Views"]')));
  check("the activity bar offers Plugin Views", viewsButton === true);
  if (viewsButton) await page.click('.activity-bar-item[title^="Plugin Views"]');
  let sidebarFrame = null;
  for (let i = 0; i < 40 && !sidebarFrame; i++) {
    await sleep(250);
    sidebarFrame = await webviewFrame(true);
  }
  check("the Pets view shows a page in the sidebar", Boolean(sidebarFrame), `${webviewFrames().length} webview frame(s)`);
  let drawn = null;
  for (let i = 0; i < 30 && !(drawn?.painted > 50); i++) {
    await sleep(250);
    drawn = sidebarFrame && (await canvasStats(sidebarFrame));
  }
  check("…with pets drawn on its canvas", drawn?.painted > 50, JSON.stringify(drawn));
  await page.screenshot({ path: `${shots}/pets-view.png` });

  // --- Throw Ball ---------------------------------------------------------------------------
  const ballBefore = drawn?.ball ?? 0;
  const first = await palette(page, "Throw Ball", 300);
  let ballAfter = 0;
  for (let i = 0; i < 20 && ballAfter <= ballBefore; i++) {
    await sleep(100);
    ballAfter = (sidebarFrame && (await canvasStats(sidebarFrame)))?.ball ?? 0;
  }
  check("Throw Ball (from the palette) puts the ball on the canvas", /Throw Ball/.test(first ?? "") && ballAfter > ballBefore, `${first}: ball pixels ${ballBefore} → ${ballAfter}`);
  await page.screenshot({ path: `${shots}/pets-in-sable.png` });

  // --- Start Pet Coding Session -----------------------------------------------------------
  await palette(page, "Start Pet Coding Session", 300);
  const tabs = await waitFor(page, () => {
    const names = [...document.querySelectorAll(".editor-tab-name")].map((name) => name.textContent);
    return names.some((name) => /pet/i.test(name)) ? names : null;
  });
  check("Start Pet Coding Session opens a tab", Boolean(tabs), JSON.stringify(tabs));
  let tabFrame = null;
  let tabDrawn = null;
  for (let i = 0; i < 40 && !(tabDrawn?.painted > 50); i++) {
    await sleep(250);
    tabFrame ??= await webviewFrame(false);
    tabDrawn = tabFrame && (await canvasStats(tabFrame));
  }
  check("…showing pets too (a second webview, in the editor)", tabDrawn?.painted > 50, JSON.stringify(tabDrawn));
  console.log(`      ball pixels ${ballBefore} → ${ballAfter}; view ${JSON.stringify(drawn)}; tab ${JSON.stringify(tabDrawn)}`);
  await page.screenshot({ path: `${shots}/pets-tab.png` });
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await bridge("plugin_uninstall", { id: "pets" }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
