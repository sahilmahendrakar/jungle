import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, ActionSheetIOS } from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { listSchedules, updateSchedule, deleteSchedule, type Schedule } from "../src/lib/api";
import { useChatStore } from "../src/store/chat";
import { useTheme } from "../src/lib/theme-context";
import { ScreenHeader } from "../src/components/ScreenHeader";
import { EmptyState } from "../src/components/EmptyState";
import { fmtRelative } from "../src/lib/format";
import { radius } from "../src/theme";

function cadence(s: Schedule): string {
  if (s.cron) return `${s.cron}${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.run_at) return `Once · ${fmtRelative(s.run_at)}`;
  return "—";
}

export default function Scheduled() {
  const router = useRouter();
  const { colors } = useTheme();
  const schedulesStale = useChatStore((s) => s.schedulesStale);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  const load = useCallback(() => {
    listSchedules().then(setSchedules).catch(() => {});
  }, []);

  // Refetch on focus and whenever a schedule_changed event bumps the stale counter.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, schedulesStale]),
  );

  const actions = (s: Schedule) => {
    const paused = s.paused_at != null;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", paused ? "Resume" : "Pause", "Delete"],
        cancelButtonIndex: 0,
        destructiveButtonIndex: 2,
      },
      async (i) => {
        if (i === 1) {
          await updateSchedule(s.id, { paused: !paused }).catch(() => {});
          load();
        } else if (i === 2) {
          await deleteSchedule(s.id).catch(() => {});
          load();
        }
      },
    );
  };

  const statusColor = (s: Schedule) =>
    s.last_status === "failure" ? colors.destructive : s.last_status === "success" ? "#10b981" : colors.mutedForeground;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Scheduled" onBack={() => router.back()} />
      {schedules.length === 0 ? (
        <EmptyState glyph="🗓️" title="No scheduled turns" hint="Recurring or one-shot agent runs will appear here." />
      ) : (
        <FlatList
          data={schedules}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const paused = item.paused_at != null;
            return (
              <Pressable
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                onLongPress={() => actions(item)}
                onPress={() => actions(item)}
              >
                <View style={styles.rowTop}>
                  <Text style={[styles.prompt, { color: colors.foreground }]} numberOfLines={1}>
                    {item.prompt || "(no prompt)"}
                  </Text>
                  {paused ? (
                    <Ionicons name="pause-circle-outline" size={18} color={colors.mutedForeground} />
                  ) : null}
                </View>
                <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
                  @{item.agent_handle ?? "agent"}
                  {item.channel_name ? ` in #${item.channel_name}` : ""} · {cadence(item)}
                </Text>
                <View style={styles.rowBottom}>
                  <Text style={[styles.next, { color: colors.mutedForeground }]}>
                    {paused ? "Paused" : `Next ${fmtRelative(item.next_run_at)}`}
                  </Text>
                  {item.last_status ? (
                    <Text style={[styles.status, { color: statusColor(item) }]}>
                      {item.last_status}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 12, gap: 10 },
  row: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  prompt: { fontSize: 15, fontWeight: "600", flex: 1 },
  meta: { fontSize: 12 },
  rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  next: { fontSize: 12 },
  status: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
});
