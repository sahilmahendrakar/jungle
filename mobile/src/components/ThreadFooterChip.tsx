// The per-message thread affordance (web ThreadFooter): a "N replies" chip on a root with
// replies (jade + "N new" pill when the viewer follows it and has unread), or an "In thread"
// chip on an also-to-channel reply shown in the timeline. Tapping opens the thread.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Message } from "../lib/api";
import { useTheme } from "../lib/theme-context";

export function ThreadFooterChip({
  m,
  replyCounts,
  unreadByRoot,
  onOpenThread,
}: {
  m: Message;
  replyCounts: Map<string, number>;
  unreadByRoot: Map<string, number>;
  onOpenThread: (rootId: string) => void;
}) {
  const { colors } = useTheme();
  const rootId = m.thread_root_id ?? m.id;
  const isRoot = !m.thread_root_id;
  const count = isRoot ? replyCounts.get(m.id) ?? 0 : 0;
  const unread = unreadByRoot.get(rootId) ?? 0;

  if (isRoot && count > 0) {
    return (
      <Pressable style={styles.chip} onPress={() => onOpenThread(rootId)}>
        <Ionicons
          name="chatbubbles-outline"
          size={13}
          color={unread > 0 ? colors.primary : colors.mutedForeground}
        />
        <Text
          style={[
            styles.text,
            { color: unread > 0 ? colors.primary : colors.mutedForeground },
            unread > 0 && styles.bold,
          ]}
        >
          {count} {count === 1 ? "reply" : "replies"}
        </Text>
        {unread > 0 ? (
          <View style={[styles.newPill, { backgroundColor: colors.primary }]}>
            <Text style={[styles.newText, { color: colors.primaryForeground }]}>{unread} new</Text>
          </View>
        ) : null}
      </Pressable>
    );
  }
  if (!isRoot) {
    return (
      <Pressable style={styles.chip} onPress={() => onOpenThread(rootId)}>
        <Ionicons name="chatbubbles-outline" size={13} color={colors.mutedForeground} />
        <Text style={[styles.text, { color: colors.mutedForeground }]}>In thread</Text>
      </Pressable>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingHorizontal: 2 },
  text: { fontSize: 12 },
  bold: { fontWeight: "700" },
  newPill: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 2 },
  newText: { fontSize: 10, fontWeight: "700" },
});
