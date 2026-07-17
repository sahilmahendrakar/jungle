import { createHmac, timingSafeEqual } from "node:crypto";

// Slack request signing (https://api.slack.com/authentication/verifying-requests-from-slack).
// The events route (http/routes/slack.ts) computes this over the RAW request bytes — it must be
// mounted before express.json() or the signature won't match.

// ±300s replay window: reject stale timestamps outright.
const MAX_SKEW_SEC = 60 * 5;

export function verifySlackSignature(
  signingSecret: string,
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SEC) return false;

  const basestring = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(basestring).digest("hex");

  // Lengths must match before timingSafeEqual (it throws on unequal-length buffers).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
