// The `analytics_*` custom tools: the agent's way to query a connected Google Analytics (GA4)
// property. Registered as an in-process SDK MCP server (name "ganalytics"), exactly like the
// "gcalendar"/"x" servers — no subprocess. Each tool calls the Analytics Admin/Data APIs directly
// with a short-lived OAuth access token read fresh from `getToken()` on every call, so a mid-turn
// `integration_credentials` refresh (key "google-analytics", see runner.ts) is picked up without
// rebuilding.
//
// Both tools are read-only (analytics.readonly scope) and auto-allowed — there's nothing to
// approve, so this module knows nothing about the confirmation card (mirrors x-tool.ts).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

interface AccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: Array<{ property?: string; displayName?: string }>;
}

interface RunReportResponse {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
}

export function createAnalyticsMcpServer(getToken: () => string | null) {
  function authHeader(): Record<string, string> {
    const token = getToken();
    if (!token) throw new Error("Google Analytics is not connected (no access token).");
    return { authorization: `Bearer ${token}` };
  }

  async function aget<T>(base: string, path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: authHeader() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`analytics GET ${path} -> ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  async function apost<T>(base: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = await res.text();
      throw new Error(`analytics POST ${path} -> ${res.status}: ${respBody.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  const listProperties = tool(
    "analytics_list_properties",
    "List the GA4 properties this connected Google account can access, with their property ids " +
      "(needed by analytics_run_report) and display names, grouped by account.",
    {},
    async () => {
      try {
        const res = await aget<{ accountSummaries?: AccountSummary[] }>(ADMIN_API, "/accountSummaries?pageSize=200");
        const accounts = res.accountSummaries ?? [];
        const props = accounts.flatMap((a) =>
          (a.propertySummaries ?? []).map((p) => {
            const id = (p.property ?? "").replace(/^properties\//, "");
            return `- id:${id} • ${p.displayName ?? "(unnamed property)"} • account: ${a.displayName ?? "?"}`;
          }),
        );
        if (!props.length) return ok("No GA4 properties are accessible with this account.");
        return ok(`${props.length} propert${props.length === 1 ? "y" : "ies"}:\n${props.join("\n")}`);
      } catch (e) {
        log.error("analytics_list_properties failed", { err: String(e) });
        return err(`Failed to list properties: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const runReport = tool(
    "analytics_run_report",
    "Run a report against one GA4 property: metrics (e.g. activeUsers, sessions, screenPageViews, " +
      "conversions) broken down by dimensions (e.g. date, country, pagePath, sessionDefaultChannelGroup), " +
      "over a date range. Get the property id from analytics_list_properties. Dimension/metric names " +
      "are the GA4 API names (https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema).",
    {
      propertyId: z.string().describe("GA4 property id (numeric, from analytics_list_properties)"),
      metrics: z.string().describe("Comma-separated GA4 metric names, e.g. \"activeUsers,sessions\""),
      dimensions: z.string().optional().describe("Comma-separated GA4 dimension names, e.g. \"date,country\""),
      startDate: z.string().optional().describe("Start of range: YYYY-MM-DD or a relative form like \"7daysAgo\" (default \"7daysAgo\")"),
      endDate: z.string().optional().describe("End of range: YYYY-MM-DD or \"today\" (default \"today\")"),
      limit: z.number().int().min(1).max(250).optional().describe("Max rows (default 25, max 250)"),
    },
    async (args) => {
      try {
        const metrics = args.metrics.split(",").map((m) => ({ name: m.trim() })).filter((m) => m.name);
        const dimensions = (args.dimensions ?? "")
          .split(",")
          .map((d) => ({ name: d.trim() }))
          .filter((d) => d.name);
        if (!metrics.length) return err("At least one metric is required.");
        const body = {
          dateRanges: [{ startDate: args.startDate ?? "7daysAgo", endDate: args.endDate ?? "today" }],
          metrics,
          dimensions,
          limit: args.limit ?? 25,
        };
        const res = await apost<RunReportResponse>(DATA_API, `/properties/${encodeURIComponent(args.propertyId)}:runReport`, body);
        const dimNames = (res.dimensionHeaders ?? []).map((h) => h.name ?? "?");
        const metNames = (res.metricHeaders ?? []).map((h) => h.name ?? "?");
        const rows = res.rows ?? [];
        if (!rows.length) return ok("No rows returned for that range.");
        const header = [...dimNames, ...metNames].join(" | ");
        const lines = rows.map((r) => {
          const dims = (r.dimensionValues ?? []).map((v) => v.value ?? "");
          const mets = (r.metricValues ?? []).map((v) => v.value ?? "");
          return [...dims, ...mets].join(" | ");
        });
        return ok(`${header}\n${lines.join("\n")}${res.rowCount && res.rowCount > rows.length ? `\n(${res.rowCount} total rows, showing ${rows.length})` : ""}`);
      } catch (e) {
        log.error("analytics_run_report failed", { err: String(e) });
        return err(`Failed to run report: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "ganalytics",
    version: "1.0.0",
    tools: [listProperties, runReport],
  });
}
