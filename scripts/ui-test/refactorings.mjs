// End-to-end test of Safe Delete, Change Signature and Move (and the
// Explorer's import-updating rename) in the real frontend, against the
// real backend through the bridge — Python through Rope, TypeScript
// through the TypeScript language service. No language servers run.
//
//   SABLE_TEST_ROPE_PYTHON=/path/to/venv/bin/python   (a virtualenv with `pip install rope`)
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/refactorings.mjs
//
// with Vite and the bridge running (README → Testing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSable, extraStandins, sleep, clickText, unknownCommands } from "./driver.mjs";

const python = process.env.SABLE_TEST_ROPE_PYTHON;
if (!python) throw new Error("set SABLE_TEST_ROPE_PYTHON to a virtualenv's python with Rope installed");
const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-refactoring-shots");
fs.mkdirSync(shots, { recursive: true });

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-refactorings-")));
const FILES = {
  "app/__init__.py": "",
  "app/pricing.py": `"""Pricing helpers."""
import math
from decimal import Decimal


def total(prices: list[float], tax: float, discount: float = 0) -> float:
    """Sum with tax."""
    return math.ceil((sum(prices) - discount) * (1 + tax))


# Doubles a number.
def unused_helper(x):
    return x * 2


def used_helper(x):
    return Decimal(x) + 1
`,
  "app/main.py": `from app.pricing import total, used_helper


def run():
    a = total([1, 2], 0.2)
    b = total(prices=[3], tax=0.1, discount=1)
    return a, b, used_helper(3)
`,
  "src/math.ts": `export function scaled(value: number, factor: number): number {
  return value * factor;
}

export function unused(a: string) {
  return a.length;
}
`,
  "src/app.ts": `import { scaled } from "./math";

export const a = scaled(1, 2);
`,
};
for (const [file, contents] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(workspace, file), contents);
}
const read = (file) => (fs.existsSync(path.join(workspace, file)) ? fs.readFileSync(path.join(workspace, file), "utf8") : null);

extraStandins.discover_python_interpreters = [{ path: python, label: "rope venv", version: "3", kind: "venv" }];

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

async function waitFor(page, fn, args = [], timeout = 20000, what = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const { browser, page, errors } = await openSable(workspace, { width: 1500, height: 950 });
const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
const MOD = mac ? "Meta" : "Control";

/** The focused editor's text. */
const editorText = () => page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.getValue() ?? "");

/** Put the cursor on `needle` (its `offset`-th character) in the focused editor. */
async function cursorOn(needle, offset = 1) {
  await page.evaluate(
    async (needle, offset) => {
      const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
      const model = editor.getModel();
      const index = model.getValue().indexOf(needle);
      if (index < 0) throw new Error(`no ${needle}`);
      editor.setPosition(model.getPositionAt(index + offset));
      editor.focus();
    },
    needle,
    offset,
  );
  await sleep(150);
}

async function openFile(relative) {
  await page.evaluate(async (file) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(file);
  }, path.join(workspace, relative));
  const file = path.join(workspace, relative);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const shown = await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.uri.path ?? "");
    if (shown === file) break;
    await sleep(100);
  }
  await sleep(400);
}

async function key(...keys) {
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k);
  await page.keyboard.press(keys[keys.length - 1]);
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k);
}

const dialogTitle = () => page.evaluate(() => document.querySelector(".rf-dialog .rf-title")?.textContent ?? null);
const waitDialog = (title) => waitFor(page, (title) => document.querySelector(".rf-dialog .rf-title")?.textContent === title, [title], 30000, `the ${title} dialog`);
const waitNoDialog = () => waitFor(page, () => !document.querySelector(".rf-dialog"), [], 30000, "the dialog to close");

async function setInput(selector, text) {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`no ${selector}`);
  await handle.click();
  await handle.evaluate((input) => input.select());
  if (text) await page.keyboard.type(text);
  else await page.keyboard.press("Backspace");
}

/** Apply the preview, then wait for the toast. */
async function doRefactor() {
  await page.click(".rf-preview .rf-footer button[type=submit]");
  await waitNoDialog();
  await waitFor(page, () => !!document.querySelector(".rf-toast"), [], 10000, "the toast");
}

async function undoViaToast() {
  await page.click(".rf-toast-undo");
  await waitFor(page, () => !document.querySelector(".rf-toast"), [], 10000, "undo");
  await sleep(300);
}

