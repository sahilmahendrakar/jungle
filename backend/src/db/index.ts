// The data layer, split by domain. Everything is re-exported here so callers keep using the
// single `import * as db from "./db"` namespace (db.getParticipant, db.pool, …). Wire/domain
// types come from @jungle/shared; the row types that extend them live in the domain modules.
export { pool } from "./pool";
export { withTransaction } from "./tx";
export * from "./participants";
export * from "./workspaces";
export * from "./channels";
export * from "./messages";
export * from "./threads";
export * from "./attachments";
export * from "./agents";
export * from "./hosts";
export * from "./github";
export * from "./google";
export * from "./integrations";
export * from "./connections";
export * from "./schedules";
export * from "./deliverables";
export * from "./turns";
export * from "./pushTokens";

// Wire/domain type aliases used across the backend via the db namespace (db.PersistedMessage, …).
export type { Kind, ChannelListItem, UnreadThread, Message as PersistedMessage, AttachmentMeta } from "@jungle/shared";
