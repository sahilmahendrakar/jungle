// Persist minimal runner state to /workspace/.jungle/state.json so the agent's
// session id (and thus its memory) survives container restarts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const STATE_DIR = process.env.JUNGLE_STATE_DIR ?? "/workspace/.jungle";
const STATE_FILE = path.join(STATE_DIR, "state.json");

// The runner's private state directory (session/model state, services registry + logs).
// Cloud runners default to the workspace volume; the self-hosted daemon points this at the
// agent's per-agent state dir via JUNGLE_STATE_DIR.
export function stateDir(): string {
  return STATE_DIR;
}

export interface PersistedState {
  sessionId: string | null;
  model: string | null;
}

export async function loadState(): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
    };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("failed to read state file, starting fresh", { err: String(err) });
    }
    return { sessionId: null, model: null };
  }
}

let writeChain: Promise<void> = Promise.resolve();

// Serialized atomic write (temp file + rename) so concurrent saves don't corrupt.
export function saveState(state: PersistedState): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      const tmp = STATE_FILE + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(tmp, STATE_FILE);
    } catch (err) {
      log.error("failed to persist state", { err: String(err) });
    }
  });
  return writeChain;
}
