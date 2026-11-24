// Runs every compiled test file with the Node test runner.
// `node --test <dir>` and glob arguments behave differently across Node 20/22/24,
// so the file list is built explicitly here.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Only run compiled files whose source still exists in test/ (tsc never deletes stale output).
const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join("dist", "test", f.replace(/\.ts$/, ".js")))
  .filter((f) => existsSync(f));
if (files.length === 0) {
  console.error("No compiled tests found in dist/test. Run `npm run build` first.");
  process.exit(1);
}

// A hung test should fail with its name instead of stalling CI until the job timeout.
// --test-timeout exists from Node 20.11 / 21.2; skip it on older runtimes.
const [major, minor] = process.versions.node.split(".").map(Number);
const hasTestTimeout = major >= 22 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11);
const flags = ["--test"];
if (hasTestTimeout) flags.push("--test-timeout=120000");

console.log(`node ${process.version} on ${process.platform}-${process.arch}: ${files.length} test files`);
const r = spawnSync(process.execPath, [...flags, ...files], { stdio: "inherit" });
if (r.error) console.error(r.error);
if (r.signal) console.error(`test runner killed by ${r.signal}`);
process.exit(r.status ?? 1);
