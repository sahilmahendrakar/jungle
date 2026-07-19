// Renders a message's attachments: inline images (capped ~360×320, aspect-preserving) and
// non-image file chips. Tapping opens the signed URL. Port of the web AttachmentList.
import { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { attachmentUrl, type Attachment } from "../lib/api";
import { INLINE_IMAGE_MIMES, fmtBytes } from "../lib/format";
import { useTheme } from "../lib/theme-context";
import { radius } from "../theme";

const MAX_W = 300;
const MAX_H = 320;

function ImageAttachment({ a }: { a: Attachment }) {
  const uri = attachmentUrl(a);
  // Fit within the cap while preserving aspect ratio from measured intrinsic size (fallback 4:3).
  const iw = a.width || 4;
  const ih = a.height || 3;
  const scale = Math.min(MAX_W / iw, MAX_H / ih, 1);
  const w = Math.round(iw * scale);
  const h = Math.round(ih * scale);
  const { colors } = useTheme();
  return (
    <Pressable onPress={() => Linking.openURL(uri).catch(() => {})}>
      <Image
        source={{ uri }}
        style={{
          width: w,
          height: h,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.muted,
        }}
      />
    </Pressable>
  );
}

function FileChip({ a }: { a: Attachment }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => Linking.openURL(attachmentUrl(a)).catch(() => {})}
      style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <Ionicons name="document-text-outline" size={20} color={colors.mutedForeground} />
      <View style={styles.chipText}>
        <Text style={[styles.filename, { color: colors.foreground }]} numberOfLines={1}>
          {a.filename}
        </Text>
        <Text style={[styles.size, { color: colors.mutedForeground }]}>{fmtBytes(a.size_bytes)}</Text>
      </View>
    </Pressable>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [failed, setFailed] = useState(false);
  if (!attachments.length) return null;
  return (
    <View style={styles.wrap}>
      {attachments.map((a) =>
        INLINE_IMAGE_MIMES.has(a.mime) && !failed ? (
          <ImageAttachment key={a.id} a={a} />
        ) : (
          <FileChip key={a.id} a={a} />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8, marginTop: 6 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 260,
  },
  chipText: { flexShrink: 1 },
  filename: { fontSize: 14, fontWeight: "600" },
  size: { fontSize: 12, marginTop: 1 },
});
