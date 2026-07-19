import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActionSheetIOS } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { Avatar } from "../../src/components/Avatar";
import { useTheme, type ThemePref } from "../../src/lib/theme-context";
import { useAuth } from "../../src/lib/auth";
import { useWorkspace } from "../../src/lib/workspace-context";
import { getBase, setServer, clearServerOverride, SERVER_PRESETS } from "../../src/lib/config";
import { radius } from "../../src/theme";

function Row({
  label,
  value,
  onPress,
  color,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  color: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[styles.row, { borderTopColor: colors.border }]}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.rowLabel, { color: colors.foreground }]}>{label}</Text>
      <View style={styles.rowRight}>
        {value ? <Text style={[styles.rowValue, { color }]}>{value}</Text> : null}
        {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} /> : null}
      </View>
    </Pressable>
  );
}

export default function You() {
  const router = useRouter();
  const { colors, pref, setPref } = useTheme();
  const { signOut } = useAuth();
  const { membership, memberships, setWsId, reboot } = useWorkspace();
  const p = membership?.participant;
  const [serverLabel, setServerLabel] = useState(() => {
    const b = getBase();
    return b === SERVER_PRESETS.prod ? "Production" : b === SERVER_PRESETS.preprod ? "Preprod" : b;
  });

  const switchWorkspace = () => {
    if (memberships.length < 2) return;
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", ...memberships.map((m) => m.workspace.name)], cancelButtonIndex: 0 },
      (i) => {
        if (i > 0) setWsId(memberships[i - 1].workspace.id);
      },
    );
  };

  const appearance = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Light", "Dark", "System"], cancelButtonIndex: 0 },
      (i) => {
        if (i === 1) setPref("light");
        else if (i === 2) setPref("dark");
        else if (i === 3) setPref("system");
      },
    );
  };

  const switchServer = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Production", "Preprod", "Reset to default"], cancelButtonIndex: 0 },
      async (i) => {
        if (i === 1) {
          await setServer(SERVER_PRESETS.prod);
          setServerLabel("Production");
        } else if (i === 2) {
          await setServer(SERVER_PRESETS.preprod);
          setServerLabel("Preprod");
        } else if (i === 3) {
          await clearServerOverride();
          setServerLabel(getBase() === SERVER_PRESETS.prod ? "Production" : "Preprod");
        } else return;
        reboot(); // re-fetch snapshot + reconnect the socket against the new origin
      },
    );
  };

  const prefLabel = pref === "light" ? "Light" : pref === "dark" ? "Dark" : "System";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="You" />
      <ScrollView contentContainerStyle={styles.content}>
        {p ? (
          <View style={styles.identity}>
            <Avatar handle={p.handle} name={p.display_name} url={p.avatar_url} size={64} />
            <View style={styles.identityText}>
              <Text style={[styles.name, { color: colors.foreground }]}>{p.display_name}</Text>
              <Text style={[styles.handle, { color: colors.mutedForeground }]}>@{p.handle}</Text>
              {p.email ? <Text style={[styles.handle, { color: colors.mutedForeground }]}>{p.email}</Text> : null}
            </View>
          </View>
        ) : null}

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Row
            label="Workspace"
            value={membership?.workspace.name}
            color={colors.mutedForeground}
            onPress={memberships.length > 1 ? switchWorkspace : undefined}
          />
          <Row label="Appearance" value={prefLabel} color={colors.mutedForeground} onPress={appearance} />
          <Row label="Scheduled turns" color={colors.mutedForeground} onPress={() => router.push("/scheduled")} />
        </View>

        {__DEV__ ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Row label="Server (dev)" value={serverLabel} color={colors.primary} onPress={switchServer} />
          </View>
        ) : null}

        <Pressable onPress={signOut} style={[styles.signOut, { borderColor: colors.border }]}>
          <Text style={[styles.signOutText, { color: colors.destructive }]}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 16 },
  identity: { flexDirection: "row", alignItems: "center", gap: 14 },
  identityText: { flex: 1, gap: 2 },
  name: { fontSize: 20, fontWeight: "700" },
  handle: { fontSize: 13 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 15 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 14 },
  signOut: {
    marginTop: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingVertical: 14,
    alignItems: "center",
  },
  signOutText: { fontSize: 15, fontWeight: "600" },
});
