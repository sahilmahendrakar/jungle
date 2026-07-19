import { useMemo, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../src/store/chat";
import { currentTurnForAgent } from "../src/store/liveTurns";
import { buildItems, liveSummary } from "../src/lib/sdkEvents";
import { createDm, type Deliverable, type Participant } from "../src/lib/api";
import { useTheme } from "../src/lib/theme-context";
import { ScreenHeader } from "../src/components/ScreenHeader";
import { EmptyState } from "../src/components/EmptyState";
import { Avatar } from "../src/components/Avatar";
import { STATUS_LABEL, fmtRelative, fmtTokens } from "../src/lib/format";
import { radius } from "../src/theme";

// Team — mission control (the web's Team page): the whole team at a glance, humans and agents.
// Agents show live status, what they're doing right now, what's waiting on you, and the last
// thing they shipped; humans show who they are and a quick DM path. Search + kind filter on top.

type KindFilter = "all" | "human" | "agent";

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "human", label: "Humans" },
  { value: "agent", label: "Agents" },
];

const AMBER = "#d97706";
const GREEN = "#10b981";

function matchesQuery(p: Participant, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    p.display_name.toLowerCase().includes(q) ||
    p.handle.toLowerCase().includes(q) ||
    `@${p.handle}`.toLowerCase().includes(q)
  );
}

