import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./auth";
import { GoogleSignIn } from "./GoogleSignIn";
import { Landing } from "./Landing";
import { CreateWorkspace, JoinWorkspace, GithubStep } from "./Onboarding";
import { App } from "./App";
import { Settings } from "./Settings";
import { setActiveWorkspaceId, type Membership } from "./api";
import { usePath, navigate } from "./route";

const ACTIVE_WS_KEY = "jungle.workspace";

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

// Decides what to show based on auth + workspace membership:
//   not signed in                 -> Google sign-in
//   /join/<token>                 -> join-workspace screen (survives sign-in, same URL)
//   signed in, no memberships     -> create-workspace screen
//   creating a new workspace      -> create-workspace screen
//   active membership, GitHub off -> connect-GitHub step (skippable, remembered)
//   otherwise                     -> the chat app, keyed to the active workspace participant
export function AuthGate() {
  const { ready, user, me, getToken, signOut, refreshMe } = useAuth();
  const [ghDismissed, setGhDismissed] = useState(false);
  const [creating, setCreating] = useState(false);
  // The active workspace id (persisted). null = fall back to the first membership.
  const [activeWsId, setActiveWsId] = useState<string | null>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_WS_KEY) : null,
  );
  const path = usePath();

  const selectWorkspace = (id: string) => {
    localStorage.setItem(ACTIVE_WS_KEY, id);
    setActiveWsId(id);
    setCreating(false);
    if (path.startsWith("/join/")) navigate("/");
  };

  // Remember a per-user "skip GitHub" choice so returning users aren't nagged each login.
  useEffect(() => {
    if (user) setGhDismissed(localStorage.getItem(`jungle.gh.${user.uid}`) === "1");
  }, [user]);
  const dismissGithub = () => {
    if (user) localStorage.setItem(`jungle.gh.${user.uid}`, "1");
    setGhDismissed(true);
  };

  // Handle the GitHub OAuth round-trip return (?github=connected|error), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const g = params.get("github");
    if (!g) return;
    if (g === "connected") {
      if (user) localStorage.setItem(`jungle.gh.${user.uid}`, "1");
      refreshMe();
    }
    for (const k of ["github", "login", "reason"]) params.delete(k);
    const qs = params.toString();
    history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : ""));
  }, [refreshMe, user]);

  // Once signed in, /login has served its purpose — drop back to the app root.
  useEffect(() => {
    if (user && path === "/login") {
      history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [user, path]);

  if (!ready) return <FullScreenSpinner />;
  // Signed-out: landing page, except when heading into sign-in or following an invite
  // link (the join flow needs to keep its /join/<token> URL through sign-in).
  if (!user) return path === "/login" || path.startsWith("/join/") ? <GoogleSignIn /> : <Landing />;
  if (!me) return <FullScreenSpinner />; // profile loading right after sign-in

  // Join-by-link takes priority: works whether or not the account already has memberships.
  if (path.startsWith("/join/")) {
    const token = path.slice("/join/".length);
    return (
      <JoinWorkspace token={token} onJoined={selectWorkspace} onNoInvite={() => navigate("/")} />
    );
  }

  const memberships = me.memberships;
  if (creating || memberships.length === 0) {
    return <CreateWorkspace onCreated={selectWorkspace} />;
  }

  // Resolve the active membership (persisted choice if still valid, else the first).
  const membership: Membership =
    memberships.find((m) => m.workspace.id === activeWsId) ?? memberships[0];

  if (path === "/settings") return <Settings />;
  if (!membership.github.connected && !ghDismissed) return <GithubStep onSkip={dismissGithub} />;

  // Set the active workspace on the API layer before App renders so its data loads (and WS
  // handshake) are scoped correctly. Keying App to the participant remounts it on a workspace
  // switch, resetting all chat state and reconnecting the socket cleanly.
  setActiveWorkspaceId(membership.workspace.id);
  return (
    <App
      key={membership.participant.id}
      authParticipantId={membership.participant.id}
      workspaceId={membership.workspace.id}
      me={membership.participant}
      memberships={memberships}
      onSwitchWorkspace={selectWorkspace}
      onCreateWorkspace={() => setCreating(true)}
      getWsToken={getToken}
      onSignOut={signOut}
    />
  );
}
