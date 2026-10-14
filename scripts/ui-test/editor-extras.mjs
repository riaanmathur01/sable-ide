// End-to-end test of the breadcrumbs, Emmet and the spell checker in the
// real frontend (no language servers: breadcrumb symbols come from
// Monaco's own TypeScript outline).
//
//   - Breadcrumbs: the path and the symbol at the cursor; a folder's
//     dropdown opens a file; a symbol's dropdown jumps (and drills into
//     children); ⇧⌘. then ←/Enter/↓/Enter from the keyboard.
//   - Emmet: Tab expands in HTML, TSX (className) and CSS; the "Emmet
//     Abbreviation" suggestion with its preview; no expansion in a
//     JavaScript comment; Balance outward.
//   - Spelling: squiggles on a misspelled comment word and on a camelCase
//     identifier part (and not in Problems); the quick fix replaces the
//     word; adding to the workspace dictionary (.vscode/settings.json) and
//     the user dictionary removes the squiggle.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/editor-extras.mjs
//
// with Vite and the bridge running (README → Testing), e.g.
//   npx vite --port 1580 --strictPort
//   (cd src-tauri && SABLE_UI_BRIDGE_PORT=1581 SABLE_UI_PLUGINS_DIR=$(mktemp -d) SABLE_UI_HISTORY_DIR=$(mktemp -d) \
//      cargo test --lib ui_bridge -- --ignored)
//   SABLE_UI_VITE_PORT=1580 SABLE_UI_BRIDGE_PORT=1581 node scripts/ui-test/editor-extras.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSable, sleep, texts, unknownCommands } from "./driver.mjs";

const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-editor-extras-shots");
fs.mkdirSync(shots, { recursive: true });
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-extras-")));
const write = (relative, text) => {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

const themesFile = write(
  "src/lib/themes.ts",
  `// Color themes for the editor.
export interface Theme {
  id: string;
  label: string;
}

export const themes: Theme[] = [];

export function themeById(id: string): Theme | undefined {
  const found = themes.find((theme) => theme.id === id);
  return found;
}

export class ThemeRegistry {
  register(theme: Theme): void {
    themes.push(theme);
  }

  lookup(id: string): Theme | undefined {
    return themeById(id);
  }
}
`,
);
write("src/lib/colors.ts", "export const accent = '#7aa2f7';\n");
write("src/lib/fonts.ts", "export const mono = 'JetBrains Mono';\n");
write("src/main.ts", "import { themes } from './lib/themes';\nconsole.log(themes.length);\n");
const htmlFile = write("index.html", "<!DOCTYPE html>\n<html>\n<body>\n  \n</body>\n</html>\n");
const tsxFile = write(
  "src/App.tsx",
  "// A small component.\nexport function App() {\n  return (\n    <main>\n      \n    </main>\n  );\n}\n\n",
);
const cssFile = write("src/styles.css", ".card {\n  \n}\n");
const spellFile = write(
  "src/spelling.ts",
  "// This functon returns the profile.\nexport function getUserProfle(): number {\n  return 1;\n}\n\n// Hello wrold\n",
);

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

async function waitFor(page, fn, args = [], timeout = 15000, what = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const { browser, page, errors } = await openSable(workspace, { width: 1400, height: 900 });
const mod = "Meta";

const openFile = (file) =>
  page.evaluate(async (file) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(file);
  }, file);

const modelValue = () => page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().getModel().getValue());

/** Wait until the editor shows `file`, then put the cursor at line:column and focus it. */
async function showAt(file, line, column) {
  await openFile(file);
  await waitFor(
    page,
    async (file) => {
      const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
      return editor?.getModel()?.uri.path === file;
    },
    [file],
    20000,
    `editor showing ${path.basename(file)}`,
  );
  await page.evaluate(
    async (line, column) => {
      const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    },
    line,
    column,
  );
  await sleep(150);
}

const position = () =>
  page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    const { lineNumber, column } = editor.getPosition();
    return { line: lineNumber, column };
  });

const crumbs = () => texts(page, ".breadcrumbs .breadcrumbs-item");
const dropdownRows = () => texts(page, ".breadcrumbs-dropdown-row .breadcrumbs-dropdown-label");

