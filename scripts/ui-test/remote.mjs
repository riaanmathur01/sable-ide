// End-to-end test of remote development (src/store/remoteStore.ts), with
// stand-ins for the remote_* backend commands. remote_call stands in for
// Sable's agent by running the inner command on the backend bridge (the
// agent runs the same functions), on a temp "remote home" folder:
//
//   - Connect through the status bar: the remote menu, SSH hosts from
//     ~/.ssh/config, typing a new user@host, connecting to a host.
//   - The remote folder picker: starts in the remote home, goes into a
//     folder, opens it; a typed path ("Go to …"), including a LONG one (a
//     deeply nested folder whose path is wider than the picker), opens.
//   - Working in the remote folder: the Explorer and the editor read
//     through the agent; Sable's own files (settings, plugins) stay local;
//     debugging is routed to the agent; the folder is remembered.
//   - Ports: the Ports tab, ports listening on the remote (ports:changed),
//     forwarding one (remote_forward_port), automatic forwarding of a port
//     that opens later, opening it in the browser, stopping a forward.
//   - Askpass: the backend asks for a password/passphrase (remote:askpass),
//     the answer typed in the dialog reaches remote_askpass_answer; Escape
//     cancels (a null answer).
//   - A lost connection offers Reconnect, which reconnects to the same folder.
//   - Close Remote Connection: back to local, forgotten for the next launch.
//   - Reconnect on launch (sable.lastRemote).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/remote.mjs
//
// with Vite and the bridge running (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, realErrors, tauriStandins, waitFor, palette, openPalette, BRIDGE_PORT } from "./helpers.mjs";

const { check, known, finish } = checker();
const shots = shotsDir("remote");
const base = tempDir("remote");
const localWorkspace = writeTree(path.join(base, "localws"), { "local.txt": "local\n" });
// A deeply nested folder: its path is much wider than the 600px picker.
const longParts = ["a-rather-long-folder-name-for-testing", "another-quite-long-nested-folder-name", "and-yet-one-more-deeply-nested-level", "the-deepest-folder-at-the-very-end"];
const remoteHome = writeTree(path.join(base, "home"), {
  "proj/README.md": "# Remote project\n",
  "proj/src/main.py": "print('remote')\n",
  "other/notes.txt": "other\n",
  [`other/${longParts.join("/")}/deep.txt`]: "deep\n",
});
const longPath = `${remoteHome}/other/${longParts.join("/")}`;

