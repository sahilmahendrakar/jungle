// A count badge (unread / mention / "N waiting"). Primary jade pill with tabular white count,
// "99+" cap — matching the web NavItem badge.
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../lib/theme-context";

export function UnreadBadge({ count }: { count: number }) {
  const { colors } = useTheme();
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, { backgroundColor: colors.primary }]}>
      <Text style={[styles.text, { color: colors.primaryForeground }]}>
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
