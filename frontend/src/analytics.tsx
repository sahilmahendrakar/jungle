import { Analytics as VercelAnalytics } from "@vercel/analytics/react";

// Vercel Web Analytics. It tracks pageviews by patching history.pushState, which is exactly how
// route.ts navigates, so in-app navigation is picked up without any router wiring.
//
// Every URL goes through scrubUrl first. Two reasons: our dynamic segments (workflow ids, invite
// tokens) would otherwise show up as one distinct page each and drown the report, and some of
// them are secrets or identity (an invite token grants workspace access; ?as= is the dev
// identity; ?person= is a handle). Analytics gets the route shape, never the value.
const DYNAMIC_SEGMENTS: [RegExp, string][] = [
  [/^\/workflows\/[^/]+(\/edit)?$/, "/workflows/[id]$1"],
  [/^\/join\/[^/]+$/, "/join/[token]"],
  [/^\/browser-signin\/[^/]+$/, "/browser-signin/[id]"],
];

const STRIPPED_PARAMS = ["as", "person"];

export function scrubUrl(rawUrl: string): string {
  const url = new URL(rawUrl, location.origin);
  for (const [pattern, replacement] of DYNAMIC_SEGMENTS) {
    if (pattern.test(url.pathname)) {
      url.pathname = url.pathname.replace(pattern, replacement);
      break;
    }
  }
  for (const p of STRIPPED_PARAMS) url.searchParams.delete(p);
  return url.pathname + (url.search || "") + url.hash;
}

export function Analytics() {
  return <VercelAnalytics beforeSend={(event) => ({ ...event, url: scrubUrl(event.url) })} />;
}
