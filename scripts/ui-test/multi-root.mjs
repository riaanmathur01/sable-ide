// End-to-end test of multi-root workspaces, window state, and a theme plugin:
//
//   - Add Folder to Workspace: the Explorer shows each folder as a root
//     under "Untitled (Workspace)"; the status bar shows a file relative to
//     its folder; quick open (⌘P) and Find in Files cover every folder.
//   - Source Control: one repository per folder (a picker), following the
//     active file's folder, with only that repository's changes.
//   - .code-workspace: Save Workspace As writes relative folders; opening a
//     single folder leaves one; Open Workspace from File restores both;
//     the window remembers its workspace (sable.windows in localStorage).
//   - A root folder's context menu: Open in New Window (hands the folder to
//     the new window through localStorage) and Remove Folder from Workspace.
//   - ⇧⌘N opens a new, empty window.
//   - A theme plugin (Dracula, copied from plugins/): its themes are listed,
//     choosing one colors the app, the editor and the syntax, and Settings'
//     theme picker groups plugin themes.
//
// Fixtures (temp dir): git repos alpha/ (src/a.ts, committed then changed;
// notes.md with "needle-in-alpha") and beta/ (lib/b.py with "needle-in-beta";
// an untracked new.txt).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/multi-root.mjs
//
// with Vite and a fresh bridge running (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openSable, sleep, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, copyFolder, combo, realErrors, waitFor, bridge, PLUGINS } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("multi-root");
const base = tempDir("multiroot");
const alpha = path.join(base, "alpha");
const beta = path.join(base, "beta");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Sable Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Sable Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
for (const [repo, files] of [
  [alpha, { "src/a.ts": "export const a = 1;\n", "notes.md": "the needle-in-alpha is here\n" }],
  [beta, { "lib/b.py": "x = 'needle-in-beta'\n" }],
]) {
  writeTree(repo, files);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
}
fs.writeFileSync(path.join(alpha, "src/a.ts"), "export const a = 2;\nexport function twice(n: number) {\n  return n * 2;\n}\n");
fs.writeFileSync(path.join(beta, "new.txt"), "new\n");
const pluginId = "vscode.dracula-theme.theme-dracula";
const themePlugin = copyFolder(path.join(PLUGINS, pluginId), path.join(base, "theme-plugin"));

let newWindowQuery;
extraStandins.new_window = (args) => {
  newWindowQuery = args.query;
  return "window-2";
};

