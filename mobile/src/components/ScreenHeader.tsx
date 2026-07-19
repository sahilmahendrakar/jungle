// A simple content-screen header bar (h-14 in the web), with an optional back button and a
// right-side accessory. Sits on the light content surface (card).
import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../lib/theme-context";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top, backgroundColor: colors.card, borderBottomColor: colors.border },
      ]}
    >
      <View style={styles.row}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={10} style={styles.back}>
            <Ionicons name="chevron-back" size={26} color={colors.primary} />
          </Pressable>
        ) : null}
        <View style={styles.titles}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 8 },
  back: { padding: 4, marginRight: 2 },
  titles: { flex: 1, paddingHorizontal: 8 },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 1 },
  right: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8 },
});
