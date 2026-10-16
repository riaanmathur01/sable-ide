// Unit tests for the ACP client (src/lib/acp): its JSON-RPC peer and the
// line diff behind reviewing an agent's edits.
//
//   node scripts/unit-test/acp.mjs
//
// Bundles acp.test.ts with esbuild into a temp dir and runs it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sable-unit-"));
const bundle = path.join(out, "acp.test.mjs");
execFileSync(
  path.join(root, "node_modules/.bin/esbuild"),
  [path.join(root, "scripts/unit-test/acp.test.ts"), "--bundle", "--platform=node", "--format=esm", "--log-level=warning", `--outfile=${bundle}`],
  { stdio: "inherit" },
);
try {
  execFileSync(process.execPath, [bundle], { stdio: "inherit", env: { ...process.env, SABLE_ROOT: root } });
} catch {
  process.exitCode = 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
