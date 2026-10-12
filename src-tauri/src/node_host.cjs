// Sable's Node extension host: runs one plugin (a VS Code extension made
// for Node) in this Node process. The plugin API is the same as in the
// sandboxed worker — the bootstrap Sable sends first is the worker's own
// (lib/plugins/workerBootstrap.ts), given a `self` that talks over
// stdin/stdout instead of postMessage. Protocol lines on stdout start with
// "\x1eSABLE "; anything else the extension prints is passed on as a log.
//
//   node node_host.cjs <plugin folder>
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const readline = require("readline");

const pluginDir = process.argv[2];
const PREFIX = "\x1eSABLE ";
const write = (message) => process.stdout.write(`${PREFIX}${JSON.stringify(message)}\n`);

let onmessage = null;
const early = [];
const scope = {
  console,
  postMessage: write,
  get onmessage() {
    return onmessage;
  },
  set onmessage(handler) {
    onmessage = handler;
    for (const message of early.splice(0)) handler({ data: message });
  },
};
globalThis.self = scope;

/** The plugin "module" the bootstrap imports: the extension, under the shim. */
function pluginModule() {
  const extension = JSON.parse(fs.readFileSync(path.join(pluginDir, "extension.json"), "utf8"));
  const shim = require(path.join(__dirname, "vscode_shim.cjs"));
  const entry = path.join(pluginDir, extension.nodeEntry);
  return {
    activate: (api) => shim.activateNode(api, extension, entry, path.join(pluginDir, "extension")),
    deactivate: () => shim.deactivate(),
  };
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "bootstrap") {
    vm.runInThisContext(message.source, { filename: "sable-plugin-bootstrap.js" });
    scope.__sableImport = async () => pluginModule();
    return;
  }
  if (onmessage) onmessage({ data: message });
  else early.push(message);
});

process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (error) => console.error(error && error.stack ? error.stack : String(error)));
process.on("unhandledRejection", (error) => console.error(error && error.stack ? error.stack : String(error)));
