"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type WireMe } from "@/lib/api";
import { auth, firebaseEnabled, onIdTokenChanged, signInWithGoogle, signOutUser, type User } from "@/lib/firebase";

// One auth brain for the whole app: Firebase user + the Liana account behind it (/api/liana/me
// auto-provisions on first sign-in, so "signed in" and "has an account" are the same thing).

interface AuthState {
  status: "loading" | "signedout" | "ready" | "unconfigured";
  user: User | null;
  me: WireMe | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>(firebaseEnabled ? "loading" : "unconfigured");
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<WireMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<WireMe>("/api/liana/me"));
      setError(null);
      setStatus("ready");
    } catch (e) {
      setError((e as Error).message);
      setStatus("ready"); // signed in, but /me failed — pages surface the error
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onIdTokenChanged(auth, (u) => {
      setUser(u);
      if (u) void loadMe();
      else {
        setMe(null);
        setStatus("signedout");
      }
    });
  }, [loadMe]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await signInWithGoogle(); // onIdTokenChanged does the rest
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!code.includes("popup-closed") && !code.includes("cancelled")) setError((e as Error).message);
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutUser();
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, me, error, signIn, signOut, refreshMe: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}
