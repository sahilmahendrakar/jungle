import { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../../src/store/chat";
import { fetchAgentEvents } from "../../../src/lib/api";
import { useTheme } from "../../../src/lib/theme-context";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { EmptyState } from "../../../src/components/EmptyState";
import { Avatar } from "../../../src/components/Avatar";
import { StatusDot } from "../../../src/components/StatusDot";
import {
  buildItems,
  groupTurns,
  mergeEvents,
  turnSummary,
  clip,
  baseName,
  inputStr,
  inputField,
  firstString,
  pretty,
  type Item,
  type ToolItem,
} from "../../../src/lib/sdkEvents";
import { radius } from "../../../src/theme";
import type { IoniconName } from "../../../src/lib/icons";

function toolMeta(name: string, input: unknown): { icon: IoniconName; verb: string; target?: string; mono?: boolean } {
  switch (name) {
    case "Bash":
      return { icon: "terminal-outline", verb: "Ran", target: inputField(input, "description") ?? inputStr(input, "command"), mono: !inputField(input, "description") };
    case "Read":
      return { icon: "document-text-outline", verb: "Read", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Edit":
      return { icon: "create-outline", verb: "Edited", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Write":
      return { icon: "add-circle-outline", verb: "Wrote", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Grep":
      return { icon: "search-outline", verb: "Searched", target: inputStr(input, "pattern"), mono: true };
    case "Glob":
      return { icon: "search-outline", verb: "Found files", target: inputStr(input, "pattern"), mono: true };
    case "WebFetch":
      return { icon: "globe-outline", verb: "Fetched", target: inputStr(input, "url"), mono: true };
    case "WebSearch":
      return { icon: "globe-outline", verb: "Searched web", target: inputStr(input, "query") };
    case "Task":
    case "Agent":
      return { icon: "sparkles-outline", verb: "Ran subagent", target: inputStr(input, "description") };
    case "TodoWrite":
      return { icon: "checkmark-done-outline", verb: "Updated to-dos" };
  }
  const mcp = name.match(/^mcp__([^_].*?)__(.+)$/);
  if (mcp) {
    const label = mcp[2].replace(/_/g, " ");
    const verb = label.charAt(0).toUpperCase() + label.slice(1);
    if (mcp[2] === "send_message") return { icon: "chatbubble-outline", verb: "Sent message", target: firstString(input) };
    return { icon: "build-outline", verb, target: firstString(input) };
  }
  return { icon: "build-outline", verb: name, target: firstString(input) };
}

function ToolRow({ item }: { item: ToolItem }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const meta = toolMeta(item.name, item.input);
  const pending = item.result == null;
  const err = item.result?.isError;
  return (
    <View>
      <Pressable style={styles.itemRow} onPress={() => setOpen((v) => !v)}>
        <Ionicons name={meta.icon} size={15} color={colors.mutedForeground} />
        <Text style={[styles.verb, { color: colors.foreground }]}>{meta.verb}</Text>
        {meta.target ? (
          <Text
            style={[styles.target, { color: colors.mutedForeground }, meta.mono && styles.mono]}
            numberOfLines={1}
          >
            {clip(meta.target)}
          </Text>
        ) : null}
        {pending ? (
          <Ionicons name="ellipsis-horizontal" size={14} color={colors.mutedForeground} />
        ) : (
          <Ionicons name={err ? "close" : "checkmark"} size={14} color={err ? colors.destructive : "#10b981"} />
        )}
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          {item.name === "Bash" && inputField(item.input, "command") ? (
            <View style={[styles.term, { backgroundColor: "#0c0a09" }]}>
              <Text style={styles.termText}>$ {inputField(item.input, "command")}</Text>
            </View>
          ) : item.input && typeof item.input === "object" && Object.keys(item.input).length ? (
            <View style={[styles.output, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Text style={[styles.outputText, { color: colors.foreground }]}>{pretty(item.input)}</Text>
            </View>
          ) : null}
          {item.result ? (
            <View
              style={[
                styles.output,
                {
                  backgroundColor: err ? "rgba(239,68,68,0.08)" : colors.muted,
                  borderColor: err ? "rgba(239,68,68,0.4)" : colors.border,
                },
              ]}
            >
              <Text style={[styles.outputText, { color: err ? colors.destructive : colors.foreground }]}>
                {clip2(item.result.text)}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function clip2(s: string): string {
  return s.length > 1200 ? s.slice(0, 1200) + "…" : s;
}

function ItemView({ item }: { item: Item }) {
  const { colors } = useTheme();
  if (item.kind === "tool") return <ToolRow item={item} />;
  if (item.kind === "thinking")
    return (
      <View style={styles.itemRow}>
        <Ionicons name="sparkles-outline" size={15} color={colors.mutedForeground} />
        <Text style={[styles.thinking, { color: colors.mutedForeground }]} numberOfLines={2}>
          {clip(item.text)}
        </Text>
      </View>
    );
  if (item.kind === "text")
    return <Text style={[styles.text, { color: colors.foreground }]}>{item.text}</Text>;
  if (item.kind === "inbound")
    return (
      <View style={[styles.inbound, { borderColor: colors.border }]}>
        <Ionicons name="download-outline" size={14} color={colors.mutedForeground} />
        <Text style={[styles.inboundText, { color: colors.mutedForeground }]} numberOfLines={2}>
          {clip(item.text)}
        </Text>
      </View>
    );
  if (item.kind === "result")
    return (
      <View style={styles.itemRow}>
        <Ionicons name={item.ok ? "checkmark-circle" : "close-circle"} size={15} color={item.ok ? "#10b981" : colors.destructive} />
        <Text style={[styles.result, { color: colors.mutedForeground }]}>
          {item.ok ? "Done" : "Failed"}
          {item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}
          {item.cost != null ? ` · $${item.cost.toFixed(4)}` : ""}
        </Text>
      </View>
    );
  if (item.kind === "note")
    return <Text style={[styles.note, { color: colors.mutedForeground }]}>{item.text}</Text>;
  return null;
}

function TurnSection({ events, defaultOpen }: { events: any[]; defaultOpen: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  const items = useMemo(() => buildItems(events), [events]);
  const summary = turnSummary(items);
  return (
    <View style={[styles.turn, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable style={styles.turnHead} onPress={() => setOpen((v) => !v)}>
        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={16} color={colors.mutedForeground} />
        <Text style={[styles.turnSummary, { color: colors.foreground }]} numberOfLines={open ? undefined : 1}>
          {summary || "Turn"}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.turnBody}>
          {items.map((it) => (
            <ItemView key={it.key} item={it} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function AgentActivity() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const agentId = String(id);
  const person = useChatStore((s) => s.people.find((p) => p.id === agentId));
  const activityEvents = useChatStore((s) => s.activityEvents);
  const activityAgentId = useChatStore((s) => s.activityAgentId);
  const setActivityAgent = useChatStore((s) => s.setActivityAgent);
  useChatStore((s) => s.liveVersion); // re-render as live events stream in

  useEffect(() => {
    fetchAgentEvents(agentId, { limit: 200 })
      .then((page) => {
        const asc = [...page.events].sort((a, b) => a.id - b.id);
        setActivityAgent(agentId, asc);
      })
      .catch(() => setActivityAgent(agentId, []));
    return () => setActivityAgent(null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Newest turn first.
  const turns = useMemo(() => {
    if (activityAgentId !== agentId) return [];
    return groupTurns(mergeEvents(activityEvents, [])).reverse();
  }, [activityEvents, activityAgentId, agentId]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={person?.display_name ?? "Activity"}
        subtitle={person ? `@${person.handle}` : undefined}
        onBack={() => router.back()}
        right={person ? <StatusDot status={person.status} /> : undefined}
      />
      {turns.length === 0 ? (
        <EmptyState glyph="⚙️" title="No activity yet" hint="This agent hasn't done any work in this workspace." />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {turns.map((t, i) => (
            <TurnSection key={t.turnId} events={t.events} defaultOpen={i === 0} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 12, gap: 10 },
  turn: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  turnHead: { flexDirection: "row", alignItems: "center", gap: 6, padding: 12 },
  turnSummary: { fontSize: 14, fontWeight: "600", flex: 1 },
  turnBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  verb: { fontSize: 13, fontWeight: "600" },
  target: { fontSize: 13, flex: 1 },
  mono: { fontFamily: "Menlo", fontSize: 12 },
  thinking: { fontSize: 13, fontStyle: "italic", flex: 1 },
  text: { fontSize: 14, lineHeight: 20 },
  note: { fontSize: 12 },
  result: { fontSize: 13 },
  detail: { marginTop: 6, marginLeft: 22, gap: 6 },
  term: { borderRadius: radius.md, padding: 10 },
  termText: { fontFamily: "Menlo", fontSize: 11, color: "#e4e4e7", lineHeight: 16 },
  output: { borderWidth: 1, borderRadius: radius.md, padding: 8, maxHeight: 260 },
  outputText: { fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
  inbound: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: radius.md,
    padding: 8,
  },
  inboundText: { fontSize: 12, flex: 1 },
});
