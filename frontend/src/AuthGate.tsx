import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./auth";
import { GoogleSignIn } from "./GoogleSignIn";
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

  // Handle the OAuth round-trip returns (?github=… / ?google=… / ?integration=…), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const gh = params.get("github");
    const google = params.get("google");
    const integration = params.get("integration");
    if (!gh && !google && !integration) return;
    if (gh === "connected") {
      if (user) localStorage.setItem(`jungle.gh.${user.uid}`, "1");
      refreshMe();
    }
    // Google and per-agent integration connections are read live by the settings/profile status
    // fetches; nothing to refresh here, just clean the return params off the URL.
    for (const k of ["github", "login", "reason", "google", "email", "integration", "agent", "connected", "error"]) {
      params.delete(k);
    }
    const qs = params.toString();
    history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : ""));
  }, [refreshMe, user]);

  if (!ready) return <FullScreenSpinner />;
  if (!user) return <GoogleSignIn />;
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
  if (!membership.github.connected && !ghDismissed && path !== "/scheduled")
    return <GithubStep onSkip={dismissGithub} />;
  // /scheduled renders inside <App> as a main-column view (sidebars intact), not a standalone
  // page — App reads the path and swaps its main region. It still needs the API layer scoped to
  // the active workspace, which the setActiveWorkspaceId below (before App renders) handles.

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
