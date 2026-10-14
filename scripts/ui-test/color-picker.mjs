// End-to-end test of the editor's color picker (src/lib/colorPicker/,
// src/components/ColorPicker/):
//
//   - Swatches before the colors written in the code (hex and rgb()).
//   - The light bulb (quick fix) offers "Pick a Color…" for an empty CSS
//     color value; the picker shows its color in the code while picking
//     (typed, or dragged in the square), Enter keeps it as hex, and one
//     undo takes it out again.
//   - Clicking a swatch opens the picker on that color; Escape puts the
//     original back.
//   - On a color, "Change Color…": every format is listed (HEX, RGB, HSL,
//     OKLCH, SwiftUI, Android, Flutter, CSS name) and clicking one inserts it;
//     functional colors (rgb()) are recognized.
//   - TypeScript: an empty string for a color-named variable offers the
//     picker and the hex goes inside the quotes; no offer where there's no
//     color.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/color-picker.mjs
//
// with Vite and the bridge running (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, openFile, editorText, setCursor, realErrors, waitFor } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("color-picker");
const workspace = writeTree(path.join(tempDir("colorpicker"), "colors"), {
  "style.css": ".card {\n  color: #ff0000;\n  background-color: \n  border: 1px solid rgb(0, 128, 255);\n}\n",
  "theme.ts": 'const accentColor = "";\nconst size = 12;\nexport { accentColor, size };\n',
});

const { browser, page, errors } = await openSable(workspace, { width: 1300, height: 860 });
try {
  await sleep(1200);
  const line = async (n) => ((await editorText(page)) ?? "").split("\n")[n - 1];
  const pickerOpen = () => page.$(".color-picker").then(Boolean);
  const quickFix = async (title) => {
    await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().getAction("editor.action.quickFix").run());
    await sleep(700);
    const items = await page.$$eval(".action-widget .action-label, .action-widget .title", (nodes) => nodes.map((n) => n.textContent.trim()));
    const ok = items.some((item) => item.startsWith(title));
    if (ok) {
      await page.evaluate((title) => {
        const node = [...document.querySelectorAll(".action-widget .monaco-list-row")].find((row) => row.textContent.includes(title));
        node?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node?.click();
      }, title);
      await sleep(500);
    }
    return { ok, items };
  };

  await openFile(page, `${workspace}/style.css`);
  const swatches = await waitFor(page, () => document.querySelectorAll(".sable-color-swatch").length || null);
  check("swatches before the colors in the code", swatches === 2, swatches);

  // An empty CSS color value: the light bulb offers a picker.
  await setCursor(page, 3, 21);
  let fix = await quickFix("Pick a Color");
  check("the light bulb offers Pick a Color… for an empty color value", fix.ok, fix.items.join(" / "));
  check("…which opens the picker", await pickerOpen());
  await page.screenshot({ path: `${shots}/picker.png` });
  await page.click(".color-picker-text input", { clickCount: 3 });
  await page.keyboard.type("#22cc88");
  await sleep(400);
  check("the code shows the color while picking", (await line(3)).trim() === "background-color: #22cc88", await line(3));
  // Dragging in the square changes it too.
  const square = await page.$(".color-picker-square");
  const box = await square.boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.25, { steps: 4 });
  await page.mouse.up();
  await sleep(300);
  const dragged = (await line(3)).trim();
  check("dragging in the square updates it", /^background-color: #[0-9a-f]{6}$/.test(dragged) && dragged !== "background-color: #22cc88", dragged);
  await page.click(".color-picker-text input", { clickCount: 3 });
  await page.keyboard.type("#22cc88");
  await page.keyboard.press("Enter");
  await sleep(400);
  check("Enter keeps it as hex", (await line(3)).trim() === "background-color: #22cc88" && !(await pickerOpen()), await line(3));
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().trigger("test", "undo", null));
  await sleep(200);
  check("one undo takes it out again", (await line(3)).trim() === "background-color:", await line(3));
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().trigger("test", "redo", null));
  await sleep(400);
  check("redo puts it back (and a third swatch appears)", (await line(3)).trim() === "background-color: #22cc88" && (await page.$$(".sable-color-swatch")).length === 3, await line(3));

  // Clicking a swatch opens the picker on that color; Escape changes nothing.
  const swatch = (await page.$$(".sable-color-swatch"))[0];
  const swatchBox = await swatch.boundingBox();
  await page.mouse.click(swatchBox.x + swatchBox.width / 2, swatchBox.y + swatchBox.height / 2);
  await sleep(500);
  const original = await page.$eval(".color-picker-original", (node) => node.textContent).catch(() => null);
  check("clicking a swatch opens the picker on its color", original === "#ff0000", original);
  await page.click(".color-picker-text input", { clickCount: 3 });
  await page.keyboard.type("#0000ff");
  await sleep(300);
  check("…showing the new color in the code meanwhile", (await line(2)).trim() === "color: #0000ff;", await line(2));
  await page.keyboard.press("Escape");
  await sleep(300);
  check("Escape puts the original back", (await line(2)).trim() === "color: #ff0000;" && !(await pickerOpen()), await line(2));

  // Insert in another format.
  await setCursor(page, 2, 12);
  fix = await quickFix("Change Color");
  check("on a color, the light bulb offers Change Color…", fix.ok && fix.items.some((item) => item.includes("#ff0000")), fix.items.join(" / "));
  const rows = await page.$$eval(".color-picker-format", (rows) => rows.map((row) => row.textContent));
  check("every format is listed", ["HEX", "RGB", "HSL", "OKLCH", "SwiftUI", "Android", "Flutter", "CSS name"].every((label) => rows.some((row) => row.startsWith(label))), rows.join(" / "));
  await page.evaluate(() => [...document.querySelectorAll(".color-picker-format")].find((row) => row.textContent.startsWith("RGB")).querySelector(".color-picker-format-value").click());
  await sleep(300);
  check("clicking a format inserts it", (await line(2)).trim() === "color: rgb(255, 0, 0);", await line(2));

  // rgb() is a color too.
  await setCursor(page, 4, 28);
  fix = await quickFix("Change Color");
  check("functional colors are recognized", fix.ok && fix.items.some((item) => item.includes("#0080ff")), fix.items.join(" / "));
  await page.keyboard.press("Escape");
  await sleep(300);

  // TypeScript: an empty string for a color-named variable.
  await openFile(page, `${workspace}/theme.ts`);
  await sleep(1500);
  await setCursor(page, 1, 22);
  fix = await quickFix("Pick a Color");
  check("TypeScript: an empty string for accentColor offers the picker", fix.ok, fix.items.join(" / "));
  await page.click(".color-picker-text input", { clickCount: 3 });
  await page.keyboard.type("rgb(124 147 255)");
  await page.click(".color-picker-insert");
  await sleep(300);
  check("…and the hex goes in the string", (await line(1)) === 'const accentColor = "#7c93ff";', await line(1));
  await setCursor(page, 2, 5);
  fix = await quickFix("Pick a Color");
  check("no color offer where there's no color", !fix.ok, fix.items.join(" / "));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/after.png` });
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
}
finish();