async function press(key, modifiers = []) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

/** Spell markers in the active model: [word, …]. */
const spellMarkers = () =>
  page.evaluate(async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    const model = getEditor().getModel();
    return monaco.editor
      .getModelMarkers({ resource: model.uri, owner: "spell" })
      .map((marker) => model.getValueInRange(marker));
  });

/** Open the quick-fix menu at a word and click the action titled `title`. */
async function quickFix(file, line, column, title) {
  await showAt(file, line, column);
  // Let the rechecks of the last edit land (new markers restart Monaco's code-action request).
  await sleep(700);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    await editor.getAction("editor.action.quickFix").run();
  });
  const rowFor = (title) =>
    [...document.querySelectorAll(".action-widget .monaco-list-row")].find((row) => row.querySelector(".title")?.textContent.trim() === title);
  await waitFor(page, (title, source) => !!new Function(`return ${source}`)()(title), [title, rowFor.toString()], 10000, `quick fix "${title}"`);
  const row = await page.evaluateHandle((title, source) => new Function(`return ${source}`)()(title), title, rowFor.toString());
  await row.asElement().click();
}

try {
  await sleep(1500);

  // --- Breadcrumbs ---------------------------------------------------------------------------
  console.log("Breadcrumbs");
  await showAt(themesFile, 10, 5);
  await waitFor(page, () => document.querySelectorAll(".breadcrumbs .breadcrumbs-item").length >= 4, [], 20000, "symbol breadcrumbs");
  check(JSON.stringify(await crumbs()) === JSON.stringify(["src", "lib", "themes.ts", "themeById"]), `path + symbol at the cursor: ${(await crumbs()).join(" › ")}`);
  await page.screenshot({ path: path.join(shots, "1-breadcrumbs.png"), clip: { x: 0, y: 0, width: 1400, height: 260 } });

  // Cursor moves into the class method: the chain follows.
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().setPosition({ lineNumber: 17, column: 7 }));
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("register"), [], 5000, "breadcrumbs to follow the cursor");
  check((await crumbs()).slice(-2).join(" ") === "ThemeRegistry register", `follows the cursor: ${(await crumbs()).join(" › ")}`);

  // A symbol's dropdown: its siblings; → drills into ThemeRegistry's members.
  await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().setPosition({ lineNumber: 10, column: 5 }));
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("themeById"), [], 5000, "themeById crumb");
  await page.click(".breadcrumbs .breadcrumbs-item:last-of-type");
  await waitFor(page, () => document.querySelectorAll(".breadcrumbs-dropdown-row").length > 0, [], 5000, "symbol dropdown");
  const symbols = await dropdownRows();
  check(["Theme", "themes", "themeById", "ThemeRegistry"].every((name) => symbols.includes(name)), `symbol dropdown lists siblings: ${symbols.join(", ")}`);
  await sleep(150);
  check(await page.evaluate(() => document.querySelector(".breadcrumbs-dropdown-row.selected")?.innerText.includes("themeById")), "the current symbol is selected");
  await page.screenshot({ path: path.join(shots, "2-symbol-dropdown.png"), clip: { x: 0, y: 0, width: 1400, height: 420 } });
  await press("ArrowDown");
  await press("ArrowRight");
  await waitFor(page, () => document.querySelector(".breadcrumbs-dropdown-heading")?.innerText.includes("ThemeRegistry"), [], 3000, "drill into ThemeRegistry");
  const members = await dropdownRows();
  check(members.includes("register") && members.includes("lookup"), `→ drills into a symbol's children: ${members.join(", ")}`);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".breadcrumbs-dropdown-row")].find((element) => element.innerText.includes("lookup"));
    row.click();
  });
  await sleep(200);
  check((await position()).line === 19, `picking a symbol jumps to it (line ${(await position()).line})`);
  check(!(await page.$(".breadcrumbs-dropdown")), "the dropdown closes after picking");

  // A folder's dropdown: its entries; a file opens.
  await page.evaluate(() => [...document.querySelectorAll(".breadcrumbs-item")].find((element) => element.innerText === "lib").click());
  await waitFor(page, () => document.querySelectorAll(".breadcrumbs-dropdown-row").length > 0, [], 5000, "folder dropdown");
  const files = await dropdownRows();
  check(JSON.stringify(files) === JSON.stringify(["colors.ts", "fonts.ts", "themes.ts"]), `folder dropdown lists the folder: ${files.join(", ")}`);
  await page.screenshot({ path: path.join(shots, "3-folder-dropdown.png"), clip: { x: 0, y: 0, width: 1400, height: 300 } });
  await page.evaluate(() => [...document.querySelectorAll(".breadcrumbs-dropdown-row")].find((element) => element.innerText.includes("colors.ts")).click());
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("colors.ts"), [], 5000, "colors.ts to open");
  check((await crumbs()).join(" ") === "src lib colors.ts", `a file from the dropdown opens: ${(await crumbs()).join(" › ")}`);

  // A folder dropdown drills into folders: src → lib → fonts.ts.
  await page.evaluate(() => [...document.querySelectorAll(".breadcrumbs-item")].find((element) => element.innerText === "src").click());
  await waitFor(page, () => document.querySelectorAll(".breadcrumbs-dropdown-row").length > 0, [], 5000, "src dropdown");
  await page.evaluate(() => [...document.querySelectorAll(".breadcrumbs-dropdown-row")].find((element) => element.innerText.trim() === "lib").click());
  await waitFor(page, () => document.querySelector(".breadcrumbs-dropdown-heading")?.innerText.includes("lib"), [], 3000, "drill into lib");
  await page.evaluate(() => [...document.querySelectorAll(".breadcrumbs-dropdown-row")].find((element) => element.innerText.includes("fonts.ts")).click());
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("fonts.ts"), [], 5000, "fonts.ts to open");
  check(true, "folders drill in, and a file deeper down opens");

  // Keyboard: ⇧⌘. focuses the last part; ← to the file; Enter lists its folder; ↓ Enter opens the next file.
  await showAt(themesFile, 10, 5);
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("themeById"), [], 5000, "themeById crumb again");
  await press("Period", [mod, "Shift"]);
  await sleep(100);
  check(await page.evaluate(() => document.activeElement?.classList.contains("breadcrumbs")), "⇧⌘. focuses the breadcrumbs");
  check((await texts(page, ".breadcrumbs-item.focused"))[0] === "themeById", "…on the last part");
  await press("ArrowLeft");
  check((await texts(page, ".breadcrumbs-item.focused"))[0] === "themes.ts", "← moves to the file");
  await page.screenshot({ path: path.join(shots, "4-keyboard-focus.png"), clip: { x: 0, y: 0, width: 1400, height: 200 } });
  await press("Enter");
  await waitFor(page, () => document.querySelectorAll(".breadcrumbs-dropdown-row").length > 0, [], 5000, "file dropdown");
  check(await page.evaluate(() => document.querySelector(".breadcrumbs-dropdown-row.selected")?.innerText.includes("themes.ts")), "Enter lists the file's folder, on the file");
  await press("ArrowUp");
  await press("Enter");
  await waitFor(page, () => document.querySelector(".breadcrumbs")?.innerText.includes("fonts.ts"), [], 5000, "fonts.ts from the keyboard");
  check(true, "↑ Enter opens a neighbouring file");
  await showAt(themesFile, 10, 5);
  await press("Period", [mod, "Shift"]);
  await press("Escape");
  check(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor")), "Esc goes back to the editor");

  // The setting hides them.
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("breadcrumbs.enabled", false));
  await sleep(100);
  check(!(await page.$(".breadcrumbs")), "breadcrumbs.enabled = false hides them");
  await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).useSettingsStore.getState().set("breadcrumbs.enabled", true));

  // --- Emmet ----------------------------------------------------------------------------------------
  console.log("Emmet");
  await showAt(htmlFile, 4, 3);
  await page.keyboard.type("ul>li*3");
  await sleep(300);
  await press("Escape");
  await press("Tab");
  await sleep(200);
  let text = await modelValue();
  check(text.includes("<ul>\n    <li></li>\n    <li></li>\n    <li></li>\n  </ul>"), "Tab expands ul>li*3 in HTML");
  check(JSON.stringify(await position()) === JSON.stringify({ line: 5, column: 9 }), "the cursor lands on the first tab stop");
  await page.keyboard.type("one");
  await press("Tab");
  await page.keyboard.type("two");
  text = await modelValue();
  check(text.includes("<li>one</li>\n    <li>two</li>"), "Tab walks the expansion's tab stops");
  await press("Escape");

  // The suggestion item, with a preview.
  await showAt(htmlFile, 3, 7);
  await press("Enter");
  await page.keyboard.type("section.hero>h1");
  await waitFor(page, () => [...document.querySelectorAll(".suggest-widget .monaco-list-row")].some((row) => row.innerText.includes("section.hero>h1")), [], 8000, "Emmet suggestion");
  check(await page.evaluate(() => document.querySelector(".suggest-widget")?.innerText.includes("Emmet")), "an Emmet Abbreviation item in the suggestions");
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.trigger("test", "toggleSuggestionDetails", {});
  });
  await sleep(400);
  await page.screenshot({ path: path.join(shots, "5-emmet-suggestion.png"), clip: { x: 0, y: 0, width: 1400, height: 450 } });
  check(await page.evaluate(() => document.querySelector(".suggest-details")?.innerText.includes('<section class="hero">')), "the suggestion previews the expansion");
  await press("Enter");
  await sleep(200);
  check((await modelValue()).includes('<section class="hero">\n    <h1></h1>\n  </section>'), "accepting the suggestion expands it");
  await press("Escape");

  // TSX: className, inside JSX.
  await showAt(tsxFile, 5, 7);
  await page.keyboard.type("ul.list>li.item");
  await sleep(300);
  await press("Escape");
  await press("Tab");
  await sleep(200);
  check((await modelValue()).includes('<ul className="list">\n        <li className="item"></li>\n      </ul>'), "Tab expands in TSX with className");
  await press("Escape");

  // No expansion in a JavaScript comment (or plain code).
  await showAt(tsxFile, 1, 22);
  await page.keyboard.type(" ul>li");
  await press("Escape");
  await press("Tab");
  await sleep(150);
  const comment = (await modelValue()).split("\n")[0];
  check(comment.startsWith("// A small component. ul>li ") && !comment.includes("<ul>"), `no expansion in a comment (Tab indents): ${JSON.stringify(comment)}`);
  await showAt(tsxFile, 10, 1);
  await page.keyboard.type("foo.bar");
  await press("Escape");
  await press("Tab");
  await sleep(150);
  check(!(await modelValue()).includes("<foo"), "no expansion in plain JavaScript");

  // CSS abbreviations.
  await showAt(cssFile, 2, 3);
  for (const abbreviation of ["m10", "p10-20", "bgc#fff", "df", "jcsb"]) {
    await page.keyboard.type(abbreviation);
    await sleep(150);
    await press("Escape");
    await press("Tab");
    await sleep(100);
    await press("Escape");
    await press("Enter");
  }
  text = await modelValue();
  for (const expected of ["margin: 10px;", "padding: 10px 20px;", "background-color: #fff;", "display: flex;", "justify-content: space-between;"]) {
    check(text.includes(expected), `CSS: ${expected}`);
  }
  await page.screenshot({ path: path.join(shots, "6-emmet-css.png"), clip: { x: 0, y: 0, width: 1400, height: 400 } });

  // Balance outward from inside the first <li>.
  await showAt(htmlFile, 1, 1);
  const one = (await modelValue()).split("\n").findIndex((line) => line.includes("<li>one</li>"));
  await showAt(htmlFile, one + 1, (await modelValue()).split("\n")[one].indexOf("one") + 2);
  await page.evaluate(async () => {
    await (await import("/src/lib/emmet/emmetMonaco.ts")).balance("outward");
  });
  const selected = await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    return editor.getModel().getValueInRange(editor.getSelection());
  });
  check(selected === "one", `Balance outward selects the tag's content: ${JSON.stringify(selected)}`);
  await page.evaluate(async () => (await import("/src/lib/emmet/emmetMonaco.ts")).balance("outward"));
  const selectedTag = await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    return editor.getModel().getValueInRange(editor.getSelection());
  });
  check(selectedTag === "<li>one</li>", `…then the whole element: ${JSON.stringify(selectedTag)}`);

  // --- Spelling -------------------------------------------------------------------------------------
  console.log("Spelling");
  await showAt(spellFile, 1, 1);
  await waitFor(page, async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    return monaco.editor.getModelMarkers({ resource: getEditor().getModel().uri, owner: "spell" }).length >= 3;
  }, [], 20000, "spelling markers");
  const misspelled = await spellMarkers();
  check(misspelled.includes("functon"), `a misspelled comment word is marked (${misspelled.join(", ")})`);
  check(misspelled.includes("Profle"), "a misspelled camelCase identifier part is marked");
  check(!misspelled.includes("returns") && !misspelled.includes("number") && !misspelled.includes("User"), "correct words aren't marked");
  const inProblems = await page.evaluate(
    async (file) => ((await import("/src/store/problemsStore.ts")).useProblemsStore.getState().markersByPath[file] ?? []).filter((problem) => problem.source === "spell").length,
    spellFile,
  );
  check(inProblems === 0, "spelling isn't listed in Problems");
  await page.screenshot({ path: path.join(shots, "7-spelling-squiggles.png"), clip: { x: 0, y: 0, width: 1400, height: 320 } });

  await quickFix(spellFile, 1, 10, 'Change to "function"');
  await sleep(300);
  check((await modelValue()).startsWith("// This function returns the profile."), "the quick fix replaces the word");
  await waitFor(page, async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    const model = getEditor().getModel();
    return !monaco.editor.getModelMarkers({ resource: model.uri, owner: "spell" }).some((marker) => model.getValueInRange(marker) === "functon");
  }, [], 5000, "functon's marker to go");
  check(true, "…and its squiggle goes");

  await quickFix(spellFile, 2, 25, 'Add "Profle" to workspace dictionary');
  await waitFor(page, async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    const model = getEditor().getModel();
    return !monaco.editor.getModelMarkers({ resource: model.uri, owner: "spell" }).some((marker) => model.getValueInRange(marker) === "Profle");
  }, [], 8000, "Profle's marker to go");
  check(true, "adding to the workspace dictionary removes the squiggle");
  const settingsJson = fs.readFileSync(path.join(workspace, ".vscode/settings.json"), "utf8");
  check(JSON.parse(settingsJson)["cSpell.words"]?.includes("Profle"), "the word is in .vscode/settings.json's cSpell.words");

  await quickFix(spellFile, 6, 11, 'Add "wrold" to user dictionary');
  await waitFor(page, async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    const model = getEditor().getModel();
    return !monaco.editor.getModelMarkers({ resource: model.uri, owner: "spell" }).some((marker) => model.getValueInRange(marker) === "wrold");
  }, [], 8000, "wrold's marker to go");
  const userWords = await page.evaluate(async () => (await import("/src/store/settingsStore.ts")).getSetting("spellCheck.userWords"));
  check(userWords.split("\n").includes("wrold"), "adding to the user dictionary removes it (and saves the word in settings)");

  // Typing a new misspelling is picked up.
  await showAt(spellFile, 6, 15);
  await page.keyboard.type(" anothr");
  await waitFor(page, async () => {
    const { whenMonaco, getEditor } = await import("/src/lib/editorRegistry.ts");
    const monaco = await whenMonaco();
    const model = getEditor().getModel();
    return monaco.editor.getModelMarkers({ resource: model.uri, owner: "spell" }).some((marker) => model.getValueInRange(marker) === "anothr");
  }, [], 8000, "a new misspelling's marker");
  check(true, "a misspelling typed afterwards is marked");
  await page.screenshot({ path: path.join(shots, "8-spelling-after.png"), clip: { x: 0, y: 0, width: 1400, height: 320 } });

  const unexpected = errors.filter((error) => !/Failed to load resource|favicon/.test(error));
  check(unexpected.length === 0, `no page errors${unexpected.length ? `: ${unexpected.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  failures.push(String(error));
  console.log(`  FAIL ${error.stack ?? error}`);
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
} finally {
  if (unknownCommands.size) console.log(`  (commands with no bridge or stand-in: ${[...unknownCommands].join(", ")})`);
  console.log(`\nScreenshots: ${shots}`);
  await browser.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