try {
  await sleep(1500);
  // The test's virtualenv is the project interpreter (Rope runs with it).
  await page.evaluate(async (python) => {
    const { useInterpreterStore } = await import("/src/store/interpreterStore.ts");
    useInterpreterStore.getState().select(python);
  }, python);

  // --- Safe Delete -----------------------------------------------------------------------
  await openFile("app/pricing.py");
  await cursorOn("def used_helper", 5);
  await key(mac ? "Meta" : "Alt", mac ? "Backspace" : "Delete");
  await waitDialog("Safe Delete");
  const usageRows = await page.$$eval(".rf-usage", (rows) => rows.map((row) => row.innerText.replace(/\s+/g, " ").trim()));
  check(usageRows.length === 2, `Safe Delete lists used_helper's 2 usages (${usageRows.join(" | ")})`);
  check(await page.evaluate(() => document.querySelector(".rf-group-header")?.innerText.includes("main.py")), "usages grouped under main.py");
  check(await page.evaluate(() => !!document.querySelector(".rf-usage mark")), "usage previews highlight the name");
  await page.screenshot({ path: path.join(shots, "1-safe-delete-usages.png") });
  await clickText(page, "View Usages", "button");
  await waitNoDialog();
  await waitFor(page, () => document.body.innerText.includes("2 usages of used_helper"), [], 5000, "the Usages panel");
  check(true, "View Usages shows them in the Usages panel");
  check((await editorText()).includes("def used_helper"), "nothing deleted");

  // No usages: deleted straight away, with its comment; Undo puts it back.
  await cursorOn("def unused_helper", 5);
  await key(mac ? "Meta" : "Alt", mac ? "Backspace" : "Delete");
  await waitFor(page, () => !!document.querySelector(".rf-toast"), [], 20000, "the toast");
  let text = await editorText();
  check(!text.includes("unused_helper") && !text.includes("Doubles"), "an unused function is deleted at once, with its comment");
  check(text.includes("(1 + tax))\n\n\ndef used_helper"), "blank lines between definitions kept");
  await page.screenshot({ path: path.join(shots, "2-safe-delete-toast.png") });
  await undoViaToast();
  check((await editorText()) === FILES["app/pricing.py"], "Undo restores it");

  // --- Change Signature -------------------------------------------------------------------
  await cursorOn("def total", 5);
  await key(MOD, "F6");
  await waitDialog("Change Signature");
  check((await page.$$eval(".rf-param-row:not(.rf-param-head)", (rows) => rows.length)) === 3, "the dialog lists total's 3 parameters");
  await setInput(".rf-fields .rf-field:nth-child(1) input", "total_price");
  await setInput(".rf-fields .rf-field:nth-child(2) input", "int");
  const row = (n) => `.rf-params .rf-param-row:not(.rf-param-head):nth-child(${n + 1})`;
  await setInput(`${row(2)} input[aria-label="Parameter name"]`, "rate");
  await page.click(`${row(2)} button[title^="Move up"]`);
  await page.click(`${row(3)} button[title="Remove"]`);
  await clickText(page, "Add parameter", "button");
  await sleep(100);
  await setInput(`${row(3)} input[aria-label="Parameter name"]`, "currency");
  await setInput(`${row(3)} input[aria-label="Type"]`, "str");
  await setInput(`${row(3)} input[aria-label="Default value"]`, '"EUR"');
  const preview = await page.$eval(".rf-signature-preview", (element) => element.textContent);
  check(preview === 'def total_price(rate: float, prices: list[float], currency: str = "EUR") -> int', `live signature preview: ${preview}`);
  await page.screenshot({ path: path.join(shots, "3-change-signature.png") });
  await page.click(".rf-change-signature .rf-footer button[type=submit]");
  await waitDialog("Refactoring Preview");
  const previewText = await page.$eval(".rf-dialog", (element) => element.innerText);
  check(previewText.includes("main.py") && previewText.includes("pricing.py"), "the preview lists both files");
  check(previewText.includes("total_price(0.2, [1, 2])"), "the preview shows the reordered call");
  check(previewText.includes("discount") && !!(await page.$(".rf-conflicts")), "the preview reports that the body still uses the removed parameter");
  await page.screenshot({ path: path.join(shots, "4-preview-change-signature.png") });
  await doRefactor();
  const main = read("app/main.py");
  check(main.includes("from app.pricing import total_price, used_helper"), "the import is renamed");
  check(main.includes("a = total_price(0.2, [1, 2])"), "positional call reordered");
  check(main.includes("b = total_price(rate=0.1, prices=[3])"), "keyword call: renamed, removed argument dropped");
  text = await editorText();
  check(text.includes('def total_price(rate: float, prices: list[float], currency: str = "EUR") -> int:'), "the declaration is rewritten in the open editor");
  check(text.includes("(1 + rate))"), "the renamed parameter's uses follow");
  await undoViaToast();
  check(read("app/main.py") === FILES["app/main.py"], "Undo restores the file that wasn't open");
  check((await editorText()) === FILES["app/pricing.py"], "Undo restores the open file");

  // --- Move ---------------------------------------------------------------------------------
  await cursorOn("def used_helper", 5);
  await key("F6");
  await waitDialog("Move used_helper");
  await waitFor(page, () => document.querySelectorAll(".rf-pick").length > 0, [], 10000, "the file list");
  check(await page.evaluate(() => [...document.querySelectorAll(".rf-pick")].some((pick) => pick.innerText.includes("main.py"))), "the picker lists workspace Python files");
  await page.keyboard.type("app/helpers.py");
  await waitFor(page, () => document.querySelector(".rf-pick.active")?.innerText.includes("Create app/helpers.py"), [], 5000, "the create entry");
  check(true, "typing a new path offers to create it");
  await page.screenshot({ path: path.join(shots, "5-move-picker.png") });
  await page.keyboard.press("Enter");
  await waitDialog("Refactoring Preview");
  check(await page.evaluate(() => [...document.querySelectorAll(".rf-file-header")].some((header) => header.innerText.includes("helpers.py") && header.innerText.toLowerCase().includes("new"))), "the preview shows the new file");
  await page.screenshot({ path: path.join(shots, "6-preview-move.png") });
  await doRefactor();
  const helpers = read("app/helpers.py");
  check(helpers?.includes("def used_helper(x):") && helpers.includes("from decimal import Decimal"), "the function moved with the import it needs");
  check(read("app/main.py").includes("from app.helpers import used_helper"), "its user imports it from the new module");
  const source = await page.evaluate(async (file) => (await import("/src/lib/editorRegistry.ts")).getModelValue(file), path.join(workspace, "app/pricing.py"));
  check(!source.includes("def used_helper") && !source.includes("Decimal"), "gone from the source, and its now-unused import too");
  await undoViaToast();
  check(read("app/helpers.py") === null, "Undo deletes the created module");
  check(read("app/main.py") === FILES["app/main.py"], "Undo restores the importer");

  // --- ⌃T and the light bulb --------------------------------------------------------------------
  await openFile("app/pricing.py");
  await cursorOn("def total", 5);
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().getAction("editor.action.refactor").run());
  await waitFor(page, () => document.body.innerText.includes("Change Signature…"), [], 8000, "Refactor This");
  const menu = await page.evaluate(() => document.querySelector(".action-widget")?.innerText ?? document.body.innerText);
  check(menu.includes("Safe Delete…") && menu.includes("Change Signature…") && menu.includes("Move…"), "Refactor This (⌃T) offers all three");
  await page.screenshot({ path: path.join(shots, "7-refactor-this.png") });
  await page.keyboard.press("Escape");

  // --- TypeScript (the TypeScript language service, no server) --------------------------------------
  await openFile("src/math.ts");
  await cursorOn("scaled", 2);
  await key(MOD, "F6");
  await waitDialog("Change Signature");
  check((await page.$eval(".rf-badge", (badge) => badge.textContent)) === "TypeScript", "TypeScript signatures use the TypeScript engine");
  await page.click(`${row(1)} button[title^="Move down"]`);
  await page.click(".rf-change-signature .rf-footer button[type=submit]");
  await waitDialog("Refactoring Preview");
  await doRefactor();
  check(read("src/app.ts").includes("scaled(2, 1)"), "TypeScript call sites reordered");
  check((await editorText()).includes("scaled(factor: number, value: number)"), "TypeScript declaration reordered");
  await undoViaToast();
  check(read("src/app.ts") === FILES["src/app.ts"], "TypeScript change undone");
  await cursorOn("unused", 2);
  await key("F6");
  await waitDialog("Move unused");
  await page.keyboard.type("src/util.ts");
  await waitFor(page, () => document.querySelector(".rf-pick.active")?.innerText.includes("Create src/util.ts"), [], 5000, "the create entry");
  await page.keyboard.press("Enter");
  await waitDialog("Refactoring Preview");
  await doRefactor();
  check(read("src/util.ts")?.includes("export function unused"), "TypeScript Move to a new file");
  await undoViaToast();

  // --- Explorer: rename with import updates, Safe Delete a file ------------------------------------------
  await clickText(page, "app", ".tree-row-name").catch(() => {});
  await waitFor(page, () => [...document.querySelectorAll(".tree-row-name")].some((name) => name.textContent === "pricing.py"), [], 5000, "the app folder");
  const pricingRow = await page.evaluateHandle(() => [...document.querySelectorAll(".tree-row")].find((row) => row.innerText.trim() === "pricing.py"));
  await pricingRow.asElement().click({ button: "right" });
  await clickText(page, "Rename");
  await page.waitForSelector(".tree-rename-input");
  await page.$eval(".tree-rename-input", (input) => input.select());
  await page.keyboard.type("prices.py");
  await page.keyboard.press("Enter");
  await waitDialog("Refactoring Preview");
  check(await page.evaluate(() => document.querySelector(".rf-move-row")?.innerText.includes("prices.py")), "renaming a module previews the rename");
  check(await page.evaluate(() => document.body.innerText.includes("Rename Only")), "…with Rename Only as the alternative");
  await page.screenshot({ path: path.join(shots, "8-preview-rename-file.png") });
  await page.click(".rf-preview .rf-footer button[type=submit]");
  await waitNoDialog();
  await sleep(300);
  check(read("app/prices.py") !== null && read("app/pricing.py") === null, "the file is renamed");
  check(read("app/main.py").includes("from app.prices import total, used_helper"), "its importer is updated");
  check(await page.evaluate(() => [...document.querySelectorAll(".editor-tab-name")].some((tab) => tab.innerText.includes("prices.py"))), "the open tab follows the rename");

  const mainRow = await page.evaluateHandle(() => [...document.querySelectorAll(".tree-row")].find((row) => row.innerText.trim() === "prices.py"));
  await mainRow.asElement().click({ button: "right" });
  await clickText(page, "Safe Delete…");
  await waitDialog("Safe Delete");
  check(await page.evaluate(() => document.querySelectorAll(".rf-usage").length === 1), "Safe Delete of a module lists its importer");
  await page.screenshot({ path: path.join(shots, "9-safe-delete-file.png") });
  await clickText(page, "Cancel", "button");
  await waitNoDialog();
  check(read("app/prices.py") !== null, "Cancel keeps the file");

  // A light theme: the dialogs follow it.
  await page.evaluate(async () => {
    const { useSettingsStore } = await import("/src/store/settingsStore.ts");
    useSettingsStore.getState().set("workbench.colorTheme", "catppuccin-latte");
  });
  await openFile("src/math.ts");
  await cursorOn("scaled", 2);
  await key(MOD, "F6");
  await waitDialog("Change Signature");
  await page.click(`${row(1)} button[title^="Move down"]`);
  await page.screenshot({ path: path.join(shots, "10-light-change-signature.png") });
  await page.click(".rf-change-signature .rf-footer button[type=submit]");
  await waitDialog("Refactoring Preview");
  await page.screenshot({ path: path.join(shots, "11-light-preview.png") });
  check(await page.evaluate(() => getComputedStyle(document.querySelector(".rf-dialog")).backgroundColor !== "rgb(30, 30, 34)"), "dialogs follow the theme");
  await clickText(page, "Cancel", "button");
  await waitNoDialog();
  check(read("src/app.ts") === FILES["src/app.ts"], "Cancel in the preview changes nothing");

  // Undo Last Refactoring (the palette's / a key's): the rename goes back, imports too.
  await page.evaluate(async () => (await import("/src/lib/shortcuts.ts")).runCommandById("sable.refactor.undo"));
  await waitFor(page, (file) => document.querySelector(".status-bar, footer")?.innerText.includes("Undid") || false, [], 10000, "the undo").catch(() => {});
  await sleep(500);
  check(read("app/pricing.py") !== null && read("app/prices.py") === null, "Undo renames the file back");
  check(read("app/main.py") === FILES["app/main.py"], "…and puts its importer back");

  check(!unknownCommands.has("python_rope_refactor"), "the bridge serves python_rope_refactor");
  // (The favicon's 404; no language servers here.)
  const relevant = errors.filter((error) => !/language server|Failed to load resource|ResizeObserver/i.test(error));
  check(relevant.length === 0, `no page errors (${relevant.join(" | ")})`);
} catch (error) {
  failures.push(String(error));
  console.log(`  FAIL ${error.stack ?? error}`);
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
console.log(`\nscreenshots: ${shots}`);
if (failures.length > 0) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log("all passed");
