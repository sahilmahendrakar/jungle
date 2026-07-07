// The `drive_*` custom tools: the agent's way to act on a connected Google Drive. Registered as an
// in-process SDK MCP server (name "gdrive"), exactly like the "gmail" server — no subprocess. Each
// tool calls the Drive REST API v3 directly with a short-lived OAuth access token read fresh from
// `getToken()` on every call, so a mid-turn `integration_credentials` refresh (key "google-drive",
// see runner.ts) is picked up without rebuilding.
//
// Read tools (search/list/get) are auto-allowed; the write tools (create/update) are gated through
// the human confirmation card when the integration's requireApproval is on (see runner.ts's
// preToolUseHook + allowedTools). This module doesn't know about that gating — it just does the work.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// Google's native doc types export to text; map each to the best plain-text export MIME.
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

export function createDriveMcpServer(getToken: () => string | null) {
  function authHeader(): Record<string, string> {
    const token = getToken();
    if (!token) throw new Error("Google Drive is not connected (no access token).");
    return { authorization: `Bearer ${token}` };
  }

  // JSON Drive API call.
  async function dapi<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...authHeader(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`drive ${init.method ?? "GET"} -> ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  // Raw (text) fetch for downloads/exports.
  async function dtext(url: string): Promise<string> {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`drive GET -> ${res.status}: ${body.slice(0, 400)}`);
    }
    return res.text();
  }

  const fileFields = "files(id,name,mimeType,modifiedTime,size)";
  const fmt = (f: DriveFile): string =>
    `- id:${f.id} • ${f.name} • ${f.mimeType}${f.modifiedTime ? ` • ${f.modifiedTime}` : ""}` +
    `${f.size ? ` • ${f.size}B` : ""}`;

  const driveSearch = tool(
    "drive_search",
    "Search the connected Google Drive. `query` is a full-text search over file names and " +
      "contents (Drive matches broadly). Returns a compact list of files (id, name, type, modified); " +
      "use drive_get_file with an id to read one.",
    {
      query: z.string().describe("Text to search for across file names and contents"),
      maxResults: z.number().int().min(1).max(50).optional().describe("Max files (default 15, max 50)"),
    },
    async (args) => {
      try {
        const n = args.maxResults ?? 15;
        const q = `fullText contains ${JSON.stringify(args.query)} and trashed = false`;
        const res = await dapi<{ files?: DriveFile[] }>(
          `${API}/files?q=${encodeURIComponent(q)}&pageSize=${n}&fields=${encodeURIComponent(fileFields)}`,
        );
        const files = res.files ?? [];
        if (!files.length) return ok(`No files match ${JSON.stringify(args.query)}.`);
        return ok(`${files.length} file(s):\n${files.map(fmt).join("\n")}`);
      } catch (e) {
        log.error("drive_search failed", { err: String(e) });
        return err(`Failed to search Drive: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const driveList = tool(
    "drive_list",
    "List files in a Drive folder (or the root if no folderId). Returns id, name, type per file.",
    {
      folderId: z.string().optional().describe("Folder id to list; omit for the Drive root"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Max files (default 30, max 100)"),
    },
    async (args) => {
      try {
        const n = args.maxResults ?? 30;
        const parent = args.folderId ?? "root";
        const q = `${JSON.stringify(parent)} in parents and trashed = false`;
        const res = await dapi<{ files?: DriveFile[] }>(
          `${API}/files?q=${encodeURIComponent(q)}&pageSize=${n}&fields=${encodeURIComponent(fileFields)}`,
        );
        const files = res.files ?? [];
        if (!files.length) return ok("Folder is empty.");
        return ok(`${files.length} item(s):\n${files.map(fmt).join("\n")}`);
      } catch (e) {
        log.error("drive_list failed", { err: String(e) });
        return err(`Failed to list folder: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const driveGetFile = tool(
    "drive_get_file",
    "Read a file's contents by id (from drive_search / drive_list). Google Docs/Sheets/Slides are " +
      "exported to text/CSV; plain-text files are returned as-is. Binary files (images, PDFs, etc.) " +
      "can't be read as text.",
    { id: z.string().describe("The file id") },
    async (args) => {
      try {
        const meta = await dapi<DriveFile>(
          `${API}/files/${args.id}?fields=id,name,mimeType,size`,
        );
        const exportAs = EXPORT_AS[meta.mimeType];
        if (exportAs) {
          const text = await dtext(`${API}/files/${args.id}/export?mimeType=${encodeURIComponent(exportAs)}`);
          return ok(`# ${meta.name} (${meta.mimeType})\n\n${text}`);
        }
        if (meta.mimeType.startsWith("text/") || meta.mimeType === "application/json") {
          const text = await dtext(`${API}/files/${args.id}?alt=media`);
          return ok(`# ${meta.name} (${meta.mimeType})\n\n${text}`);
        }
        return err(`${meta.name} is ${meta.mimeType}, which can't be read as text.`);
      } catch (e) {
        log.error("drive_get_file failed", { err: String(e) });
        return err(`Failed to read file: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const driveCreateFile = tool(
    "drive_create_file",
    "Create a new text file in the connected Drive. Depending on the integration's settings this " +
      "may require a human's approval first.",
    {
      name: z.string().describe("File name (e.g. notes.md)"),
      content: z.string().describe("The file's text content"),
      mimeType: z.string().optional().describe("MIME type (default text/plain)"),
      parentFolderId: z.string().optional().describe("Folder id to create it in; omit for the root"),
    },
    async (args) => {
      try {
        const mimeType = args.mimeType ?? "text/plain";
        const metadata: Record<string, unknown> = { name: args.name, mimeType };
        if (args.parentFolderId) metadata.parents = [args.parentFolderId];
        // Multipart upload: metadata part + media part.
        const boundary = `jungle_${Math.random().toString(36).slice(2)}`;
        const body =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n` +
          `${args.content}\r\n--${boundary}--`;
        const created = await dapi<DriveFile>(
          `${UPLOAD}/files?uploadType=multipart&fields=id,name`,
          { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
        );
        return ok(`Created ${created.name} (id ${created.id}).`);
      } catch (e) {
        log.error("drive_create_file failed", { err: String(e) });
        return err(`Failed to create file: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const driveUpdateFile = tool(
    "drive_update_file",
    "Overwrite an existing file's text content by id. May require a human's approval first.",
    {
      id: z.string().describe("The file id to overwrite"),
      content: z.string().describe("The new full text content"),
      mimeType: z.string().optional().describe("MIME type of the content (default text/plain)"),
    },
    async (args) => {
      try {
        const updated = await dapi<DriveFile>(
          `${UPLOAD}/files/${args.id}?uploadType=media&fields=id,name`,
          {
            method: "PATCH",
            headers: { "content-type": args.mimeType ?? "text/plain" },
            body: args.content,
          },
        );
        return ok(`Updated ${updated.name} (id ${updated.id}).`);
      } catch (e) {
        log.error("drive_update_file failed", { err: String(e) });
        return err(`Failed to update file: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "gdrive",
    version: "1.0.0",
    tools: [driveSearch, driveList, driveGetFile, driveCreateFile, driveUpdateFile],
  });
}
