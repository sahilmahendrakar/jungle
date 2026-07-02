// Entrypoint: read env, construct the Runner, wire process signals.
import { Runner } from "./runner.js";
import { log } from "./log.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const wsUrl = requireEnv("JUNGLE_BACKEND_WS");
  const token = requireEnv("JUNGLE_RUNNER_TOKEN");
  requireEnv("ANTHROPIC_API_KEY"); // consumed by the SDK from the environment

  // agentId is informational for the hello frame; the token is what authenticates.
  const agentId = process.env.JUNGLE_AGENT_ID ?? "unknown";

  const runner = new Runner({ agentId, wsUrl, token });

  process.on("SIGTERM", () => {
    log.info("received SIGTERM, exiting");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log.info("received SIGINT, exiting");
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { err: String(err), stack: (err as Error)?.stack });
    try {
      runner.fatal(String(err));
    } catch {
      /* ignore */
    }
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason) });
  });

  await runner.start();
}

main().catch((err) => {
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
