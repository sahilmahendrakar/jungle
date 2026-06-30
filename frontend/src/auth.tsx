import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { auth, onIdTokenChanged, signInWithGoogle, signOutUser, type User } from "./firebase";
import { getMe, setAuthToken, type Me } from "./api";

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

  // Fires on sign-in, sign-out, and hourly token refresh — keeps the API bearer token current.
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
