import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../src/store/chat";
import { searchMessages, type SearchResult, type Channel, type Participant } from "../../src/lib/api";
import { useTheme } from "../../src/lib/theme-context";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { Avatar } from "../../src/components/Avatar";
import { fmtRelative } from "../../src/lib/format";
import { radius } from "../../src/theme";

export default function Search() {
  const router = useRouter();
  const { colors } = useTheme();
  const channels = useChatStore((s) => s.channels);
  const people = useChatStore((s) => s.people);
  const myPid = useChatStore((s) => s.myParticipantId);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced server FTS (min 2 chars).
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => {
      searchMessages(q.trim(), 20)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  const ql = q.trim().toLowerCase();
  const channelHits = useMemo(
    () => (ql.length >= 1 ? channels.filter((c) => c.kind !== "dm" && c.name.toLowerCase().includes(ql)).slice(0, 6) : []),
    [channels, ql],
  );
  const peopleHits = useMemo(
    () =>
      ql.length >= 1
        ? people
            .filter((p) => p.id !== myPid && (p.handle.toLowerCase().includes(ql) || p.display_name.toLowerCase().includes(ql)))
            .slice(0, 6)
        : [],
    [people, ql, myPid],
  );

  const sections = [
    ...(channelHits.length ? [{ type: "header" as const, key: "h-ch", label: "Channels" }] : []),
    ...channelHits.map((c) => ({ type: "channel" as const, key: `ch-${c.id}`, channel: c })),
    ...(peopleHits.length ? [{ type: "header" as const, key: "h-pp", label: "People" }] : []),
    ...peopleHits.map((p) => ({ type: "person" as const, key: `pp-${p.id}`, person: p })),
    ...(results.length ? [{ type: "header" as const, key: "h-msg", label: "Messages" }] : []),
    ...results.map((r) => ({ type: "message" as const, key: `msg-${r.message_id}`, result: r })),
  ];

  const render = ({ item }: { item: (typeof sections)[number] }) => {
    if (item.type === "header")
      return <Text style={[styles.section, { color: colors.mutedForeground }]}>{item.label}</Text>;
    if (item.type === "channel") {
      const c = item.channel as Channel;
      return (
        <Pressable style={styles.row} onPress={() => router.push(`/channel/${c.id}`)}>
          <Ionicons name="grid-outline" size={18} color={colors.mutedForeground} />
          <Text style={[styles.rowTitle, { color: colors.foreground }]}>{c.name}</Text>
        </Pressable>
      );
    }
    if (item.type === "person") {
      const p = item.person as Participant;
      return (
        <Pressable style={styles.row} onPress={() => router.push(`/agent/${p.id}`)}>
          <Avatar handle={p.handle} name={p.display_name} url={p.avatar_url} size={26} />
          <Text style={[styles.rowTitle, { color: colors.foreground }]}>{p.display_name}</Text>
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>@{p.handle}</Text>
        </Pressable>
      );
    }
    const r = item.result as SearchResult;
    return (
      <Pressable style={styles.msgRow} onPress={() => router.push(`/channel/${r.channel_id}`)}>
        <Text style={[styles.msgBody, { color: colors.foreground }]} numberOfLines={2}>
          {r.body}
        </Text>
        <Text style={[styles.msgMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
          @{r.sender_handle} in {r.channel_kind === "dm" ? `@${r.dm_with}` : `#${r.channel_name}`} · {fmtRelative(r.created_at)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Search" />
      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="search" size={17} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Search messages, channels, people…"
            placeholderTextColor={colors.mutedForeground}
            value={q}
            onChangeText={setQ}
            autoFocus
            autoCorrect={false}
            returnKeyType="search"
          />
          {loading ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
        </View>
      </View>
      <FlatList
        data={sections}
        keyExtractor={(s) => s.key}
        renderItem={render}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchWrap: { padding: 12 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchInput: { flex: 1, fontSize: 15 },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  section: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", marginTop: 14, marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  rowTitle: { fontSize: 15, fontWeight: "500" },
  rowSub: { fontSize: 13 },
  msgRow: { paddingVertical: 9, gap: 3 },
  msgBody: { fontSize: 14, lineHeight: 19 },
  msgMeta: { fontSize: 12 },
});
