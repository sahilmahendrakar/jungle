// Notifications: the tab-title/favicon unread badge and desktop (Notification API) pings.
// Pure DOM module — no React. App owns the rules of WHAT notifies; this owns the mechanics.

// ---- Preference (localStorage; default on — permission is the real gate) ----

const PREF_KEY = "jungle.notifications";

export function notificationsEnabled(): boolean {
  return localStorage.getItem(PREF_KEY) !== "off";
}

export function setNotificationsEnabled(on: boolean): void {
  localStorage.setItem(PREF_KEY, on ? "on" : "off");
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// ---- Title + favicon badge ----

// The favicon <link>s we overlay a dot onto, with their original hrefs so count=0 restores them.
let faviconLinks: Array<{ el: HTMLLinkElement; href: string }> | null = null;
let badgedHref: string | null = null; // the generated dot-overlay icon, built once

function collectFavicons(): Array<{ el: HTMLLinkElement; href: string }> {
  if (!faviconLinks) {
    faviconLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map((el) => ({
      el,
      href: el.href,
    }));
  }
  return faviconLinks;
}

// Draw the 32px favicon with a notification dot in the top-right corner; cached after first build.
function buildBadgedFavicon(onReady: (href: string) => void): void {
  if (badgedHref) return onReady(badgedHref);
  const img = new Image();
  img.onload = () => {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size - 7, 7, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444"; // red-500 — visible against the jade mark in light and dark
    ctx.fill();
    badgedHref = canvas.toDataURL("image/png");
    onReady(badgedHref);
  };
  img.src = "/favicon-32.png";
}

// Reflect the unread count in the tab: "(3) Jungle" + a red dot on the favicon. Idempotent —
// call it whenever the count might have changed.
export function setAppBadge(count: number): void {
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) Jungle` : "Jungle";
  const links = collectFavicons();
  if (count > 0) {
    buildBadgedFavicon((href) => {
      // Only swap while the badge is still wanted (the build is async on first use).
      if (document.title.startsWith("(")) for (const l of links) l.el.href = href;
    });
  } else {
    for (const l of links) l.el.href = l.href;
  }
}

// ---- Desktop notifications ----

export interface NotifyOptions {
  title: string;
  body: string;
  // Same-tag notifications replace each other (one per conversation, not a pileup).
  tag?: string;
  onClick?: () => void;
}

// Show a desktop notification — if enabled, permitted, and the tab isn't being looked at
// (visible AND focused means the in-app UI already carries the signal).
export function notify(opts: NotifyOptions): void {
  if (!notificationsEnabled()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body.length > 180 ? `${opts.body.slice(0, 179)}…` : opts.body,
      tag: opts.tag,
      icon: "/favicon-32.png",
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* some browsers throw for page-context notifications — never break the app for a ping */
  }
}
