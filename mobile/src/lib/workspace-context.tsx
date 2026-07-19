// Owns the active workspace + the per-workspace bootstrap: wires the API workspace header, loads
// the initial data snapshot, and brings up the live socket. Switching workspace (from the You tab)
// clears per-workspace store state, re-fetches, and reconnects the socket. Lifted out of the root
// layout so any screen can switch via useWorkspace().
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Membership } from "@jungle/shared";
import { useAuth } from "./auth";
import {
  setActiveWorkspaceId,
  listChannels,
  listParticipants,
  listDeliverables,
  listPendingConfirms,
} from "./api";
import { appSocket } from "./socket";
import { registerPush } from "./push";
import { useChatStore } from "../store/chat";

const WS_KEY = "jungle.activeWorkspaceId";

interface WorkspaceContextValue {
  ready: boolean;
  wsId: string | null;
  membership: Membership | null;
  memberships: Membership[];
  setWsId: (id: string) => void;
  // Re-run the snapshot fetch + socket handshake (e.g. after the dev server switcher changes origin).
  reboot: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { me, getToken } = useAuth();
  const setMyParticipantId = useChatStore((s) => s.setMyParticipantId);
  const setChannels = useChatStore((s) => s.setChannels);
  const setPeople = useChatStore((s) => s.setPeople);
  const setDeliverables = useChatStore((s) => s.setDeliverables);
  const setConfirms = useChatStore((s) => s.setConfirms);
  const resetWorkspaceState = useChatStore((s) => s.resetWorkspaceState);
  const [ready, setReady] = useState(false);
  const [wsId, setWsIdState] = useState<string | null>(null);
  const [bootNonce, setBootNonce] = useState(0);

  const memberships = me?.memberships ?? [];

  // Resolve the initial membership (persisted choice, else the first workspace).
  useEffect(() => {
    if (!memberships.length) return;
    AsyncStorage.getItem(WS_KEY).then((saved) => {
      const pick = memberships.find((m) => m.workspace.id === saved) ?? memberships[0];
      setWsIdState((cur) => cur ?? pick.workspace.id);
    });
  }, [me]);

  const membership = useMemo(
    () => memberships.find((m) => m.workspace.id === wsId) ?? null,
    [me, wsId],
  );

  // Bootstrap on membership change (initial + switch): snapshot + socket.
  useEffect(() => {
    if (!membership) return;
    let cancelled = false;
    const pid = membership.participant.id;
    setReady(false);
    resetWorkspaceState();
    setActiveWorkspaceId(membership.workspace.id);
    AsyncStorage.setItem(WS_KEY, membership.workspace.id).catch(() => {});
    setMyParticipantId(pid);

    Promise.allSettled([
      listChannels(pid).then((cs) => !cancelled && setChannels(cs)),
      listParticipants().then((ps) => !cancelled && setPeople(ps)),
      listDeliverables().then((ds) => !cancelled && setDeliverables(ds)),
      listPendingConfirms().then((cs) => !cancelled && setConfirms(cs)),
    ]).finally(() => {
      if (cancelled) return;
      setReady(true);
      useChatStore.getState().refreshThreads();
      void registerPush(); // ask permission + register the Expo token (no-op without the native build)
    });

    appSocket.start({ getToken, workspaceId: membership.workspace.id, participantId: null });
    return () => {
      cancelled = true;
      appSocket.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership, bootNonce]);

  const setWsId = useCallback(
    (id: string) => {
      if (id !== wsId) setWsIdState(id);
    },
    [wsId],
  );

  const reboot = useCallback(() => setBootNonce((n) => n + 1), []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ ready, wsId, membership, memberships, setWsId, reboot }),
    [ready, wsId, membership, memberships, setWsId, reboot],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
