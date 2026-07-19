// An uppercase section label with an optional trailing action (web SectionHeader). Color is
// passed in so it works on both the dark sidebar (Home) and the light content surfaces.
import { Pressable, StyleSheet, Text, View } from "react-native";

export function SectionHeader({
  label,
  color,
  actionGlyph,
  onAction,
}: {
  label: string;
  color: string;
  actionGlyph?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color }]}>{label}</Text>
      {actionGlyph && onAction ? (
        <Pressable onPress={onAction} hitSlop={10}>
          <Text style={[styles.action, { color }]}>{actionGlyph}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  action: { fontSize: 17, fontWeight: "500" },
});
