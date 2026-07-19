// A pending tool-call approval (web ConfirmCard): an amber card naming the agent + tool, the
// tool input in a scrollable mono block, and Approve / Deny buttons. Resolving posts the decision;
// the store removes the card when the tool_confirmation_resolved event lands.
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { confirmToolCall, type PendingConfirmation } from "../lib/api";
import { fmtRelative } from "../lib/format";
import { useTheme } from "../lib/theme-context";
import { amber, radius } from "../theme";
import { pretty } from "../lib/sdkEvents";

export function ConfirmCard({
  confirm,
  channelName,
  onOpenChannel,
}: {
  confirm: PendingConfirmation;
  channelName?: string;
  onOpenChannel?: () => void;
}) {
  const { colors, resolved } = useTheme();
  const a = resolved === "light" ? amber.light : amber.dark;
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    try {
      await confirmToolCall(confirm.confirmId, decision);
    } catch {
      setBusy(false); // leave the card up on failure
    }
  };

  return (
    <View style={[styles.card, { borderColor: a.border, backgroundColor: a.bg }]}>
      <View style={styles.head}>
        <Ionicons name="shield-half-outline" size={18} color={a.icon} />
        <Text style={[styles.title, { color: colors.foreground }]}>
          <Text style={styles.bold}>{confirm.agentName}</Text> wants to run{" "}
          <Text style={[styles.tool, { backgroundColor: colors.muted, color: colors.foreground }]}>
            {confirm.tool}
          </Text>
        </Text>
      </View>
      <Pressable onPress={onOpenChannel} disabled={!onOpenChannel}>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {channelName ? `#${channelName} · ` : ""}
          {fmtRelative(confirm.createdAt)}
        </Text>
      </Pressable>
      {confirm.input != null ? (
        <ScrollView
          style={[styles.pre, { backgroundColor: colors.background, borderColor: colors.border }]}
          nestedScrollEnabled
        >
          <Text style={[styles.preText, { color: colors.foreground }]}>{pretty(confirm.input)}</Text>
        </ScrollView>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
          onPress={() => decide("allow")}
          disabled={busy}
        >
          <Ionicons name="checkmark" size={16} color={colors.primaryForeground} />
          <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Approve</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.deny, { borderColor: colors.border, opacity: busy ? 0.6 : 1 }]}
          onPress={() => decide("deny")}
          disabled={busy}
        >
          <Ionicons name="close" size={16} color={colors.foreground} />
          <Text style={[styles.btnText, { color: colors.foreground }]}>Deny</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 8 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { fontSize: 14, flex: 1, lineHeight: 20 },
  bold: { fontWeight: "700" },
  tool: {
    fontFamily: "Menlo",
    fontSize: 12,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: "hidden",
  },
  meta: { fontSize: 12 },
  pre: { maxHeight: 190, borderWidth: 1, borderRadius: radius.md, padding: 8 },
  preText: { fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: "row", gap: 8, marginTop: 2 },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.md,
    paddingVertical: 9,
  },
  deny: { borderWidth: 1 },
  btnText: { fontSize: 14, fontWeight: "600" },
});
