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
// Portability (self-hosted): the repo clones inside the workspace (not a hardcoded /workspace), and
// the credential store is redirectable via JUNGLE_GIT_CREDENTIALS. On a user's own machine the
// daemon points JUNGLE_GIT_CREDENTIALS + GIT_CONFIG_GLOBAL into the agent's private state dir so the
// agent never clobbers the person's real ~/.gitconfig / ~/.git-credentials. In a container both are
// unset and this stays exactly as before (~/.git-credentials, global gitconfig).
const WORKSPACE = process.env.JUNGLE_WORKSPACE ?? "/workspace";
const CREDENTIALS_FILE = process.env.JUNGLE_GIT_CREDENTIALS ?? path.join(HOME, ".git-credentials");
const REPO_DIR = path.join(WORKSPACE, "repo");

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
    // Point the store helper explicitly at our file so it works regardless of HOME and never reads
    // the user's default ~/.git-credentials on a self-hosted machine.
    await run("git", ["config", "--global", "credential.helper", `store --file=${CREDENTIALS_FILE}`]);
    // Identity for commits the agent makes.
    await run("git", ["config", "--global", "user.name", user]);
    await run("git", ["config", "--global", "user.email", `${user}@users.noreply.github.com`]);
    log.info("git credentials applied", { login: user });
  } catch (err) {
    log.error("failed to write git credentials", { err: String(err) });
  }
}

// Clone repoUrl into /workspace/repo if it doesn't already exist there. Retries with
// backoff: a just-minted GitHub App installation token can 404 ("Repository not found")
// on GitHub's git endpoints for a few seconds until it propagates.
//
// Skipped entirely when JUNGLE_AUTO_CLONE_REPO=0: an unsandboxed self-hosted device roots the
// agent's workspace at the user's real connect directory (their own repo), so cloning into
// <workspace>/repo would nest or collide. Credentials are still applied above, so the agent can
// push against the repo that's already checked out in its cwd.
export async function cloneRepoIfNeeded(repoUrl: string): Promise<void> {
  if (process.env.JUNGLE_AUTO_CLONE_REPO === "0") {
    log.info("auto-clone suppressed (unsandboxed device); using repo in cwd", { repoUrl });
    return;
  }
  try {
    await fs.access(path.join(REPO_DIR, ".git"));
    log.info("repo already present, skipping clone", { dir: REPO_DIR });
    return;
  } catch {
    // not present -> clone
  }
  const env = { ...process.env };
  if (currentToken) env.GH_TOKEN = currentToken;
  const delays = [0, 2000, 5000, 10000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    log.info("cloning repo", { repoUrl, dir: REPO_DIR, attempt: attempt + 1 });
    const { code, stderr } = await run("git", ["clone", repoUrl, REPO_DIR], { env });
    if (code === 0) {
      log.info("git clone complete", { dir: REPO_DIR });
      return;
    }
    log.warn("git clone failed", { code, attempt: attempt + 1, stderr: stderr.slice(0, 300) });
  }
  log.error("git clone failed after all retries; agent will have to clone manually", { repoUrl });
}
