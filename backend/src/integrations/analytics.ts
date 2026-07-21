import { ApiError } from "../http/errors";
import { createStaticMcpAdapter } from "./mcp-static";

// Analytics integrations: PostHog + Mixpanel, both via their OFFICIAL hosted MCP servers with
// static credentials (no OAuth for headless use). Validation hits each provider's REST API with
// the pasted credential so a typo fails at connect time with a clear message, not silently at an
// agent's 8am run. Region (data residency) is auto-detected by trying hosts in order and stored
// in the connection's extra.

// --- PostHog: personal API key (phx_...), MCP at mcp.posthog.com ---
// https://posthog.com/docs/model-context-protocol — Authorization: Bearer <personal API key>.

const POSTHOG_HOSTS = ["https://us.posthog.com", "https://eu.posthog.com"];

export const posthogAdapter = createStaticMcpAdapter({
  key: "posthog",
  displayName: "PostHog",
  toolsHint: "query events, insights, trends, funnels, errors and docs",
  mcpUrlFor: () => "https://mcp.posthog.com/mcp",
  async validate(fields) {
    const apiKey = (fields.apiKey ?? "").trim();
    if (!apiKey) throw new ApiError(400, "paste your PostHog personal API key");
    for (const host of POSTHOG_HOSTS) {
      try {
        const resp = await fetch(`${host}/api/users/@me/`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        if (resp.ok) {
          const me = (await resp.json()) as { email?: string; first_name?: string };
          return {
            bearerValue: apiKey,
            externalAccount: me.email ?? me.first_name ?? null,
            extra: { host },
          };
        }
        if (resp.status !== 401 && resp.status !== 403) {
          console.error(`posthog validate: ${host} -> ${resp.status}`);
        }
      } catch (e) {
        console.error(`posthog validate: ${host} unreachable:`, e);
      }
    }
    throw new ApiError(
      400,
      "PostHog didn't accept that key — use a personal API key (starts with phx_) from Settings → Personal API keys",
    );
  },
});

// --- Mixpanel: service account (username + secret), MCP per data-residency region ---
// https://docs.mixpanel.com/docs/mcp — Authorization: Bearer Basic <b64(user:secret)>.

const MIXPANEL_REGIONS: { region: string; api: string; mcp: string }[] = [
  { region: "us", api: "https://mixpanel.com", mcp: "https://mcp.mixpanel.com/mcp" },
  { region: "eu", api: "https://eu.mixpanel.com", mcp: "https://mcp-eu.mixpanel.com/mcp" },
  { region: "in", api: "https://in.mixpanel.com", mcp: "https://mcp-in.mixpanel.com/mcp" },
];

export const mixpanelAdapter = createStaticMcpAdapter({
  key: "mixpanel",
  displayName: "Mixpanel",
  toolsHint: "run queries and reports, inspect events/properties, read dashboards and metrics",
  mcpUrlFor: (extra) => {
    const region = typeof extra.region === "string" ? extra.region : "us";
    return MIXPANEL_REGIONS.find((r) => r.region === region)?.mcp ?? MIXPANEL_REGIONS[0].mcp;
  },
  async validate(fields) {
    const username = (fields.username ?? "").trim();
    const secret = (fields.secret ?? "").trim();
    if (!username || !secret) throw new ApiError(400, "enter the service account username and secret");
    const basic = Buffer.from(`${username}:${secret}`).toString("base64");
    for (const { region, api } of MIXPANEL_REGIONS) {
      try {
        const resp = await fetch(`${api}/api/app/me`, {
          headers: { authorization: `Basic ${basic}` },
        });
        if (resp.ok) {
          return {
            // The MCP server wants "Authorization: Bearer Basic <b64>"; the runner prefixes
            // "Bearer ", so the stored bearer value is "Basic <b64>".
            bearerValue: `Basic ${basic}`,
            externalAccount: username.split(".")[0] || username,
            extra: { region },
          };
        }
        if (resp.status !== 401 && resp.status !== 403) {
          console.error(`mixpanel validate: ${region} -> ${resp.status}`);
        }
      } catch (e) {
        console.error(`mixpanel validate: ${region} unreachable:`, e);
      }
    }
    throw new ApiError(
      400,
      "Mixpanel didn't accept those credentials — create a service account under Organization Settings → Service Accounts",
    );
  },
});
