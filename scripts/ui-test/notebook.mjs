// End-to-end test of the notebook editor (.ipynb) against a real Jupyter
// kernel: opens a notebook, runs its cells (print, an expression, a
// matplotlib plot, HTML/Markdown displays, update_display_data,
// clear_output, a long output, an error, input()), checks the outputs,
// completions and hover, edits cells with Jupyter's keys, saves with ⌘S
// and checks the saved nbformat JSON; then screenshots it in a light theme.
//
//   SABLE_TEST_JUPYTER_PYTHON=/path/to/venv/bin/python  (with ipykernel; matplotlib for the plot)
//   [SABLE_TEST_PLAIN_PYTHON=/path/to/python without ipykernel: also checks the install banner]
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/notebook.mjs
//
// with Vite and the bridge running (README → Testing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { openSable, extraStandins, sleep, clickText, unknownCommands } from "./driver.mjs";

const python = process.env.SABLE_TEST_JUPYTER_PYTHON;
if (!python) throw new Error("set SABLE_TEST_JUPYTER_PYTHON");
const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-nb-shots");
fs.mkdirSync(shots, { recursive: true });

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-nb-")));
const file = path.join(workspace, "analysis.ipynb");
const notebook = {
  cells: [
    { cell_type: "markdown", id: "md-intro", metadata: {}, source: ["# Sales analysis\n", "\n", "Some **bold** text, `code`, and a list:\n", "\n", "- one\n", "- two"] },
    { cell_type: "code", execution_count: null, id: "c-print", metadata: { tags: ["keep-me"] }, outputs: [], source: ['print("hello from the kernel")\n', 'import sys; print("warning!", file=sys.stderr)'] },
    { cell_type: "code", execution_count: null, id: "c-expr", metadata: {}, outputs: [], source: ["6 * 7"] },
    { cell_type: "code", execution_count: null, id: "c-plot", metadata: {}, outputs: [], source: ["import matplotlib\n", 'matplotlib.use("module://matplotlib_inline.backend_inline")\n', "import matplotlib.pyplot as plt\n", "plt.figure(figsize=(4, 2.5))\n", "plt.plot([1, 3, 2, 5, 4], marker='o')\n", 'plt.title("A plot")\n', "plt.show()"] },
    { cell_type: "code", execution_count: null, id: "c-table", metadata: {}, outputs: [], source: ["from IPython.display import HTML, Markdown, display\n", 'display(HTML("<table><thead><tr><th>name</th><th>qty</th></tr></thead><tbody><tr><td>apples</td><td>3</td></tr><tr><td>pears</td><td>5</td></tr></tbody></table>"))\n', 'display(Markdown("**markdown** output"))'] },
    { cell_type: "code", execution_count: null, id: "c-update", metadata: {}, outputs: [], source: ["from IPython.display import display\n", 'handle = display("first", display_id=True)\n', 'handle.update("updated")'] },
    { cell_type: "code", execution_count: null, id: "c-clear", metadata: {}, outputs: [], source: ["from IPython.display import clear_output\n", "for i in range(3):\n", "    clear_output(wait=True)\n", '    print("tick", i)'] },
    { cell_type: "code", execution_count: null, id: "c-long", metadata: {}, outputs: [], source: ['for i in range(300): print("\\x1b[32mline\\x1b[0m", i)'] },
    { cell_type: "code", execution_count: null, id: "c-error", metadata: {}, outputs: [], source: ["def divide(a, b):\n", "    return a / b\n", "\n", "divide(1, 0)"] },
    { cell_type: "code", execution_count: null, id: "c-input", metadata: {}, outputs: [], source: ['name = input("Your name? ")\n', 'print("Hi", name)'] },
  ],
  metadata: {
    custom_field: { keep: true, nested: [1, 2] },
    kernelspec: { display_name: "Python 3 (ipykernel)", language: "python", name: "python3" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
};
fs.writeFileSync(file, JSON.stringify(notebook, null, 1) + "\n");

extraStandins.discover_python_interpreters = [{ path: python, label: "test venv", version: "3.12", kind: "venv" }];

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

async function waitFor(page, fn, args = [], timeout = 30000, what = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn, ...args)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const cellText = (page, id) =>
  page.evaluate((id) => {
    const cells = [...document.querySelectorAll(".nb-cell")];
    const cell = cells.find((element) => element.dataset.cellKey.startsWith(`${id}-`));
    return cell?.querySelector(".nb-outputs")?.innerText ?? "";
  }, id);

const kernelCount = () =>
  execSync("ps -ax -o command", { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes("ipykernel_launcher")).length;
const kernelsBefore = kernelCount();

const { browser, page, errors } = await openSable(workspace, { pollEvents: true, width: 1400, height: 1000 });
try {
  await sleep(1500);
  await clickText(page, "analysis.ipynb");
  await waitFor(page, () => document.querySelectorAll(".nb-cell").length === 10, [], 20000, "notebook cells");
  check(true, "notebook opens in the notebook editor with 10 cells");
  check(await page.evaluate(() => !!document.querySelector(".nb-markdown h1")), "markdown cell renders");
  check(await page.evaluate(() => document.querySelectorAll(".nb-cell-code .monaco-editor").length === 9), "code cells are Monaco editors");
  await page.screenshot({ path: path.join(shots, "1-opened.png") });

  // Run everything.
  await clickText(page, "Run All", ".nb-tool");
  await waitFor(page, () => document.querySelectorAll(".nb-cell.running, .nb-cell.queued").length > 0, [], 10000, "runs to start");
  await page.screenshot({ path: path.join(shots, "1b-running.png") });
  await waitFor(page, () => document.querySelectorAll(".nb-cell.running, .nb-cell.queued").length === 0, [], 90000, "runs to finish");
  await sleep(300);

  check((await cellText(page, "c-print")).includes("hello from the kernel"), "stdout output");
  check(await page.evaluate(() => !!document.querySelector(".nb-stderr")), "stderr output styled");
  check((await cellText(page, "c-expr")).includes("42"), "expression result");
  const plot = await page.evaluate(() => [...document.querySelectorAll(".nb-output-image")].some((image) => image.src.startsWith("data:image/png")));
  check(plot, "matplotlib PNG plot");
  check(await page.evaluate(() => !!document.querySelector(".nb-output-html table")), "HTML table output");
  check((await cellText(page, "c-table")).includes("markdown output"), "markdown output");
  check((await cellText(page, "c-error")).includes("ZeroDivisionError"), "error traceback");
  const updated = await cellText(page, "c-update");
  check(updated.includes("updated") && !updated.includes("first"), "update_display_data replaces the output");
  const ticks = await cellText(page, "c-clear");
  check(ticks.includes("tick 2") && !ticks.includes("tick 1"), "clear_output(wait=True)");
  check(await page.evaluate(() => !!document.querySelector('[data-cell-key^="c-long-"] .nb-outputs-body.scrolled')), "long output scrolls");
  check(await page.evaluate(() => [...document.querySelectorAll(".nb-error span")].some((span) => span.style.color)), "traceback has ANSI colors");
  // Run All stops at the error (like Jupyter): the input cell didn't run then. Run it on its own.
  const counts = await page.evaluate(() => [...document.querySelectorAll(".nb-exec-count")].map((element) => element.textContent));
  console.log("  counts", counts.join(" "));
  check(counts[0] === "[1]" && counts[1] === "[2]", "execution counts");
  await page.screenshot({ path: path.join(shots, "2-ran.png") });

  // input(): run the input cell alone (the error stopped Run All before it).
  check((await cellText(page, "c-input")) === "", "Run All stops at the error");
  await page.evaluate(() => [...document.querySelectorAll(".nb-cell")].find((element) => element.dataset.cellKey.startsWith("c-input-")).querySelector(".nb-run-button").click());
  await waitFor(page, () => !!document.querySelector(".nb-stdin input"), [], 30000, "the input() prompt");
  check(true, "input() shows a prompt box");
  await page.screenshot({ path: path.join(shots, "2b-input.png") });
  await page.type(".nb-stdin input", "Ada");
  await page.keyboard.press("Enter");
  await waitFor(page, () => document.querySelectorAll(".nb-cell.running, .nb-cell.queued").length === 0, [], 30000, "input run");
  await sleep(300);
  check((await cellText(page, "c-input")).includes("Hi Ada"), "input() reply reaches the program");

  // Hover: the kernel's inspect_request.
  const point = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-cell-key^="c-error-"] .view-lines span span')];
    const span = spans.find((element) => element.textContent === "divide");
    const box = span?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  });
  if (point) {
    await page.mouse.move(point.x, point.y);
    await waitFor(page, () => [...document.querySelectorAll(".monaco-hover")].some((element) => element.offsetParent && element.textContent.includes("divide(a, b)")), [], 10000, "hover").then(
      () => check(true, "hover shows the kernel's inspection"),
      () => check(false, "hover shows the kernel's inspection"),
    );
    await page.screenshot({ path: path.join(shots, "2c-hover.png") });
    await page.mouse.move(5, 500);
  } else check(false, "found the word to hover");

  // Edit a cell, add one with B, run it with Shift+Enter.
  await page.click('[data-cell-key^="c-expr-"] .monaco-editor .view-lines');
  await page.keyboard.press("End");
  await page.keyboard.type(" + 1");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await waitFor(page, () => document.querySelector('[data-cell-key^="c-expr-"] .nb-outputs')?.innerText.includes("43"), [], 20000, "edited cell result");
  check(true, "Shift+Enter runs the edited cell");
  // Shift+Enter moved to the next cell in command mode: B adds a cell below it.
  await page.keyboard.press("b");
  await sleep(200);
  check(await page.evaluate(() => document.querySelectorAll(".nb-cell").length === 11), "B inserts a cell");
  await page.keyboard.press("Enter");
  await sleep(200);
  await page.keyboard.type("squares = [n * n for n in range(5)]\nsquares");
  await page.keyboard.down("Alt");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Alt");
  await waitFor(page, () => [...document.querySelectorAll(".nb-outputs")].some((element) => element.innerText.includes("[0, 1, 4, 9, 16]")), [], 20000, "new cell result");
  check(await page.evaluate(() => document.querySelectorAll(".nb-cell").length === 12), "Alt+Enter runs and inserts a cell below");
  // Esc, then delete the empty new cell (D D), undo (Z), delete again.
  await page.keyboard.press("Escape");
  await sleep(100);
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await sleep(150);
  check(await page.evaluate(() => document.querySelectorAll(".nb-cell").length === 11), "D D deletes a cell");
  await page.keyboard.press("z");
  await sleep(150);
  check(await page.evaluate(() => document.querySelectorAll(".nb-cell").length === 12), "Z brings it back");
  await page.keyboard.press("m");
  await sleep(150);
  check(await page.evaluate(() => document.querySelector(".nb-cell.selected")?.classList.contains("nb-cell-markdown")), "M makes it Markdown");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await sleep(150);
  check(await page.evaluate(() => document.querySelector(".editor-tab.active .editor-tab-close.dirty") !== null), "tab shows unsaved changes");

  // Completions from the kernel.
  await page.click('[data-cell-key^="c-expr-"] .monaco-editor .view-lines');
  await page.keyboard.press("End");
  await page.keyboard.type("\nsquares.");
  await waitFor(page, () => [...document.querySelectorAll(".suggest-widget .monaco-list-row")].some((row) => row.textContent.includes("append")), [], 15000, "kernel completions").then(
    () => check(true, "kernel completions"),
    () => check(false, "kernel completions"),
  );
  await page.screenshot({ path: path.join(shots, "3-completions.png") });
  await page.keyboard.press("Escape");
  await sleep(100);
  // Remove the "squares." line again.
  await page.click('[data-cell-key^="c-expr-"] .monaco-editor .view-lines');
  await page.keyboard.down("Meta");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");

  // Save with ⌘S.
  await page.keyboard.down("Meta");
  await page.keyboard.press("s");
  await page.keyboard.up("Meta");
  await sleep(800);
  const text = fs.readFileSync(file, "utf8");
  const saved = JSON.parse(text);
  check(text.endsWith("}\n") && text.startsWith('{\n "cells": [\n  {\n   "cell_type"'), "saved with 1-space indent, sorted keys, trailing newline");
  check(saved.nbformat === 4 && saved.nbformat_minor === 5, "nbformat kept");
  check(JSON.stringify(saved.metadata.custom_field) === JSON.stringify({ keep: true, nested: [1, 2] }), "notebook metadata kept");
  check(saved.cells[1].id === "c-print" && saved.cells[1].metadata.tags[0] === "keep-me", "cell ids and metadata kept");
  check(saved.cells.every((cell) => typeof cell.id === "string"), "every cell has an id");
  const expr = saved.cells.find((cell) => cell.id === "c-expr");
  check(expr.source.join("") === "6 * 7 + 1", `edited source saved (${JSON.stringify(expr.source)})`);
  check(expr.outputs[0]?.data?.["text/plain"]?.[0] === "43" && typeof expr.execution_count === "number", "result and count saved");
  const printed = saved.cells.find((cell) => cell.id === "c-print");
  check(printed.outputs.some((output) => output.output_type === "stream" && output.name === "stdout" && output.text.join("") === "hello from the kernel\n"), "stream output saved as lines");
  const plotCell = saved.cells.find((cell) => cell.id === "c-plot");
  check(plotCell.outputs.some((output) => output.output_type === "display_data" && typeof output.data["image/png"] === "string"), "PNG saved");
  const errorCell = saved.cells.find((cell) => cell.id === "c-error");
  check(errorCell.outputs.some((output) => output.output_type === "error" && output.ename === "ZeroDivisionError" && output.traceback.length > 0), "error saved");
  const added = saved.cells.find((cell) => cell.source.join("").startsWith("squares ="));
  check(added && /^[0-9a-f]{8}$/.test(added.id) && added.outputs.length === 1, "new cell saved with an id and output");
  check(saved.cells[0].cell_type === "markdown" && !("outputs" in saved.cells[0]), "markdown cell has no outputs field");
  check(await page.evaluate(() => document.querySelector(".editor-tab.active .editor-tab-close.dirty") === null), "tab clean after save");

  // Open as Text.
  await page.click('.nb-tool[title^="Open as Text"]');
  await waitFor(page, () => [...document.querySelectorAll(".editor-tab")].length === 2, [], 10000, "text tab");
  await sleep(800);
  check(await page.evaluate(() => document.querySelector(".monaco-pane .view-lines")?.innerText.includes('"cells"')), "Open as Text shows the JSON");
  await clickText(page, "analysis.ipynb", ".editor-tab:not(.active) .editor-tab-name");
  await sleep(300);

  // Kernel picker.
  await page.click(".nb-kernel-button");
  await waitFor(page, () => !!document.querySelector(".nb-kernel-option"), [], 30000, "kernel list");
  check(await page.evaluate(() => document.querySelector(".nb-kernel-option")?.innerText.includes("Python 3")), "kernel picker lists kernelspecs");
  await page.screenshot({ path: path.join(shots, "4-picker.png") });
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 500);

  // Close the tab: the kernel shuts down.
  // Kernels running now, less those running before the test.
  const kernels = () => kernelCount() - kernelsBefore;
  check(kernels() === 1, "one kernel running");
  await page.evaluate(() => {
    for (const tab of document.querySelectorAll(".editor-tab")) {
      if (tab.textContent.includes("analysis.ipynb")) tab.querySelector(".editor-tab-close").click();
    }
  });
  for (let waited = 0; waited < 10000 && kernels() > 0; waited += 250) await sleep(250);
  check(kernels() === 0, "closing the notebook shuts its kernel down");
} catch (error) {
  failures.push(String(error));
  console.log("  ERROR", error);
  await page.screenshot({ path: path.join(shots, "error.png") });
} finally {
  const relevant = errors.filter((error) => !/favicon|Failed to load resource/.test(error));
  if (relevant.length) console.log("page errors:", relevant.slice(0, 10));
  if (unknownCommands.size) console.log("unknown commands:", [...unknownCommands]);
  await browser.close();
}

