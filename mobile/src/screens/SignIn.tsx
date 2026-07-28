import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme-context";
import { radius, space } from "../theme";

// Turn a firebase auth error code into something a human can act on. Firebase collapses
// wrong-password and unknown-email into auth/invalid-credential on purpose (account enumeration),
// so those share one message.
function friendlyError(e: unknown): string {
  const code = String((e as { code?: string })?.code ?? "");
  if (/invalid-credential|wrong-password|user-not-found/.test(code)) {
    return "That email or password isn't right.";
  }
  if (code.includes("invalid-email")) return "That doesn't look like an email address.";
  if (code.includes("too-many-requests")) return "Too many attempts. Try again in a few minutes.";
  if (code.includes("network-request-failed")) return "Couldn't reach Jungle. Check your connection.";
  if (code.includes("operation-not-allowed")) return "Email sign-in isn't enabled for this project.";
  return String((e as Error)?.message ?? e);
}

// Sign-in screen. Google is the primary path; email/password is a secondary one so there's a way in
// that doesn't depend on a third-party provider. Rendered on the always-dark forest brand color.
export function SignIn() {
  const { signIn, signInEmail, signingIn } = useAuth();
  const { sidebar } = useTheme();
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submitEmail() {
    setError("");
    try {
      await signInEmail(email, password);
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !signingIn;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.container, { backgroundColor: sidebar.bg }]}>
        <View style={styles.brand}>
          <Text style={styles.logo}>🌴</Text>
          <Text style={[styles.title, { color: sidebar.fg }]}>Jungle</Text>
          <Text style={[styles.tagline, { color: sidebar.fgMuted }]}>
            Chat with agents that do real work.
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: sidebar.primary },
              pressed && styles.buttonPressed,
            ]}
            onPress={signIn}
            disabled={signingIn}
          >
            {signingIn && !showEmail ? (
              <ActivityIndicator color="#00140c" />
            ) : (
              <Text style={styles.buttonText}>Continue with Google</Text>
            )}
          </Pressable>

          {showEmail ? (
            <View style={styles.form}>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: sidebar.accent, borderColor: sidebar.border, color: sidebar.fg },
                ]}
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={sidebar.fgMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                editable={!signingIn}
              />
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: sidebar.accent, borderColor: sidebar.border, color: sidebar.fg },
                ]}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={sidebar.fgMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                textContentType="password"
                editable={!signingIn}
                onSubmitEditing={() => canSubmit && submitEmail()}
                returnKeyType="go"
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: sidebar.primary },
                  !canSubmit && styles.buttonDisabled,
                  pressed && styles.buttonPressed,
                ]}
                onPress={submitEmail}
                disabled={!canSubmit}
              >
                {signingIn ? (
                  <ActivityIndicator color="#00140c" />
                ) : (
                  <Text style={styles.buttonText}>Sign in</Text>
                )}
              </Pressable>
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              setShowEmail((v) => !v);
              setError("");
            }}
            hitSlop={8}
          >
            <Text style={[styles.toggle, { color: sidebar.fgMuted }]}>
              {showEmail ? "Back to Google sign-in" : "Sign in with email"}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
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
  actions: { alignItems: "center", gap: space(4), alignSelf: "stretch" },
  button: {
    paddingVertical: space(4),
    paddingHorizontal: space(8),
    borderRadius: radius.pill,
    minWidth: 240,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#00140c", fontSize: 16, fontWeight: "700" },
  form: { alignSelf: "stretch", gap: space(3) },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
    fontSize: 16,
  },
  error: { color: "#f14d4c", fontSize: 13, textAlign: "center" },
  toggle: { fontSize: 14, fontWeight: "600" },
});
