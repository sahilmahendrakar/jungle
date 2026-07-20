import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseResourceMetadataHeader,
  normalizeResourceIndicator,
  discoverResourceMetadataUrl,
} from "./mcp-oauth.js";

describe("parseResourceMetadataHeader", () => {
  it("extracts the resource_metadata URL from a WWW-Authenticate header", () => {
    const header = `Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp/.well-known/oauth-protected-resource", error="invalid_token"`;
    assert.strictEqual(
      parseResourceMetadataHeader(header),
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp/.well-known/oauth-protected-resource",
    );
  });

  it("returns null when the header has no resource_metadata parameter", () => {
    assert.strictEqual(parseResourceMetadataHeader('Bearer realm="OAuth"'), null);
    assert.strictEqual(parseResourceMetadataHeader(""), null);
  });
});

describe("normalizeResourceIndicator", () => {
  it("uses the spec MCP URL when the metadata resource field is a metadata document URL", () => {
    assert.strictEqual(
      normalizeResourceIndicator(
        "https://mcp.notion.com/mcp/.well-known/oauth-protected-resource",
        "https://mcp.notion.com/mcp",
      ),
      "https://mcp.notion.com/mcp",
    );
  });

  it("keeps a valid resource indicator unchanged", () => {
    assert.strictEqual(
      normalizeResourceIndicator("https://mcp.linear.app/mcp", "https://mcp.linear.app/mcp"),
      "https://mcp.linear.app/mcp",
    );
  });
});

describe("discoverResourceMetadataUrl", () => {
  it("reads the resource_metadata URL from a 401 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/meta", error="invalid_token"`,
        },
      });
    try {
      const url = await discoverResourceMetadataUrl({
        key: "test",
        displayName: "Test",
        mcpUrl: "https://mcp.example.com/mcp",
      });
      assert.strictEqual(url, "https://mcp.example.com/meta");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null for non-401 responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    try {
      const url = await discoverResourceMetadataUrl({
        key: "test",
        displayName: "Test",
        mcpUrl: "https://mcp.example.com/mcp",
      });
      assert.strictEqual(url, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