export default function Team() {
  const router = useRouter();
  const { colors } = useTheme();
  const people = useChatStore((s) => s.people);
  const confirms = useChatStore((s) => s.confirms);
  const deliverables = useChatStore((s) => s.deliverables);
  const myPid = useChatStore((s) => s.myParticipantId);
  const liveVersion = useChatStore((s) => s.liveVersion);
  const reloadChannels = useChatStore((s) => s.reloadChannels);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const confirmsByAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of confirms) if (c.agentId) m.set(c.agentId, (m.get(c.agentId) ?? 0) + 1);
    return m;
  }, [confirms]);

  const lastShippedByAgent = useMemo(() => {
    const m = new Map<string, Deliverable>();
    for (const d of deliverables) if (!m.has(d.agent_id)) m.set(d.agent_id, d); // newest-first
    return m;
  }, [deliverables]);

  const kindCounts = useMemo(() => {
    let humans = 0;
    let agents = 0;
    for (const p of people) (p.kind === "agent" ? agents++ : humans++);
    return { all: people.length, human: humans, agent: agents } as Record<KindFilter, number>;
  }, [people]);

  // Kind filter + name/handle search; working agents float to the top, then those with
  // something waiting, then the rest by name. (Same ranking as the web.)
  const visible = useMemo(() => {
    const rank = (p: Participant) =>
      p.kind === "agent" && (p.status === "working" || p.status === "waking")
        ? 0
        : (confirmsByAgent.get(p.id) ?? 0) > 0
          ? 1
          : 2;
    return people
      .filter((p) => (kindFilter === "all" ? true : p.kind === kindFilter))
      .filter((p) => matchesQuery(p, query))
      .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
  }, [people, kindFilter, query, confirmsByAgent]);

  async function openDm(p: Participant) {
    if (!myPid) return;
    try {
      const dm = await createDm(myPid, p.id);
      reloadChannels();
      router.push(`/channel/${dm.id}`);
    } catch {
      /* best effort */
    }
  }

  const renderCard = ({ item: p }: { item: Participant }) => {
    const isAgent = p.kind === "agent";
    const status = p.status ?? "idle";
    const working = isAgent && status === "working";
    const turn = isAgent ? currentTurnForAgent(p.id) : undefined;
    const now = working && turn && !turn.done ? liveSummary(buildItems(turn.events)) : null;
    const pending = confirmsByAgent.get(p.id) ?? 0;
    const shipped = isAgent ? lastShippedByAgent.get(p.id) : undefined;
    const ctxPct =
      p.context_tokens && p.context_max_tokens
        ? Math.min(100, Math.round((p.context_tokens / p.context_max_tokens) * 100))
        : null;

    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardTop}>
          <Pressable disabled={!isAgent} onPress={() => router.push(`/agent/${p.id}`)}>
            <Avatar handle={p.handle} name={p.display_name} url={p.avatar_url} size={38} />
          </Pressable>
          <View style={styles.identity}>
            <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
              {p.display_name}
            </Text>
            <Text style={[styles.handle, { color: colors.mutedForeground }]} numberOfLines={1}>
              @{p.handle}
            </Text>
          </View>
          <View style={[styles.statusPill, { borderColor: colors.border }]}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: working ? GREEN : colors.mutedForeground },
              ]}
            />
            <Text style={[styles.statusText, { color: working ? GREEN : colors.mutedForeground }]}>
              {isAgent ? STATUS_LABEL[status] : "Human"}
            </Text>
          </View>
        </View>

        {/* What it's doing / what's blocked on you / what it last shipped. */}
        <View style={styles.middle}>
          {now ? (
            <Pressable style={styles.midRow} onPress={() => router.push(`/agent/${p.id}/activity`)}>
              <Ionicons name="pulse" size={13} color={GREEN} />
              <Text style={[styles.midText, { color: colors.mutedForeground }]} numberOfLines={1}>
                {now}
              </Text>
            </Pressable>
          ) : null}
          {pending > 0 ? (
            <Pressable style={styles.midRow} onPress={() => router.push("/(tabs)/activity")}>
              <Ionicons name="shield-half-outline" size={13} color={AMBER} />
              <Text style={[styles.midText, styles.midStrong, { color: AMBER }]} numberOfLines={1}>
                {pending} approval{pending === 1 ? "" : "s"} waiting on you
              </Text>
            </Pressable>
          ) : null}
          {shipped ? (
            <Pressable style={styles.midRow} onPress={() => Linking.openURL(shipped.url).catch(() => {})}>
              <Ionicons name="open-outline" size={13} color={colors.mutedForeground} />
              <Text style={[styles.midText, { color: colors.mutedForeground }]} numberOfLines={1}>
                Shipped {shipped.title ?? shipped.url} · {fmtRelative(shipped.created_at)}
              </Text>
            </Pressable>
          ) : null}
          {!now && !pending && !shipped ? (
            <Text style={[styles.midText, { color: colors.mutedForeground }]} numberOfLines={1}>
              {!isAgent
                ? p.role === "admin"
                  ? "Admin"
                  : "Member"
                : status === "offline"
                  ? "Device offline — messages queue until it reconnects."
                  : status === "sleeping"
                    ? "Asleep — wakes on message."
                    : "Ready for work."}
            </Text>
          ) : null}
        </View>

        <View style={[styles.actions, { borderTopColor: colors.border }]}>
          <Pressable onPress={() => openDm(p)} style={[styles.btn, { borderColor: colors.border }]}>
            <Ionicons name="chatbubble-outline" size={13} color={colors.foreground} />
            <Text style={[styles.btnText, { color: colors.foreground }]}>Message</Text>
          </Pressable>
          {isAgent ? (
            <Pressable
              onPress={() => router.push(`/agent/${p.id}/activity`)}
              style={[styles.btn, { borderColor: "transparent" }]}
            >
              <Ionicons name="pulse-outline" size={13} color={colors.mutedForeground} />
              <Text style={[styles.btnText, { color: colors.mutedForeground }]}>Activity</Text>
            </Pressable>
          ) : null}
          {ctxPct != null ? (
            <Text style={[styles.ctx, { color: colors.mutedForeground }]}>
              ctx {ctxPct}% · {fmtTokens(p.context_tokens!)}
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Team" onBack={() => router.back()} />

      {/* Search + kind filter */}
      <View style={styles.filters}>
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="search" size={15} color={colors.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or handle…"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
        <View style={[styles.segment, { borderColor: colors.border }]}>
          {KIND_TABS.map((tab) => (
            <Pressable
              key={tab.value}
              onPress={() => setKindFilter(tab.value)}
              style={[styles.segItem, kindFilter === tab.value && { backgroundColor: colors.primary }]}
            >
              <Text
                style={[
                  styles.segText,
                  { color: kindFilter === tab.value ? colors.primaryForeground : colors.mutedForeground },
                ]}
              >
                {tab.label} {kindCounts[tab.value]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {visible.length === 0 ? (
        <EmptyState
          glyph="🔍"
          title={people.length === 0 ? "No one here yet" : "No one matches"}
          hint={
            people.length === 0
              ? "Agents are persistent teammates: DM one and it does real work while you watch live."
              : "Try a different name or handle, or widen the filter to everyone."
          }
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          renderItem={renderCard}
          extraData={liveVersion}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  filters: { padding: 12, gap: 8 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  segment: {
    flexDirection: "row",
    padding: 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: radius.sm },
  segText: { fontSize: 12, fontWeight: "600" },
  list: { paddingHorizontal: 12, paddingBottom: 24, gap: 10 },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: 13, gap: 10 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  identity: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: "700" },
  handle: { fontSize: 12 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: "600" },
  middle: { gap: 5, minHeight: 18 },
  midRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  midText: { fontSize: 12, flex: 1 },
  midStrong: { fontWeight: "600" },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  btnText: { fontSize: 12, fontWeight: "600" },
  ctx: { fontSize: 10, marginLeft: "auto" },
});
