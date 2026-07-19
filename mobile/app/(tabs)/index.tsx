import { useMemo, useState } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../src/store/chat";
import { channelHasRunningTurn } from "../../src/store/liveTurns";
import { createDm, type Channel, type Participant } from "../../src/lib/api";
import { useTheme } from "../../src/lib/theme-context";
import { useWorkspace } from "../../src/lib/workspace-context";
import { Avatar } from "../../src/components/Avatar";
import { StatusDot } from "../../src/components/StatusDot";
import { UnreadBadge } from "../../src/components/UnreadBadge";
import { STATUS_RANK } from "../../src/lib/format";
import type { AgentStatus } from "@jungle/shared";

// Home — the mobile analogue of the web sidebar, rendered on the always-dark forest palette.
// Sections: Unreads / Channels / Direct messages / People. Slack-style unread semantics
// (channels bold-only unless a mention; DMs always show a count).
type Row =
  | { kind: "channel"; channel: Channel }
  | { kind: "dm"; channel: Channel; person?: Participant }
  | { kind: "person"; person: Participant };

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sidebar } = useTheme();
  const { membership } = useWorkspace();
  const channels = useChatStore((s) => s.channels);
  const people = useChatStore((s) => s.people);
  const connected = useChatStore((s) => s.connected);
  const myPid = useChatStore((s) => s.myParticipantId);
  const liveVersion = useChatStore((s) => s.liveVersion);
  const reloadChannels = useChatStore((s) => s.reloadChannels);
  const [refreshing, setRefreshing] = useState(false);
  const [openingDm, setOpeningDm] = useState<string | null>(null);

  const peopleByHandle = useMemo(() => {
    const m: Record<string, Participant> = {};
    for (const p of people) if (p.handle) m[p.handle] = p;
    return m;
  }, [people]);

  const sections = useMemo(() => {
    const dmChannels = channels.filter((c) => c.kind === "dm");
    const realChannels = channels.filter((c) => c.kind !== "dm");
    const unreads = channels
      .filter((c) => (c.unread_count ?? 0) > 0)
      .sort((a, b) => Number(b.has_mention) - Number(a.has_mention));

    // People not me and without an existing open DM row (avoid listing the same person twice).
    const dmHandles = new Set(dmChannels.map((c) => c.dm_with).filter(Boolean));
    const otherPeople = people.filter(
      (p) => p.id !== myPid && !dmHandles.has(p.handle),
    );

    const out: { title: string; data: Row[] }[] = [];
    if (unreads.length)
      out.push({
        title: "Unread",
        data: unreads.map((c) =>
          c.kind === "dm"
            ? { kind: "dm", channel: c, person: c.dm_with ? peopleByHandle[c.dm_with] : undefined }
            : { kind: "channel", channel: c },
        ),
      });
    out.push({ title: "Channels", data: realChannels.map((c) => ({ kind: "channel", channel: c })) });
    if (dmChannels.length)
      out.push({
        title: "Direct messages",
        data: dmChannels.map((c) => ({
          kind: "dm",
          channel: c,
          person: c.dm_with ? peopleByHandle[c.dm_with] : undefined,
        })),
      });
    if (otherPeople.length)
      out.push({
        title: "People",
        data: otherPeople.map((p) => ({ kind: "person", person: p })),
      });
    return out;
  }, [channels, people, myPid, peopleByHandle]);

  const refresh = async () => {
    setRefreshing(true);
    reloadChannels();
    setTimeout(() => setRefreshing(false), 500);
  };

  const openDm = async (person: Participant) => {
    if (!myPid) return;
    setOpeningDm(person.id);
    try {
      const dm = await createDm(myPid, person.id);
      reloadChannels();
      router.push(`/channel/${dm.id}`);
    } catch {
      /* ignore */
    } finally {
      setOpeningDm(null);
    }
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === "person") {
      const p = item.person;
      return (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: sidebar.accent }]}
          onPress={() => openDm(p)}
        >
          <Avatar handle={p.handle} name={p.display_name} url={p.avatar_url} size={22} />
          {p.kind === "agent" ? <StatusDot status={p.status} /> : <View style={styles.dotSpacer} />}
          <Text style={[styles.rowTitle, { color: sidebar.fg }]} numberOfLines={1}>
            {p.display_name}
          </Text>
          {openingDm === p.id ? <ActivityIndicator size="small" color={sidebar.fgMuted} /> : null}
          {p.kind === "agent" ? (
            <Ionicons name="sparkles" size={12} color={sidebar.fgMuted} />
          ) : null}
        </Pressable>
      );
    }

    const c = item.channel;
    const unread = c.unread_count ?? 0;
    const badge = c.kind === "dm" ? unread : c.has_mention ? unread : 0;
    const bold = unread > 0;

    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: sidebar.accent }]}
        onPress={() => router.push(`/channel/${c.id}`)}
      >
        {item.kind === "dm" ? (
          <>
            <Avatar
              handle={item.person?.handle ?? c.dm_with ?? c.name}
              name={item.person?.display_name ?? c.dm_with ?? c.name}
              url={item.person?.avatar_url}
              size={22}
            />
            {item.person?.kind === "agent" ? (
              <StatusDot status={item.person.status} />
            ) : (
              <View style={styles.dotSpacer} />
            )}
          </>
        ) : (
          <>
            <Ionicons name="grid-outline" size={16} color={sidebar.fgMuted} style={styles.hash} />
            {channelHasRunningTurn(c.id) ? (
              <StatusDot status="working" />
            ) : (
              <View style={styles.dotSpacer} />
            )}
          </>
        )}
        <Text
          style={[
            styles.rowTitle,
            { color: bold ? sidebar.fg : sidebar.fgMuted },
            bold && styles.bold,
          ]}
          numberOfLines={1}
        >
          {item.kind === "dm" ? item.person?.display_name ?? c.dm_with ?? c.name : c.name}
        </Text>
        <UnreadBadge count={badge} />
      </Pressable>
    );
  };

  const myP = membership?.participant;

  return (
    <View style={[styles.container, { backgroundColor: sidebar.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: sidebar.border }]}>
        <Text style={[styles.workspace, { color: sidebar.fg }]} numberOfLines={1}>
          {membership?.workspace.name ?? "Jungle"}
        </Text>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.connDot,
              { backgroundColor: connected ? "#34d399" : "rgba(148,163,184,0.6)" },
            ]}
          />
          <Pressable onPress={() => router.push("/team")} hitSlop={8}>
            <Ionicons name="people-outline" size={22} color={sidebar.fg} />
          </Pressable>
          {myP ? (
            <Pressable onPress={() => router.push("/you")} hitSlop={8}>
              <Avatar handle={myP.handle} name={myP.display_name} url={myP.avatar_url} size={26} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item, i) =>
          item.kind === "person" ? `p-${item.person.id}` : `c-${item.channel.id}-${i}`
        }
        renderItem={renderRow}
        extraData={liveVersion}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionHeader, { color: sidebar.fgMuted, backgroundColor: sidebar.bg }]}>
            {section.title}
          </Text>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={sidebar.fgMuted} />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  workspace: { fontSize: 20, fontWeight: "800", flex: 1 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  listContent: { paddingBottom: 24 },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  hash: { width: 18, textAlign: "center" },
  dotSpacer: { width: 6 },
  rowTitle: { flex: 1, fontSize: 15 },
  bold: { fontWeight: "700" },
});
