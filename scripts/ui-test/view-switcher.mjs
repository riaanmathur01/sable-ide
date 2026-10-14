// End-to-end test of the three View Switcher styles (workbench.viewSwitcher):
//
//   - Activity bar (the default): one button per view (+ Plugins and
//     Settings), switches views, clicking the active view hides the
//     sidebar and clicking again brings it back.
//   - Hamburger menu: the activity bar goes, the sidebar comes back (even
//     if it was hidden) with a Views menu listing every view; choosing one
//     switches to it.
//   - Icons in the sidebar header: the views' icons sit in the header.
//   - The choice is saved to settings.json.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/view-switcher.mjs
//
// with Vite and the bridge running (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, palette, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("view-switcher");
const workspace = writeTree(path.join(tempDir("switcher"), "mws"), { "README.md": "# Switcher\n", "src/a.ts": "export const a = 1;\n" });

let settings = {};
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

const { browser, page, errors } = await openSable(workspace, { width: 1400, height: 850 });
try {
  await sleep(1500);
  const sidebarTitle = () => page.$eval(".sidebar-title", (element) => element.textContent.trim()).catch(() => null);
  const views = (await page.evaluate(async () => (await import("/src/components/ActivityBar/views.ts")).VIEWS.map((view) => view.label)));

  // --- Activity bar (the default) -----------------------------------------------------------
  const barButtons = await page.$$(".activity-bar .activity-bar-item");
  check("activity bar shown by default, a button per view + Plugins + Settings", barButtons.length === views.length + 2, `${barButtons.length} buttons for ${views.join(", ")}`);
  check("no view icons in the sidebar header", (await page.$$(".sidebar-header .sidebar-actions button[title^='Search']")).length === 0);
  await page.click('.activity-bar-item[title^="Search"]');
  await sleep(300);
  check("activity bar switches views", (await sidebarTitle()) === "Search", await sidebarTitle());
  await page.click('.activity-bar-item[title^="Search"]');
  await sleep(300);
  check("clicking the active view hides the sidebar", (await page.$(".sidebar")) === null && (await page.$(".activity-bar")) !== null);
  await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
  check("…and clicking a view shows it again", (await sidebarTitle())?.toLowerCase() === "mws", await sidebarTitle());
  await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
  check("activity bar hides the explorer", (await page.$(".sidebar")) === null);

  // --- Hamburger menu ---------------------------------------------------------------------------
  await palette(page, "View: Hamburger Menu");
  check("hamburger: activity bar gone", (await page.$(".activity-bar")) === null);
  check("hamburger: the hidden sidebar comes back, with its Views menu", (await page.$(".sidebar")) !== null && (await page.$('.sidebar-header button[title="Views"]')) !== null);
  await page.click('.sidebar-header button[title="Views"]');
  await sleep(300);
  const menu = await texts(page, ".view-menu .view-menu-label");
  check("hamburger menu lists the views, Plugins and Settings", menu.join() === [...views, "Plugins", "Settings"].join(), menu.join());
  await page.screenshot({ path: `${shots}/hamburger.png` });
  await clickText(page, "Source Control", ".view-menu-label");
  await sleep(300);
  check("hamburger switches views (and closes the menu)", (await sidebarTitle()) === "Source Control" && (await page.$(".view-menu")) === null, await sidebarTitle());
  check("the choice is saved to settings.json (menu)", settings["workbench.viewSwitcher"] === "menu", JSON.stringify(settings));

  // --- Back to the activity bar, hide, then sidebar-header icons -----------------------------
  await palette(page, "View: Activity Bar");
  check("activity bar again", (await page.$(".activity-bar")) !== null);
  await page.click('.activity-bar-item[title^="Source Control"]');
  await sleep(300);
  check("hidden again from the activity bar", (await page.$(".sidebar")) === null);
  await palette(page, "View: Icons in the Sidebar Header");
  const headerIcons = await page.$$(".sidebar-header .sidebar-actions .icon-button");
  check("sidebar-header icons: the sidebar comes back with the views' icons", (await page.$(".activity-bar")) === null && (await page.$(".sidebar")) !== null && headerIcons.length >= 6, `${headerIcons.length} icons`);
  await page.click('.sidebar-header .sidebar-actions button[title^="Search"]');
  await sleep(300);
  check("a header icon switches views", (await sidebarTitle()) === "Search", await sidebarTitle());
  check("the choice is saved to settings.json (sidebarHeader)", settings["workbench.viewSwitcher"] === "sidebarHeader", JSON.stringify(settings));
  await page.screenshot({ path: `${shots}/sidebar-header.png` });

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
}
finish();
