import * as db from "./db";

const DEV_HANDLE = "dev";
const DEV_DISPLAY_NAME = "Dev User";
const DEV_CHANNEL = "general";

export interface DevBootstrap {
  participantId: string;
  handle: string;
  channelId: string;
}

// Idempotent: reuse the fixed dev participant + #general channel if they already exist.
export async function ensureDevBootstrap(): Promise<DevBootstrap> {
  let participant = await db.getParticipantByHandle(DEV_HANDLE);
  if (!participant) {
    participant = await db.createParticipant({
      kind: "human",
      handle: DEV_HANDLE,
      displayName: DEV_DISPLAY_NAME,
    });
  }

  let channel = await db.getChannelByNameForMember(DEV_CHANNEL, participant.id);
  if (!channel) {
    channel = await db.createChannel({
      name: DEV_CHANNEL,
      kind: "channel",
      memberHandles: [DEV_HANDLE],
    });
  }

  return {
    participantId: participant.id,
    handle: participant.handle,
    channelId: channel.id,
  };
}

export function isDevMode(): boolean {
  return process.env.NODE_ENV !== "production";
}
