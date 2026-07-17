// Text conversion between Slack mrkdwn and Jungle's plain message bodies. Pure (no I/O) so it's
// unit-testable; the bridge (services/slackBridge.ts) supplies the user-mention resolver.
//
// Slack wraps special tokens in angle brackets: <@U123>, <@U123|name>, <#C123|chan>,
// <https://x|label>, <https://x>, <!here>. It also HTML-escapes exactly &, <, > (as &amp; &lt;
// &gt;) everywhere. See https://api.slack.com/reference/surfaces/formatting.

function unescapeEntities(s: string): string {
  // Order matters: &amp; last so we don't double-unescape (&amp;lt; -> &lt; -> <).
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// The Slack user ids referenced by <@U…> tokens, so the bridge can batch-resolve them to handles
// before calling slackToJungleText.
export function mentionedSlackUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(m[1]);
  return [...ids];
}

// Slack -> Jungle. `resolveUser` maps a Slack user id to a Jungle @handle (WITHOUT the @) when we
// know the participant, else null. A resolved mention becomes "@handle" (so resolveMentions can
// trigger the agent); an unresolved one becomes the inline name as PLAIN text (never @-prefixed —
// we must not accidentally trigger a same-named Jungle handle for a stranger).
export function slackToJungleText(
  text: string,
  resolveUser: (slackUserId: string) => string | null = () => null,
): string {
  const replaced = text.replace(/<([^>]+)>/g, (_whole, inner: string) => {
    // User mention: @U123 or @U123|display
    if (inner.startsWith("@")) {
      const [id, name] = inner.slice(1).split("|");
      const handle = resolveUser(id);
      if (handle) return `@${handle}`;
      return name ? name : `@${id}`;
    }
    // Channel mention: #C123|name
    if (inner.startsWith("#")) {
      const [, name] = inner.slice(1).split("|");
      return name ? `#${name}` : inner;
    }
    // Special: !here, !channel, !subteam^S123|@team
    if (inner.startsWith("!")) {
      const [tag, label] = inner.slice(1).split("|");
      if (label) return label;
      if (tag === "here" || tag === "channel" || tag === "everyone") return `@${tag}`;
      return "";
    }
    // Link: url or url|label
    const [url, label] = inner.split("|");
    if (label) return `${label} (${url})`;
    return url;
  });
  return unescapeEntities(replaced);
}

// Jungle -> Slack. Escape the three entities Slack requires; @handles ride through as plain text
// (Slack won't linkify a non-Slack handle, which is fine — the persona is set via username/icon).
export function jungleToSlackText(body: string): string {
  return body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
