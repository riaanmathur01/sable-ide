// End-to-end test of rebindable keyboard shortcuts and Vim mode:
//
//   - ⌘B toggles the sidebar (a default, through the shortcut dispatcher).
//   - Settings → Keyboard Shortcuts lists the commands; "Toggle sidebar"
//     shows ⌘B; clicking its keys and pressing ⌃⌥K rebinds it: written to
//     keybindings.json (beside settings.json — here a temp dir, via the
//     settings_path stand-in) as the new key plus the default's removal.
//     ⌘B stops working, ⌃⌥K works; Reset brings ⌘B back (file emptied).
//   - keybindings.json written by hand (JSONC: comments, trailing commas),
//     then reloaded: a palette command (toggle-vim) and an editor action
//     (editor.action.deleteLines) on new keys.
//   - Vim mode (switched on by that palette shortcut, saved to settings):
//     the mode line, dd, u, A (insert mode shown), :w saves; off again.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/keybindings-vim.mjs
//
// with Vite and the bridge running (README → Testing, or run-all.mjs).
// ~25 seconds.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, combo, setCursor, editorText, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("keybindings-vim");
const root = tempDir("keys-vim");
const workspace = writeTree(path.join(root, "ws"), { "abc.txt": "alpha\nbravo\ncharlie\ndelta\necho\n" });
// settings.json's folder: keybindings.json goes beside it.
const config = path.join(root, "config");
fs.mkdirSync(config);
const keybindingsFile = path.join(config, "keybindings.json");

let settings = {};
extraStandins.settings_path = path.join(config, "settings.json");
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};
/** keybindings.json, parsed (its // comments dropped). */
const file = () => JSON.parse(fs.readFileSync(keybindingsFile, "utf8").replace(/^\s*\/\/.*$/gm, ""));

