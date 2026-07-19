import { useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { randomFreePreset, toKebab } from "@jungle/shared";
import { createDm, createParticipant } from "../src/lib/api";
import { useChatStore } from "../src/store/chat";
import { useTheme } from "../src/lib/theme-context";
import { ScreenHeader } from "../src/components/ScreenHeader";
import { Avatar } from "../src/components/Avatar";
import { MODEL_OPTIONS } from "../src/lib/format";
import { radius } from "../src/theme";

// Create an agent (the web AddAgentDialog, mobile-shaped): playful animal identity by default
// (reroll die), Name -> Handle auto-derive until the handle is touched, optional instructions,
// model picker. Environment defaults to cloud; repos/integrations/devices are configured
// afterwards from the agent's profile or the web app.

export default function CreateAgent() {
  const router = useRouter();
  const { colors } = useTheme();
  const people = useChatStore((s) => s.people);
  const myPid = useChatStore((s) => s.myParticipantId);
  const setPeople = useChatStore((s) => s.setPeople);
  const reloadChannels = useChatStore((s) => s.reloadChannels);

  const taken = useMemo(() => new Set(people.map((p) => p.handle)), [people]);
  const [preset] = useState(() => randomFreePreset(taken));
  const [name, setName] = useState(preset.name);
  const [handle, setHandle] = useState(preset.handle);
  const [handleTouched, setHandleTouched] = useState(false);
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState<string | undefined>(undefined); // undefined = backend default
  const [busy, setBusy] = useState(false);

  const modelLabel = model ? (MODEL_OPTIONS.find((m) => m.id === model)?.label ?? model) : "Default";

  function reroll() {
    const next = randomFreePreset(taken);
    setName(next.name);
    if (!handleTouched) setHandle(next.handle);
  }

  function onName(v: string) {
    setName(v);
    if (!handleTouched) setHandle(toKebab(v));
  }

  function pickModel() {
    const options = ["Cancel", "Default", ...MODEL_OPTIONS.map((m) => m.label)];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 0 }, (i) => {
      if (i === 0) return;
      setModel(i === 1 ? undefined : MODEL_OPTIONS[i - 2].id);
    });
  }

  async function create() {
    const displayName = name.trim();
    const h = toKebab(handle);
    if (!displayName || !h) {
      Alert.alert("Name and handle are required");
      return;
    }
    if (taken.has(h)) {
      Alert.alert("Handle taken", `@${h} already exists in this workspace.`);
      return;
    }
    setBusy(true);
    try {
      const agent = await createParticipant({
        kind: "agent",
        handle: h,
        displayName,
        ...(model ? { model } : {}),
        ...(persona.trim() ? { persona: persona.trim() } : {}),
      });
      setPeople([...people, agent]);
      // Land in a DM with the new agent — the natural first step.
      if (myPid) {
        try {
          const dm = await createDm(myPid, agent.id);
          reloadChannels();
          router.replace(`/channel/${dm.id}`);
          return;
        } catch {
          /* fall through to back */
        }
      }
      router.back();
    } catch (e) {
      Alert.alert("Couldn't create the agent", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="New agent" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Identity */}
          <View style={styles.identityRow}>
            <Avatar handle={toKebab(handle) || "agent"} name={name || "Agent"} size={52} />
            <View style={styles.identityText}>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                A persistent teammate: DM it or @mention it and it does real work while you watch.
              </Text>
            </View>
            <Pressable onPress={reroll} hitSlop={8} style={[styles.dice, { borderColor: colors.border }]}>
              <Ionicons name="dice-outline" size={20} color={colors.primary} />
            </Pressable>
          </View>

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={onName}
            autoCorrect={false}
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Handle</Text>
          <View style={[styles.input, styles.handleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.at, { color: colors.mutedForeground }]}>@</Text>
            <TextInput
              value={handle}
              onChangeText={(v) => {
                setHandle(v);
                setHandleTouched(true);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.handleInput, { color: colors.foreground }]}
            />
          </View>

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Instructions (optional)</Text>
          <TextInput
            value={persona}
            onChangeText={setPersona}
            multiline
            placeholder="What should this agent focus on? Tone, duties, boundaries…"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.input,
              styles.personaInput,
              { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
            ]}
          />

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Model</Text>
          <Pressable
            onPress={pickModel}
            style={[styles.input, styles.modelRow, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.modelText, { color: colors.foreground }]}>{modelLabel}</Text>
            <Ionicons name="chevron-expand-outline" size={16} color={colors.mutedForeground} />
          </Pressable>

          <Pressable
            disabled={busy}
            onPress={() => void create()}
            style={[styles.createBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
          >
            <Ionicons name="sparkles" size={16} color={colors.primaryForeground} />
            <Text style={[styles.createText, { color: colors.primaryForeground }]}>
              {busy ? "Creating…" : "Create agent"}
            </Text>
          </Pressable>
          <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
            Repos, integrations, and devices can be added later from the agent's profile.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  body: { padding: 16, paddingBottom: 40, gap: 8 },
  identityRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  identityText: { flex: 1 },
  hint: { fontSize: 12, lineHeight: 17 },
  dice: { borderWidth: 1, borderRadius: radius.md, padding: 8 },
  label: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
  },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  handleRow: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 0 },
  at: { fontSize: 15 },
  handleInput: { flex: 1, fontSize: 15, paddingVertical: 10 },
  personaInput: { minHeight: 90, textAlignVertical: "top", fontSize: 14, lineHeight: 19 },
  modelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modelText: { fontSize: 15 },
  createBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: radius.md,
    paddingVertical: 13,
    marginTop: 18,
  },
  createText: { fontSize: 15, fontWeight: "700" },
  footnote: { fontSize: 12, textAlign: "center", marginTop: 8, lineHeight: 17 },
});