// Light theme screenshot of the same notebook.
extraStandins.load_settings = { "workbench.colorTheme": "catppuccin-latte" };
{
  const { browser, page } = await openSable(workspace, { pollEvents: true, width: 1400, height: 1000 });
  try {
    await sleep(1500);
    await clickText(page, "analysis.ipynb");
    await waitFor(page, () => document.querySelectorAll(".nb-cell").length > 5, [], 20000, "cells");
    await sleep(1500);
    await page.screenshot({ path: path.join(shots, "5-light.png") });
  } finally {
    await browser.close();
  }
}

// An interpreter without ipykernel: the notebook offers to install it.
if (process.env.SABLE_TEST_PLAIN_PYTHON) {
  delete extraStandins.load_settings;
  extraStandins.discover_python_interpreters = [{ path: process.env.SABLE_TEST_PLAIN_PYTHON, label: "plain", version: "3", kind: "cpython" }];
  extraStandins.notebook_install_ipykernel = () => {
    throw new Error("installing is not part of the test");
  };
  const empty = path.join(workspace, "empty.ipynb");
  fs.writeFileSync(empty, "");
  const { browser, page } = await openSable(workspace, { pollEvents: true, width: 1200, height: 600 });
  try {
    await sleep(1500);
    await clickText(page, "empty.ipynb");
    await waitFor(page, () => document.querySelectorAll(".nb-cell").length === 1, [], 10000, "a new notebook");
    check(true, "an empty .ipynb opens as a new notebook");
    await page.click(".nb-cell .monaco-editor .view-lines");
    await page.keyboard.type("print(1)");
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await waitFor(page, () => !!document.querySelector(".nb-banner"), [], 30000, "the banner").catch(() => {});
    const banner = await page.evaluate(() => document.querySelector(".nb-banner")?.innerText ?? "");
    check(banner.includes("Install ipykernel"), "missing ipykernel: banner with an Install button");
    check(await page.evaluate(() => document.querySelectorAll(".nb-cell.running, .nb-cell.queued").length === 0), "the cell isn't left running");
    await page.screenshot({ path: path.join(shots, "6-missing.png") });
  } finally {
    await browser.close();
  }
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
console.log(`screenshots in ${shots}`);
process.exit(failures.length ? 1 : 0);
