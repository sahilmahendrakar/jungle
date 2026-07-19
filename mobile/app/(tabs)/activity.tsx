import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../src/store/chat";
import { useTheme } from "../../src/lib/theme-context";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { EmptyState } from "../../src/components/EmptyState";
import { ConfirmCard } from "../../src/components/ConfirmCard";
import { UnreadBadge } from "../../src/components/UnreadBadge";
import { Avatar } from "../../src/components/Avatar";
import { fmtRelative } from "../../src/lib/format";
import { DELIVERABLE_KIND_META } from "../../src/lib/deliverableMeta";
import { listActivity, type ActivityFilters, type ActivityItem, type ActivityMessage, type Deliverable, type UnreadThread } from "../../src/lib/api";
import { radius } from "../../src/theme";

// The Activity tab: the unified Feed (the web Activity page — your messages, DMs, @mentions,
// thread replies, and deliverables, composably filtered), plus Approvals and unread Threads.
// The old "Shipped" segment became the Feed's Deliverables type filter.

type Tab = "feed" | "approvals" | "threads";
type Direction = NonNullable<ActivityFilters["direction"]>;

const PAGE = 50;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function itemTs(it: ActivityItem): string {
  return it.type === "message" ? it.message.created_at : it.deliverable.created_at;
}

function itemKey(it: ActivityItem): string {
  return it.type === "message" ? `m:${it.message.message_id}` : `d:${it.deliverable.id}`;
}

function whereLabel(m: ActivityMessage): string {
  const where = m.channel_kind === "dm" ? `@${m.dm_with ?? "dm"}` : `#${m.channel_name}`;
  return m.thread_root_id ? `${where} · in thread` : where;
}

// The feed flattened for one FlatList: day headers interleaved with items.
type FeedRow = { kind: "day"; label: string } | { kind: "item"; item: ActivityItem };

