// End-to-end test of the SQLite database editor against the real backend:
// generates a sample database (foreign keys, a view, an index, a trigger,
// a WITHOUT ROWID table, a 200,000-row table, NULLs, blobs including a
// PNG) with Python's sqlite3, opens it from the Explorer, and checks the
// structure tree; browsing, sorting, filtering and scrolling far; editing
// a cell + Write Changes (checked on disk) and Revert Changes; adding and
// deleting records; Execute SQL (results, an error); pragmas; export and
// import CSV; Create Table; and that closing with unwritten changes asks.
// Screenshots in the dark theme and a light one (Catppuccin Latte).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/database.mjs
//
// with Vite and the bridge running (README → Testing), e.g.
//   npx vite --port 1570 --strictPort
//   (cd src-tauri && SABLE_UI_BRIDGE_PORT=1571 cargo test --lib ui_bridge -- --ignored)
//   SABLE_UI_VITE_PORT=1570 SABLE_UI_BRIDGE_PORT=1571 node scripts/ui-test/database.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openSable, extraStandins, sleep, clickText, unknownCommands } from "./driver.mjs";

const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-db-shots");
fs.mkdirSync(shots, { recursive: true });
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-db-")));
const file = path.join(workspace, "music.db");

// --- The sample database --------------------------------------------------------------------
const python = process.env.SABLE_TEST_PYTHON ?? "python3";
const sql = (query, db = file) =>
  JSON.parse(
    execFileSync(python, ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchall()))", db, query], {
      encoding: "utf8",
    }),
  );
