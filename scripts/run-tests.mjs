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
  .map((f) => join("dist/test", f.replace(/\.ts$/, ".js")))
  .filter((f) => existsSync(f));
if (files.length === 0) {
  console.error("No compiled tests found in dist/test. Run `npm run build` first.");
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
