import type { ConfigureFrame } from "@jungle/shared";
import { ApiError } from "../http/errors";
import type * as db from "../db";
import * as gh from "../github";
import type { IntegrationAdapter } from "./types";

// GitHub integration: the agent gets a repo cloned into /workspace/repo with a short-lived
// installation token so it can read code, commit, and open PRs via git + the gh CLI. Config is
// { repo: "owner/name", authorName?, authorEmail? } — the optional author fields set the agent's
// git commit identity so commits can be attributed to a real GitHub account (the email must be
// one on that account; its `12345+login@users.noreply.github.com` noreply works). Without them
// commits use the default <display name> / <handle>@agents.jungle.dev identity, which GitHub
// shows as unverified. The installation token hard-expires at ~1h, so it's re-minted before
// every drain via refreshCredentials.

function repoOf(config: Record<string, unknown>): string | null {
  const repo = config.repo;
  return typeof repo === "string" && repo ? repo : null;
}

function optConfigString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// The agent's commit identity: the integration's configured author name/email when set, else the
// default (<display name> / <handle>@agents.jungle.dev). Each field falls back independently.
// Used both in the prompt block below and as ConfigureFrame.git.authorName/authorEmail so the
// runner's global git config agrees.
function gitIdentity(agent: db.AgentRow, config: Record<string, unknown>): { name: string; email: string } {
  return {
    name: optConfigString(config.authorName) || agent.display_name || agent.handle,
    email: optConfigString(config.authorEmail) || `${agent.handle}@agents.jungle.dev`,
  };
}

// The system-prompt block advertising the repo. Shown whenever a repo is configured — even if the
// token mint below fails — matching the pre-registry behavior (the runner clones on first turn and
// can fall back to `gh` if the handed token is missing).
function promptBlock(agent: db.AgentRow, repo: string, config: Record<string, unknown>): string {
  const { name: gitName, email: gitEmail } = gitIdentity(agent, config);
  return (
    `\n\n— Working on ${repo} —\n` +
    `The repo is already cloned at /workspace/repo with git credentials configured ` +
    `(if it's ever missing, clone it yourself with gh). Make and COMMIT changes with git so ` +
    `commits are authored as you. Before committing, run once:\n` +
    `  git config user.name ${JSON.stringify(gitName)}\n` +
    `  git config user.email ${JSON.stringify(gitEmail)}\n` +
    `Then push your branch and open the pull request.`
  );
}

export const githubAdapter: IntegrationAdapter = {
  key: "github",

  // Validate + normalize the optional commit-identity fields (repo is required by the route's
  // configFields check). Empty strings are dropped rather than persisted.
  async resolveConfig(_ctx, rawConfig): Promise<Record<string, unknown>> {
    const config = { ...rawConfig };
    const authorName = optConfigString(config.authorName);
    const authorEmail = optConfigString(config.authorEmail);
    if (authorName.length > 100) {
      throw new ApiError(400, "Commit author name must be at most 100 characters");
    }
    if (authorEmail && (authorEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail))) {
      throw new ApiError(400, "Commit author email must be a valid email address");
    }
    if (authorName) config.authorName = authorName;
    else delete config.authorName;
    if (authorEmail) config.authorEmail = authorEmail;
    else delete config.authorEmail;
    return config;
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const repo = repoOf(config);
    if (!repo) return null;
    if (gh.appAuthConfigured()) {
      try {
        const token = await gh.installationTokenForRepo(repo);
        // repoUrl makes the runner clone into /workspace/repo before its first turn; authorName/
        // authorEmail set its git commit identity (default-derived when unconfigured).
        const { name, email } = gitIdentity(agent, config);
        frame.git = {
          token,
          login: agent.handle,
          repoUrl: `https://github.com/${repo}.git`,
          authorName: name,
          authorEmail: email,
        };
      } catch (e) {
        console.error(`runner[${agent.id}] configure: could not mint git token:`, e);
      }
    }
    return promptBlock(agent, repo, config);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const repo = repoOf(config);
    if (!repo || !gh.appAuthConfigured()) return;
    try {
      const token = await gh.installationTokenForRepo(repo);
      const { name, email } = gitIdentity(agent, config);
      send({ type: "git_credentials", token, login: agent.handle, authorName: name, authorEmail: email });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh git token:`, e);
    }
  },
};