// --- Stand-ins for the remote commands -------------------------------------------------------------
const remoteCalls = [];
const connects = [];
const forwards = [];
const stopped = [];
const askpassAnswers = [];
let disconnects = 0;
let nextLocalPort = 41000;
const viaBridge = async (cmd, args) => {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/invoke`, { method: "POST", body: JSON.stringify({ cmd, args }) });
  return response.json();
};
extraStandins.remote_targets = { ssh: [{ name: "devbox", hostname: "10.0.0.5", user: "me" }], wsl: [], containers: [{ name: "web", image: "node:20", engine: "docker" }] };
extraStandins.remote_connect = ({ target }) => {
  connects.push(target);
  return { target, label: `SSH: ${target.host}`, agent: { version: "0.3.5", protocol: 1, os: "linux", arch: "x86_64", home: remoteHome, hostname: "devbox", tmp: "/tmp" } };
};
extraStandins.remote_disconnect = () => {
  disconnects += 1;
  return null;
};
extraStandins.remote_forward_port = ({ remotePort }) => {
  forwards.push(remotePort);
  return nextLocalPort++;
};
extraStandins.remote_stop_forward = ({ remotePort }) => {
  stopped.push(remotePort);
  return null;
};
extraStandins.remote_askpass_answer = ({ id, answer }) => {
  askpassAnswers.push({ id, answer });
  return null;
};
const AGENT_ONLY = ["watch_workspace", "watch_folders", "create_terminal", "kill_terminal", "resize_terminal", "write_terminal", "stop_language_servers", "python_formatter", "ports_watch", "start_debug"];
extraStandins.remote_call = async ({ cmd, args }) => {
  remoteCalls.push({ cmd, args });
  if (cmd === "discover_python_interpreters") return [];
  if (AGENT_ONLY.includes(cmd)) return null;
  if (cmd === "start_language_server" || cmd === "lsp_request") throw "No language server running";
  const result = await viaBridge(cmd, args);
  if (result.unknown) return null;
  if ("err" in result) throw result.err;
  return result.ok;
};

// The driver sets sable.lastFolder (the local workspace) on every load; for
// the relaunch below, the last folder is the remote one (as the app saves it).
const init = `${tauriStandins({ "plugin:opener|open_url": null })};
  (() => {
    const last = localStorage.getItem("sable-test.lastFolder");
    if (window === window.top && last) localStorage.setItem("sable.lastFolder", last);
  })()`;
const { browser, page, errors } = await openSable(localWorkspace, { width: 1400, height: 850, init });
try {
  await sleep(1500);
  const remoteItem = () => page.$eval(".status-bar-remote", (el) => ({ text: el.textContent.trim(), cls: el.className })).catch(() => null);
  const pickItems = () => texts(page, "[data-index]");
  const sidebarTitle = async () => ((await texts(page, ".sidebar-title"))[0] ?? "").toLowerCase();
  const choose = async (text) => {
    await page.keyboard.type(text);
    await sleep(300);
    await page.keyboard.press("Enter");
    await sleep(700);
  };
  const store = (fn, ...args) => page.evaluate(fn, ...args);

  // --- Local first ------------------------------------------------------------------------------------
  check("local workspace opens", (await sidebarTitle()) === "localws", await sidebarTitle());
  check("status bar offers remote (icon only)", (await remoteItem())?.text === "", JSON.stringify(await remoteItem()));
  await openPalette(page);
  await page.keyboard.type("Remote: Show Ports");
  await sleep(300);
  check("no Ports command in a local window", !(await pickItems()).some((t) => t.startsWith("Remote: Show Ports")), (await pickItems()).join(" | "));
  await page.keyboard.press("Escape");
  await sleep(300);

  // --- Connect --------------------------------------------------------------------------------------
  await page.click(".status-bar-remote");
  await sleep(500);
  const menu = await pickItems();
  check("remote menu offers SSH and containers", menu.some((t) => t.startsWith("Connect to SSH Host")) && menu.some((t) => t.startsWith("Attach to Running Container")), menu.join(" | "));
  await choose("SSH Host");
  await sleep(300);
  const hosts = await pickItems();
  check("hosts from ~/.ssh/config", hosts.some((t) => t.includes("devbox") && t.includes("me@10.0.0.5")), hosts.join(" | "));
  await page.keyboard.type("me@elsewhere");
  await sleep(300);
  check("typing offers a new host", (await pickItems())[0]?.startsWith("Connect to me@elsewhere"), (await pickItems())[0]);
  await page.keyboard.press("Escape");
  await sleep(300);
  check("Escape connects nowhere", connects.length === 0, JSON.stringify(connects));
  await page.click(".status-bar-remote");
  await sleep(400);
  await choose("SSH Host");
  await sleep(300);
  await choose("devbox");
  await sleep(500);
  check("connects to the chosen host", connects.length === 1 && connects[0].kind === "ssh" && connects[0].host === "devbox", JSON.stringify(connects));
  const folders = await pickItems();
  check("folder picker starts in the remote home", folders[0]?.startsWith("Open ~") && folders.some((t) => t.startsWith("proj/")) && folders.some((t) => t.startsWith("other/")), folders.join(" | "));
  await page.screenshot({ path: `${shots}/remote-picker.png` });
  await choose("proj/");
  await sleep(300);
  const inProj = await pickItems();
  check("picker goes into a folder", inProj[0]?.startsWith("Open ~/proj") && inProj.some((t) => t.startsWith("src/")), inProj.join(" | "));
  await page.keyboard.press("Enter");
  await sleep(1500);

  // --- Working in the remote folder ------------------------------------------------------------------
  check("remote folder opens", (await sidebarTitle()) === "proj", await sidebarTitle());
  const tree = await texts(page, ".tree-row-name");
  check("explorer lists remote files", tree.some((t) => t.includes("README.md")) && tree.some((t) => t === "src"), tree.slice(0, 6).join(" | "));
  check("listing went to the agent", remoteCalls.some((c) => c.cmd === "read_directory" && c.args.path === `${remoteHome}/proj`));
  const item = await remoteItem();
  check("status bar shows the connection", item?.text === "SSH: devbox" && item.cls.includes("connected"), JSON.stringify(item));
  await clickText(page, "README.md", ".tree-row-name");
  await sleep(2000);
  const lines = await page.$$eval(".view-line", (l) => l.map((x) => x.textContent.replace(/ /g, " ")).join("|"));
  check("remote file opens in the editor", lines.includes("# Remote project"), lines);
  check("…read through the agent", remoteCalls.some((c) => c.cmd === "read_file" && c.args.path === `${remoteHome}/proj/README.md`));
  await page.screenshot({ path: `${shots}/remote-editor.png` });
  const debugCallsBefore = remoteCalls.filter((c) => c.cmd === "start_debug").length;
  const routing = await store(async (remoteHome) => {
    const backend = await import("/src/lib/backend.ts");
    await backend.invoke("start_debug", {}).catch(() => {});
    return {
      remoteFile: backend.runsRemotely("read_file", { path: `${remoteHome}/proj/README.md` }),
      settings: backend.runsRemotely("read_file", { path: "/tmp/sable-ui-settings.json" }),
      plugins: backend.runsRemotely("plugin_list", {}),
      debug: backend.runsRemotely("start_debug", {}),
    };
  }, remoteHome);
  check("Sable's own files stay local", routing.remoteFile && !routing.settings && !routing.plugins, JSON.stringify(routing));
  check("debugging runs on the remote (through the agent)", routing.debug && remoteCalls.filter((c) => c.cmd === "start_debug").length === debugCallsBefore + 1, JSON.stringify(routing));
  const saved = await store(() => JSON.parse(localStorage.getItem("sable.lastRemote")));
  check("remembers the remote folder", saved?.target?.host === "devbox" && saved.folder === `${remoteHome}/proj`, JSON.stringify(saved));

  // --- Ports ------------------------------------------------------------------------------------------
  check("ports are watched on the remote", remoteCalls.some((c) => c.cmd === "ports_watch"));
  const shown = await palette(page, "Remote: Show Ports");
  check("Remote: Show Ports in the palette", shown?.startsWith("Remote: Show Ports"), shown);
  const tabs = await texts(page, "[role=tab]");
  check("…opens the Ports tab of the bottom panel", tabs.some((t) => /^ports/i.test(t)) && (await page.$(".ports-panel")) !== null, tabs.join(", "));
  check("Ports panel: empty at first", Boolean(await page.$(".ports-empty")) && (await page.$eval(".ports-toolbar", (el) => el.textContent)).includes("SSH: devbox"));
  // Ports already open when connecting aren't forwarded by themselves.
  await store(() => window.__sableEmit("ports:changed", [{ port: 22 }, { port: 5432 }]));
  await sleep(400);
  let rows = await texts(page, ".ports-table tbody tr");
  check("listening ports are listed, not forwarded", rows.length === 2 && rows.every((r) => r.includes("not forwarded")) && forwards.length === 0, rows.join(" | "));
  await page.click(".ports-table tbody tr:nth-child(2) .ports-forward");
  await sleep(400);
  rows = await texts(page, ".ports-table tbody tr");
  check("Forward forwards a listening port", forwards.join() === "5432" && rows.some((r) => r.includes("5432") && r.includes("localhost:41000") && r.includes("by you")), rows.join(" | "));
  // A dev server starting later is forwarded automatically.
  await store(() => window.__sableEmit("ports:changed", [{ port: 22 }, { port: 5432 }, { port: 3000 }]));
  await sleep(600);
  rows = await texts(page, ".ports-table tbody tr");
  check("a port that opens later is forwarded automatically", forwards.join() === "5432,3000" && rows.some((r) => r.includes("3000") && r.includes("localhost:41001") && r.includes("automatic")), rows.join(" | "));
  const badge = await page.$$eval("[role=tab]", (tabs) => tabs.find((t) => t.textContent.startsWith("Ports"))?.querySelector(".terminal-panel-badge")?.textContent ?? null);
  check("the Ports tab counts forwarded ports", badge === "2", badge);
  await clickText(page, "localhost:41001", ".ports-link");
  await sleep(300);
  const opened = await store(() => window.__tauriCalls.filter((c) => c.cmd === "plugin:opener|open_url").map((c) => c.args.url));
  check("a forwarded port opens in the browser", opened.includes("http://localhost:41001"), opened.join(", "));
  await page.evaluate(() => [...document.querySelectorAll(".ports-table tbody tr")].find((r) => r.textContent.includes("3000")).querySelector('button[title="Stop forwarding"]').click());
  await sleep(400);
  rows = await texts(page, ".ports-table tbody tr");
  check("Stop forwarding stops it", stopped.join() === "3000" && rows.some((r) => r.includes("3000") && r.includes("not forwarded")), rows.join(" | "));
  // Forward a Port… by number.
  await clickText(page, "Forward a Port…", ".ports-button");
  await sleep(400);
  await page.keyboard.type("8080");
  await sleep(300);
  check("Forward a Port… takes a typed number", (await pickItems())[0]?.startsWith("Forward port 8080"), (await pickItems()).join(" | "));
  await page.keyboard.press("Enter");
  await sleep(500);
  rows = await texts(page, ".ports-table tbody tr");
  check("…and forwards it", forwards.at(-1) === 8080 && rows.some((r) => r.startsWith("8080") && r.includes("by you")), rows.join(" | "));
  await page.screenshot({ path: `${shots}/remote-ports.png` });

  // --- Askpass ----------------------------------------------------------------------------------------
  await store(() => window.__sableEmit("remote:askpass", { id: 7, prompt: "Enter passphrase for key '/home/me/.ssh/id_ed25519':" }));
  await sleep(400);
  const dialog = await page.$eval(".askpass-dialog", (el) => ({ text: el.innerText, type: el.querySelector("input").type, focused: document.activeElement === el.querySelector("input") })).catch(() => null);
  check("askpass: the dialog shows ssh's prompt", dialog?.text.includes("Enter passphrase for key") && dialog.text.includes("SSH: devbox"), dialog?.text);
  check("askpass: a secret input, focused", dialog?.type === "password" && dialog.focused, JSON.stringify(dialog));
  await page.screenshot({ path: `${shots}/remote-askpass.png` });
  await page.keyboard.type("s3cret pass");
  await page.keyboard.press("Enter");
  await sleep(400);
  check("askpass: the answer reaches the backend", askpassAnswers.length === 1 && askpassAnswers[0].id === 7 && askpassAnswers[0].answer === "s3cret pass", JSON.stringify(askpassAnswers));
  check("askpass: the dialog closes", (await page.$(".askpass-dialog")) === null);
  // The same prompt delivered twice is asked once; a yes/no question isn't secret; Escape cancels.
  await store(() => window.__sableEmit("remote:askpass", { id: 7, prompt: "again?" }));
  await store(() => window.__sableEmit("remote:askpass", { id: 8, prompt: "Are you sure you want to continue connecting (yes/no/[fingerprint])?" }));
  await sleep(400);
  const question = await page.$eval(".askpass-dialog", (el) => ({ text: el.innerText, type: el.querySelector("input").type })).catch(() => null);
  check("askpass: a repeated prompt isn't asked again; a yes/no question is plain text", question?.text.includes("continue connecting") && question.type === "text", JSON.stringify(question));
  await page.keyboard.press("Escape");
  await sleep(400);
  check("askpass: Escape cancels (no answer)", askpassAnswers.length === 2 && askpassAnswers[1].id === 8 && askpassAnswers[1].answer === null && (await page.$(".askpass-dialog")) === null, JSON.stringify(askpassAnswers));

  // --- Lost, then reconnect ---------------------------------------------------------------------------
  const forwardsBefore = forwards.length;
  await store(() => window.__sableEmit("remote:status", { state: "disconnected", label: "SSH: devbox", message: "Connection reset by peer" }));
  await sleep(300);
  const lost = await remoteItem();
  check("a lost connection offers Reconnect", lost?.cls.includes("lost") && lost.text.includes("Reconnect"), JSON.stringify(lost));
  await page.click(".status-bar-remote");
  await sleep(1500);
  check("Reconnect reconnects to the same folder", connects.length === 2 && (await remoteItem())?.cls.includes("connected") && (await sidebarTitle()) === "proj", `${connects.length} connects, ${await sidebarTitle()}`);
  check("…and forwards the ports again", forwards.slice(forwardsBefore).sort().join() === "5432,8080", forwards.join());

  // --- Typed path in the folder picker (a long one) -------------------------------------------------
  await page.click(".status-bar-remote");
  await sleep(400);
  await choose("Open Folder");
  await sleep(300);
  await page.keyboard.type(longPath, { delay: 0 });
  await sleep(400);
  const typed = await page.evaluate(() => {
    const input = document.querySelector(".palette-input");
    const palette = document.querySelector(".palette").getBoundingClientRect();
    const label = document.querySelector("[data-index='0'] .palette-item-label")?.getBoundingClientRect();
    return {
      value: input.value,
      first: document.querySelector("[data-index='0']")?.innerText.trim(),
      wider: input.scrollWidth > input.clientWidth,
      caretVisible: input.scrollLeft > 0,
      labelFits: label ? label.right <= palette.right + 1 : null,
      labelWhole: (() => { const node = document.querySelector("[data-index='0'] .palette-item-label"); return node ? node.scrollWidth <= node.clientWidth + 1 : null; })(),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  // A long typed path is shown by its end (the part being typed).
  check("typed paths in the folder picker: Go to …", typed.first?.startsWith("Go to …") && typed.first.endsWith(longPath.slice(-40)) && typed.value === longPath, JSON.stringify(typed));
  check("the long path is wider than the picker, and the input shows its end", typed.wider && typed.caretVisible, JSON.stringify(typed));
  check("the long path doesn't widen the window", !typed.overflow, JSON.stringify(typed));
  check("the long Go to … label fits in the picker, its end readable", typed.labelFits && typed.labelWhole, JSON.stringify(typed));
  await page.screenshot({ path: `${shots}/remote-long-path.png` });
  await page.keyboard.press("Enter");
  await sleep(700);
  const inLong = await pickItems();
  check("the picker goes to the typed folder", inLong[0] === `Open ~/other/${longParts.join("/")}` || inLong[0]?.startsWith(`Open ~/other/${longParts.join("/")}`), inLong.join(" | "));
  await page.keyboard.press("Enter");
  await sleep(1500);
  check("opens the typed (long) folder", (await sidebarTitle()) === longParts.at(-1) && (await texts(page, ".tree-row-name")).includes("deep.txt"), await sidebarTitle());
  // A short typed path relative to home.
  await page.click(".status-bar-remote");
  await sleep(400);
  await choose("Open Folder");
  await sleep(300);
  await page.keyboard.type("~/other");
  await sleep(300);
  check("a ~/ path in the folder picker", (await pickItems())[0]?.startsWith("Go to ~/other"), (await pickItems())[0]);
  await page.keyboard.press("Enter");
  await sleep(600);
  await page.keyboard.press("Enter");
  await sleep(1500);
  check("opens the typed folder", (await sidebarTitle()) === "other", await sidebarTitle());

  // --- Close ------------------------------------------------------------------------------------------
  await page.click(".status-bar-remote");
  await sleep(400);
  await choose("Close Remote");
  await sleep(1000);
  check("Close Remote Connection disconnects", disconnects >= 1 && (await remoteItem())?.text === "", `${disconnects} ${JSON.stringify(await remoteItem())}`);
  check("…and closes the remote folder", (await sidebarTitle()) !== "other", await sidebarTitle());
  check("…and forgets it for next launch", (await store(() => localStorage.getItem("sable.lastRemote"))) === null);
  const portsAfter = await store(async () => {
    const state = (await import("/src/store/remoteStore.ts")).useRemoteStore.getState();
    return { listening: state.listening.length, forwarded: state.forwarded.length, rows: document.querySelectorAll(".ports-table tbody tr").length };
  });
  check("…and forgets its ports", portsAfter.listening === 0 && portsAfter.forwarded === 0 && portsAfter.rows === 0, JSON.stringify(portsAfter));
  const before = remoteCalls.length;
  const localRouting = await store(async () => (await import("/src/lib/backend.ts")).runsRemotely("read_file", { path: "/x" }));
  check("commands run locally again", localRouting === false && remoteCalls.length === before);

  // --- Reconnect on launch ------------------------------------------------------------------------------
  await store((folder) => {
    localStorage.setItem("sable.lastRemote", JSON.stringify({ target: { kind: "ssh", host: "devbox" }, folder }));
    localStorage.setItem("sable-test.lastFolder", folder);
  }, `${remoteHome}/proj`);
  const connectsBefore = connects.length;
  const callsBefore = remoteCalls.length;
  await page.reload({ waitUntil: "networkidle0" });
  const relaunched = await waitFor(page, () => document.querySelector(".status-bar-remote.connected")?.textContent.trim() ?? null);
  await sleep(1000);
  check(
    "reopens a remote folder on launch",
    connects.length === connectsBefore + 1 && relaunched === "SSH: devbox" && (await sidebarTitle()) === "proj" && remoteCalls.some((c, i) => i >= callsBefore && c.cmd === "read_directory" && c.args.path === `${remoteHome}/proj`),
    `${connects.length - connectsBefore} connects, ${relaunched}, ${await sidebarTitle()}`,
  );

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(base, { recursive: true, force: true });
}
finish();
