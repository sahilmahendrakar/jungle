// Firebase init for the mobile app. Uses the Firebase JS SDK (same as the web app) so the backend
// token verification is unchanged. Two RN-specific things:
//   - persistence MUST be getReactNativePersistence(AsyncStorage) or the session silently drops on
//     app restart (the JS SDK defaults to in-memory on RN).
//   - config comes from app.json → extra.firebase (public client values; safe to ship, exactly like
//     the GoogleService-Info.plist that ships in every native iOS app).
import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  // @ts-expect-error — getReactNativePersistence is only in the react-native build of firebase/auth;
  // TS resolves the browser types here, but Metro loads the .rn build at runtime where it exists.
  getReactNativePersistence,
  GoogleAuthProvider,
  signInWithCredential,
  signOut,
  onIdTokenChanged,
  type Auth,
  type User,
} from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

interface FirebaseCfg {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const cfg = (Constants.expoConfig?.extra as { firebase?: FirebaseCfg } | undefined)?.firebase;
export const firebaseEnabled = Boolean(cfg?.apiKey && cfg?.projectId && cfg?.appId);

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
if (firebaseEnabled && cfg) {
  firebaseApp = getApps().length ? getApp() : initializeApp(cfg);
  firebaseAuth = initializeAuth(firebaseApp, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
}

export const auth = firebaseAuth;

// Exchange a Google ID token (from the expo-auth-session flow) for a Firebase session. Firebase
// accepts it because the iOS OAuth client that minted it belongs to the same Firebase project.
export function signInWithGoogleCredential(idToken: string) {
  if (!auth) throw new Error("firebase auth not configured");
  return signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

export function signOutUser() {
  return auth ? signOut(auth) : Promise.resolve();
}

export { onIdTokenChanged };
export type { User };
