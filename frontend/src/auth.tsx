import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { auth, onIdTokenChanged, signInWithGoogle, signOutUser, type User } from "./firebase";
import { getMe, setAuthToken, setTokenProvider, type Me } from "./api";

interface AuthCtx {
  user: User | null;
  ready: boolean; // initial auth state resolved
  me: Me | null;
  refreshMe: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>; // fresh ID token (for the WebSocket)
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

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

  // Registers a just-in-time token getter for api.ts's authFetch: Firebase's getIdToken()
  // checks the cached JWT's exp locally and silently re-mints if it's stale, so REST calls
  // never rely on onIdTokenChanged's last push, which can lag real expiry across a
  // backgrounded/suspended tab (that lag was surfacing as "auth required" 401s).
  useEffect(() => {
    if (!auth) {
      setReady(true);
      return;
    }
    const fbAuth = auth;
    setTokenProvider(() => (fbAuth.currentUser ? fbAuth.currentUser.getIdToken() : Promise.resolve(null)));
    // Fires on sign-in, sign-out, and hourly token refresh — keeps setAuthToken current too
    // (only used by withDevAuth to detect Firebase mode, not as the bearer token itself).
    const unsubscribe = onIdTokenChanged(fbAuth, async (u) => {
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
    return () => {
      unsubscribe();
      setTokenProvider(null);
    };
  }, []);

  const getToken = useCallback(
    () => (auth?.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)),
    [],
  );
  const signIn = useCallback(async () => {
    await signInWithGoogle();
  }, []);
  const signOut = useCallback(async () => {
    await signOutUser();
    setMe(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, ready, me, refreshMe, signIn, signOut, getToken }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