export default function Activity() {
  const router = useRouter();
  const { colors } = useTheme();
  const [tab, setTab] = useState<Tab>("feed");
  const confirms = useChatStore((s) => s.confirms);
  const unreadThreads = useChatStore((s) => s.unreadThreads);
  const channels = useChatStore((s) => s.channels);
  const people = useChatStore((s) => s.people);

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name;
  const personByHandle = useCallback(
    (h?: string | null) => (h ? people.find((p) => p.handle === h) : undefined),
    [people],
  );

  // --- Feed state ---
  const [type, setType] = useState<ActivityFilters["type"]>("all");
  const [direction, setDirection] = useState<Direction | undefined>(undefined);
  const [text, setText] = useState("");
  const [appliedText, setAppliedText] = useState("");
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadingMore = useRef(false);

  // Debounce the free text so typing doesn't refetch per keystroke. Tokens like "from:@pip"
  // still work — the backend parses them out of `q`.
  useEffect(() => {
    const t = setTimeout(() => setAppliedText(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const filters = useMemo<ActivityFilters & { q?: string }>(
    () => ({ type, direction: type === "deliverables" ? undefined : direction, q: appliedText || undefined }),
    [type, direction, appliedText],
  );

  const fetchFirst = useCallback(() => {
    return listActivity(filters, { limit: PAGE })
      .then((r) => {
        setItems(r.items);
        setHasMore(r.hasMore);
      })
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, [filters]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  useFocusEffect(
    useCallback(() => {
      void fetchFirst();
    }, [fetchFirst]),
  );

  async function loadMore() {
    if (loadingMore.current || !hasMore || items.length === 0) return;
    loadingMore.current = true;
    try {
      const before = itemTs(items[items.length - 1]);
      const r = await listActivity(filters, { before, limit: PAGE });
      setItems((prev) => {
        const seen = new Set(prev.map(itemKey));
        return [...prev, ...r.items.filter((x) => !seen.has(itemKey(x)))];
      });
      setHasMore(r.hasMore);
    } catch {
      /* keep what we have */
    } finally {
      loadingMore.current = false;
    }
  }

  // Interleave day headers into the newest-first feed.
  const feedRows = useMemo<FeedRow[]>(() => {
    const rows: FeedRow[] = [];
    let day = "";
    for (const it of items) {
      const label = dayLabel(itemTs(it));
      if (label !== day) {
        rows.push({ kind: "day", label });
        day = label;
      }
      rows.push({ kind: "item", item: it });
    }
    return rows;
  }, [items]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "feed", label: "Feed", count: 0 },
    { id: "approvals", label: "Approvals", count: confirms.length },
    { id: "threads", label: "Threads", count: unreadThreads.length },
  ];

  const openMessage = (m: ActivityMessage) => {
    if (m.thread_root_id) router.push(`/channel/${m.channel_id}/thread/${m.thread_root_id}`);
    else router.push(`/channel/${m.channel_id}`);
  };

  const renderDeliverable = (d: Deliverable) => {
    const meta = DELIVERABLE_KIND_META[d.kind];
    return (
      <Pressable
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
  };

  const renderFeedRow = ({ item: row }: { item: FeedRow }) => {
    if (row.kind === "day") {
      return <Text style={[styles.dayLabel, { color: colors.mutedForeground }]}>{row.label}</Text>;
    }
    const it = row.item;
    if (it.type === "deliverable") return renderDeliverable(it.deliverable);
    const m = it.message;
    const sender = personByHandle(m.sender_handle);
    return (
      <Pressable
        style={({ pressed }) => [
          styles.msgRow,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
        onPress={() => openMessage(m)}
      >
        <Avatar handle={m.sender_handle} name={sender?.display_name} url={sender?.avatar_url} size={30} />
        <View style={styles.msgBody}>
          <View style={styles.msgTop}>
            <Text style={[styles.msgSender, { color: colors.foreground }]} numberOfLines={1}>
              {sender?.display_name ?? m.sender_handle}
            </Text>
            <Text style={[styles.msgTime, { color: colors.mutedForeground }]}>{fmtRelative(m.created_at)}</Text>
            {m.mentions_me ? (
              <View style={[styles.mentionPill, { backgroundColor: colors.primary + "1A" }]}>
                <Text style={[styles.mentionText, { color: colors.primary }]}>@ you</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.msgText, { color: colors.foreground }]} numberOfLines={2}>
            {m.body || "(attachment)"}
          </Text>
          <Text style={[styles.msgWhere, { color: colors.mutedForeground }]} numberOfLines={1}>
            {whereLabel(m)}
          </Text>
        </View>
      </Pressable>
    );
  };

  const typePills: { value: ActivityFilters["type"]; label: string }[] = [
    { value: "all", label: "All" },
    { value: "messages", label: "Messages" },
    { value: "deliverables", label: "Shipped" },
  ];
  const dirPills: Direction[] = ["sent", "received", "mentions"];

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

      {tab === "feed" ? (
        <>
          {/* Filter pills + free-text search (server-side tokens like from:@pip still apply). */}
          <View style={styles.filterBar}>
            <View style={styles.pillRow}>
              {typePills.map((p) => (
                <Pressable
                  key={p.value}
                  onPress={() => setType(p.value)}
                  style={[
                    styles.pill,
                    { backgroundColor: type === p.value ? colors.primary : colors.muted },
                  ]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      { color: type === p.value ? colors.primaryForeground : colors.mutedForeground },
                    ]}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              ))}
              {type !== "deliverables" ? (
                <>
                  <View style={[styles.pillDivider, { backgroundColor: colors.border }]} />
                  {dirPills.map((d) => (
                    <Pressable
                      key={d}
                      onPress={() => setDirection(direction === d ? undefined : d)}
                      style={[
                        styles.pill,
                        { backgroundColor: direction === d ? colors.primary : colors.muted },
                      ]}
                    >
                      <Text
                        style={[
                          styles.pillText,
                          { color: direction === d ? colors.primaryForeground : colors.mutedForeground },
                        ]}
                      >
                        {d === "mentions" ? "Mentions" : d[0].toUpperCase() + d.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </>
              ) : null}
            </View>
            <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="search" size={14} color={colors.mutedForeground} />
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Filter — try text, from:@pip, in:#general"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {text ? (
                <Pressable onPress={() => setText("")} hitSlop={8}>
                  <Ionicons name="close-circle" size={15} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {loaded && items.length === 0 ? (
            <EmptyState
              glyph="🌊"
              title="Nothing matches"
              hint={
                appliedText || direction || type !== "all"
                  ? "Try removing a filter or two."
                  : "Your messages, mentions, thread replies, and deliverables land here."
              }
            />
          ) : (
            <FlatList
              data={feedRows}
              keyExtractor={(r, i) => (r.kind === "day" ? `day-${r.label}-${i}` : itemKey(r.item))}
              renderItem={renderFeedRow}
              contentContainerStyle={styles.list}
              onEndReachedThreshold={0.4}
              onEndReached={() => void loadMore()}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    setRefreshing(true);
                    void fetchFirst().finally(() => setRefreshing(false));
                  }}
                  tintColor={colors.mutedForeground}
                />
              }
            />
          )}
        </>
      ) : null}

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  segment: {
    flexDirection: "row",
    margin: 12,
    marginBottom: 8,
    padding: 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: radius.sm },
  segText: { fontSize: 13, fontWeight: "600" },
  filterBar: { paddingHorizontal: 12, gap: 8 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { fontSize: 12, fontWeight: "600" },
  pillDivider: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginHorizontal: 2 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  searchInput: { flex: 1, fontSize: 13, padding: 0 },
  list: { padding: 12, gap: 10 },
  dayLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  msgRow: { flexDirection: "row", gap: 10, borderWidth: 1, borderRadius: radius.lg, padding: 12 },
  msgBody: { flex: 1, gap: 2 },
  msgTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  msgSender: { fontSize: 14, fontWeight: "700", flexShrink: 1 },
  msgTime: { fontSize: 11 },
  mentionPill: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  mentionText: { fontSize: 10, fontWeight: "700" },
  msgText: { fontSize: 14, lineHeight: 19 },
  msgWhere: { fontSize: 12 },
  threadRow: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  threadTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  threadChan: { fontSize: 12, flex: 1 },
  threadBody: { fontSize: 14, lineHeight: 19 },
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
