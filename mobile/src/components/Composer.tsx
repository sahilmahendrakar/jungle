// The channel/thread composer: @-mention autocomplete, upload-first attachments (photo library /
// camera / files), and an auto-growing input. Owns its own draft / pending / mention state; the
// parent supplies mention data + an onSend(body, attachmentIds) that performs the WS post and
// returns whether it was accepted (so the composer clears only on success). Port of web Composer.
import { useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { uploadAttachment, type LocalFile, type Participant } from "../lib/api";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  detectMention,
  newId,
  type PendingAttachment,
} from "../lib/format";
import { useTheme } from "../lib/theme-context";
import { radius } from "../theme";
import { Avatar } from "./Avatar";

interface StagedFile extends LocalFile {
  size: number;
  previewUri?: string;
}

export function Composer({
  placeholder,
  people,
  members,
  participantId,
  compact,
  onSend,
  onNotice,
  accessory,
}: {
  placeholder: string;
  people: Participant[];
  members: Participant[];
  participantId: string | null;
  compact?: boolean;
  onSend: (body: string, attachmentIds: string[]) => boolean;
  onNotice: (msg: string) => void;
  // Extra row rendered above the input (e.g. the thread "Also send to channel" checkbox).
  accessory?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | undefined>(undefined);
  const caretRef = useRef(0);

  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const memberIds = new Set(members.map((m) => m.id));
    return people
      .filter((p) => p.id !== participantId)
      .filter(
        (p) =>
          !q || p.handle.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const am = memberIds.has(a.id) ? 0 : 1;
        const bm = memberIds.has(b.id) ? 0 : 1;
        if (am !== bm) return am - bm;
        const asw = a.handle.toLowerCase().startsWith(q) ? 0 : 1;
        const bsw = b.handle.toLowerCase().startsWith(q) ? 0 : 1;
        if (asw !== bsw) return asw - bsw;
        return a.display_name.localeCompare(b.display_name);
      })
      .slice(0, 8);
  }, [mention, people, members, participantId]);

  const onChange = (value: string) => {
    setDraft(value);
    setSel(undefined); // release any forced caret from a mention accept
    setMention(detectMention(value, caretRef.current));
  };

  const onSelectionChange = (e: { nativeEvent: { selection: { start: number; end: number } } }) => {
    caretRef.current = e.nativeEvent.selection.start;
    setMention((m) => (m ? detectMention(draft, e.nativeEvent.selection.start) : m));
  };

  const acceptMention = (p: Participant) => {
    if (!mention) return;
    const caret = caretRef.current;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const insert = `@${p.handle} `;
    const next = before + insert + after;
    const pos = (before + insert).length;
    setDraft(next);
    setMention(null);
    setSel({ start: pos, end: pos }); // force caret once; released on next keystroke
    caretRef.current = pos;
  };

  const stageFiles = (files: StagedFile[]) => {
    let slots = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
    const chips: PendingAttachment[] = [];
    for (const f of files) {
      if (slots <= 0) {
        onNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
        break;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        onNotice(`"${f.name}" is too large (max 25MB per file).`);
        continue;
      }
      slots--;
      const key = newId();
      chips.push({
        key,
        name: f.name,
        size: f.size,
        mime: f.mime || "application/octet-stream",
        status: "uploading",
        localUri: f.previewUri,
      });
      uploadAttachment({ uri: f.uri, name: f.name, mime: f.mime })
        .then((att) =>
          setPending((ps) => ps.map((p) => (p.key === key ? { ...p, status: "ready", att } : p))),
        )
        .catch((e) =>
          setPending((ps) =>
            ps.map((p) =>
              p.key === key ? { ...p, status: "error", error: String((e as Error).message ?? e) } : p,
            ),
          ),
        );
    }
    if (chips.length) setPending((ps) => [...ps, ...chips]);
  };

  const pickImages = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return onNotice("Photo access is off — enable it in Settings.");
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      quality: 0.9,
    });
    if (res.canceled) return;
    stageFiles(
      res.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName || `image-${newId()}.jpg`,
        mime: a.mimeType || "image/jpeg",
        size: a.fileSize ?? 0,
        previewUri: a.uri,
      })),
    );
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return onNotice("Camera access is off — enable it in Settings.");
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (res.canceled) return;
    stageFiles(
      res.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName || `photo-${newId()}.jpg`,
        mime: a.mimeType || "image/jpeg",
        size: a.fileSize ?? 0,
        previewUri: a.uri,
      })),
    );
  };

  const pickDocuments = async () => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    stageFiles(
      res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mime: a.mimeType || "application/octet-stream",
        size: a.size ?? 0,
        previewUri: (a.mimeType || "").startsWith("image/") ? a.uri : undefined,
      })),
    );
  };

  const openAttach = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Photo Library", "Take Photo", "Files"], cancelButtonIndex: 0 },
      (i) => {
        if (i === 1) pickImages();
        else if (i === 2) takePhoto();
        else if (i === 3) pickDocuments();
      },
    );
  };

  const removePending = (key: string) => setPending((ps) => ps.filter((p) => p.key !== key));

  const canSend = draft.trim().length > 0 || pending.some((p) => p.status === "ready" && p.att);

  const send = () => {
    const body = draft.trim();
    const readyIds = pending.filter((p) => p.status === "ready" && p.att).map((p) => p.att!.id);
    if (!body && readyIds.length === 0) return;
    if (pending.some((p) => p.status === "uploading")) return onNotice("Wait for uploads to finish.");
    if (!onSend(body, readyIds)) return;
    setDraft("");
    setPending([]);
    setMention(null);
  };

  return (
    <View style={styles.wrap}>
      {/* @-mention popup, above the composer */}
      {mention && mentionCandidates.length > 0 ? (
        <View
          style={[styles.popup, { backgroundColor: colors.popover, borderColor: colors.border }]}
        >
          {mentionCandidates.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => acceptMention(p)}
              style={({ pressed }) => [styles.candidate, pressed && { backgroundColor: colors.accent }]}
            >
              <Avatar handle={p.handle} name={p.display_name} url={p.avatar_url} size={22} />
              <Text style={[styles.candName, { color: colors.foreground }]} numberOfLines={1}>
                {p.display_name}
              </Text>
              <Text style={[styles.candHandle, { color: colors.mutedForeground }]} numberOfLines={1}>
                @{p.handle}
              </Text>
              {p.kind === "agent" ? (
                <Ionicons name="sparkles" size={13} color={colors.primary} />
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {accessory}

      {/* Staged attachments */}
      {pending.length > 0 ? (
        <View style={styles.chips}>
          {pending.map((p) => (
            <View
              key={p.key}
              style={[
                styles.chip,
                {
                  backgroundColor: colors.muted,
                  borderColor: p.status === "error" ? colors.destructive : colors.border,
                },
              ]}
            >
              {p.localUri ? (
                <Image source={{ uri: p.localUri }} style={styles.thumb} />
              ) : (
                <View style={[styles.fileIcon, { backgroundColor: colors.background }]}>
                  <Ionicons name="document-text-outline" size={16} color={colors.mutedForeground} />
                </View>
              )}
              <Text style={[styles.chipName, { color: colors.foreground }]} numberOfLines={1}>
                {p.name}
              </Text>
              {p.status === "uploading" ? (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              ) : null}
              {p.status === "error" ? (
                <Text style={[styles.failed, { color: colors.destructive }]}>failed</Text>
              ) : null}
              <Pressable onPress={() => removePending(p.key)} hitSlop={8}>
                <Ionicons name="close" size={16} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={[styles.bar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Pressable onPress={openAttach} hitSlop={6} style={styles.attach}>
          <Ionicons name="add-circle-outline" size={24} color={colors.mutedForeground} />
        </Pressable>
        <TextInput
          style={[styles.input, { color: colors.foreground }]}
          value={draft}
          onChangeText={onChange}
          onSelectionChange={onSelectionChange}
          selection={sel}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
        />
        <Pressable
          style={[styles.send, { backgroundColor: canSend ? colors.primary : colors.muted }]}
          onPress={send}
          disabled={!canSend}
        >
          <Ionicons
            name="arrow-up"
            size={20}
            color={canSend ? colors.primaryForeground : colors.mutedForeground}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative" },
  popup: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 4,
    maxHeight: 260,
    zIndex: 20,
  },
  candidate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  candName: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  candHandle: { fontSize: 13, flexShrink: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, paddingHorizontal: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 4,
    paddingLeft: 4,
    paddingRight: 8,
    maxWidth: 220,
  },
  thumb: { width: 34, height: 34, borderRadius: 6 },
  fileIcon: { width: 34, height: 34, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  chipName: { fontSize: 13, flexShrink: 1 },
  failed: { fontSize: 12 },
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.xxl,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 6,
  },
  attach: { paddingBottom: 5 },
  input: { flex: 1, fontSize: 15, maxHeight: 140, paddingVertical: 6, paddingHorizontal: 2 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});
