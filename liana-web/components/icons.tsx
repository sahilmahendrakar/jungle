// Brand marks for the three chat surfaces, shared by the landing page and the channel cards.
// Each glyph is a monochrome path drawn with currentColor, so a BrandTile can render it white on
// a brand-colored square. Keeping them here (not inline) means one source of truth for the look.

export function SlackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 1 1-5.04 0v-6.32zM8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31zM18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31zM15.16 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.32a2.52 2.52 0 1 1 0 5.04h-6.32z" />
    </svg>
  );
}

export function MessageIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3C6.48 3 2 6.86 2 11.6c0 2.63 1.38 4.98 3.55 6.55-.13 1.09-.62 2.44-1.87 3.47 0 0 2.55-.06 4.53-1.47.13-.1.3-.13.46-.09.75.19 1.87.34 3.33.34 5.52 0 10-3.86 10-8.6S17.52 3 12 3z" />
    </svg>
  );
}

export function TelegramIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21.9 4.03c.27-1.08-.4-1.55-1.15-1.27L2.2 9.9c-1.2.47-1.18 1.14-.2 1.44l4.74 1.48 11-6.93c.52-.34.99-.15.6.19l-8.9 8.03-.34 4.9c.49 0 .7-.22.96-.48l2.3-2.23 4.78 3.53c.88.49 1.51.23 1.73-.82l3.03-14.98z" />
    </svg>
  );
}

export function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// A channel's glyph rendered white on its brand color — the instantly-recognizable mark at the top
// of each surface card. `channel` picks the background via the `.brand-tile.<channel>` CSS rule.
export function BrandTile({ channel }: { channel: "slack" | "imessage" | "telegram" }) {
  return (
    <span className={`brand-tile ${channel}`}>
      {channel === "slack" ? <SlackIcon /> : channel === "imessage" ? <MessageIcon /> : <TelegramIcon />}
    </span>
  );
}
