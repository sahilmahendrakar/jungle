import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Globe, Loader2, TriangleAlert } from "lucide-react";
import { getBrowserSignin, getBrowserSigninView } from "./api";
import { ViewShell } from "./components/chat/ViewShell";
import { Button } from "@/components/ui/button";

// The /browser-signin/:id page: where a human logs into a real site by hand, inside the cloud
// browser an agent will then reuse.
//
// The whole point of this page existing (rather than the agent just pasting a Browserbase URL into
// chat) is that the live-view URL is a BEARER CAPABILITY — anyone holding it drives a browser that
// is about to hold your logged-in session. Jungle messages are persisted, searchable and mirrored
// into Slack, so the agent shares this page's URL instead and the backend mints the capability
// here, only for the person who actually has to sign in. Consequently the URL below is fetched on
// mount, kept in component state only, and never persisted or logged.

type Status = "pending" | "completed" | "expired" | "failed";

export function BrowserSignin({
  requestId,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
}: {
  requestId: string;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [siteLabel, setSiteLabel] = useState("");
  const [liveViewUrl, setLiveViewUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Guards against a poll that resolves after the component unmounts (or after we've reached a
  // terminal state) clobbering what the user is looking at.
  const done = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await getBrowserSignin(requestId);
      setStatus(r.status);
      setSiteLabel(r.siteLabel);
      if (r.status !== "pending") {
        done.current = true;
        setLiveViewUrl("");
        return;
      }
      // Only fetch the capability once we know the request is genuinely open — a separate call by
      // design, so a mere status check never mints one.
      if (!liveViewUrl) {
        const v = await getBrowserSigninView(requestId);
        // Treat a missing URL as a failure rather than rendering an endless spinner. A field-name
        // mismatch between this and the route once produced exactly that: a page that looked like
        // it was still connecting, forever, with nothing to report.
        if (!v.liveViewUrl) throw new Error("the browser session didn't return a view — try a new sign-in link");
        setLiveViewUrl(v.liveViewUrl);
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
      done.current = true;
    } finally {
      setLoading(false);
    }
  }, [requestId, liveViewUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll for completion. The backend detects the login by watching the browser's cookie jar, so
  // there's nothing for the user to click when they're done — this is what notices.
  useEffect(() => {
    if (done.current) return;
    const t = setInterval(() => {
      if (done.current) return;
      getBrowserSignin(requestId)
        .then((r) => {
          setStatus(r.status);
          if (r.status !== "pending") {
            done.current = true;
            setLiveViewUrl("");
          }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [requestId, status]);

  const body = () => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Opening a browser…
        </div>
      );
    }
    if (status === "completed") {
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <Check className="size-5" /> Signed into {siteLabel}.
          </div>
          <p className="text-sm text-muted-foreground">
            The agent can use this session now. Your password was never sent to Jungle — only the
            browser profile is stored, and you can disconnect it any time in Settings → Connections.
          </p>
        </div>
      );
    }
    if (status === "expired" || status === "failed" || error) {
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-5" />
            {error || (status === "expired" ? "This sign-in window expired." : "The sign-in didn't complete.")}
          </div>
          <p className="text-sm text-muted-foreground">
            Ask the agent to start a new sign-in, then open the fresh link it sends you.
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Log into <span className="font-medium text-foreground">{siteLabel}</span> below, exactly as
          you would in your own browser. Two-factor prompts on your phone work normally. Nobody at
          Jungle sees what you type — we only watch for the site's session cookie, and close this
          window as soon as it appears.
        </p>
        {liveViewUrl ? (
          // Interactive on purpose (no pointer-events:none): the whole point is that a human can
          // click and type in here.
          <iframe
            src={liveViewUrl}
            title={`Sign into ${siteLabel}`}
            className="h-[70vh] w-full rounded-lg border bg-background"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          />
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Connecting…
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          This window is private to you and expires shortly. Don't share this page's link.
          {liveViewUrl && (
            <>
              {" "}
              If the browser above doesn't load,{" "}
              {/* Escape hatch: the embed is a third-party app in an iframe, and "it just spins" is
                  the failure mode with no other recourse. Opening it directly still works. */}
              <a href={liveViewUrl} target="_blank" rel="noreferrer" className="underline">
                open it in a new tab
              </a>
              .
            </>
          )}
        </p>
      </div>
    );
  };

  return (
    <ViewShell
      icon={<Globe className="size-5" />}
      title={siteLabel ? `Sign into ${siteLabel}` : "Browser sign-in"}
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="browser-signin-view"
    >
      <div className="mx-auto max-w-4xl space-y-4">
        {body()}
        {status !== "pending" && (
          <Button variant="outline" onClick={() => history.back()}>
            Back
          </Button>
        )}
      </div>
    </ViewShell>
  );
}
