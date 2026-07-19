import { useCallback, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  listWorkflows,
  listWorkflowTemplates,
  openWorkflowBuilder,
  runWorkflow,
  stopWorkflowRun,
  type Workflow,
  type WorkflowTemplate,
} from "../../src/lib/api";
import { useChatStore } from "../../src/store/chat";
import { useTheme } from "../../src/lib/theme-context";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { StatusPill } from "../../src/components/WorkflowBits";
import { liveRunOf, triggerLabel, workflowStatusMeta } from "../../src/lib/workflowMeta";
import { fmtRelative } from "../../src/lib/format";
import { radius } from "../../src/theme";

// The Workflows tab: your workflows, the template gallery, and a row into Scheduled tasks
// (mirroring the web page, which absorbed /scheduled). Creating — blank or from a template —
// goes through the conversational Architect builder: the backend opens a DM where the
// Architect shapes the draft, which is the right "builder UI" for a phone.

type Row =
  | { kind: "workflow"; w: Workflow }
  | { kind: "template"; t: WorkflowTemplate }
  | { kind: "scheduled-link" }
  | { kind: "empty" };

export default function Workflows() {
  const router = useRouter();
  const { colors } = useTheme();
  const workflowsStale = useChatStore((s) => s.workflowsStale);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // workflow id, template id, or "blank"

  const load = useCallback(() => {
    return Promise.allSettled([listWorkflows(), listWorkflowTemplates()]).then(([w, t]) => {
      if (w.status === "fulfilled") setWorkflows(w.value);
      if (t.status === "fulfilled") setTemplates(t.value);
      setLoaded(true);
    });
  }, []);

  // Refetch on focus and whenever a workflow_changed / workflow_run_changed event lands.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, workflowsStale]),
  );

  // Create a draft (blank or from a template) and jump into the Architect DM.
  async function newDraft(templateId?: string) {
    setBusyId(templateId ?? "blank");
    try {
      const { dmChannelId } = await openWorkflowBuilder(templateId);
      router.push(`/channel/${dmChannelId}`);
    } catch (e) {
      Alert.alert("Couldn't start the builder", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(w: Workflow) {
    setBusyId(w.id);
    try {
      await runWorkflow(w.id);
      await load();
    } catch (e) {
      Alert.alert("Couldn't start the run", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function stopRun(w: Workflow) {
    const live = liveRunOf(w);
    if (!live) return;
    setBusyId(w.id);
    try {
      await stopWorkflowRun(w.id, live.id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const sections: { title: string | null; data: Row[] }[] = [
    {
      title: "Your workflows",
      data: workflows.length
        ? workflows.map((w): Row => ({ kind: "workflow", w }))
        : loaded
          ? [{ kind: "empty" }]
          : [],
    },
    { title: "Start from a template", data: templates.map((t): Row => ({ kind: "template", t })) },
    { title: null, data: [{ kind: "scheduled-link" }] },
  ];

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === "empty") {
      return (
        <View style={[styles.emptyCard, { borderColor: colors.border }]}>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            A workflow is a small team of agents with a trigger and a playbook. Start from a
            template below, or build one with the Architect.
          </Text>
        </View>
      );
    }
    if (item.kind === "scheduled-link") {
      return (
        <Pressable
          onPress={() => router.push("/scheduled")}
          style={({ pressed }) => [
            styles.schedRow,
            { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Ionicons name="calendar-outline" size={18} color={colors.mutedForeground} />
          <Text style={[styles.schedText, { color: colors.foreground }]}>Scheduled tasks</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
        </Pressable>
      );
    }
    if (item.kind === "template") {
      const t = item.t;
      const busy = busyId === t.id;
      return (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardTop}>
            <Text style={styles.emoji}>{t.emoji}</Text>
            <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
              {t.name}
            </Text>
          </View>
          <Text style={[styles.desc, { color: colors.mutedForeground }]}>{t.description}</Text>
          <View style={styles.cardBottom}>
            <View style={styles.metaItem}>
              <Ionicons name="people-outline" size={13} color={colors.mutedForeground} />
              <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                {t.roster.length} agent{t.roster.length === 1 ? "" : "s"}
              </Text>
            </View>
            <Pressable
              disabled={busy}
              onPress={() => newDraft(t.id)}
              style={[styles.btn, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
            >
              <Ionicons name="play-outline" size={14} color={colors.foreground} />
              <Text style={[styles.btnText, { color: colors.foreground }]}>
                {busy ? "Starting…" : "Use template"}
              </Text>
            </Pressable>
          </View>
        </View>
      );
    }
    const w = item.w;
    const status = workflowStatusMeta(w);
    const trig = triggerLabel(w);
    const live = liveRunOf(w);
    const busy = busyId === w.id;
    return (
      <Pressable
        onPress={() => router.push(`/workflow/${w.id}`)}
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View style={styles.cardTop}>
          {w.emoji ? <Text style={styles.emoji}>{w.emoji}</Text> : null}
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {w.name}
          </Text>
          <StatusPill label={status.label} tone={status.tone} />
        </View>
        {w.description ? (
          <Text style={[styles.desc, { color: colors.mutedForeground }]} numberOfLines={2}>
            {w.description}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="people-outline" size={13} color={colors.mutedForeground} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              {w.roster.length} agent{w.roster.length === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name={trig.icon} size={13} color={colors.mutedForeground} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              {w.trigger.type === "schedule" && w.next_run_at
                ? `Next run ${fmtRelative(w.next_run_at)}`
                : trig.text}
            </Text>
          </View>
          {w.home_channel_name ? (
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>#{w.home_channel_name}</Text>
          ) : null}
        </View>
        <View style={styles.cardBottom}>
          {w.status === "draft" ? (
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              Draft — tap to finish setting it up
            </Text>
          ) : live ? (
            <Pressable
              disabled={busy}
              onPress={() => stopRun(w)}
              style={[styles.btn, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
            >
              <Ionicons name="stop" size={13} color={colors.foreground} />
              <Text style={[styles.btnText, { color: colors.foreground }]}>Stop run</Text>
            </Pressable>
          ) : (
            <Pressable
              disabled={busy || w.status === "paused"}
              onPress={() => runNow(w)}
              style={[
                styles.btn,
                styles.btnPrimary,
                { backgroundColor: colors.primary, opacity: busy || w.status === "paused" ? 0.5 : 1 },
              ]}
            >
              <Ionicons name="flash" size={13} color={colors.primaryForeground} />
              <Text style={[styles.btnText, { color: colors.primaryForeground }]}>
                {busy ? "Starting…" : "Run now"}
              </Text>
            </Pressable>
          )}
          {w.last_run && !live ? (
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              Last run {fmtRelative(w.last_run.started_at)}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Workflows"
        right={
          <Pressable
            disabled={busyId === "blank"}
            onPress={() =>
              ActionSheetIOS.showActionSheetWithOptions(
                {
                  title: "New workflow",
                  message: "The Architect will shape it with you in a DM.",
                  options: ["Cancel", "Start from scratch"],
                  cancelButtonIndex: 0,
                },
                (i) => {
                  if (i === 1) void newDraft();
                },
              )
            }
            hitSlop={8}
          >
            <Ionicons name="add-circle-outline" size={26} color={colors.primary} />
          </Pressable>
        }
      />
      <SectionList
        sections={sections}
        keyExtractor={(item, i) =>
          item.kind === "workflow" ? item.w.id : item.kind === "template" ? item.t.id : `${item.kind}-${i}`
        }
        renderItem={renderRow}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{section.title}</Text>
          ) : null
        }
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            tintColor={colors.mutedForeground}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 12, paddingBottom: 24, gap: 10 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 2,
  },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: 14, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  emoji: { fontSize: 18 },
  name: { fontSize: 15, fontWeight: "700", flex: 1 },
  desc: { fontSize: 13, lineHeight: 18 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12 },
  cardBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  btnPrimary: { borderWidth: 0 },
  btnText: { fontSize: 13, fontWeight: "600" },
  emptyCard: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: radius.lg,
    padding: 20,
  },
  emptyText: { fontSize: 13, lineHeight: 19, textAlign: "center" },
  schedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 14,
    marginTop: 8,
  },
  schedText: { fontSize: 14, fontWeight: "600", flex: 1 },
});
