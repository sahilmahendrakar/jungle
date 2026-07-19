// Live work chips anchored under the message that triggered an agent (web MessageTurnChips):
// a running chip with bouncing dots + a live one-line summary, a finished ✓/✗ chip, or a neutral
// "queued…" chip for a dispatch still waiting behind a busy agent. Tapping a real turn opens the
// agent Activity transcript focused on that turn.
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Participant } from "../lib/api";
import type { QueuedTurn, TurnChipData } from "../store/liveTurns";
import { buildItems, liveSummary } from "../lib/sdkEvents";
import { useTheme } from "../lib/theme-context";
import { emerald, radius } from "../theme";
import { WorkingDots } from "./WorkingDots";

function TurnChip({
  turn,
  agent,
  onOpenTurn,
}: {
  turn: TurnChipData;
  agent: Participant | undefined;
  onOpenTurn: (turn: TurnChipData) => void;
}) {
  const { colors } = useTheme();
  const items = useMemo(() => buildItems(turn.events), [turn.events, turn.events.length]);
  const handle = agent?.handle ?? "agent";
  const secs =
    turn.durationMs != null
      ? `${(turn.durationMs / 1000).toFixed(turn.durationMs >= 60_000 ? 0 : 1)}s`
      : null;
  const summary = turn.done
    ? `${turn.ok === false ? "failed" : "finished"}${secs ? ` · ${secs}` : ""}`
    : items.length
      ? liveSummary(items)
      : "starting…";

  return (
    <Pressable
      onPress={() => onOpenTurn(turn)}
      style={[
        styles.chip,
        turn.done
          ? { borderColor: colors.border, backgroundColor: colors.muted }
          : { borderColor: emerald.border, backgroundColor: emerald.bg },
      ]}
    >
      {turn.done ? (
        <Ionicons
          name={turn.ok === false ? "close" : "checkmark"}
          size={13}
          color={turn.ok === false ? colors.destructive : emerald.check}
        />
      ) : (
        <WorkingDots />
      )}
      <Text style={styles.text} numberOfLines={1}>
        <Text style={[styles.handle, { color: colors.foreground }]}>@{handle}</Text>
        <Text style={{ color: colors.mutedForeground }}> {summary}</Text>
      </Text>
    </Pressable>
  );
}

function QueuedChip({ agentId, agent }: { agentId: string; agent: Participant | undefined }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.muted }]}>
      <Ionicons name="time-outline" size={13} color={colors.mutedForeground} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={[styles.handle, { color: colors.foreground }]}>@{agent?.handle ?? agentId}</Text>
        <Text style={{ color: colors.mutedForeground }}> queued…</Text>
      </Text>
    </View>
  );
}

export function MessageTurnChips({
  turns,
  queued,
  personById,
  onOpenTurn,
}: {
  turns: TurnChipData[];
  queued: QueuedTurn[];
  personById: (id: string) => Participant | undefined;
  onOpenTurn: (turn: TurnChipData) => void;
}) {
  if (!turns.length && !queued.length) return null;
  return (
    <>
      {queued.map((q) => (
        <QueuedChip key={`queued:${q.agentId}:${q.messageId}`} agentId={q.agentId} agent={personById(q.agentId)} />
      ))}
      {turns.map((t) => (
        <TurnChip key={`${t.agentId}:${t.turnId}`} turn={t} agent={personById(t.agentId)} onOpenTurn={onOpenTurn} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  text: { fontSize: 12, flexShrink: 1 },
  handle: { fontWeight: "600" },
});
