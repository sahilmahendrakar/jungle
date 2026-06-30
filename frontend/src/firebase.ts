import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onIdTokenChanged,
  type Auth,
  type User,
} from "firebase/auth";

// Config comes from VITE_FIREBASE_* env vars (public client config, not secret). When they're
// absent — e.g. the test/dev environment — auth is "disabled" and the app falls back to the
// legacy ?as= dev sign-in so the existing Playwright suites keep working unchanged.
const env = import.meta.env as Record<string, string | undefined>;
const cfg = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId);

let app: FirebaseApp | null = null;
export const auth: Auth | null = firebaseEnabled ? getAuth((app = initializeApp(cfg))) : null;

const provider = new GoogleAuthProvider();

export function signInWithGoogle() {
  if (!auth) throw new Error("firebase auth not configured");
  return signInWithPopup(auth, provider);
}

export function signOutUser() {
  return auth ? signOut(auth) : Promise.resolve();
}

export { onIdTokenChanged };
export type { User };
