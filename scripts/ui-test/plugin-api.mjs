// End-to-end test of the plugin API in the real host, through real plugins
// from plugins/ (Number Tools, Clock, Regex Search, Selection Stats, Case
// Converter), installed into the bridge's plugins folder:
//
//   - all of them start; Clock's time is in the status bar (statusBar.set)
//   - hover: Number Tools shows 255 in other bases (registerHover)
//   - plugin keybindings: ctrl+alt+= / ctrl+alt+- increment and decrement
//     the number at the cursor (manifest keybindings → editor.applyEdits)
//   - selection events: Selection Stats counts the selection
//     (onDidChangeSelection → status bar), and clears it when it's gone
//   - Regex Search: showInputBox asks for a pattern, the matches come in a
//     quick pick (showQuickPick), choosing one selects it (setSelection)
//   - rename suggestions: F2 on a name lists Case Converter's other cases
//     (registerRenameSuggestions)
//   - storage: Clock's 12/24-hour choice survives a plugin reload
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/plugin-api.mjs
//
// with Vite and a fresh bridge running (README → Testing, or run-all.mjs):
// it installs plugins into the bridge's SABLE_UI_PLUGINS_DIR. ~35 seconds.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, palette, combo, waitFor, setCursor, realErrors, tauriStandins, PLUGINS } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("plugin-api");
const workspace = writeTree(path.join(tempDir("plugin-api"), "ws"), {
  // Line 1 is 11 characters long; \d+ matches 255, 41, 10, 20 and 30.
  "nums.txt": "values: 255\ncount = 41\nlist 10 20 30\n",
  "names.ts": "export const userProfileId = 1;\nconsole.log(userProfileId);\n",
});
const IDS = ["number-tools", "clock", "find-regex", "selection-stats", "case-converter"];

