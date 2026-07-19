import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme-context";
import { radius, space } from "../theme";

// Sign-in screen: the whole app is gated behind Google sign-in (Firebase). Shown by the root
// gate whenever there's no authenticated user. Rendered on the always-dark forest brand color.
export function SignIn() {
  const { signIn, signingIn } = useAuth();
  const { sidebar } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: sidebar.bg }]}>
      <View style={styles.brand}>
        <Text style={styles.logo}>🌴</Text>
        <Text style={[styles.title, { color: sidebar.fg }]}>Jungle</Text>
        <Text style={[styles.tagline, { color: sidebar.fgMuted }]}>
          Chat with agents that do real work.
        </Text>
      </View>
      <Pressable
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: sidebar.primary },
          pressed && styles.buttonPressed,
        ]}
        onPress={signIn}
        disabled={signingIn}
      >
        {signingIn ? (
          <ActivityIndicator color="#00140c" />
        ) : (
          <Text style={styles.buttonText}>Continue with Google</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space(8),
    gap: space(12),
  },
  brand: { alignItems: "center", gap: space(2) },
  logo: { fontSize: 56 },
  title: { fontSize: 34, fontWeight: "800" },
  tagline: { fontSize: 15, textAlign: "center" },
  button: {
    paddingVertical: space(4),
    paddingHorizontal: space(8),
    borderRadius: radius.pill,
    minWidth: 240,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: "#00140c", fontSize: 16, fontWeight: "700" },
});
