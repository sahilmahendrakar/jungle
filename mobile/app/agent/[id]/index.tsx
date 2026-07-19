import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActionSheetIOS,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useChatStore } from "../../../src/store/chat";
import { useTheme } from "../../../src/lib/theme-context";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { Avatar } from "../../../src/components/Avatar";
import { AgentBadge } from "../../../src/components/AgentBadge";
import { StatusDot } from "../../../src/components/StatusDot";
import {
  STATUS_LABEL,
  MODEL_OPTIONS,
  SDK_MODE_OPTIONS,
  EFFORT_OPTIONS,
  fmtTokens,
} from "../../../src/lib/format";
import { createDm, updateAgent, getAgentMemory, interruptAgent } from "../../../src/lib/api";
import { radius } from "../../../src/theme";

type Opt = { id: string; label: string; hint?: string };

function PickerRow({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: Opt[];
  onPick: (id: string) => void;
}) {
  const { colors } = useTheme();
  const current = options.find((o) => o.id === value);
  const open = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", ...options.map((o) => o.label)], cancelButtonIndex: 0 },
      (i) => {
        if (i > 0) onPick(options[i - 1].id);
      },
    );
  };
  return (
    <Pressable style={[styles.row, { borderColor: colors.border }]} onPress={open}>
      <Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={[styles.rowValue, { color: colors.foreground }]}>{current?.label ?? value}</Text>
        <Ionicons name="chevron-down" size={15} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

export default function AgentProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const agentId = String(id);
  const person = useChatStore((s) => s.people.find((p) => p.id === agentId));
  const myPid = useChatStore((s) => s.myParticipantId);
  const reloadChannels = useChatStore((s) => s.reloadChannels);

  const [displayName, setDisplayName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("default");
  const [effort, setEffort] = useState("medium");
  const [saving, setSaving] = useState(false);
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    if (!person) return;
    setDisplayName(person.display_name);
    setPersona(person.persona ?? "");
    setModel(person.model ?? MODEL_OPTIONS[0]?.id ?? "");
    setMode(person.mode || "default");
    setEffort(person.effort || "medium");
  }, [person?.id]);

  const isAgent = person?.kind === "agent";
  const dirty =
    !!person &&
    (displayName !== person.display_name ||
      persona !== (person.persona ?? "") ||
      model !== (person.model ?? MODEL_OPTIONS[0]?.id ?? "") ||
      mode !== (person.mode || "default") ||
      effort !== (person.effort || "medium"));

  const save = async () => {
    if (!person) return;
    setSaving(true);
    try {
      await updateAgent(person.id, { displayName, persona, model, mode, effort });
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const loadMemory = async () => {
    if (!memoryOpen && memory === null && person) {
      const r = await getAgentMemory(person.id).catch(() => null);
      setMemory(r?.memory ?? "");
    }
    setMemoryOpen((v) => !v);
  };

  const message = async () => {
    if (!myPid || !person) return;
    const dm = await createDm(myPid, person.id).catch(() => null);
    if (dm) {
      reloadChannels();
      router.replace(`/channel/${dm.id}`);
    }
  };

  if (!person) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Profile" onBack={() => router.back()} />
        <View style={styles.content}>
          <Text style={{ color: colors.mutedForeground }}>Participant not found.</Text>
        </View>
      </View>
    );
  }

  const ctxPct =
    person.context_tokens != null && person.context_max_tokens
      ? Math.min(1, person.context_tokens / person.context_max_tokens)
      : null;
  const ctxColor = ctxPct == null ? colors.muted : ctxPct >= 0.9 ? "#ef4444" : ctxPct >= 0.7 ? "#f59e0b" : "#10b981";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Profile"
        onBack={() => router.back()}
        right={
          dirty && isAgent ? (
            <Pressable onPress={save} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={[styles.save, { color: colors.primary }]}>Save</Text>
              )}
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <Avatar handle={person.handle} name={person.display_name} url={person.avatar_url} size={64} />
          <View style={styles.idText}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, { color: colors.foreground }]}>{person.display_name}</Text>
              {isAgent ? <AgentBadge /> : null}
            </View>
            <Text style={[styles.handle, { color: colors.mutedForeground }]}>@{person.handle}</Text>
            {isAgent ? (
              <View style={styles.statusRow}>
                <StatusDot status={person.status} />
                <Text style={[styles.handle, { color: colors.mutedForeground }]}>
                  {person.status ? STATUS_LABEL[person.status] : "—"}
                </Text>
              </View>
            ) : person.email ? (
              <Text style={[styles.handle, { color: colors.mutedForeground }]}>{person.email}</Text>
            ) : null}
          </View>
        </View>

        {isAgent ? (
          <>
            {person.status === "working" ? (
              <Pressable
                style={[styles.stop, { borderColor: colors.border }]}
                onPress={() => interruptAgent(person.id).catch(() => {})}
              >
                <Ionicons name="stop-circle-outline" size={18} color={colors.destructive} />
                <Text style={[styles.stopText, { color: colors.destructive }]}>Stop current turn</Text>
              </Pressable>
            ) : null}

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DISPLAY NAME</Text>
            <TextInput
              style={[styles.input, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border }]}
              value={displayName}
              onChangeText={setDisplayName}
            />

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>PERSONA</Text>
            <TextInput
              style={[
                styles.input,
                styles.textarea,
                { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border },
              ]}
              value={persona}
              onChangeText={setPersona}
              placeholder="Role / personality injected into the agent's system prompt"
              placeholderTextColor={colors.mutedForeground}
              multiline
            />

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SETTINGS</Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <PickerRow label="Model" value={model} options={MODEL_OPTIONS} onPick={setModel} />
              <PickerRow label="Permissions" value={mode} options={SDK_MODE_OPTIONS} onPick={setMode} />
              <PickerRow label="Reasoning" value={effort} options={EFFORT_OPTIONS} onPick={setEffort} />
            </View>

            {ctxPct != null ? (
              <>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>CONTEXT</Text>
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, padding: 12 }]}>
                  <View style={styles.ctxTop}>
                    <Text style={[styles.ctxText, { color: colors.mutedForeground }]}>
                      {fmtTokens(person.context_tokens!)} / {fmtTokens(person.context_max_tokens!)} tokens
                    </Text>
                    <Text style={[styles.ctxText, { color: colors.mutedForeground }]}>
                      {Math.round(ctxPct * 100)}%
                    </Text>
                  </View>
                  <View style={[styles.ctxTrack, { backgroundColor: colors.muted }]}>
                    <View style={[styles.ctxFill, { width: `${ctxPct * 100}%`, backgroundColor: ctxColor }]} />
                  </View>
                </View>
              </>
            ) : null}

            <Pressable style={[styles.memHead, { borderColor: colors.border }]} onPress={loadMemory}>
              <Text style={[styles.memLabel, { color: colors.foreground }]}>Memory</Text>
              <Ionicons name={memoryOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
            </Pressable>
            {memoryOpen ? (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, padding: 12 }]}>
                <Text style={[styles.memText, { color: colors.foreground }]}>
                  {memory ? memory : "No memory yet."}
                </Text>
              </View>
            ) : null}

            <Pressable
              style={[styles.actionBtn, { borderColor: colors.border }]}
              onPress={() => router.push(`/agent/${person.id}/activity`)}
            >
              <Ionicons name="pulse-outline" size={18} color={colors.foreground} />
              <Text style={[styles.actionText, { color: colors.foreground }]}>View activity</Text>
            </Pressable>
          </>
        ) : person.persona ? (
          <Text style={[styles.persona, { color: colors.foreground }]}>{person.persona}</Text>
        ) : null}

        <Pressable style={[styles.msgBtn, { backgroundColor: colors.primary }]} onPress={message}>
          <Text style={[styles.msgText, { color: colors.primaryForeground }]}>Message</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  save: { fontSize: 16, fontWeight: "700" },
  identity: { flexDirection: "row", alignItems: "center", gap: 14 },
  idText: { flex: 1, gap: 3 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { fontSize: 20, fontWeight: "700" },
  handle: { fontSize: 13 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  persona: { fontSize: 14, lineHeight: 20 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  textarea: { minHeight: 88, textAlignVertical: "top" },
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 14 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 14, fontWeight: "500" },
  ctxTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  ctxText: { fontSize: 12 },
  ctxTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  ctxFill: { height: 6, borderRadius: 3 },
  memHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 6,
  },
  memLabel: { fontSize: 15, fontWeight: "600" },
  memText: { fontFamily: "Menlo", fontSize: 12, lineHeight: 18 },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 11,
  },
  stopText: { fontSize: 14, fontWeight: "600" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 12,
    marginTop: 6,
  },
  actionText: { fontSize: 15, fontWeight: "600" },
  msgBtn: { borderRadius: radius.md, paddingVertical: 13, alignItems: "center", marginTop: 6 },
  msgText: { fontSize: 15, fontWeight: "600" },
});
