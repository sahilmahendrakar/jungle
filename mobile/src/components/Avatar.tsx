// A rounded-square avatar (matching the web's PersonAvatar — NOT a circle). Shows the person's
// image when present, otherwise deterministic hash-colored initials.
import { Image, StyleSheet, Text, View } from "react-native";
import { avatarColor, initials } from "../lib/people";
import { radius } from "../theme";

export function Avatar({
  handle,
  name,
  url,
  size = 32,
}: {
  handle: string;
  name?: string | null;
  url?: string | null;
  size?: number;
}) {
  const br = size <= 22 ? 4 : radius.sm;
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: br, backgroundColor: "#0002" }}
      />
    );
  }
  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: br, backgroundColor: avatarColor(handle) },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size <= 22 ? 9 : size <= 32 ? 12 : size * 0.38 }]}>
        {initials(name || handle)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: "center", justifyContent: "center" },
  initials: { color: "#fff", fontWeight: "700" },
});
