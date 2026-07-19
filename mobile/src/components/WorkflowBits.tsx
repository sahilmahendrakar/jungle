// Small shared pieces for the Workflows screens: the status pill and a run row.
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Workflow, WorkflowRun } from "@jungle/shared";
import { useTheme } from "../lib/theme-context";
import { fmtRelative } from "../lib/format";
import { runDuration, runStatusMeta } from "../lib/workflowMeta";
import { radius } from "../theme";

const AMBER = "#d97706";

// Tinted capsule: Running (live, pulses conceptually — static dot here), Active, Draft/Paused,
// Stalled. Mirrors the web's badge palette.
export function StatusPill({ label, tone }: { label: string; tone: "live" | "active" | "muted" | "warn" }) {
  const { colors } = useTheme();
  const tint = tone === "live" || tone === "active" ? colors.primary : tone === "warn" ? AMBER : colors.mutedForeground;
  return (
    <View style={[styles.pill, { backgroundColor: tint + "1A" }]}>
      {tone === "live" ? <View style={[styles.dot, { backgroundColor: tint }]} /> : null}
      <Text style={[styles.pillText, { color: tint }]}>{label}</Text>
    </View>
  );
}

// One run: relative start time, status, summary, duration. Tapping opens the run's thread when
// it has one (a run's timeline IS its thread in the home channel).
export function RunRow({
  run,
  w,
  onOpenThread,
}: {
  run: WorkflowRun;
  w: Workflow;
  onOpenThread?: (channelId: string, rootId: string) => void;
}) {
  const { colors } = useTheme();
  const meta = runStatusMeta(run.status);
  const openable = !!(w.home_channel_id && run.root_message_id && onOpenThread);
  return (
    <Pressable
      disabled={!openable}
      onPress={() => onOpenThread?.(w.home_channel_id!, run.root_message_id!)}
      style={({ pressed }) => [
        styles.runRow,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.runTop}>
        <Text style={[styles.runWhen, { color: colors.foreground }]}>{fmtRelative(run.started_at)}</Text>
        <StatusPill label={meta.label} tone={meta.tone} />
        <Text style={[styles.runDur, { color: colors.mutedForeground }]}>{runDuration(run)}</Text>
      </View>
      <Text style={[styles.runSummary, { color: colors.mutedForeground }]} numberOfLines={2}>
        {run.summary ?? (run.status === "running" ? "In progress…" : "—")}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: { fontSize: 11, fontWeight: "700" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  runRow: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  runTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  runWhen: { fontSize: 13, fontWeight: "600", flex: 1 },
  runDur: { fontSize: 12 },
  runSummary: { fontSize: 13, lineHeight: 18 },
});
