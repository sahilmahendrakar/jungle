// The `calendar_*` custom tools: the agent's way to act on a connected Google Calendar.
// Registered as an in-process SDK MCP server (name "gcalendar"), exactly like the "gdrive"
// server — no subprocess. Each tool calls the Calendar REST API v3 directly with a short-lived
// OAuth access token read fresh from `getToken()` on every call, so a mid-turn
// `integration_credentials` refresh (key "google-calendar", see runner.ts) is picked up without
// rebuilding.
//
// Read tools (list/get) are auto-allowed; the write tools (create/update) are gated through the
// human confirmation card when the integration's requireApproval is on (see runner.ts's
// preToolUseHook + allowedTools). This module doesn't know about that gating — it just does the work.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";

const API = "https://www.googleapis.com/calendar/v3";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

interface CalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; responseStatus?: string }[];
  status?: string;
}

// "2026-07-20T09:00:00-07:00" → "Jul 20 09:00"; all-day events carry `date` instead.
function fmtWhen(e?: { dateTime?: string; date?: string }): string {
  const raw = e?.dateTime ?? e?.date;
  if (!raw) return "?";
  if (!e?.dateTime) return raw; // all-day: date only, already compact
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fmtEvent = (e: CalEvent): string =>
  `- id:${e.id} • ${e.summary ?? "(no title)"} • ${fmtWhen(e.start)} → ${fmtWhen(e.end)}` +
  `${e.location ? ` • ${e.location}` : ""}` +
  `${e.attendees?.length ? ` • ${e.attendees.length} attendee(s)` : ""}`;

// Validate an ISO-ish datetime before it hits Google (a bad value surfaces as a 400 anyway,
// but this error message names the offending arg).
function asDateTime(v: string, arg: string): string {
  if (isNaN(new Date(v).getTime())) throw new Error(`${arg} must be an ISO 8601 date-time (got ${JSON.stringify(v)})`);
  return v;
}

export function createCalendarMcpServer(getToken: () => string | null) {
  function authHeader(): Record<string, string> {
    const token = getToken();
    if (!token) throw new Error("Google Calendar is not connected (no access token).");
    return { authorization: `Bearer ${token}` };
  }

  async function capi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...authHeader(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`calendar ${init.method ?? "GET"} -> ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  const calId = (v?: string) => encodeURIComponent(v ?? "primary");

  const calendarList = tool(
    "calendar_list",
    "List events on the connected Google Calendar in a time range (default: the next 7 days). " +
      "Returns a compact list (id, title, start → end, location, attendees); use calendar_get " +
      "with an id for full details.",
    {
      timeMin: z.string().optional().describe("Start of range, ISO 8601 (default: now)"),
      timeMax: z.string().optional().describe("End of range, ISO 8601 (default: 7 days from now)"),
      maxResults: z.number().int().min(1).max(50).optional().describe("Max events (default 15, max 50)"),
      calendarId: z.string().optional().describe("Calendar id (default: the primary calendar)"),
    },
    async (args) => {
      try {
        const now = new Date();
        const timeMin = asDateTime(args.timeMin ?? now.toISOString(), "timeMin");
        const timeMax = asDateTime(
          args.timeMax ?? new Date(now.getTime() + 7 * 86400e3).toISOString(),
          "timeMax",
        );
        const n = args.maxResults ?? 15;
        const q =
          `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
          `&maxResults=${n}&singleEvents=true&orderBy=startTime`;
        const res = await capi<{ items?: CalEvent[] }>(`/calendars/${calId(args.calendarId)}/events?${q}`);
        const events = res.items ?? [];
        if (!events.length) return ok("No events in that range.");
        return ok(`${events.length} event(s):\n${events.map(fmtEvent).join("\n")}`);
      } catch (e) {
        log.error("calendar_list failed", { err: String(e) });
        return err(`Failed to list events: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const calendarGet = tool(
    "calendar_get",
    "Read one calendar event's full details by id (from calendar_list): title, times, location, " +
      "description, attendees with their RSVP status.",
    {
      eventId: z.string().describe("The event id"),
      calendarId: z.string().optional().describe("Calendar id (default: the primary calendar)"),
    },
    async (args) => {
      try {
        const e = await capi<CalEvent>(
          `/calendars/${calId(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
        );
        const lines = [
          `# ${e.summary ?? "(no title)"}`,
          `id: ${e.id}`,
          `when: ${fmtWhen(e.start)} → ${fmtWhen(e.end)}${e.start?.timeZone ? ` (${e.start.timeZone})` : ""}`,
        ];
        if (e.location) lines.push(`location: ${e.location}`);
        if (e.attendees?.length) {
          lines.push(
            `attendees: ${e.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`).join(", ")}`,
          );
        }
        if (e.description) lines.push(`\n${e.description}`);
        return ok(lines.join("\n"));
      } catch (e2) {
        log.error("calendar_get failed", { err: String(e2) });
        return err(`Failed to read event: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    },
  );

  // Shared start/end shape for create/update. `timeZone` is optional — with an offset in
  // dateTime Google doesn't need it, but naming it keeps events readable in the calendar UI.
  const timeBlock = {
    summary: z.string().optional().describe("Event title"),
    start: z.string().optional().describe("Start, ISO 8601 date-time (e.g. 2026-07-20T09:00:00-07:00)"),
    end: z.string().optional().describe("End, ISO 8601 date-time"),
    timeZone: z.string().optional().describe("IANA timezone for start/end (e.g. America/Los_Angeles)"),
    description: z.string().optional().describe("Event description/notes"),
    location: z.string().optional().describe("Event location"),
  };

  const calendarCreate = tool(
    "calendar_create",
    "Create a new event on the connected Google Calendar. Depending on the integration's " +
      "settings this may require a human's approval first.",
    {
      ...timeBlock,
      summary: z.string().describe("Event title"),
      start: z.string().describe("Start, ISO 8601 date-time (e.g. 2026-07-20T09:00:00-07:00)"),
      end: z.string().describe("End, ISO 8601 date-time"),
      attendees: z.string().optional().describe("Comma-separated attendee emails to invite"),
      calendarId: z.string().optional().describe("Calendar id (default: the primary calendar)"),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          summary: args.summary,
          start: { dateTime: asDateTime(args.start, "start"), ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
          end: { dateTime: asDateTime(args.end, "end"), ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
        };
        if (args.description) body.description = args.description;
        if (args.location) body.location = args.location;
        if (args.attendees) {
          body.attendees = args.attendees.split(",").map((s) => ({ email: s.trim() })).filter((a) => a.email);
        }
        const created = await capi<CalEvent>(`/calendars/${calId(args.calendarId)}/events`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(`Created "${created.summary ?? "(no title)"}" ${fmtWhen(created.start)} → ${fmtWhen(created.end)} (id ${created.id}).`);
      } catch (e) {
        log.error("calendar_create failed", { err: String(e) });
        return err(`Failed to create event: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const calendarUpdate = tool(
    "calendar_update",
    "Change an existing calendar event by id — any of title, start/end, description, location. " +
      "May require a human's approval first.",
    {
      ...timeBlock,
      eventId: z.string().describe("The event id to update"),
      calendarId: z.string().optional().describe("Calendar id (default: the primary calendar)"),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.summary !== undefined) body.summary = args.summary;
        if (args.start !== undefined) {
          body.start = { dateTime: asDateTime(args.start, "start"), ...(args.timeZone ? { timeZone: args.timeZone } : {}) };
        }
        if (args.end !== undefined) {
          body.end = { dateTime: asDateTime(args.end, "end"), ...(args.timeZone ? { timeZone: args.timeZone } : {}) };
        }
        if (args.description !== undefined) body.description = args.description;
        if (args.location !== undefined) body.location = args.location;
        if (!Object.keys(body).length) return err("Nothing to update — pass at least one field.");
        const updated = await capi<CalEvent>(
          `/calendars/${calId(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        return ok(`Updated "${updated.summary ?? "(no title)"}" ${fmtWhen(updated.start)} → ${fmtWhen(updated.end)} (id ${updated.id}).`);
      } catch (e) {
        log.error("calendar_update failed", { err: String(e) });
        return err(`Failed to update event: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "gcalendar",
    version: "1.0.0",
    tools: [calendarList, calendarGet, calendarCreate, calendarUpdate],
  });
}