execFileSync(
  python,
  [
    "-c",
    `
import sqlite3, sys, struct, zlib, random, json
random.seed(7)
def png(w, h, rgb):
    raw = b"".join(b"\\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
c = sqlite3.connect(sys.argv[1])
c.executescript("""
PRAGMA foreign_keys = ON;
CREATE TABLE artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  country TEXT,
  formed INTEGER
);
CREATE TABLE albums (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  year INTEGER CHECK (year > 1900),
  rating REAL,
  cover BLOB,
  notes TEXT DEFAULT 'none'
);
CREATE INDEX albums_by_year ON albums(year DESC);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id INTEGER,
  amount REAL,
  payload TEXT
);
CREATE VIEW album_overview AS
  SELECT albums.id, artists.name AS artist, albums.title, albums.year, albums.rating
  FROM albums JOIN artists ON artists.id = albums.artist_id;
CREATE TABLE audit (at TEXT DEFAULT CURRENT_TIMESTAMP, what TEXT);
CREATE TRIGGER albums_audit AFTER UPDATE ON albums BEGIN
  INSERT INTO audit (what) VALUES ('album ' || NEW.id || ' changed');
END;
""")
artists = [("Nina Simone", "US", 1954), ("Björk", "IS", 1977), ("Fela Kuti", "NG", 1958), ("Kraftwerk", "DE", 1970), ("Radiohead", "GB", 1985), ("Ryuichi Sakamoto", "JP", 1978), ("Tinariwen", "ML", 1979), ("Caetano Veloso", "BR", 1965)]
c.executemany("INSERT INTO artists (name, country, formed) VALUES (?, ?, ?)", artists)
titles = ["Pastel Blues", "Homogenic", "Zombie", "Trans-Europe Express", "OK Computer", "async", "Amassakoul", "Transa", "Wild Is the Wind", "Vespertine", "Expensive Shit", "Computer World", "Kid A", "BTTB", "Emmaar", "Cinema Transcendental"]
colors = [(220, 80, 60), (60, 140, 220), (90, 180, 90), (230, 190, 60)]
for index, title in enumerate(titles):
    cover = png(24, 24, colors[index % 4]) if index % 3 == 0 else (bytes(random.getrandbits(8) for _ in range(100_000)) if index == 4 else None)
    c.execute("INSERT INTO albums (artist_id, title, year, rating, cover, notes) VALUES (?, ?, ?, ?, ?, ?)",
      (index % 8 + 1, title, 1965 + index * 3, None if index % 5 == 2 else round(3 + (index % 5) * 0.5, 1), cover,
       json.dumps({"tracks": 8 + index, "label": "Label %d" % index}) if index % 4 == 1 else (None if index % 4 == 2 else "Notes for " + title)))
c.executemany("INSERT INTO settings VALUES (?, ?)", [("theme", "dark"), ("language", "en"), ("autoplay", "1"), ("volume", "0.8")])
kinds = ["play", "pause", "skip", "like", "purchase"]
rows = []
for i in range(1, 200_001):
    kind = kinds[i % 5]
    rows.append(("2024-%02d-%02d %02d:%02d:%02d" % (i % 12 + 1, i % 28 + 1, i % 24, i % 60, (i * 7) % 60), kind, i % 997 if i % 13 else None, round((i % 1000) / 10, 2) if kind == "purchase" else None, '{"session": %d}' % (i // 50) if i % 3 == 0 else None))
c.executemany("INSERT INTO events (ts, kind, user_id, amount, payload) VALUES (?, ?, ?, ?, ?)", rows)
c.commit()
`,
    file,
  ],
  { stdio: "inherit" },
);
const csvFile = path.join(workspace, "people.csv");
fs.writeFileSync(csvFile, 'name,age,city\n"Ada Lovelace",36,London\n"Grace Hopper",85,"New York, NY"\nLinus,54,Portland\n');

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
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const statusText = (page) => page.evaluate(() => document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? "");
const gridTexts = (page, column) =>
  page.evaluate((column) => {
    const rows = [...document.querySelectorAll(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-row")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows.map((row) => row.querySelectorAll(".dbg-cell")[column]?.innerText.trim() ?? "");
  }, column);
const cellAt = (page, row, column) =>
  page.evaluate(
    (row, column) => {
      const element = [...document.querySelectorAll(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-row")].find((candidate) => candidate.getAttribute("aria-rowindex") === String(row + 1));
      const cell = element?.querySelectorAll(".dbg-cell")[column];
      if (!cell) return null;
      const box = cell.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, text: cell.innerText.trim() };
    },
    row,
    column,
  );
const tabDirty = (page) => page.evaluate(() => !!document.querySelector(".editor-tab.active .editor-tab-close.dirty"));
const mod = process.platform === "darwin" ? "Meta" : "Control";
const chord = async (page, key, modifiers = [mod]) => {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
};
async function chooseTable(page, name) {
  await page.click(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-picker-button");
  await page.type(".db-picker-search", name);
  await page.keyboard.press("Enter");
  await waitFor(page, (name) => document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-picker-name")?.textContent === name, [name], 5000, `table ${name}`);
  await waitFor(page, (name) => document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-browse")?.dataset.ready === name, [name], 10000, `${name} rows`);
  await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading"), [], 10000, "rows to load");
}
async function setTab(page, label) {
  await clickText(page, label, ".db-tab");
  await sleep(150);
}

// Native dialogs: the test answers them (save/open paths).
const dialogAnswers = [];
async function answerDialogs(page) {
  await page.exposeFunction("__nextDialogAnswer", () => dialogAnswers.shift() ?? null);
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "plugin:dialog|save" || cmd === "plugin:dialog|open") return window.__nextDialogAnswer();
      return original(cmd, args);
    };
  });
}

const theme = process.env.SABLE_DB_THEME;
if (theme) extraStandins.load_settings = { "workbench.colorTheme": theme };

// The dev server has no favicon: that 404 isn't the editor's.
const missing = [];
const watch404 = (page) => page.on("response", (response) => response.status() === 404 && missing.push(response.url()));
const ownErrors = (errors) => {
  let favicons = missing.filter((url) => url.endsWith("/favicon.ico")).length;
  return errors.filter((error) => !(error.startsWith("Failed to load resource") && error.includes("404") && favicons-- > 0));
};
const { browser, page, errors } = await openSable(workspace, { width: 1500, height: 940, beforeLoad: watch404 });
try {
  await answerDialogs(page);
  await sleep(1200);
  // --- Opening ------------------------------------------------------------------------------
  await clickText(page, "music.db");
  await waitFor(page, () => !!document.querySelector(".db-root .db-tabs"), [], 15000, "database view");
  check(await page.evaluate(() => !!document.querySelector(".editor-tab.active svg.lucide-database")), "the tab shows a database icon");
  await waitFor(page, () => /\d rows/.test(document.querySelector(".db-status")?.innerText ?? ""), [], 10000, "first table");
  check((await page.$eval(".db-picker-name", (element) => element.textContent)) === "albums", "Browse Data opens on the first table (albums)");
  await page.screenshot({ path: path.join(shots, "1-browse.png") });

  // --- Structure ------------------------------------------------------------------------------
  await setTab(page, "Database Structure");
  const tree = await page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object .db-tree-label")].map((element) => element.textContent));
  check(["albums", "artists", "audit", "events", "settings", "albums_by_year", "album_overview", "albums_audit"].every((name) => tree.includes(name)), `structure tree lists tables, index, view, trigger (${tree.join(", ")})`);
  const eventsRow = await page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object")].find((row) => row.dataset.key === "table:events")?.innerText ?? "");
  check(eventsRow.includes("200,000 rows"), "row counts in the tree");
  check(
    (await page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object")].find((row) => row.dataset.key === "table:settings")?.innerText ?? "")).includes("WITHOUT ROWID"),
    "WITHOUT ROWID detected",
  );
  // Expand albums: its columns with markers.
  await page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object")].find((row) => row.dataset.key === "table:albums").querySelector(".db-tree-toggle").click());
  await sleep(150);
  const columns = await page.evaluate(() => [...document.querySelectorAll(".db-tree-row.column")].map((row) => row.innerText.replace(/\s+/g, " ")));
  check(columns.some((text) => text.includes("id") && text.includes("PK")), "primary key marker");
  check(columns.some((text) => text.includes("artist_id") && text.includes("NN") && text.includes("→ artists.id")), "NOT NULL and foreign key markers");
  check(columns.some((text) => text.includes("notes") && text.includes("= 'none'")), "default value shown");
  await clickText(page, "albums", ".db-tree-label");
  await sleep(300);
  check((await page.$eval(".db-structure-sql .db-sql", (element) => element.innerText.replace(/\u00a0/g, " "))).includes("CREATE TABLE albums"), "CREATE statement of the selected table");
  await page.screenshot({ path: path.join(shots, "2-structure.png") });

  // --- Browse: sort, filter, scroll far -----------------------------------------------------
  await setTab(page, "Browse Data");
  await chooseTable(page, "events");
  check((await statusText(page)).includes("200,000 rows"), "events: 200,000 rows");
  await page.screenshot({ path: path.join(shots, "3-events.png") });
  // Scroll to the very end.
  await page.click(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-scroll");
  await page.evaluate(() => {
    const scroller = document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-scroll");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await waitFor(page, () => [...document.querySelectorAll(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-rownum")].some((element) => element.textContent === "200000"), [], 10000, "last row number");
  await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading"), [], 10000, "last rows to load");
  const lastIds = await gridTexts(page, 0);
  check(lastIds.includes("200000"), `scrolling to the end shows row id 200000 (${lastIds.slice(-2).join(",")})`);
  // Middle (a jump).
  await page.evaluate(() => {
    const scroller = document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-scroll");
    scroller.scrollTop = scroller.scrollHeight / 2;
  });
  await waitFor(
    page,
    () => {
      const first = Number(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-rownum")?.textContent);
      return first > 90000 && first < 110000 && !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading");
    },
    [],
    10000,
    "middle rows to load",
  );
  const middle = (await gridTexts(page, 0)).map(Number).filter(Boolean);
  check(middle.length > 10 && middle[0] > 90000 && middle[0] < 110000, `jumping to the middle loads rows around 100,000 (${middle[0]})`);
  await page.screenshot({ path: path.join(shots, "4-events-middle.png") });

  // Sort by amount descending (click twice).
  await clickText(page, "amount", ".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-head-name");
  await sleep(100);
  await clickText(page, "amount", ".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-head-name");
  await waitFor(page, () => !!document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-sort.lucide-arrow-down"), [], 5000, "sort arrow");
  await sleep(300);
  await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading") && document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-rownum")?.textContent === "1", [], 15000, "sorted rows");
  const amounts = (await gridTexts(page, 4)).slice(0, 5);
  check(amounts[0] === "99.9" && amounts.every((value) => value === "99.9" || Number(value) <= 99.9), `sorted by amount descending (${amounts.join(", ")})`);

  // Filter: kind = like, user_id > 900.
  const filters = await page.$$(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-filter input");
  await filters[2].type("=like");
  await filters[3].type(">900");
  await waitFor(page, () => /^[\d,]+ rows \(filtered/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 10000, "filtered count");
  const expected = sql("SELECT count(*) FROM events WHERE kind = 'like' AND user_id > 900")[0][0];
  const status = await statusText(page);
  check(status.includes(`${expected.toLocaleString("en-US")} rows`), `column filters (=like, >900): ${expected} rows (${status.split("\n")[0]})`);
  const kindsShown = new Set(await gridTexts(page, 2));
  check(kindsShown.size === 1 && kindsShown.has("like"), "only 'like' rows shown");
  await page.screenshot({ path: path.join(shots, "5-filtered.png") });
  // Clear filters; the global search.
  await page.click(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-subbar button[title='Clear all filters']");
  await page.type(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-search input", "session\": 3999");
  await waitFor(page, () => /^\d+ rows? \(filtered/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 10000, "searched count");
  const searched = sql(`SELECT count(*) FROM events WHERE payload LIKE '%session": 3999%'`)[0][0];
  check((await statusText(page)).startsWith(`${searched} row`), `global filter finds ${searched} rows`);
  await page.click(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-subbar button[title='Clear all filters']");

  // --- Edit a cell, Write Changes ------------------------------------------------------------
  await chooseTable(page, "albums");
  await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading"), [], 5000, "albums rows");
  const titleCell = await cellAt(page, 1, 2);
  check(titleCell?.text === "Homogenic", `albums row 2 title (${titleCell?.text})`);
  check((await cellAt(page, 2, 4))?.text === "NULL", "NULL shown as NULL");
  check(await page.evaluate(() => !!document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-thumb")), "PNG blob shown as a thumbnail");
  check((await cellAt(page, 4, 5))?.text.includes("BLOB (97.7 KB)"), "a large blob shown as BLOB (size)");
  await page.mouse.click(titleCell.x, titleCell.y, { count: 2 });
  await waitFor(page, () => !!document.querySelector(".dbg-editor"), [], 3000, "inline editor");
  await page.keyboard.down(mod);
  await page.keyboard.press("a");
  await page.keyboard.up(mod);
  await page.keyboard.type("Homogenic (Remastered)");
  await page.keyboard.press("Enter");
  await waitFor(page, async () => true);
  await sleep(300);
  check((await cellAt(page, 1, 2))?.text === "Homogenic (Remastered)", "inline edit shows the new value");
  check(await tabDirty(page), "the tab shows unsaved changes");
  check(sql("SELECT title FROM albums WHERE id = 2")[0][0] === "Homogenic", "not written to disk yet");
  // Type into a number cell: stored as an integer.
  const yearCell = await cellAt(page, 0, 3);
  await page.mouse.click(yearCell.x, yearCell.y);
  await page.keyboard.type("1966");
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.screenshot({ path: path.join(shots, "6-edited.png") });
  await chord(page, "s");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "written");
  check(sql("SELECT title FROM albums WHERE id = 2")[0][0] === "Homogenic (Remastered)", "⌘S wrote the change to disk");
  check(JSON.stringify(sql("SELECT year, typeof(year) FROM albums WHERE id = 1")[0]) === '[1966,"integer"]', "typed into an INTEGER column: stored as an integer");
  check(sql("SELECT count(*) FROM audit")[0][0] === 2, "the trigger ran for the edits");

  // --- Revert Changes --------------------------------------------------------------------------
  const ratingCell = await cellAt(page, 0, 4);
  await page.mouse.click(ratingCell.x, ratingCell.y, { count: 2 });
  await page.keyboard.down(mod);
  await page.keyboard.press("a");
  await page.keyboard.up(mod);
  await page.keyboard.type("1.5");
  await page.keyboard.press("Enter");
  await sleep(250);
  check((await cellAt(page, 0, 4))?.text === "1.5", "edited rating shown");
  await clickText(page, "Revert Changes", ".db-tool");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "reverted");
  await sleep(300);
  check((await cellAt(page, 0, 4))?.text === "3.0", `Revert Changes restores the value (${(await cellAt(page, 0, 4))?.text})`);
  check(sql("SELECT rating FROM albums WHERE id = 1")[0][0] === 3, "the file never saw the reverted edit");

  // --- Edit Cell pane ---------------------------------------------------------------------------
  await clickText(page, "Edit Cell", ".db-tool");
  const notesCell = await cellAt(page, 1, 6);
  await page.mouse.click(notesCell.x, notesCell.y);
  await waitFor(page, () => document.querySelector(".db-cellpane .db-seg button.on")?.textContent === "JSON", [], 3000, "JSON view");
  check((await page.$eval(".db-cellpane-text", (element) => element.value)).includes('\n  "tracks": 9'), "Edit Cell shows JSON pretty-printed");
  const coverCell = await cellAt(page, 0, 5);
  await page.mouse.click(coverCell.x, coverCell.y);
  await waitFor(page, () => !!document.querySelector(".db-cellpane-image img"), [], 3000, "image view");
  check(true, "Edit Cell shows a PNG blob as an image");
  await page.screenshot({ path: path.join(shots, "7-edit-cell.png") });
  await clickText(page, "Hex", ".db-cellpane .db-seg button");
  check((await page.$eval(".db-hex", (element) => element.textContent)).startsWith("00000000  89 50 4e 47"), "hex view of the blob");
  const bigBlob = await cellAt(page, 4, 5);
  await page.mouse.click(bigBlob.x, bigBlob.y);
  await waitFor(page, () => (document.querySelector(".db-hex")?.textContent ?? "").includes("more"), [], 5000, "large blob hex");
  check(true, "a large blob is fetched for the hex view");
  // Set as NULL.
  const notes3 = await cellAt(page, 2, 6);
  await page.mouse.click(notes3.x, notes3.y);
  await clickText(page, "Set as NULL", ".db-cellpane button");
  await sleep(250);
  // (row 3's notes were already NULL in the sample; set row 1's instead)
  const notes1 = await cellAt(page, 0, 6);
  await page.mouse.click(notes1.x, notes1.y);
  await clickText(page, "Set as NULL", ".db-cellpane button");
  await sleep(250);
  check((await cellAt(page, 0, 6))?.text === "NULL", "Set as NULL");
  await clickText(page, "Edit Cell", ".db-tool");

  // --- Foreign key: jump to the artist ---------------------------------------------------------
  const artistCell = await cellAt(page, 1, 1);
  await page.mouse.click(artistCell.x, artistCell.y);
  await page.click(".dbg-cell.focused .dbg-follow");
  await waitFor(page, () => document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-picker-name")?.textContent === "artists", [], 5000, "artists table");
  await waitFor(page, () => /^1 row/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 5000, "the referenced row");
  check((await cellAt(page, 0, 1))?.text === "Björk", "following a foreign key shows the referenced row");
  await page.click(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-subbar button[title='Clear all filters']");

  // --- New and deleted records ---------------------------------------------------------------
  await chooseTable(page, "settings");
  await clickText(page, "New Record", ".db-tool");
  await waitFor(page, () => /^5 rows/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 5000, "5 settings");
  check(true, "New Record adds a row (WITHOUT ROWID table: a new key)");
  await waitFor(page, () => !!document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-cell.focused"), [], 5000, "new record selected");
  const newKey = await page.$eval(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-cell.focused", (element) => element.innerText.trim());
  check(newKey === "new 5", `the new record is selected (${newKey})`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("quiet");
  await page.keyboard.press("Enter");
  await sleep(250);
  // Delete "autoplay" (row 1 sorted by key? — table order).
  const keys = await gridTexts(page, 0);
  const autoplayRow = keys.indexOf("autoplay");
  const autoplay = await cellAt(page, autoplayRow, 0);
  await page.mouse.click(autoplay.x, autoplay.y);
  await clickText(page, "Delete Record", ".db-tool");
  await waitFor(page, () => /^4 rows/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 5000, "4 settings");
  check(!(await gridTexts(page, 0)).includes("autoplay"), "Delete Record removes the row");
  await clickText(page, "Write Changes", ".db-tool");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "written");
  check(JSON.stringify(sql("SELECT key, value FROM settings ORDER BY key")) === JSON.stringify([["language", "en"], ["new 5", "quiet"], ["theme", "dark"], ["volume", "0.8"]]), "record changes written to disk");

  // --- Execute SQL ---------------------------------------------------------------------------
  await setTab(page, "Execute SQL");
  await page.click(".db-sql-editor .monaco-editor .view-lines");
  await page.keyboard.type("SELECT kind, count(*) AS n, round(sum(amount), 2) AS total\nFROM events GROUP BY kind ORDER BY n DESC, kind;\n");
  await chord(page, "Enter");
  await waitFor(page, () => (document.querySelector(".db-messages")?.innerText ?? "").includes("returned"), [], 10000, "results");
  const messages = await page.$eval(".db-messages", (element) => element.innerText);
  check(/Execution finished without errors\.\nResult: 5 rows returned in \d+ ms/.test(messages), `messages: ${messages.split("\n").slice(0, 2).join(" / ")}`);
  check((await gridTexts(page, 0)).join(",") === "like,pause,play,purchase,skip", "results grid shows the rows");
  await page.screenshot({ path: path.join(shots, "8-execute.png") });
  // An error, with its line.
  await chord(page, "a");
  await page.keyboard.type("UPDATE artists SET formed = formed + 0;\nSELECT * FROM no_such_table;\n");
  await chord(page, "Enter");
  await waitFor(page, () => (document.querySelector(".db-messages")?.innerText ?? "").includes("errors"), [], 10000, "error message");
  const errorMessage = await page.$eval(".db-messages", (element) => element.innerText);
  check(errorMessage.includes("no such table: no_such_table") && errorMessage.includes("At line 2"), `error with its line (${errorMessage.split("\n")[1]})`);
  check(await page.evaluate(() => !!document.querySelector(".db-error-line")), "the failing line is highlighted");
  await page.screenshot({ path: path.join(shots, "9-execute-error.png") });
  // Run Current Statement.
  await chord(page, "a");
  await page.keyboard.type("SELECT 1 AS one;\nSELECT name FROM artists ORDER BY name LIMIT 3;");
  await chord(page, "Enter", [mod, "Shift"]);
  await waitFor(page, () => (document.querySelector(".db-messages")?.innerText ?? "").includes("3 rows returned"), [], 10000, "current statement");
  check((await gridTexts(page, 0)).join(",") === "Björk,Caetano Veloso,Fela Kuti", "Run Current Statement runs the statement at the cursor");
  check(await tabDirty(page), "the UPDATE before the error is pending (in the transaction)");
  await clickText(page, "Revert Changes", ".db-tool");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "reverted");
  // History.
  await clickText(page, "History", ".db-tool");
  check((await page.$$eval(".db-history-item", (items) => items.length)) >= 3, "history lists executed SQL");
  await clickText(page, "History", ".db-tool");

  // --- Pragmas ---------------------------------------------------------------------------------
  await setTab(page, "Edit Pragmas");
  await waitFor(page, () => !!document.querySelector("[data-pragma='user_version'] input"), [], 5000, "pragmas");
  check((await page.$eval("[data-pragma='encoding'] .db-pragma-info", (element) => element.textContent)) === "UTF-8", "encoding pragma shown");
  await page.click("[data-pragma='user_version'] input", { count: 3 });
  await page.keyboard.type("42");
  await page.screenshot({ path: path.join(shots, "10-pragmas.png") });
  await clickText(page, "Save", ".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-tool");
  await waitFor(page, () => !document.querySelector(".db-pragma.changed"), [], 5000, "pragmas saved");
  check(sql("PRAGMA user_version")[0][0] === 42, "user_version saved to the file");

  // --- Export CSV ------------------------------------------------------------------------------
  const exported = path.join(workspace, "artists-export.csv");
  dialogAnswers.push(exported);
  await setTab(page, "Browse Data");
  await chooseTable(page, "artists");
  await clickText(page, "Export", ".db-tool");
  await clickText(page, "Table as CSV…", ".db-menu button");
  await waitFor(page, () => !!document.querySelector(".db-modal"), [], 3000, "export dialog");
  await page.screenshot({ path: path.join(shots, "11-export.png") });
  await clickText(page, "Export…", ".db-modal .db-button");
  await waitFor(page, () => !document.querySelector(".db-modal"), [], 5000, "export done");
  await sleep(200);
  const csv = fs.existsSync(exported) ? fs.readFileSync(exported, "utf8") : "";
  check(csv.startsWith("id,name,country,formed\n1,Nina Simone,US,1954\n") && csv.trim().split("\n").length === 9, "exported the table as CSV");
  // SQL dump.
  const dumped = path.join(workspace, "music.sql");
  dialogAnswers.push(dumped);
  await clickText(page, "Export", ".db-tool");
  await clickText(page, "Database as SQL…", ".db-menu button");
  await clickText(page, "Export…", ".db-modal .db-button");
  await waitFor(page, () => !document.querySelector(".db-modal"), [], 15000, "dump done");
  const dump = fs.existsSync(dumped) ? fs.readFileSync(dumped, "utf8") : "";
  check(dump.includes("CREATE TABLE artists") && dump.includes("INSERT INTO \"events\" VALUES(200000,") && dump.endsWith("COMMIT;\n"), "exported the database as SQL");

  // --- Import CSV --------------------------------------------------------------------------
  dialogAnswers.push(csvFile);
  await page.click(".db-toolbar button[title='Import a CSV file into a table']");
  await waitFor(page, () => !!document.querySelector(".db-preview table"), [], 5000, "import preview");
  check((await page.$$eval(".db-preview tbody tr", (rows) => rows.length)) === 3, "import preview shows the rows");
  await page.screenshot({ path: path.join(shots, "12-import.png") });
  await clickText(page, "Import", ".db-modal .db-button");
  await waitFor(page, () => document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-picker-name")?.textContent === "people", [], 5000, "people table");
  await waitFor(page, () => /^3 rows/.test(document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .db-status")?.innerText ?? ""), [], 5000, "3 people");
  check((await cellAt(page, 1, 2))?.text === "New York, NY", "imported a quoted field with a comma");
  await chord(page, "s");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "written");
  check(JSON.stringify(sql("SELECT name, age, typeof(age) FROM people ORDER BY rowid")) === JSON.stringify([["Ada Lovelace", 36, "integer"], ["Grace Hopper", 85, "integer"], ["Linus", 54, "integer"]]), "imported rows on disk, ages as integers");

  // --- Create Table --------------------------------------------------------------------------
  await setTab(page, "Database Structure");
  await clickText(page, "Create Table", ".db-tool");
  await waitFor(page, () => !!document.querySelector(".db-table-editor"), [], 3000, "create table dialog");
  await page.type(".db-table-editor .db-field input", "playlists");
  // Row 2 (the empty one): name it.
  const secondRow = await (await page.$$(".db-fields-row"))[1].$$("input:not([type=checkbox])");
  await secondRow[0].click({ count: 3 });
  await page.keyboard.type("title");
  await page.evaluate(() => document.querySelectorAll(".db-fields-row")[1].querySelectorAll("input[type=checkbox]")[2].click());
  await clickText(page, "Add", ".db-table-editor .db-tool");
  const lastRowInputs = await page.$$(".db-fields-row:last-of-type input:not([type=checkbox])");
  await lastRowInputs[0].click({ count: 3 });
  await page.keyboard.type("created");
  await lastRowInputs[1].click({ count: 3 });
  await page.keyboard.type("TEXT");
  await lastRowInputs[2].type("CURRENT_TIMESTAMP");
  await sleep(200);
  const preview = await page.$eval(".db-table-editor .db-sql", (element) => element.innerText.replace(/[\s\u00a0]+/g, " "));
  check(preview.includes('CREATE TABLE "playlists"') && preview.includes('"title" TEXT NOT NULL') && preview.includes("DEFAULT CURRENT_TIMESTAMP") && preview.includes('PRIMARY KEY("id" AUTOINCREMENT)'), `the dialog shows the generated SQL (${preview})`);
  await page.screenshot({ path: path.join(shots, "13-create-table.png") });
  await clickText(page, "Create", ".db-modal .db-button");
  await waitFor(page, () => !document.querySelector(".db-modal"), [], 5000, "created");
  await waitFor(page, () => [...document.querySelectorAll(".db-tree-label")].some((element) => element.textContent === "playlists"), [], 5000, "playlists in tree");
  check(true, "the new table appears in the structure tree");

  // --- Modify Table: add a column (ALTER) ------------------------------------------------------
  await clickText(page, "playlists", ".db-tree-label");
  await clickText(page, "Modify Table", ".db-tool");
  await waitFor(page, () => !!document.querySelector(".db-table-editor"), [], 3000, "modify dialog");
  await clickText(page, "Add", ".db-table-editor .db-tool");
  const added = await page.$$(".db-fields-row:last-of-type input:not([type=checkbox])");
  await added[0].click({ count: 3 });
  await page.keyboard.type("position");
  await added[1].click({ count: 3 });
  await page.keyboard.type("INTEGER");
  await sleep(150);
  check((await page.$eval(".db-table-editor .db-sql", (element) => element.innerText.replace(/[\s\u00a0]+/g, " "))).includes('ALTER TABLE "playlists" ADD COLUMN "position"'), "Modify Table adds a column with ALTER TABLE");
  await clickText(page, "Save", ".db-modal .db-button");
  await waitFor(page, () => !document.querySelector(".db-modal"), [], 5000, "modified");
  await chord(page, "s");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "written");
  check(JSON.stringify(sql("SELECT name FROM pragma_table_info('playlists')").flat()) === '["id","title","created","position"]', "playlists created and modified on disk");

  // --- Modify Table: a change that rebuilds the table ------------------------------------------
  await clickText(page, "albums", ".db-tree-label");
  await clickText(page, "Modify Table", ".db-tool");
  await waitFor(page, () => !!document.querySelector(".db-table-editor"), [], 3000, "modify dialog");
  const ratingRow = await page.evaluateHandle(() => [...document.querySelectorAll(".db-fields-row")].find((row) => row.querySelector("input").value === "rating"));
  const ratingType = (await ratingRow.$$("input:not([type=checkbox])"))[1];
  await ratingType.click({ count: 3 });
  await page.keyboard.type("NUMERIC");
  await sleep(150);
  const rebuild = await page.$eval(".db-table-editor .db-sql", (element) => element.innerText.replace(/[\s\u00a0]+/g, " "));
  check(
    rebuild.includes('CREATE TABLE "sable_temp_albums"') && rebuild.includes('"rating" NUMERIC') && rebuild.includes("CHECK(year > 1900)") && rebuild.includes('FOREIGN KEY("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE') && rebuild.includes("CREATE INDEX albums_by_year") && rebuild.includes("CREATE TRIGGER albums_audit"),
    "a type change rebuilds the table, keeping its CHECK, foreign key, index and trigger",
  );
  await page.screenshot({ path: path.join(shots, "13b-modify-rebuild.png") });
  await clickText(page, "Save", ".db-modal .db-button");
  await waitFor(page, () => !document.querySelector(".db-modal"), [], 5000, "rebuilt");
  await chord(page, "s");
  await waitFor(page, () => !document.querySelector(".editor-tab.active .editor-tab-close.dirty"), [], 5000, "written");
  check(sql("SELECT count(*) FROM albums")[0][0] === 16, "the rebuilt table kept its rows");
  check(sql("SELECT type FROM pragma_table_info('albums') WHERE name = 'rating'")[0][0] === "NUMERIC", "the column's type changed");
  check(sql("SELECT count(*) FROM sqlite_schema WHERE name IN ('albums_by_year', 'albums_audit')")[0][0] === 2, "index and trigger recreated");
  check(sql("SELECT count(*) FROM artists")[0][0] === 8 && sql("SELECT count(*) FROM pragma_foreign_key_list('albums')")[0][0] === 1, "foreign key kept, nothing cascaded");
  check(sql("PRAGMA integrity_check")[0][0] === "ok", "the database is intact after the rebuild");

  // --- Palette commands --------------------------------------------------------------------------
  await chord(page, "p", [mod, "Shift"]);
  await page.keyboard.type("Database: Integrity");
  await sleep(150);
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector(".db-integrity"), [], 10000, "integrity dialog");
  check((await page.$eval(".db-integrity", (element) => element.innerText)).includes("No problems found"), "palette: Database: Integrity Check");
  await clickText(page, "OK", ".db-modal .db-button");

  // --- Copy as TSV -----------------------------------------------------------------------------
  await setTab(page, "Browse Data");
  await chooseTable(page, "artists");
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  const from = await cellAt(page, 0, 1);
  await page.mouse.click(from.x, from.y);
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await chord(page, "c");
  await sleep(150);
  check((await page.evaluate(() => window.__copied)) === "Nina Simone\tUS\nBjörk\tIS", "a selection copies as TSV");
  check((await statusText(page)).includes("2 rows, 4 cells selected"), "the status line counts the selection");

  // --- Closing with unwritten changes asks ---------------------------------------------------
  await setTab(page, "Execute SQL");
  await page.click(".db-sql-editor .monaco-editor .view-lines");
  await chord(page, "a");
  await page.keyboard.type("DELETE FROM events WHERE id <= 10;");
  await chord(page, "Enter");
  await waitFor(page, () => (document.querySelector(".db-messages")?.innerText ?? "").includes("10 rows affected"), [], 5000, "delete ran");
  check(await tabDirty(page), "pending DELETE marks the tab");
  await page.click(".editor-tab.active .editor-tab-close");
  await waitFor(page, () => !!document.querySelector(".db-confirm"), [], 3000, "close prompt");
  check((await page.$eval(".db-confirm", (element) => element.innerText)).includes("Write the changes"), "closing with unwritten changes asks Write / Discard / Cancel");
  await page.screenshot({ path: path.join(shots, "14-close-prompt.png") });
  await clickText(page, "Cancel", ".db-confirm .db-button");
  check(await page.evaluate(() => !!document.querySelector(".editor-tab.active svg.lucide-database")), "Cancel keeps the tab open");
  await page.click(".editor-tab.active .editor-tab-close");
  await waitFor(page, () => !!document.querySelector(".db-confirm"), [], 3000, "close prompt");
  await clickText(page, "Discard", ".db-confirm .db-button");
  await waitFor(page, () => !document.querySelector(".db-root"), [], 5000, "closed");
  check(sql("SELECT count(*) FROM events")[0][0] === 200000, "Discard closes without writing");

  // --- A database without a database extension (by its header) -------------------------------
  fs.copyFileSync(file, path.join(workspace, "library"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(300);
  await page.evaluate(async (target) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(target);
  }, path.join(workspace, "library"));
  await waitFor(page, () => !!document.querySelector(".db-root .db-tabs"), [], 10000, "sniffed database");
  check(true, "a file starting with 'SQLite format 3' opens as a database");

  // --- A million rows: the scrollbar maps proportionally past the browser's height limit --------
  const big = path.join(workspace, "big.sqlite");
  execFileSync(python, ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE numbers (n INTEGER PRIMARY KEY, square INTEGER, label TEXT)'); c.executemany('INSERT INTO numbers VALUES (?, ?, ?)', ((i, i * i, 'row %d' % i) for i in range(1, 1000001))); c.commit()", big]);
  await page.evaluate(async (target) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(target);
  }, big);
  await waitFor(page, () => document.querySelector(".editor-layer:not([style*='none']) .db-browse")?.dataset.ready === "numbers", [], 20000, "a million rows");
  check((await statusText(page)).startsWith("1,000,000 rows"), "1,000,000 rows counted");
  const measure = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-row")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const numbers = rows.map((row) => Number(row.querySelector(".dbg-cell")?.innerText));
      const tops = rows.map((row) => row.getBoundingClientRect().top);
      return { numbers, contiguous: numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1), even: tops.every((top, i) => i === 0 || Math.abs(top - tops[i - 1] - 22) < 0.5), tops: tops.slice(0, 4) };
    });
  const jump = async (fraction) => {
    await page.evaluate((fraction) => {
      const scroller = document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-scroll");
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
    }, fraction);
    await sleep(100);
    await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading"), [], 10000, "rows after a jump");
    return measure();
  };
  const started = Date.now();
  const end = await jump(1);
  check(end.numbers.includes(1000000) && end.contiguous && end.even, `scrolled to the end of a million rows (${end.numbers.at(-1)})`);
  const half = await jump(0.5);
  check(half.numbers[0] > 490000 && half.numbers[0] < 510000 && half.contiguous && half.even, `the middle of a million rows (${half.numbers[0]})`);
  // Wheel-scroll a little from there: rows move on smoothly.
  await page.mouse.move(900, 500);
  await page.mouse.wheel({ deltaY: 220 });
  await sleep(150);
  await waitFor(page, () => !document.querySelector(".editor-layer:not([style*='none']) .db-page:not([style*='none']) .dbg-loading"), [], 10000, "rows after wheel");
  const after = await measure();
  check(after.contiguous && after.even && after.numbers[0] > half.numbers[0], `rows stay contiguous while scrolling (${after.numbers[0]}, ${JSON.stringify(after.tops)})`);
  check(Date.now() - started < 8000, `paging a million rows is quick (${Date.now() - started} ms)`);
  await page.screenshot({ path: path.join(shots, "15-million.png") });

  const pageErrors = ownErrors(errors);
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(" | ")}` : ""}`);
  check(![...unknownCommands].some((command) => command.startsWith("database")), `bridge serves the database commands (unknown: ${[...unknownCommands].join(", ")})`);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.stack ?? error}`);
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
}

// --- Light theme screenshots ------------------------------------------------------------------
if (!theme && failures.length === 0) {
  extraStandins.load_settings = { "workbench.colorTheme": "catppuccin-latte" };
  const light = await openSable(workspace, { width: 1500, height: 940, beforeLoad: watch404 });
  try {
    await sleep(1200);
    await clickText(light.page, "music.db");
    await waitFor(light.page, () => /\d rows/.test(document.querySelector(".db-status")?.innerText ?? ""), [], 15000, "light: table");
    await light.page.screenshot({ path: path.join(shots, "L1-browse.png") });
    await setTab(light.page, "Database Structure");
    await light.page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object")].find((row) => row.dataset.key === "table:albums").click());
    await light.page.evaluate(() => [...document.querySelectorAll(".db-tree-row.object")].find((row) => row.dataset.key === "table:albums").querySelector(".db-tree-toggle").click());
    await sleep(300);
    await light.page.screenshot({ path: path.join(shots, "L2-structure.png") });
    await setTab(light.page, "Execute SQL");
    await sleep(300);
    await light.page.screenshot({ path: path.join(shots, "L3-execute.png") });
    await setTab(light.page, "Edit Pragmas");
    await sleep(300);
    await light.page.screenshot({ path: path.join(shots, "L4-pragmas.png") });
    check(ownErrors(light.errors).length === 0, "light theme: no page errors");
  } finally {
    await light.browser.close();
  }
}

console.log(`\nscreenshots: ${shots}`);
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
fs.rmSync(workspace, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
