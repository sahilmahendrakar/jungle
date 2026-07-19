// Workspace-level Slack install state + a popup connect flow. Slack is workspace-scoped (one bot
// token per Slack team, connected by a workspace admin), so it lives outside the per-user
// `useConnections` model — but it reuses the same self-closing-popup OAuth protocol
// (http/oauthPopup.ts posts { source: "jungle-oauth", connection: "slack", status }).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SlackStatus } from "@/api";
import { getSlackStatus, slackInstallUrl, disconnectSlack } from "@/api";

export interface SlackApi {
  status: SlackStatus;
  loading: boolean;
  connecting: boolean;
  error: string;
  refresh: () => Promise<void>;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
}

// Run the Slack install in a popup, resolving when it finishes. Completion is detected via the
// callback's postMessage, with a status poll as the ground-truth fallback (same belt-and-braces
// approach as lib/connections.tsx runPopupFlow).
async function runInstallPopup(isInstalled: () => Promise<boolean>): Promise<boolean> {
  const { url } = await slackInstallUrl({ popup: true });
  const popup = window.open(url, "jungle-connect-slack", "width=560,height=720");
  if (!popup) {
    const { url: redirectUrl } = await slackInstallUrl({ popup: false });
    window.location.href = redirectUrl;
    return false;
  }
  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (pollTimer) clearTimeout(pollTimer);
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* COOP-severed handle */
      }
      resolve(ok);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; connection?: string; status?: string } | null;
      if (d && d.source === "jungle-oauth" && d.connection === "slack") finish(d.status === "connected");
    };
    window.addEventListener("message", onMessage);
    let closedPolls = 0;
    const poll = async () => {
      if (settled) return;
      try {
        if (await isInstalled()) return finish(true);
      } catch {
        /* keep polling */
      }
      if (settled) return;
      let closed = false;
      try {
        closed = popup.closed;
      } catch {
        closed = true;
      }
      if (closed && ++closedPolls > 2) return finish(false);
      if (Date.now() - start > TIMEOUT_MS) return finish(false);
      pollTimer = setTimeout(poll, closed ? 1200 : 3000);
    };
    pollTimer = setTimeout(poll, 1500);
  });
}

export function useSlack(enabled = true): SlackApi {
  const [status, setStatus] = useState<SlackStatus>({ installed: false });
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await getSlackStatus().catch(() => ({ installed: false }) as SlackStatus);
    if (alive.current) setStatus(s);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    getSlackStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus({ installed: false }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const connect = useCallback(async () => {
    setError("");
    setConnecting(true);
    try {
      const ok = await runInstallPopup(async () => {
        const s = await getSlackStatus();
        if (alive.current) setStatus(s);
        return s.installed && s.status !== "revoked";
      });
      await refresh();
      return ok;
    } catch (e) {
      if (alive.current) setError(String((e as Error).message ?? e));
      return false;
    } finally {
      if (alive.current) setConnecting(false);
    }
  }, [refresh]);

  const disconnect = useCallback(async () => {
    setError("");
    try {
      await disconnectSlack();
    } catch (e) {
      if (alive.current) setError(String((e as Error).message ?? e));
    }
    await refresh();
  }, [refresh]);

  return { status, loading, connecting, error, refresh, connect, disconnect };
}
