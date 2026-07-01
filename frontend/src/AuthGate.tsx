import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./auth";
import { GoogleSignIn } from "./GoogleSignIn";
import { Onboarding } from "./Onboarding";
import { App } from "./App";

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

// Decides what to show based on auth + onboarding state:
//   not signed in            -> Google sign-in
//   signed in, no participant -> onboarding (pick handle)
//   onboarded, GitHub not yet -> onboarding (connect GitHub, skippable & remembered)
//   fully set up              -> the chat app, keyed to the Firebase identity
export function AuthGate() {
  const { ready, user, me, getToken, signOut, refreshMe } = useAuth();
  const [ghDismissed, setGhDismissed] = useState(false);

  // Remember a per-user "skip GitHub" choice so returning users aren't nagged each login.
  useEffect(() => {
    if (user) setGhDismissed(localStorage.getItem(`jungle.gh.${user.uid}`) === "1");
  }, [user]);
  const dismissGithub = () => {
    if (user) localStorage.setItem(`jungle.gh.${user.uid}`, "1");
    setGhDismissed(true);
  };

  // Handle the GitHub round-trip return (?github=connected|configured|error), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const g = params.get("github");
    if (!g) return;
    if (g === "connected") {
      if (user) localStorage.setItem(`jungle.gh.${user.uid}`, "1");
      refreshMe();
    } else if (g === "configured") {
      // Returned from installing the App / choosing repos — identity is unchanged, but refresh
      // so any connection state stays current.
      refreshMe();
    }
    for (const k of ["github", "login", "reason"]) params.delete(k);
    const qs = params.toString();
    history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : ""));
  }, [refreshMe, user]);

  if (!ready) return <FullScreenSpinner />;
  if (!user) return <GoogleSignIn />;
  if (!me) return <FullScreenSpinner />; // profile loading right after sign-in
  if (!me.onboarded) return <Onboarding onSkipGithub={dismissGithub} />;
  if (!me.github?.connected && !ghDismissed) return <Onboarding onSkipGithub={dismissGithub} />;

  return (
    <App
      authParticipantId={me.participant!.id}
      me={me.participant}
      email={me.profile?.email}
      picture={me.profile?.picture}
      github={me.github}
      getWsToken={getToken}
      onSignOut={signOut}
    />
  );
}
