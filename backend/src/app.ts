import express from "express";
import * as auth from "./auth";
import { errorHandler } from "./http/errors";
import participantsRouter from "./http/routes/participants";
import workspacesRouter from "./http/routes/workspaces";
import identityRouter from "./http/routes/identity";
import agentsRouter from "./http/routes/agents";
import attachmentsRouter from "./http/routes/attachments";
import channelsRouter from "./http/routes/channels";
import threadsRouter from "./http/routes/threads";
import githubRouter from "./http/routes/github";
import googleRouter from "./http/routes/google";
import integrationsRouter from "./http/routes/integrations";
import schedulesRouter from "./http/routes/schedules";
import workflowsRouter from "./http/routes/workflows";
import workfeedRouter from "./http/routes/workfeed";
import devicesRouter from "./http/routes/devices";
import pushRouter from "./http/routes/push";
import llmRouter from "./http/routes/llm";
import { slackEventsRouter, slackRouter } from "./http/routes/slack";

// Build the Express app: global middleware, the per-domain routers, and the terminal error
// handler. The http server + WebSocket wiring live in index.ts (boot).
export function createApp(): express.Express {
  const app = express();
  // The LLM inference proxy for self-hosted runners must see the RAW request body (it forwards the
  // Anthropic request verbatim + streams the response), so it is mounted BEFORE express.json().
  app.use(llmRouter);
  // The Slack events webhook verifies its signature over the RAW body, so like the LLM proxy it
  // must be mounted BEFORE express.json(). The rest of the Slack routes are ordinary JSON below.
  app.use(slackEventsRouter);
  app.use(express.json());
  app.use(auth.attachAuth); // populates req.auth when a valid Firebase token is present

  // MVP CORS: the frontend (a different origin in dev) needs to read API responses.
  // Lock the origin down before any real deployment.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "content-type, authorization, x-workspace-id");
    // PUT is load-bearing: attaching/reconfiguring an agent integration is a PUT — omitting it
    // here made every cross-origin integration save die in preflight ("Failed to fetch").
    res.header("Access-Control-Allow-Methods", "GET,PUT,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "jungle-backend" });
  });

  app.use(participantsRouter);
  app.use(workspacesRouter);
  app.use(identityRouter);
  app.use(agentsRouter);
  app.use(attachmentsRouter);
  app.use(channelsRouter);
  app.use(threadsRouter);
  app.use(githubRouter);
  app.use(googleRouter);
  app.use(integrationsRouter);
  app.use(schedulesRouter);
  app.use(workflowsRouter);
  app.use(workfeedRouter);
  app.use(devicesRouter);
  app.use(pushRouter);
  app.use(slackRouter);

  app.use(errorHandler);
  return app;
}