const { browser, page, errors } = await openSable(alpha, { width: 1400, height: 880, pollEvents: true });
try {
  await sleep(1500);
  const ws = () =>
    page.evaluate(async () => {
      const s = (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState();
      return { folders: s.folders, root: s.rootPath, file: s.workspaceFile };
    });

  check("opens the first folder", (await ws()).root === alpha, JSON.stringify(await ws()));
  await page.evaluate(async (beta) => (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState().addFolder(beta), beta);
  await sleep(600);
  check("Add Folder to Workspace adds it", JSON.stringify((await ws()).folders) === JSON.stringify([alpha, beta]), JSON.stringify(await ws()));
  const roots = await texts(page, ".tree-row.root .tree-row-name");
  check("Explorer shows each folder as a root", roots.length === 2 && /alpha/i.test(roots[0]) && /beta/i.test(roots[1]), roots.join(", "));
  const header = await page.$eval(".sidebar", (element) => element.innerText.split("\n")[0]);
  check("Explorer header names the workspace", /Untitled \(Workspace\)/i.test(header), header);

  // A file in the second folder.
  await page.evaluate(async (path) => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openFile(path), `${beta}/lib/b.py`);
  await sleep(1200);
  const status = await page.$eval(".status-bar", (element) => element.innerText);
  check("status bar shows the file relative to its folder", status.includes("beta/lib/b.py"), status.replace(/\n/g, " | "));

  // Quick open lists both folders' files.
  await combo(page, ["Meta"], "KeyP", 500);
  await page.keyboard.type("b.py");
  await sleep(500);
  const items = await texts(page, ".palette-item");
  check("quick open finds files in every folder", items.some((item) => item.includes("b.py") && item.includes("beta/lib/b.py")), items.slice(0, 4).join(" / "));
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("a.ts");
  await sleep(500);
  const alphaItems = await texts(page, ".palette-item");
  check("…including the first folder's", alphaItems.some((item) => item.includes("a.ts") && item.includes("alpha/src/a.ts")), alphaItems.slice(0, 4).join(" / "));
  await page.keyboard.press("Escape");

  // Find in files across folders.
  await page.evaluate(async () => {
    const search = (await import("/src/store/searchStore.ts")).useSearchStore.getState();
    search.setQuery("needle-in");
    await search.runSearch();
  });
  const found =
    (await waitFor(page, async () => {
      const paths = (await import("/src/store/searchStore.ts")).useSearchStore.getState().matches.filter((m) => m.kind === "content").map((m) => m.path);
      return paths.some((p) => p.includes("/alpha/")) && paths.some((p) => p.includes("/beta/")) ? paths : null;
    })) ?? (await page.evaluate(async () => (await import("/src/store/searchStore.ts")).useSearchStore.getState().matches.map((m) => `${m.kind}:${m.path}`)));
  check("search finds matches in both folders", found.some((p) => p.includes("/alpha/notes.md")) && found.some((p) => p.includes("/beta/lib/b.py")), found.join(", "));

  // Source Control: one repository per folder.
  await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().setSidebarView("git"));
  await sleep(800);
  const pickerOptions = await page.$$eval(".scm-repository option", (options) => options.map((o) => o.textContent));
  check("Source Control offers each folder's repository", pickerOptions.length === 2, pickerOptions.join(", "));
  const repo = await page.evaluate(async () => (await import("/src/store/gitStore.ts")).repositoryRoot());
  check("…following the active file's folder", repo === beta, repo);
  await sleep(800);
  const changes = await page.evaluate(async () => Object.keys((await import("/src/store/gitStore.ts")).useGitStore.getState().statusByPath));
  check("…with that repository's changes", changes.some((p) => p.endsWith("new.txt")) && !changes.some((p) => p.endsWith("a.ts")), changes.join(", "));
  await page.screenshot({ path: `${shots}/scm.png` });

  // Save as a .code-workspace file, then open it again.
  const file = path.join(base, "both.code-workspace");
  await page.evaluate(async (file) => (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState().saveWorkspaceAs(file), file);
  await sleep(300);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  check("Save Workspace As writes relative folders", JSON.stringify(saved?.folders) === JSON.stringify([{ path: "alpha" }, { path: "beta" }]), JSON.stringify(saved));
  await page.evaluate(async (path) => (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState().openWorkspace(path), alpha);
  await sleep(500);
  check("opening a single folder leaves one", (await ws()).folders.length === 1, JSON.stringify(await ws()));
  await page.evaluate(async (file) => (await import("/src/store/workspaceStore.ts")).useWorkspaceStore.getState().openWorkspaceFile(file), file);
  await sleep(800);
  const reopened = await ws();
  check("Open Workspace from File restores both folders", JSON.stringify(reopened.folders) === JSON.stringify([alpha, beta]) && reopened.file === file, JSON.stringify(reopened));
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem("sable.windows") ?? "{}"));
  check("the window remembers its workspace", remembered.main?.workspaceFile === file && remembered.main?.folders?.length === 2, JSON.stringify(remembered));

  // Remove a folder from the Explorer's menu.
  await page.evaluate(async () => (await import("/src/store/uiStore.ts")).useUiStore.getState().setSidebarView("files"));
  await sleep(500);
  const fileHeader = await page.$eval(".sidebar", (element) => element.innerText.split("\n")[0]);
  check("the Explorer header names the workspace file", /both \(Workspace\)/i.test(fileHeader), fileHeader);
  await page.click(`.tree-row.root[data-tree-path="${beta}"]`, { button: "right" });
  await sleep(300);
  const menuItems = await texts(page, ".context-menu-item");
  check("a root folder's menu offers Remove and Open in New Window", menuItems.includes("Remove Folder from Workspace") && menuItems.includes("Open in New Window"), menuItems.join(", "));
  await page.evaluate(() => [...document.querySelectorAll(".context-menu-item")].find((item) => item.textContent === "Open in New Window").click());
  await sleep(300);
  const pending = newWindowQuery && new URLSearchParams(newWindowQuery).get("open");
  const handed = pending && (await page.evaluate((token) => localStorage.getItem(`sable.pendingWindow:${token}`), pending));
  check("Open in New Window hands the folder to a new window", Boolean(handed) && JSON.parse(handed).folders[0] === beta, `${newWindowQuery} ${handed}`);
  await page.click(`.tree-row.root[data-tree-path="${beta}"]`, { button: "right" });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll(".context-menu-item")].find((item) => item.textContent === "Remove Folder from Workspace").click());
  await sleep(600);
  check("Remove Folder from Workspace removes it", JSON.stringify((await ws()).folders) === JSON.stringify([alpha]), JSON.stringify(await ws()));
  check("…and the Explorer is single-root again", (await page.$$(".tree-row.root")).length === 0);

  // New Window (⇧⌘N).
  newWindowQuery = undefined;
  await combo(page, ["Meta", "Shift"], "KeyN");
  check("⇧⌘N opens a new (empty) window", newWindowQuery === null, String(newWindowQuery));

  // A theme plugin: install, choose, check the colors.
  await page.evaluate(async (path) => {
    const { invokeLocal } = await import("/src/lib/backend.ts");
    await invokeLocal("plugin_install", { path, link: false, source: null });
    await (await import("/src/store/pluginStore.ts")).usePluginStore.getState().loadThemes();
  }, themePlugin);
  await sleep(500);
  const themeIds = await page.evaluate(async () => (await import("/src/lib/themes.ts")).allThemes().filter((t) => t.pluginId).map((t) => `${t.id}|${t.label}`));
  check("theme plugin's themes are listed", themeIds.length === 2 && themeIds.some((t) => t.endsWith("|Dracula Theme")), themeIds.join(", "));
  const manifest = JSON.parse(fs.readFileSync(path.join(themePlugin, "sable-plugin.json"), "utf8"));
  const id = manifest.themes[0].id;
  await page.evaluate(async (id) => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("workbench.colorTheme", id), id);
  await page.evaluate(async (path) => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openFile(path), `${alpha}/src/a.ts`);
  await sleep(2000);
  const colors = await page.evaluate(() => ({
    base: getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim(),
    editor: getComputedStyle(document.querySelector(".monaco-editor .monaco-editor-background") ?? document.body).backgroundColor,
  }));
  const json = JSON.parse(fs.readFileSync(path.join(themePlugin, manifest.themes[0].path), "utf8"));
  const want = json.colors["editor.background"].toLowerCase();
  const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  check("the app takes the theme's colors", colors.base.toLowerCase() === want.slice(0, 7), `${colors.base} vs ${want}`);
  check("…and so does the editor", hex(colors.editor) === want.slice(0, 7), `${colors.editor} vs ${want}`);
  const keywordColor = await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".view-line span span")];
    const keyword = spans.find((span) => span.textContent === "export");
    return keyword ? getComputedStyle(keyword).color : null;
  });
  check("syntax colors come from the theme", Boolean(keywordColor) && keywordColor !== colors.editor, keywordColor);
  await page.screenshot({ path: `${shots}/theme.png` });
  const settingsPicker = await page.evaluate(async () => {
    (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openSettings();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return [...document.querySelectorAll(".settings-select optgroup")].map((group) => `${group.label}:${group.children.length}`);
  });
  check("Settings' theme picker groups plugin themes", settingsPicker.includes("From plugins:2"), settingsPicker.join(", "));

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await bridge("plugin_uninstall", { id: pluginId }).catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
}
finish();
