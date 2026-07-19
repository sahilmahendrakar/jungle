import { useMemo, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Linking } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../src/store/chat";
import { useTheme } from "../../src/lib/theme-context";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { EmptyState } from "../../src/components/EmptyState";
import { ConfirmCard } from "../../src/components/ConfirmCard";
import { UnreadBadge } from "../../src/components/UnreadBadge";
import { fmtRelative } from "../../src/lib/format";
import { DELIVERABLE_KIND_META } from "../../src/lib/deliverableMeta";
import { radius } from "../../src/theme";
import type { Deliverable, UnreadThread } from "../../src/lib/api";

type Tab = "approvals" | "threads" | "deliverables";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export default function Activity() {
  const router = useRouter();
  const { colors } = useTheme();
  const [tab, setTab] = useState<Tab>("approvals");
  const confirms = useChatStore((s) => s.confirms);
  const unreadThreads = useChatStore((s) => s.unreadThreads);
  const deliverables = useChatStore((s) => s.deliverables);
  const channels = useChatStore((s) => s.channels);

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "approvals", label: "Approvals", count: confirms.length },
    { id: "threads", label: "Threads", count: unreadThreads.length },
    { id: "deliverables", label: "Shipped", count: 0 },
  ];

  // Deliverables grouped by day (already newest-first from the API).
  const deliverableSections = useMemo(() => {
    const groups: { title: string; data: Deliverable[] }[] = [];
    for (const d of deliverables) {
      const label = dayLabel(d.created_at);
      const last = groups[groups.length - 1];
      if (last && last.title === label) last.data.push(d);
      else groups.push({ title: label, data: [d] });
    }
    return groups;
  }, [deliverables]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Activity" />
      <View style={[styles.segment, { borderColor: colors.border }]}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[styles.segItem, tab === t.id && { backgroundColor: colors.primary }]}
          >
            <Text
              style={[
                styles.segText,
                { color: tab === t.id ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              {t.label}
              {t.count > 0 ? ` ${t.count}` : ""}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "approvals" ? (
        confirms.length === 0 ? (
          <EmptyState glyph="✅" title="Nothing waiting on you" hint="Tool approvals from your agents show up here." />
        ) : (
          <FlatList
            data={confirms}
            keyExtractor={(c) => c.confirmId}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <ConfirmCard
                confirm={item}
                channelName={channelName(item.channelId)}
                onOpenChannel={() => router.push(`/channel/${item.channelId}`)}
              />
            )}
          />
        )
      ) : null}

      {tab === "threads" ? (
        unreadThreads.length === 0 ? (
          <EmptyState glyph="🧵" title="No unread threads" hint="Replies to threads you follow appear here." />
        ) : (
          <FlatList
            data={unreadThreads}
            keyExtractor={(t) => t.root_id}
            contentContainerStyle={styles.list}
            renderItem={({ item }: { item: UnreadThread }) => (
              <Pressable
                style={[styles.threadRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => router.push(`/channel/${item.channel_id}/thread/${item.root_id}`)}
              >
                <View style={styles.threadTop}>
                  <Text style={[styles.threadChan, { color: colors.mutedForeground }]} numberOfLines={1}>
                    #{item.channel_name} · @{item.root_sender_handle}
                  </Text>
                  <UnreadBadge count={item.unread_count} />
                </View>
                <Text style={[styles.threadBody, { color: colors.foreground }]} numberOfLines={2}>
                  {item.root_body || "(no text)"}
                </Text>
              </Pressable>
            )}
          />
        )
      ) : null}

      {tab === "deliverables" ? (
        deliverables.length === 0 ? (
          <EmptyState glyph="📦" title="No shipped work yet" hint="PRs, docs, and other artifacts your agents ship land here." />
        ) : (
          <FlatList
            data={deliverableSections}
            keyExtractor={(s) => s.title}
            contentContainerStyle={styles.list}
            renderItem={({ item: section }) => (
              <View style={styles.daySection}>
                <Text style={[styles.dayLabel, { color: colors.mutedForeground }]}>{section.title}</Text>
                {section.data.map((d) => {
                  const meta = DELIVERABLE_KIND_META[d.kind];
                  return (
                    <Pressable
                      key={d.id}
                      style={[styles.delivRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                      onPress={() => Linking.openURL(d.url).catch(() => {})}
                    >
                      <View style={[styles.delivIcon, { backgroundColor: colors.primary + "1A" }]}>
                        <Ionicons name={meta.icon} size={18} color={colors.primary} />
                      </View>
                      <View style={styles.delivText}>
                        <Text style={[styles.delivTitle, { color: colors.foreground }]} numberOfLines={2}>
                          {d.title || meta.label}
                        </Text>
                        <Text style={[styles.delivMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                          {meta.label} · @{d.agent_handle} in #{d.channel_name} · {fmtRelative(d.created_at)}
                        </Text>
                      </View>
                      <Pressable onPress={() => router.push(`/channel/${d.channel_id}`)} hitSlop={8}>
                        <Ionicons name="chatbubble-outline" size={18} color={colors.mutedForeground} />
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            )}
          />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  segment: {
    flexDirection: "row",
    margin: 12,
    padding: 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: radius.sm },
  segText: { fontSize: 13, fontWeight: "600" },
  list: { padding: 12, gap: 10 },
  threadRow: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  threadTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  threadChan: { fontSize: 12, flex: 1 },
  threadBody: { fontSize: 14, lineHeight: 19 },
  daySection: { gap: 8, marginBottom: 6 },
  dayLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  delivRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 12,
  },
  delivIcon: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  delivText: { flex: 1, gap: 2 },
  delivTitle: { fontSize: 14, fontWeight: "600" },
  delivMeta: { fontSize: 12 },
});
