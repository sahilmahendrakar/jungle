import { useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../../../src/store/chat";
import { appSocket } from "../../../../src/lib/socket";
import { getThread, markThreadRead, type Message, type Participant } from "../../../../src/lib/api";
import { newId, fmtTime } from "../../../../src/lib/format";
import { useTheme } from "../../../../src/lib/theme-context";
import { Avatar } from "../../../../src/components/Avatar";
import { AgentBadge } from "../../../../src/components/AgentBadge";
import { Markdown } from "../../../../src/components/Markdown";
import { AttachmentList } from "../../../../src/components/AttachmentList";
import { Composer } from "../../../../src/components/Composer";

const EMPTY: Message[] = [];
const EMPTY_P: Participant[] = [];

// A thread: the root message + its replies (compact, non-grouped rows) with a reply composer that
// can also echo to the channel. Port of the web ThreadPanel.
export default function ThreadScreen() {
  const { id, rootId } = useLocalSearchParams<{ id: string; rootId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const channelId = String(id);
  const root = String(rootId);

  const channelMsgs = useChatStore((s) => s.messagesByChannel[channelId]) ?? EMPTY;
  const people = useChatStore((s) => s.people);
  const members = useChatStore((s) => s.membersByChannel[channelId]) ?? EMPTY_P;
  const myPid = useChatStore((s) => s.myParticipantId);
  const mergeChannelMessages = useChatStore((s) => s.mergeChannelMessages);
  const [alsoToChannel, setAlsoToChannel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const personByHandle = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const p of people) map.set(p.handle, p);
    return (h?: string | null) => (h ? map.get(h) : undefined);
  }, [people]);

  // Load the thread once; live replies for this channel land in the store and flow in below.
  useEffect(() => {
    getThread(channelId, root).then((msgs) => mergeChannelMessages(channelId, msgs)).catch(() => {});
    markThreadRead(root).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, root]);

  const thread = useMemo(
    () =>
      channelMsgs
        .filter((m) => m.id === root || m.thread_root_id === root)
        .sort((a, b) => Number(a.seq) - Number(b.seq)),
    [channelMsgs, root],
  );

  // Mark read whenever the reply set grows while we're looking at it.
  useEffect(() => {
    if (thread.length > 1) markThreadRead(root).catch(() => {});
  }, [thread.length, root]);

  const handleSend = (body: string, attachmentIds: string[]) => {
    const ok = appSocket.post({
      type: "post",
      channelId,
      body,
      clientMsgId: newId(),
      threadRootId: root,
      alsoToChannel,
      attachmentIds: attachmentIds.length ? attachmentIds : undefined,
    });
    return ok;
  };

  const renderRow = ({ item: m }: { item: Message }) => {
    const sender = personByHandle(m.sender_handle);
    return (
      <View style={styles.msg}>
        <Pressable onPress={() => sender && router.push(`/agent/${sender.id}`)}>
          <Avatar handle={m.sender_handle} name={sender?.display_name} url={sender?.avatar_url} size={26} />
        </Pressable>
        <View style={styles.msgContent}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: colors.foreground }]}>
              {sender?.display_name ?? m.sender_handle}
            </Text>
            {sender?.kind === "agent" ? <AgentBadge /> : null}
            <Text style={[styles.time, { color: colors.mutedForeground }]}>{fmtTime(m.created_at)}</Text>
          </View>
          {m.body ? (
            <Markdown personByHandle={personByHandle} onOpenProfile={(pid) => router.push(`/agent/${pid}`)}>
              {m.body}
            </Markdown>
          ) : null}
          {(m.attachments?.length ?? 0) > 0 ? <AttachmentList attachments={m.attachments!} /> : null}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={26} color={colors.primary} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Thread</Text>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        <FlatList
          data={thread}
          keyExtractor={(m) => m.id}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: colors.border }]} />}
        />
        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          {notice ? (
            <Text style={[styles.notice, { color: colors.mutedForeground }]} onPress={() => setNotice(null)}>
              {notice}
            </Text>
          ) : null}
          <Composer
            placeholder="Reply…"
            people={people}
            members={members}
            participantId={myPid}
            draftKey={rootId ? `thread:${rootId}` : undefined}
            onSend={handleSend}
            onNotice={setNotice}
            accessory={
              <Pressable style={styles.checkRow} onPress={() => setAlsoToChannel((v) => !v)}>
                <View
                  style={[
                    styles.check,
                    {
                      borderColor: colors.border,
                      backgroundColor: alsoToChannel ? colors.primary : "transparent",
                    },
                  ]}
                >
                  {alsoToChannel ? (
                    <Ionicons name="checkmark" size={13} color={colors.primaryForeground} />
                  ) : null}
                </View>
                <Text style={[styles.checkLabel, { color: colors.mutedForeground }]}>
                  Also send to channel
                </Text>
              </Pressable>
            }
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
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 2 },
  title: { fontSize: 17, fontWeight: "700" },
  list: { padding: 14, gap: 12 },
  sep: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  msg: { flexDirection: "row", gap: 9 },
  msgContent: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 1 },
  name: { fontSize: 14, fontWeight: "700" },
  time: { fontSize: 11 },
  composerWrap: { paddingHorizontal: 10, paddingTop: 6 },
  notice: { fontSize: 12, textAlign: "center", paddingBottom: 6 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 8 },
  check: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checkLabel: { fontSize: 13 },
});
