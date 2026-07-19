// Auth provider — ported from frontend/src/auth.tsx. Same shape (user/ready/me + token plumbing),
// but sign-in uses the expo-auth-session Google flow (an ASWebAuthenticationSession sheet) instead
// of the web's signInWithPopup: it returns a Google ID token which we hand to Firebase.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import Constants from "expo-constants";
import {
  auth,
  firebaseEnabled,
  onIdTokenChanged,
  signInWithGoogleCredential,
  signOutUser,
  type User,
} from "./firebase";
import { getMe, setAuthToken, setTokenGetter, type Me } from "./api";
import { unregisterPush } from "./push";

// Required so the auth session sheet dismisses and returns control to the app.
WebBrowser.maybeCompleteAuthSession();

const iosClientId = (Constants.expoConfig?.extra as { googleIosClientId?: string } | undefined)
  ?.googleIosClientId;

interface AuthCtx {
  user: User | null;
  ready: boolean; // initial auth state resolved
  me: Me | null;
  signingIn: boolean;
  refreshMe: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>; // fresh ID token (for the WebSocket handshake)
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // expo-auth-session Google request. useIdTokenAuthRequest returns a Google ID token directly
  // (audience = our iOS OAuth client), which Firebase accepts as a credential.
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({ iosClientId });

  const refreshMe = useCallback(async () => {
    if (!auth?.currentUser) {
      setMe(null);
      return;
    }
    try {
      setMe(await getMe());
    } catch {
      setMe(null);
    }
  }, []);

  // Exchange the Google ID token for a Firebase session when the auth sheet returns.
  useEffect(() => {
    if (response?.type !== "success") {
      if (response) setSigningIn(false); // dismissed / cancelled / error
      return;
    }
    const idToken = response.params?.id_token;
    if (!idToken) {
      setSigningIn(false);
      return;
    }
    signInWithGoogleCredential(idToken)
      .catch(() => {
        /* onIdTokenChanged handles the resulting state; nothing to do on failure but stop spinner */
      })
      .finally(() => setSigningIn(false));
  }, [response]);

  // Let authed HTTP requests mint a fresh token per call (getIdToken refreshes an expired one).
  useEffect(() => {
    const a = auth;
    if (!a) return;
    setTokenGetter(() => (a.currentUser ? a.currentUser.getIdToken() : Promise.resolve(null)));
    return () => setTokenGetter(null);
  }, []);

  // Fires on sign-in, sign-out, and hourly refresh — keeps the cached bearer snapshot current.
  useEffect(() => {
    if (!auth) {
      setReady(true);
      return;
    }
    return onIdTokenChanged(auth, async (u) => {
      setUser(u);
      setAuthToken(u ? await u.getIdToken() : null);
      if (u) {
        try {
          setMe(await getMe());
        } catch {
          setMe(null);
        }
      } else {
        setMe(null);
      }
      setReady(true);
    });
  }, []);

  const getToken = useCallback(
    () => (auth?.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)),
    [],
  );

  const signIn = useCallback(async () => {
    if (!firebaseEnabled) throw new Error("firebase not configured");
    setSigningIn(true);
    try {
      await promptAsync();
    } catch {
      setSigningIn(false);
    }
  }, [promptAsync]);

  const signOut = useCallback(async () => {
    await unregisterPush().catch(() => {});
    await signOutUser();
    setMe(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, ready, me, signingIn, refreshMe, signIn, signOut, getToken }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
