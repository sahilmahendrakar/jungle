// Shared OAuth-error helpers for the integration adapters.

// Providers signal a permanently-dead grant with the standard `invalid_grant` OAuth error code
// (RFC 6749 §5.2) — the refresh token expired, was revoked, or the user changed their password.
// That is fundamentally different from a transient failure (network blip, provider 5xx): the only
// fix is sending the user back through consent. Every token helper (google.ts, mcp-oauth.ts)
// embeds the provider's raw error code in its thrown message, so matching `invalid_grant` is the
// reliable cross-provider check. Callers use this to set needs_reconnect (migration 027) — and
// ONLY on a match, so a transient blip never marks a healthy connection broken.
export function isInvalidGrantError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("invalid_grant");
}
