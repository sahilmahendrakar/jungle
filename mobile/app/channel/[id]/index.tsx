import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../../src/store/chat";
import { appSocket } from "../../../src/lib/socket";
import {
  getMessages,
  getChannelTurnChips,
  listChannelMembers,
  markChannelRead,
  type Message,
  type Participant,
} from "../../../src/lib/api";
import { newId } from "../../../src/lib/format";
import { useTheme } from "../../../src/lib/theme-context";
import {
  hydrateChannel,
  turnsForMessage,
  queuedForMessage,
  type TurnChipData,
} from "../../../src/store/liveTurns";
import { MessageRow, type MessageGroup } from "../../../src/components/MessageRow";
import { MessageTurnChips } from "../../../src/components/TurnChips";
import { Composer } from "../../../src/components/Composer";
import { EmptyState } from "../../../src/components/EmptyState";

const EMPTY: Message[] = [];
const EMPTY_P: Participant[] = [];

// A channel/DM screen: the sender-grouped message timeline (inverted FlatList) + a composer that
// posts a `{type:"post"}` frame over the socket. Faithful port of the web MessageList/Composer.
export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const channelId = String(id);

  const messages = useChatStore((s) => s.messagesByChannel[channelId]) ?? EMPTY;
  const channel = useChatStore((s) => s.channels.find((c) => c.id === channelId));
  const people = useChatStore((s) => s.people);
  const members = useChatStore((s) => s.membersByChannel[channelId]) ?? EMPTY_P;
  const myPid = useChatStore((s) => s.myParticipantId);
  const unreadThreads = useChatStore((s) => s.unreadThreads);
  // Subscribe to the throttled live-turn counter so anchored chips re-render as work streams.
  const liveVersion = useChatStore((s) => s.liveVersion);
  const setSelected = useChatStore((s) => s.setSelected);
  const setChannelMessages = useChatStore((s) => s.setChannelMessages);
  const setChannelMembers = useChatStore((s) => s.setChannelMembers);
  const setChannels = useChatStore((s) => s.setChannels);
  const [notice, setNotice] = useState<string | null>(null);

  const dmPerson =
    channel?.kind === "dm" ? people.find((p) => p.handle === channel.dm_with) : undefined;
  const title =
    channel?.kind === "dm"
      ? dmPerson?.display_name ?? channel.dm_with ?? channel.name
      : channel?.name ?? "Channel";

  useEffect(() => {
    setSelected(channelId);
    getMessages(channelId).then((h) => setChannelMessages(channelId, h)).catch(() => {});
    listChannelMembers(channelId).then((m) => setChannelMembers(channelId, m)).catch(() => {});
    getChannelTurnChips(channelId).then((r) => hydrateChannel(channelId, r.turns, r.queued)).catch(() => {});
    markChannelRead(channelId).catch(() => {});
    const st = useChatStore.getState();
    setChannels(
      st.channels.map((c) => (c.id === channelId ? { ...c, unread_count: 0, has_mention: false } : c)),
    );
    return () => {
      if (useChatStore.getState().selectedChannelId === channelId) setSelected(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const personByHandle = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const p of people) map.set(p.handle, p);
    return (h?: string | null) => (h ? map.get(h) : undefined);
  }, [people]);

  const personById = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const p of people) map.set(p.id, p);
    return (pid: string) => map.get(pid);
  }, [people]);

  const replyCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) if (!msg.thread_root_id && msg.reply_count > 0) m.set(msg.id, msg.reply_count);
    return m;
  }, [messages]);

  const unreadByRoot = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of unreadThreads) if (t.channel_id === channelId) m.set(t.root_id, t.unread_count);
    return m;
  }, [unreadThreads, channelId]);

  // Timeline (top-level + echoed replies), grouped by consecutive sender, reversed for `inverted`.
  const invertedGroups = useMemo(() => {
    const timeline = messages
      .filter((m) => !m.thread_root_id || m.also_to_channel)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const groups: MessageGroup[] = [];
    for (const m of timeline) {
      const last = groups[groups.length - 1];
      if (last && last.lead.sender_id === m.sender_id) last.rest.push(m);
      else groups.push({ lead: m, rest: [] });
    }
    return groups.reverse();
  }, [messages]);

  const openProfile = (pid: string) => router.push(`/agent/${pid}`);
  const openThread = (rootId: string) => router.push(`/channel/${channelId}/thread/${rootId}`);
  const openTurn = (turn: TurnChipData) =>
    router.push(`/agent/${turn.agentId}/activity?turnId=${turn.turnId}`);

  // Render the live turn chips anchored to a given message (re-runs when liveVersion ticks).
  const renderChips = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    liveVersion;
    return (messageId: string) => {
      const turns = turnsForMessage(messageId);
      const q = queuedForMessage(messageId);
      if (!turns.length && !q) return null;
      return (
        <MessageTurnChips
          turns={turns}
          queued={q ? [q] : []}
          personById={(id) => personById(id)}
          onOpenTurn={openTurn}
        />
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion, personById]);

  const handleSend = (body: string, attachmentIds: string[]) =>
    appSocket.post({
      type: "post",
      channelId,
      body,
      clientMsgId: newId(),
      attachmentIds: attachmentIds.length ? attachmentIds : undefined,
    });

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={26} color={colors.primary} />
        </Pressable>
        {channel?.kind !== "dm" ? (
          <Ionicons name="grid-outline" size={16} color={colors.mutedForeground} />
        ) : null}
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        {invertedGroups.length === 0 ? (
          <View style={styles.flex}>
            <EmptyState
              glyph="💬"
              title={`This is the start of ${title}`}
              hint="Say something — or @mention an agent to put it to work."
            />
          </View>
        ) : (
          <FlatList
            data={invertedGroups}
            keyExtractor={(g) => g.lead.id}
            inverted
            keyboardDismissMode="interactive"
            renderItem={({ item }) => (
              <MessageRow
                group={item}
                personByHandle={personByHandle}
                onOpenProfile={openProfile}
                replyCounts={replyCounts}
                unreadByRoot={unreadByRoot}
                onOpenThread={openThread}
                renderChips={renderChips}
              />
            )}
            extraData={liveVersion}
            contentContainerStyle={styles.listContent}
          />
        )}

        <View
          style={[
            styles.composerWrap,
            { paddingBottom: Math.max(insets.bottom, 8), backgroundColor: colors.background },
          ]}
        >
          {notice ? (
            <Text style={[styles.notice, { color: colors.mutedForeground }]} onPress={() => setNotice(null)}>
              {notice}
            </Text>
          ) : null}
          <Composer
            placeholder={`Message ${channel?.kind === "dm" ? title : "#" + title}`}
            people={people}
            members={members}
            participantId={myPid}
            onSend={handleSend}
            onNotice={setNotice}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
    paddingRight: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 2 },
  title: { fontSize: 17, fontWeight: "700", flex: 1 },
  listContent: { paddingVertical: 10 },
  composerWrap: { paddingHorizontal: 10, paddingTop: 6 },
  notice: { fontSize: 12, textAlign: "center", paddingBottom: 6 },
});
