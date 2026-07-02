// GitHub credential handling for the SDK's child git/gh processes.
// - Write ~/.git-credentials (https://x-access-token:TOKEN@github.com)
// - Ensure `credential.helper store` in the global gitconfig
// - Track GH_TOKEN so it can be injected into the SDK `env` for child processes
// - Optionally clone the configured repo into /workspace/repo
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "./log.js";

const HOME = process.env.HOME ?? os.homedir();
const CREDENTIALS_FILE = path.join(HOME, ".git-credentials");
const REPO_DIR = "/workspace/repo";

// Latest known token, injected into the SDK env option (see runner.ts).
let currentToken: string | null = null;

export function getGhToken(): string | null {
  return currentToken;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

// Write/refresh the git credential store and configure the helper. Never logs the token.
export async function applyGitCredentials(token: string, login: string): Promise<void> {
  currentToken = token;
  const user = login || "x-access-token";
  const line = `https://x-access-token:${token}@github.com\n`;
  try {
    await fs.writeFile(CREDENTIALS_FILE, line, { mode: 0o600 });
    await run("git", ["config", "--global", "credential.helper", "store"]);
    // Identity for commits the agent makes.
    await run("git", ["config", "--global", "user.name", user]);
    await run("git", ["config", "--global", "user.email", `${user}@users.noreply.github.com`]);
    log.info("git credentials applied", { login: user });
  } catch (err) {
    log.error("failed to write git credentials", { err: String(err) });
  }
}

// Clone repoUrl into /workspace/repo if it doesn't already exist there.
export async function cloneRepoIfNeeded(repoUrl: string): Promise<void> {
  try {
    await fs.access(path.join(REPO_DIR, ".git"));
    log.info("repo already present, skipping clone", { dir: REPO_DIR });
    return;
  } catch {
    // not present -> clone
  }
  log.info("cloning repo", { repoUrl, dir: REPO_DIR });
  const env = { ...process.env };
  if (currentToken) env.GH_TOKEN = currentToken;
  const { code, stderr } = await run("git", ["clone", repoUrl, REPO_DIR], { env });
  if (code !== 0) {
    log.error("git clone failed", { code, stderr: stderr.slice(0, 500) });
  } else {
    log.info("git clone complete", { dir: REPO_DIR });
  }
}
