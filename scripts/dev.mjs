// Run backend + frontend dev servers together.
// Run: npm run dev
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const children = [
  spawn(npm, ["run", "dev:backend"], { cwd: root, stdio: "inherit", shell: true }),
  spawn(npm, ["run", "dev:frontend"], { cwd: root, stdio: "inherit", shell: true }),
];

let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || exiting) return;
    shutdown(code ?? 1);
  });
}
