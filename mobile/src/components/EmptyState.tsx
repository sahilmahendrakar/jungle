// Centered empty state: a glyph tile + title + optional hint (web EmptyState).
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../lib/theme-context";
import { radius } from "../theme";

export function EmptyState({
  glyph = "🌱",
  title,
  hint,
}: {
  glyph?: string;
  title: string;
  hint?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <View style={[styles.tile, { backgroundColor: colors.muted, borderRadius: radius.xl }]}>
        <Text style={styles.glyph}>{glyph}</Text>
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      {hint ? <Text style={[styles.hint, { color: colors.mutedForeground }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  tile: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  glyph: { fontSize: 26 },
  title: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  hint: { fontSize: 13, textAlign: "center", lineHeight: 18, maxWidth: 260 },
});
