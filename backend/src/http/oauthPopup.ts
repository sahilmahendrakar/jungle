// OAuth-in-a-popup support. The SPA can run any connect flow in a small popup window
// (window.open) instead of a full-page redirect — e.g. while creating an agent, so the
// in-progress draft isn't lost. The connect-url endpoints record `popup: true` on the pending
// OAuth state; their callbacks then respond with this tiny self-closing page instead of
// redirecting to /settings. The page notifies the opener via postMessage and closes itself.
// The payload is status-only (connection key + connected/error) — never tokens — so a "*"
// target origin is safe.

export interface PopupResult {
  connection: string; // connection key ("github" | "google" | integration key)
  status: "connected" | "error";
  account?: string; // display handle/email of the linked account
  reason?: string; // error detail when status === "error"
}

export function popupClosePage(result: PopupResult): string {
  const payload = JSON.stringify({ source: "jungle-oauth", ...result });
  const heading = result.status === "connected" ? "Connected" : "Connection failed";
  const detail =
    result.status === "connected"
      ? "You can close this window."
      : escapeHtml(result.reason ?? "Something went wrong — close this window and try again.");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; color: #333; }
      main { text-align: center; }
      h1 { font-size: 1.1rem; margin-bottom: 0.4rem; }
      p { font-size: 0.9rem; color: #666; }
    </style>
  </head>
  <body>
    <main><h1>${heading}</h1><p>${detail}</p></main>
    <script>
      try { window.opener && window.opener.postMessage(${payload}, "*"); } catch (e) {}
      setTimeout(function () { window.close(); }, 300);
    </script>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
