import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onIdTokenChanged,
  type Auth,
  type User,
} from "firebase/auth";

// Same Firebase project as jungle (public client config, not secret) via NEXT_PUBLIC_* env.
// When unset — local dev without auth — the app shows a "sign-in not configured" landing state.
const cfg = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId);

let app: FirebaseApp | null = null;
export const auth: Auth | null = firebaseEnabled
  ? getAuth((app = getApps()[0] ?? initializeApp(cfg)))
  : null;

const provider = new GoogleAuthProvider();

export function signInWithGoogle() {
  if (!auth) throw new Error("firebase auth not configured");
  return signInWithPopup(auth, provider);
}

export function signOutUser() {
  return auth ? signOut(auth) : Promise.resolve();
}

// The bearer credential for every API call — Firebase refreshes it under the hood.
export async function idToken(): Promise<string | null> {
  return auth?.currentUser ? auth.currentUser.getIdToken() : null;
}

export { onIdTokenChanged };
export type { User };
