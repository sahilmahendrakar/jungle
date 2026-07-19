import { useCallback, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  createDm,
  deleteWorkflow,
  finalizeWorkflow,
  getWorkflow,
  listWorkflowRuns,
  runWorkflow,
  stopWorkflowRun,
  updateWorkflow,
  type Workflow,
  type WorkflowRun,
} from "../../src/lib/api";
import { useChatStore } from "../../src/store/chat";
import { useTheme } from "../../src/lib/theme-context";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { Avatar } from "../../src/components/Avatar";
import { RunRow, StatusPill } from "../../src/components/WorkflowBits";
import { liveRunOf, triggerSentence, workflowStatusMeta } from "../../src/lib/workflowMeta";
import { fmtRelative } from "../../src/lib/format";
import { radius } from "../../src/theme";

// One workflow: status + trigger, actions, the team, its runs, and the playbook. Deliberately
// thin (matching the web detail page) — a run's timeline IS its thread in the home channel, so
// tapping a run jumps there. No canvas on mobile: the Team list carries the same information.

export default function WorkflowDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const workflowsStale = useChatStore((s) => s.workflowsStale);
  const people = useChatStore((s) => s.people);
  const myParticipantId = useChatStore((s) => s.myParticipantId);

  const [w, setW] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editingPlaybook, setEditingPlaybook] = useState(false);
  const [playbook, setPlaybook] = useState("");

  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    return Promise.allSettled([getWorkflow(id), listWorkflowRuns(id)]).then(([wf, rs]) => {
      if (wf.status === "fulfilled") {
        setW(wf.value);
        setPlaybook((p) => (p ? p : wf.value.playbook));
      }
      if (rs.status === "fulfilled") setRuns(rs.value);
    });
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, workflowsStale]),
  );

  async function act(fn: () => Promise<unknown>, errTitle: string) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      Alert.alert(errTitle, (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!w) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Workflow" onBack={() => router.back()} />
      </View>
    );
  }

  const status = workflowStatusMeta(w);
  const live = liveRunOf(w) ?? runs.find((r) => r.status === "running" || r.status === "stalled") ?? null;
  const byId = new Map(people.map((p) => [p.id, p]));
  const isDraft = w.status === "draft";

  // Drafts are shaped conversationally: jump into (or create) the DM with the Architect.
  async function openArchitect() {
    const architect = people.find((p) => p.handle === "architect");
    if (!architect || !myParticipantId) return;
    try {
      const dm = await createDm(myParticipantId, architect.id);
      router.push(`/channel/${dm.id}`);
    } catch {
      /* DM open is best-effort */
    }
  }

  function moreActions() {
    const opts = ["Cancel"];
    const handlers: (() => void)[] = [() => {}];
    if (!isDraft) {
      opts.push(w!.status === "active" ? "Pause" : "Resume");
      handlers.push(() =>
        void act(() => updateWorkflow(w!.id, { paused: w!.status === "active" }), "Couldn't update"),
      );
    }
    opts.push("Delete workflow");
    handlers.push(() =>
      Alert.alert(
        "Delete this workflow?",
        live
          ? "A run is live — deleting stops it. The team's agents and past chat stay."
          : isDraft
            ? "The draft and its unprovisioned agents will be removed."
            : "Runs and the schedule go away; the team's agents and past chat stay.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () =>
              void deleteWorkflow(w!.id)
                .then(() => router.back())
                .catch((e) => Alert.alert("Couldn't delete", (e as Error).message)),
          },
        ],
      ),
    );
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: opts,
        cancelButtonIndex: 0,
        destructiveButtonIndex: opts.length - 1,
      },
      (i) => handlers[i]?.(),
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={`${w.emoji ? w.emoji + " " : ""}${w.name}`}
        subtitle={triggerSentence(w) + (w.next_run_at ? ` · next run ${fmtRelative(w.next_run_at)}` : "")}
        onBack={() => router.back()}
        right={
          <Pressable onPress={moreActions} hitSlop={8}>
            <Ionicons name="ellipsis-horizontal-circle-outline" size={24} color={colors.primary} />
          </Pressable>
        }
      />
      <ScrollView
        contentContainerStyle={styles.body}
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
      >
        {/* Status + primary action */}
        <View style={styles.statusRow}>
          <StatusPill label={status.label} tone={status.tone} />
          <View style={styles.flexSpacer} />
          {isDraft ? null : live ? (
            <Pressable
              disabled={busy}
              onPress={() => void act(() => stopWorkflowRun(w.id, live.id), "Couldn't stop the run")}
              style={[styles.btn, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
            >
              <Ionicons name="stop" size={14} color={colors.foreground} />
              <Text style={[styles.btnText, { color: colors.foreground }]}>Stop run</Text>
            </Pressable>
          ) : (
            <Pressable
              disabled={busy || w.status !== "active"}
              onPress={() => void act(() => runWorkflow(w.id), "Couldn't start the run")}
              style={[
                styles.btn,
                styles.btnPrimary,
                { backgroundColor: colors.primary, opacity: busy || w.status !== "active" ? 0.5 : 1 },
              ]}
            >
              <Ionicons name="flash" size={14} color={colors.primaryForeground} />
              <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Run now</Text>
            </Pressable>
          )}
        </View>

        {w.description ? (
          <Text style={[styles.desc, { color: colors.mutedForeground }]}>{w.description}</Text>
        ) : null}

        {/* Draft: finish in the Architect DM, or create the team as-is. */}
        {isDraft ? (
          <View style={[styles.draftCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.draftText, { color: colors.mutedForeground }]}>
              This is a draft — the team isn't live yet. Shape it with the Architect, or create it
              as it stands.
            </Text>
            <View style={styles.draftActions}>
              <Pressable
                onPress={() => void openArchitect()}
                style={[styles.btn, { borderColor: colors.border }]}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.foreground} />
                <Text style={[styles.btnText, { color: colors.foreground }]}>DM the Architect</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => void act(() => finalizeWorkflow(w.id), "Couldn't create the team")}
                style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary, opacity: busy ? 0.5 : 1 }]}
              >
                <Ionicons name="checkmark" size={14} color={colors.primaryForeground} />
                <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Create team</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Team */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Team</Text>
        <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {w.roster.map((r, i) => {
            const p = r.participant_id ? byId.get(r.participant_id) : undefined;
            return (
              <Pressable
                key={r.participant_id ?? i}
                disabled={!p}
                onPress={() => p && router.push(`/agent/${p.id}`)}
                style={({ pressed }) => [
                  styles.teamRow,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Avatar
                  handle={p?.handle ?? r.handle_seed}
                  name={p?.display_name ?? r.name ?? r.handle_seed}
                  url={p?.avatar_url}
                  size={32}
                />
                <View style={styles.teamText}>
                  <Text style={[styles.teamName, { color: colors.foreground }]} numberOfLines={1}>
                    {p?.display_name ?? r.name ?? `@${r.handle_seed}`}
                  </Text>
                  <Text style={[styles.teamRole, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {r.role}
                  </Text>
                </View>
                {p?.status === "working" ? (
                  <View style={[styles.workingDot, { backgroundColor: colors.primary }]} />
                ) : null}
                {p ? <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} /> : null}
              </Pressable>
            );
          })}
        </View>

        {/* Runs */}
        {!isDraft ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              Runs{runs.length ? ` · ${runs.length}` : ""}
            </Text>
            {runs.length === 0 ? (
              <View style={[styles.emptyCard, { borderColor: colors.border }]}>
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No runs yet — hit Run now, or wait for the trigger.
                </Text>
              </View>
            ) : (
              <View style={styles.runList}>
                {runs.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    w={w}
                    onOpenThread={(channelId, rootId) => router.push(`/channel/${channelId}/thread/${rootId}`)}
                  />
                ))}
              </View>
            )}
          </>
        ) : null}

        {/* Playbook */}
        <View style={styles.playbookHeader}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Playbook</Text>
          {!editingPlaybook ? (
            <Pressable onPress={() => setEditingPlaybook(true)} hitSlop={8}>
              <Text style={[styles.editLink, { color: colors.primary }]}>Edit</Text>
            </Pressable>
          ) : null}
        </View>
        {editingPlaybook ? (
          <>
            <TextInput
              multiline
              value={playbook}
              onChangeText={setPlaybook}
              style={[
                styles.playbookInput,
                { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
              ]}
            />
            <Text style={[styles.playbookHint, { color: colors.mutedForeground }]}>
              Every member sees the playbook word for word. Edits apply from the next run.
            </Text>
            <View style={styles.draftActions}>
              <Pressable
                onPress={() => {
                  setPlaybook(w.playbook);
                  setEditingPlaybook(false);
                }}
                style={[styles.btn, { borderColor: colors.border }]}
              >
                <Text style={[styles.btnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={busy || playbook === w.playbook}
                onPress={() =>
                  void act(() => updateWorkflow(w.id, { playbook }), "Couldn't save").then(() =>
                    setEditingPlaybook(false),
                  )
                }
                style={[
                  styles.btn,
                  styles.btnPrimary,
                  { backgroundColor: colors.primary, opacity: busy || playbook === w.playbook ? 0.5 : 1 },
                ]}
              >
                <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Save playbook</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.playbookText, { color: colors.foreground }]}>{w.playbook || "—"}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: { padding: 14, paddingBottom: 40, gap: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  flexSpacer: { flex: 1 },
  desc: { fontSize: 13, lineHeight: 19 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
  },
  panel: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  teamRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  teamText: { flex: 1, gap: 1 },
  teamName: { fontSize: 14, fontWeight: "600" },
  teamRole: { fontSize: 12 },
  workingDot: { width: 6, height: 6, borderRadius: 3 },
  runList: { gap: 8 },
  emptyCard: { borderWidth: 1, borderStyle: "dashed", borderRadius: radius.lg, padding: 20 },
  emptyText: { fontSize: 13, textAlign: "center", lineHeight: 19 },
  draftCard: { borderWidth: 1, borderRadius: radius.lg, padding: 14, gap: 10 },
  draftText: { fontSize: 13, lineHeight: 19 },
  draftActions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
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
  playbookHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  editLink: { fontSize: 13, fontWeight: "600" },
  playbookInput: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 12,
    minHeight: 160,
    fontSize: 13,
    lineHeight: 19,
    textAlignVertical: "top",
  },
  playbookHint: { fontSize: 12, lineHeight: 17 },
  playbookText: { fontSize: 13, lineHeight: 19, padding: 12 },
});
