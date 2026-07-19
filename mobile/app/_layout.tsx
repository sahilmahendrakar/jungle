import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider, useAuth } from "../src/lib/auth";
import { initConfig } from "../src/lib/config";
import { ThemeProvider, useTheme } from "../src/lib/theme-context";
import { WorkspaceProvider, useWorkspace } from "../src/lib/workspace-context";
import { installNotificationHandler, installTapHandler } from "../src/lib/push";
import { SignIn } from "../src/screens/SignIn";

installNotificationHandler();

function Splash() {
  const { colors } = useTheme();
  return (
    <View style={[styles.splash, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

// The navigator: tabs + the screens that push over them (channel, thread, agent, scheduled).
// Header is hidden globally; each screen draws its own (matching the web's custom chrome).
function AppStack() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="channel/[id]/index" />
      <Stack.Screen name="channel/[id]/thread/[rootId]" />
      <Stack.Screen name="agent/[id]/index" />
      <Stack.Screen name="agent/[id]/activity" />
      <Stack.Screen name="scheduled" />
    </Stack>
  );
}

// Gate the tabs behind the initial workspace bootstrap.
function WorkspaceGate() {
  const { ready } = useWorkspace();
  if (!ready) return <Splash />;
  return <AppStack />;
}

function AuthGate() {
  const { ready, user } = useAuth();
  const router = useRouter();
  // Deep-link notification taps (and cold starts) to the channel/activity they name. The backend
  // sends scheme URLs (jungle:///channel/<id>); strip the scheme to an expo-router path.
  useEffect(
    () => installTapHandler((url) => router.push(url.replace(/^jungle:\/\//, "/").replace(/^\/+/, "/") as never)),
    [router],
  );
  if (!ready) return <Splash />;
  if (!user) return <SignIn />;
  return (
    <WorkspaceProvider>
      <WorkspaceGate />
    </WorkspaceProvider>
  );
}

export default function RootLayout() {
  const [cfgReady, setCfgReady] = useState(false);
  useEffect(() => {
    initConfig().finally(() => setCfgReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={styles.flex}>
      <ThemeProvider>
        <StatusBar style="light" />
        {cfgReady ? (
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        ) : (
          <Splash />
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  splash: { flex: 1, alignItems: "center", justifyContent: "center" },
});
