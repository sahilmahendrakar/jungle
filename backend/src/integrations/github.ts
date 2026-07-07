import type { ConfigureFrame } from "@jungle/shared";
import type * as db from "../db";
import * as gh from "../github";
import type { IntegrationAdapter } from "./types";

// GitHub integration: the agent gets a repo cloned into /workspace/repo with a short-lived
// installation token so it can read code, commit, and open PRs via git + the gh CLI. Config is a
// single { repo: "owner/name" } field (stored as-is — no resolveConfig). The installation token
// hard-expires at ~1h, so it's re-minted before every drain via refreshCredentials.

function repoOf(config: Record<string, unknown>): string | null {
  const repo = config.repo;
  return typeof repo === "string" && repo ? repo : null;
}

// The system-prompt block advertising the repo. Shown whenever a repo is configured — even if the
// token mint below fails — matching the pre-registry behavior (the runner clones on first turn and
// can fall back to `gh` if the handed token is missing).
function promptBlock(agent: db.AgentRow, repo: string): string {
  const gitName = agent.display_name || agent.handle;
  const gitEmail = `${agent.handle}@agents.jungle.dev`;
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

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const repo = repoOf(config);
    if (!repo) return null;
    if (gh.appAuthConfigured()) {
      try {
        const token = await gh.installationTokenForRepo(repo);
        // repoUrl makes the runner clone into /workspace/repo before its first turn.
        frame.git = { token, login: agent.handle, repoUrl: `https://github.com/${repo}.git` };
      } catch (e) {
        console.error(`runner[${agent.id}] configure: could not mint git token:`, e);
      }
    }
    return promptBlock(agent, repo);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const repo = repoOf(config);
    if (!repo || !gh.appAuthConfigured()) return;
    try {
      const token = await gh.installationTokenForRepo(repo);
      send({ type: "git_credentials", token, login: agent.handle });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh git token:`, e);
    }
  },
};