let settings = {};
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 850,
  init: tauriStandins({ "plugin:dialog|message": "Yes", "plugin:dialog|ask": true, "plugin:app|version": "0.3.6" }),
});
const statusItems = () => texts(page, ".status-bar-plugin");
const clockText = async () => (await statusItems()).find((text) => /\d:\d\d/.test(text)) ?? "";
try {
  await sleep(1500);
  for (const id of IDS) {
    await page.evaluate((folder) => import("/src/store/pluginStore.ts").then((m) => m.usePluginStore.getState().installFromFolder(folder)), path.join(PLUGINS, id));
  }
  const states = await waitFor(page, async (ids) => {
    const { states } = (await import("/src/store/pluginStore.ts")).usePluginStore.getState();
    return ids.every((id) => states[id] === "running") && states;
  }, [IDS]);
  check("the plugins are running", Boolean(states), JSON.stringify(await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states)));
  await waitFor(page, () => [...document.querySelectorAll(".status-bar-plugin")].some((item) => /\d:\d\d/.test(item.textContent)));
  check("clock in the status bar", /^\d{1,2}:\d{2}/.test((await clockText()).trim()), (await statusItems()).join(" | "));

  if (!(await page.$(".sidebar"))) await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
  await clickText(page, "nums.txt");
  await waitFor(page, () => [...document.querySelectorAll(".view-line")].some((line) => line.textContent.includes("255")));
  await sleep(500);
  const lineText = (n) => page.evaluate(async (n) => (await import("/src/lib/editorRegistry.ts")).getEditor().getModel().getLineContent(n), n);

  // --- Hover on 255 (registerHover) ----------------------------------------------------------------
  const box = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".view-line span span")].find((s) => s.textContent.includes("255"));
    const range = document.createRange();
    const node = span.firstChild;
    const index = node.textContent.indexOf("255");
    range.setStart(node, index + 1);
    range.setEnd(node, index + 2);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x - 30, box.y);
  await sleep(200);
  await page.mouse.move(box.x, box.y);
  const hover = (await waitFor(page, () => [...document.querySelectorAll(".monaco-hover-content")].map((el) => el.textContent).find((text) => /0xff/i.test(text)), [], { timeout: 6000 })) ?? "";
  check("hover shows 255 in other bases", /0xff/i.test(hover) && /0b11111111/.test(hover) && /0o377/.test(hover), hover.slice(0, 160));
  await page.mouse.move(5, 840);
  await page.keyboard.press("Escape");

  // --- Increment/decrement via the plugin's keyboard shortcuts (keybindings → applyEdits) --------------
  await setCursor(page, 2, 11); // end of "count = 41"
  await combo(page, ["Control", "Alt"], "Equal", 800);
  check("ctrl+alt+= increments the number (plugin shortcut → applyEdits)", (await lineText(2)) === "count = 42", await lineText(2));
  await combo(page, ["Control", "Alt"], "Equal", 800);
  check("…again (the cursor stays after the number)", (await lineText(2)) === "count = 43", await lineText(2));
  await combo(page, ["Control", "Alt"], "Minus", 800);
  check("ctrl+alt+- decrements it", (await lineText(2)) === "count = 42", await lineText(2));

  // --- Selection stats (onDidChangeSelection): select line 1 -------------------------------------
  await setCursor(page, 1, 1);
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  const stats = await waitFor(page, () => [...document.querySelectorAll(".status-bar-plugin")].map((item) => item.textContent).find((text) => /chars?/.test(text)), [], { timeout: 4000 });
  check("selection stats from selection events", /11 chars · 2 words · 1 line/.test(stats ?? ""), (await statusItems()).join(" | "));
  await page.keyboard.press("ArrowRight");
  const cleared = await waitFor(page, () => ![...document.querySelectorAll(".status-bar-plugin")].some((item) => /chars?/.test(item.textContent)), [], { timeout: 4000 });
  check("…and they go when nothing is selected", Boolean(cleared), (await statusItems()).join(" | "));

  // --- Regex search: showInputBox → quick pick → setSelection -------------------------------------
  await page.mouse.move(5, 840);
  await palette(page, "Regex Search: Find with Regex", 700);
  const placeholder = await page.$eval(".palette-input", (input) => input.placeholder).catch(() => "");
  check("showInputBox asks for a pattern", /\\bget\\w\+/.test(placeholder), placeholder);
  await page.keyboard.type("\\d+");
  await sleep(200);
  await page.keyboard.press("Enter");
  await sleep(900);
  const matches = await texts(page, "[data-index]");
  check("matches listed in a quick pick", matches.length === 5 && matches.some((m) => m.includes("255")), matches.join(" | "));
  const pickPlaceholder = await page.$eval(".palette-input", (input) => input.placeholder).catch(() => "");
  check("…with the quick pick's placeholder", pickPlaceholder.startsWith("5 matches of /\\d+/g"), pickPlaceholder);
  await page.keyboard.type("10");
  await sleep(300);
  await page.keyboard.press("Enter");
  await sleep(700);
  const selected = await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    const selection = editor.getSelection();
    return { text: editor.getModel().getValueInRange(selection), line: selection.startLineNumber };
  });
  check("choosing a match selects it (setSelection)", selected.text === "10" && selected.line === 3, JSON.stringify(selected));
  await page.screenshot({ path: `${shots}/api-1.png` });

  // --- Rename suggestions (registerRenameSuggestions) ------------------------------------------------
  await clickText(page, "names.ts");
  await waitFor(page, async () => (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.uri.path.endsWith("names.ts"));
  await sleep(1500);
  await setCursor(page, 1, 16); // in userProfileId
  await page.keyboard.press("F2");
  const candidates = await waitFor(
    page,
    () => {
      const list = [...document.querySelectorAll(".rename-box .rename-candidate, .rename-box .new-name-candidate")].map((el) => el.textContent.trim());
      return list.length ? list : null;
    },
    [],
    { timeout: 8000 },
  );
  check("F2 lists the name in Case Converter's other cases", JSON.stringify(candidates) === JSON.stringify(["UserProfileId", "user_profile_id", "USER_PROFILE_ID"]), JSON.stringify(candidates));
  await page.keyboard.press("Escape");
  await sleep(300);

  // --- Storage: Clock's 12/24-hour choice survives a plugin reload --------------------------------
  const before = await clockText();
  await palette(page, "Clock: Toggle 12/24-Hour Time", 600);
  const toggled = await clockText();
  check("the clock command toggles its format", toggled !== before && toggled !== "", `${before} → ${toggled}`);
  await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().reload("clock"));
  await waitFor(page, async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states.clock === "running");
  await sleep(800);
  const after = await clockText();
  const stored = await page.evaluate(() => localStorage.getItem("sable.plugin.clock"));
  check("plugin storage persists across a reload", stored !== null && JSON.parse(stored).hour12 !== undefined && after === toggled, `${before} → ${toggled} → ${after} (reloaded), stored ${stored}`);

  // Auto save is on by default: the plugin's edits reached the file.
  const saved = fs.readFileSync(path.join(workspace, "nums.txt"), "utf8");
  check("the plugin's edits are saved with the file (auto save)", saved === "values: 255\ncount = 42\nlist 10 20 30\n", JSON.stringify(saved));
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
}
finish();
