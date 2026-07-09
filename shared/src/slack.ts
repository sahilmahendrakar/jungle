// Wire contracts for the Slack integration (two-way channel mirroring). See the backend
// services/slackBridge.ts and http/routes/slack.ts; frontend Settings + SlackLinkDialog.

// Workspace-level install status (one Slack team per Jungle workspace).
export interface SlackStatus {
  installed: boolean;
  teamName?: string | null;
  status?: "active" | "revoked";
}

// A public Slack channel the bot can see, for the link picker.
export interface SlackChannelInfo {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

// The mirror binding for one Jungle channel (null when unlinked).
export interface SlackChannelLink {
  channelId: string; // Jungle channel id
  slackChannelId: string;
  slackChannelName: string | null;
  status: "active" | "error";
  lastError: string | null;
}
