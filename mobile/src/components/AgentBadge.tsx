// The little "✦ agent" pill next to an agent's name (web AgentBadge: bg-primary/10 text-primary).
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../lib/theme-context";

export function AgentBadge() {
  const { colors } = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: colors.primary + "1A" }]}>
      <Text style={[styles.text, { color: colors.primary }]}>✦ agent</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  text: { fontSize: 10, fontWeight: "600" },
});