const { browser, page, errors } = await openSable(workspace, { width: 1400, height: 850 });
try {
  await sleep(1500);
  const sidebar = async () => Boolean(await page.$(".sidebar"));
  const lines = async () => ((await editorText(page)) ?? "").split("\n").join("|");
  const sidebarRow = () => page.evaluateHandle(() => [...document.querySelectorAll(".shortcuts-row")].find((row) => row.querySelector(".shortcuts-title span")?.textContent === "Toggle sidebar"));

  // --- Defaults through the dispatcher ---------------------------------------------------------
  const before = await sidebar();
  await combo(page, ["Meta"], "KeyB");
  check("⌘B toggles the sidebar (default)", (await sidebar()) !== before);
  await combo(page, ["Meta"], "KeyB");

  // --- Settings → Keyboard Shortcuts: rebind "Toggle sidebar" by pressing a key ----------------------
  await combo(page, ["Meta"], "Comma", 800);
  await clickText(page, "Keyboard Shortcuts", ".settings-nav button");
  await sleep(500);
  const rows = await page.$$(".shortcuts-row");
  check("the shortcut editor lists commands", rows.length > 60, `${rows.length} rows`);
  await page.click(".shortcuts-toolbar input");
  await page.keyboard.type("Toggle sidebar");
  await sleep(300);
  const keysText = await (await sidebarRow()).evaluate((row) => row?.querySelector(".shortcuts-keys")?.textContent ?? null);
  check("its row shows ⌘B", keysText === "⌘B", keysText);
  await (await (await sidebarRow()).asElement().$(".shortcuts-keys")).click();
  await sleep(200);
  check("clicking the keys records a new shortcut", Boolean(await page.$(".shortcuts-recorder")));
  await page.screenshot({ path: `${shots}/keys-1.png` });
  await combo(page, ["Control", "Alt"], "KeyK", 600);
  const written = fs.existsSync(keybindingsFile) ? file() : null;
  check(
    "keybindings.json (beside settings.json) gets the new key, and the default removed",
    Array.isArray(written) &&
      written.some((e) => e.command === "workbench.action.toggleSidebarVisibility" && e.key === "ctrl+alt+k") &&
      written.some((e) => e.command === "-workbench.action.toggleSidebarVisibility" && e.key === "mod+b"),
    JSON.stringify(written),
  );
  const shownNow = await (await sidebarRow()).evaluate((row) => row?.querySelector(".shortcuts-keys")?.textContent ?? null);
  check("the row shows the new key, marked modified", shownNow === "⌃⌥K" && (await (await sidebarRow()).evaluate((row) => row.classList.contains("modified"))), shownNow);
  const s1 = await sidebar();
  await combo(page, ["Meta"], "KeyB");
  check("⌘B no longer does it", (await sidebar()) === s1);
  await combo(page, ["Control", "Alt"], "KeyK");
  check("⌃⌥K does", (await sidebar()) !== s1);
  await combo(page, ["Control", "Alt"], "KeyK");
  // Reset.
  await (await (await sidebarRow()).asElement().$('button[title^="Back to the default"]')).click();
  await sleep(400);
  const s2 = await sidebar();
  await combo(page, ["Meta"], "KeyB");
  check("Reset brings ⌘B back (and empties keybindings.json)", (await sidebar()) !== s2 && file().length === 0, JSON.stringify(file()));
  await combo(page, ["Meta"], "KeyB");

  // --- A palette command and an editor action, from a hand-written keybindings.json ------------------
  fs.writeFileSync(
    keybindingsFile,
    `// mine\n[\n  { "key": "ctrl+alt+j", "command": "toggle-vim" },\n  { "key": "ctrl+alt+l", "command": "editor.action.deleteLines" }, // trailing comma ok\n]\n`,
  );
  await page.evaluate(async () => (await import("/src/lib/shortcuts.ts")).useShortcutStore.getState().load());
  await sleep(500);
  check("the hand-written file loads (comments and trailing comma)", (await page.evaluate(async () => {
    const state = (await import("/src/lib/shortcuts.ts")).useShortcutStore.getState();
    return state.error === null && state.user.length === 2;
  })) === true);
  if (!(await sidebar())) await combo(page, ["Meta"], "KeyB");
  await clickText(page, "abc.txt");
  await sleep(2000);
  await setCursor(page, 1, 1);
  await combo(page, ["Control", "Alt"], "KeyL");
  check("an editor action bound in keybindings.json", (await lines()).startsWith("bravo|charlie"), await lines());
  await combo(page, ["Meta"], "KeyZ");
  check("…undone", (await lines()).startsWith("alpha|bravo"), await lines());

  // --- Vim, switched on by the palette command's new shortcut ------------------------------------
  await combo(page, ["Control", "Alt"], "KeyJ", 1200);
  check("a palette command bound to a key (Toggle Vim Mode)", settings["editor.vim"] === true && Boolean(await page.$(".vim-status")), JSON.stringify(settings));
  await setCursor(page, 3, 1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.type("dd");
  await sleep(300);
  check("vim: gg dd deletes the first line", (await lines()).startsWith("bravo|charlie"), await lines());
  await page.keyboard.type("u");
  await sleep(300);
  check("vim: u undoes", (await lines()).startsWith("alpha|bravo"), await lines());
  await page.keyboard.type("A");
  await sleep(200);
  const insertStatus = await page.$eval(".vim-status", (el) => el.textContent);
  await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  await sleep(200);
  check("vim: A appends in insert mode (shown in the mode line)", (await lines()).startsWith("alpha!|") && /insert/i.test(insertStatus), `${await lines()} / ${insertStatus}`);
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  await sleep(800);
  const saved = fs.readFileSync(path.join(workspace, "abc.txt"), "utf8");
  check("vim: :w saves", saved === "alpha!\nbravo\ncharlie\ndelta\necho\n", JSON.stringify(saved));
  await page.screenshot({ path: `${shots}/vim-1.png` });
  await combo(page, ["Control", "Alt"], "KeyJ", 500);
  // (settings.json keeps only non-default values: off drops the key.)
  check("vim off again: no mode line, setting saved off", !(await page.$(".vim-status")) && !settings["editor.vim"], JSON.stringify(settings));

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
