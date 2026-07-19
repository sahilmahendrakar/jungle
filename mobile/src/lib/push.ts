// Expo push-notification client wiring. Every reference to expo-notifications is behind a lazy
// require in try/catch so the JS bundle still runs on a dev client that DOESN'T yet bundle the
// native module (the current build) — importing it statically would crash startup. Once the
// push-enabled build is installed these all succeed.
//
// Responsibilities: request permission + register the Expo token with the backend after sign-in;
// suppress the foreground banner for the channel you're actively viewing; deep-link on tap (and
// cold-start) via expo-router; unregister on sign-out.
import { Platform } from "react-native";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import { registerPushToken, unregisterPushToken } from "./api";
import { useChatStore } from "../store/chat";

// True only on a build that actually bundles the expo-notifications native modules (the push-
// enabled dev/prod build). On the pre-push build ExpoPushTokenManager is absent, so every push
// call must no-op silently instead of throwing "Cannot find native module 'ExpoPushTokenManager'".
// The whole expo-notifications package ships together, so probing this one module is sufficient.
const PUSH_NATIVE_AVAILABLE = !!requireOptionalNativeModule("ExpoPushTokenManager");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function notifications(): any | null {
  if (!PUSH_NATIVE_AVAILABLE) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications");
  } catch {
    return null;
  }
}

const projectId =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  "4e1a7101-bfb0-40f3-9331-7224eb76fd27";

let registeredToken: string | null = null;

// Show nothing when the app is foregrounded on the very channel the notification is about (the WS
// already updated the UI); otherwise present the banner.
export function installNotificationHandler(): void {
  const N = notifications();
  if (!N) return;
  try {
    N.setNotificationHandler({
      handleNotification: async (notif: any) => {
        const data = notif?.request?.content?.data ?? {};
        const open = useChatStore.getState().selectedChannelId;
        const suppress = data.channelId && data.channelId === open;
        return {
          shouldShowBanner: !suppress,
          shouldShowList: true,
          shouldPlaySound: !suppress,
          shouldSetBadge: false,
        };
      },
    });
  } catch {
    /* native module absent on this build */
  }
}

// Ask permission + register the Expo token with the backend. Safe no-op on a build without the
// native module, on a simulator, or when permission is denied.
export async function registerPush(): Promise<void> {
  const N = notifications();
  if (!N || Platform.OS !== "ios") return;
  try {
    const settings = await N.getPermissionsAsync();
    let granted = settings.granted || settings.ios?.status === 3; // 3 = authorized
    if (!granted) {
      const req = await N.requestPermissionsAsync();
      granted = req.granted || req.ios?.status === 3;
    }
    if (!granted) return;
    const { data: token } = await N.getExpoPushTokenAsync({ projectId });
    if (token && token !== registeredToken) {
      await registerPushToken(token, "ios");
      registeredToken = token;
    }
  } catch (err) {
    console.warn("[push] register failed:", err);
  }
}

// Wire notification taps to navigation. Returns a cleanup fn. `navigate` deep-links to data.url
// (e.g. jungle:///channel/<id>); also handles a cold start (app launched by tapping a push).
export function installTapHandler(navigate: (url: string) => void): () => void {
  const N = notifications();
  if (!N) return () => {};
  const handle = (resp: any) => {
    const url = resp?.notification?.request?.content?.data?.url;
    if (typeof url === "string") navigate(url);
  };
  let sub: { remove: () => void } | null = null;
  try {
    sub = N.addNotificationResponseReceivedListener(handle);
    // Cold start: the app was launched by tapping a notification.
    N.getLastNotificationResponseAsync?.().then((resp: any) => {
      if (resp) handle(resp);
    });
  } catch {
    /* native module absent */
  }
  return () => sub?.remove();
}

export async function unregisterPush(): Promise<void> {
  if (!registeredToken) return;
  try {
    await unregisterPushToken(registeredToken);
  } catch {
    /* best effort */
  }
  registeredToken = null;
}
