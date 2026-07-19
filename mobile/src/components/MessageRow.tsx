// A sender-grouped message group (web MessageList row): the lead message shows avatar + name +
// agent badge + time + body; consecutive follow-ups from the same sender render body-only,
// indented under the avatar column. Body = markdown + attachments + a footer row (thread chip,
// and — wired in Phase 5 — live turn chips). Long-press opens a small action sheet.
import { memo } from "react";
import { ActionSheetIOS, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Message, Participant } from "../lib/api";
import { fmtTime } from "../lib/format";
import { useTheme } from "../lib/theme-context";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { Markdown } from "./Markdown";
import { AttachmentList } from "./AttachmentList";
import { ThreadFooterChip } from "./ThreadFooterChip";

export interface MessageGroup {
  lead: Message;
  rest: Message[];
}

export interface MessageRowProps {
  group: MessageGroup;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
  replyCounts: Map<string, number>;
  unreadByRoot: Map<string, number>;
  onOpenThread: (rootId: string) => void;
  // Slot for the Phase-5 turn chips, keyed by triggering message id.
  renderChips?: (messageId: string) => React.ReactNode;
}

function MessageBody({
  m,
  personByHandle,
  onOpenProfile,
  replyCounts,
  unreadByRoot,
  onOpenThread,
  renderChips,
  lead,
}: {
  m: Message;
  lead: boolean;
} & Omit<MessageRowProps, "group">) {
  const isRoot = !m.thread_root_id;
  const hasReplies = isRoot && (replyCounts.get(m.id) ?? 0) > 0;
  const chips = renderChips?.(m.id);
  const showFooter = !isRoot || hasReplies || !!chips;

  const onLongPress = () => {
    if (Platform.OS !== "ios") return;
    const options = ["Cancel"];
    const actions: (() => void)[] = [() => {}];
    if (isRoot) {
      options.push("Reply in thread");
      actions.push(() => onOpenThread(m.id));
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: 0 },
      (i) => actions[i]?.(),
    );
  };

  return (
    <Pressable onLongPress={onLongPress} delayLongPress={300} style={!lead && styles.followBody}>
      {m.body ? (
        <Markdown personByHandle={personByHandle} onOpenProfile={onOpenProfile}>
          {m.body}
        </Markdown>
      ) : null}
      {(m.attachments?.length ?? 0) > 0 ? <AttachmentList attachments={m.attachments!} /> : null}
      {showFooter ? (
        <View style={styles.footer}>
          <ThreadFooterChip
            m={m}
            replyCounts={replyCounts}
            unreadByRoot={unreadByRoot}
            onOpenThread={onOpenThread}
          />
          {chips}
        </View>
      ) : null}
    </Pressable>
  );
}

function MessageRowInner(props: MessageRowProps) {
  const { group, personByHandle, onOpenProfile } = props;
  const { colors } = useTheme();
  const { lead, rest } = group;
  const sender = personByHandle(lead.sender_handle);
  const isAgent = sender?.kind === "agent";

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => sender && onOpenProfile(sender.id)}
        disabled={!sender}
        style={styles.avatarCol}
      >
        <Avatar
          handle={lead.sender_handle}
          name={sender?.display_name ?? lead.sender_handle}
          url={sender?.avatar_url}
          size={36}
        />
      </Pressable>
      <View style={styles.content}>
        <View style={styles.nameRow}>
          <Pressable onPress={() => sender && onOpenProfile(sender.id)} disabled={!sender}>
            <Text style={[styles.name, { color: colors.foreground }]}>
              {sender?.display_name ?? lead.sender_handle}
            </Text>
          </Pressable>
          {isAgent ? <AgentBadge /> : null}
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {fmtTime(lead.created_at)}
          </Text>
        </View>
        <MessageBody m={lead} lead {...props} />
        {rest.map((m) => (
          <MessageBody key={m.id} m={m} lead={false} {...props} />
        ))}
      </View>
    </View>
  );
}

export const MessageRow = memo(MessageRowInner);

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  avatarCol: { paddingTop: 2 },
  content: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 1 },
  name: { fontSize: 15, fontWeight: "700" },
  time: { fontSize: 11 },
  followBody: { marginTop: 2 },
  footer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 3 },
});
