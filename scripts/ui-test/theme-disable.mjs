// End-to-end test: a theme plugin's colors go away with the plugin.
//
//   - Installing a theme plugin (a copy of plugins/vscode.dracula-theme.
//     theme-dracula, through the plugin store, with the install
//     confirmation answered Yes) offers its themes in a picker; choosing
//     Dracula applies it to the app (--bg-base), the editor background and
//     the syntax colors, and saves workbench.colorTheme.
//   - Disabling the plugin restores the previous app, editor and syntax
//     colors; enabling it again brings the theme back.
//   - Uninstalling it (Uninstall confirmed) restores the colors at once,
//     and the next launch (a reload, settings still naming the theme)
//     doesn't show it either.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/theme-disable.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, copyFolder, PLUGINS, bridge, tauriStandins, waitFor, openFile, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("theme-disable");
const root = tempDir("theme-disable");
const workspace = writeTree(path.join(root, "ws"), { "src/a.ts": "export const a = 1;\nexport function b() {\n  return a;\n}\n" });
const plugin = copyFolder(path.join(PLUGINS, "vscode.dracula-theme.theme-dracula"), path.join(root, "dracula"));
const PLUGIN_ID = "vscode.dracula-theme.theme-dracula";
const DRACULA_BG = "rgb(40, 42, 54)";

let settings = {};
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

const { browser, page, errors } = await openSable(workspace, {
  width: 1300,
  height: 800,
  // The install and uninstall confirmations: Yes.
  init: tauriStandins({ "plugin:dialog|ask": true, "plugin:dialog|confirm": true, "plugin:dialog|message": "Yes" }),
});
const colors = () =>
  page.evaluate(() => {
    const keyword = [...document.querySelectorAll(".view-line span span")].find((span) => span.textContent === "export");
    const background = document.querySelector(".monaco-editor .monaco-editor-background");
    return {
      ui: getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim(),
      editor: background ? getComputedStyle(background).backgroundColor : null,
      keyword: keyword ? getComputedStyle(keyword).color : null,
    };
  });
const store = (fn, ...args) =>
  page.evaluate(
    async (fn, args) => {
      const { usePluginStore } = await import("/src/store/pluginStore.ts");
      return new Function("store", "args", `return (${fn})(store, ...args)`)(usePluginStore.getState(), args);
    },
    fn.toString(),
    args,
  );
const openA = async () => {
  await openFile(page, path.join(workspace, "src/a.ts"));
  await waitFor(page, () => [...document.querySelectorAll(".view-line span span")].some((span) => span.textContent === "export"));
  await sleep(500);
};

try {
  await sleep(1200);
  await openA();
  const before = await colors();
  check("the editor shows a.ts with its built-in theme", before.editor && before.keyword && before.editor !== DRACULA_BG, JSON.stringify(before));

  // --- Install: the plugin store offers its themes -------------------------------------------
  const install = store((s, folder) => s.installFromFolder(folder), plugin);
  const offer = await waitFor(page, () => {
    const items = [...document.querySelectorAll("[data-index]")].map((item) => item.innerText.trim());
    return items.some((item) => item.startsWith("Dracula Theme")) ? items : null;
  });
  check("installing it offers its themes", offer?.[0]?.startsWith("Dracula Theme") && offer.some((item) => /Keep the current theme/.test(item)), JSON.stringify(offer));
  await page.screenshot({ path: `${shots}/offer.png` });
  await page.keyboard.press("Enter");
  check("…and installs it", (await install) === true);
  const applied = await waitFor(page, (bg) => getComputedStyle(document.querySelector(".monaco-editor .monaco-editor-background")).backgroundColor === bg, [DRACULA_BG]);
  await sleep(500);
  const dracula = await colors();
  check("the plugin theme applies (app and editor)", applied && dracula.ui === "#282a36" && dracula.editor === DRACULA_BG, JSON.stringify(dracula));
  check("…and the syntax colors change", dracula.keyword !== before.keyword, `${dracula.keyword} vs ${before.keyword}`);
  check("…and it's saved to settings.json", /dracula/.test(settings["workbench.colorTheme"] ?? ""), JSON.stringify(settings));
  await page.screenshot({ path: `${shots}/dracula.png` });

  // --- Disable / enable -------------------------------------------------------------------
  await store((s, id) => s.setEnabled(id, false), PLUGIN_ID);
  await sleep(1500);
  const off = await colors();
  check("disabling it restores the app's colors", off.ui === before.ui, `${off.ui} vs ${before.ui}`);
  check("…and the editor's", off.editor === before.editor, `${off.editor} vs ${before.editor}`);
  check("…and the syntax colors", off.keyword === before.keyword, `${off.keyword} vs ${before.keyword}`);
  await page.screenshot({ path: `${shots}/disabled.png` });
  await store((s, id) => s.setEnabled(id, true), PLUGIN_ID);
  await sleep(1500);
  const on = await colors();
  check("enabling it again brings the theme back", on.editor === DRACULA_BG && on.ui === "#282a36" && on.keyword === dracula.keyword, JSON.stringify(on));

  // --- Uninstall, then relaunch -------------------------------------------------------------
  await store((s, id) => s.uninstall(id), PLUGIN_ID);
  await sleep(1500);
  const removed = await colors();
  check("uninstalling it removes the plugin", !(await bridge("plugin_list")).some((p) => p.manifest.id === PLUGIN_ID));
  check("…and restores the colors at once", removed.ui === before.ui && removed.editor === before.editor && removed.keyword === before.keyword, JSON.stringify(removed));
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(2500);
  await openA();
  const gone = await colors();
  check("after uninstalling, the next launch doesn't show it", gone.ui === before.ui && gone.editor === before.editor && gone.keyword === before.keyword, JSON.stringify(gone));
  await page.screenshot({ path: `${shots}/relaunched.png` });
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await bridge("plugin_uninstall", { id: PLUGIN_ID }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
