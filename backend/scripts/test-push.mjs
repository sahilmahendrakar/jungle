// One-off: send a test push to a registered device to verify FCM→APNs delivery.
// Usage: node scripts/test-push.mjs <firebase_uid> ["title" "body"]
// Loads ../.env via dotenv (same parser as the backend) so FIREBASE_SERVICE_ACCOUNT
// JSON survives intact — shell `source` corrupts it and sendPush silently no-ops.
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url) });

const uid = process.argv[2];
if (!uid) {
  console.error("usage: test-push.mjs <firebase_uid> [title] [body]");
  process.exit(1);
}
const title = process.argv[3] || "Jungle test";
const body = process.argv[4] || "This is a test push from the backend.";

const { sendPush } = await import("../src/services/push.ts");
const { firebaseApp } = await import("../src/auth.ts");

const app = firebaseApp();
if (!app) {
  console.error("firebaseApp() is null — FIREBASE_SERVICE_ACCOUNT not loaded. Aborting.");
  process.exit(2);
}
console.log(`firebase app initialized; sending push to uid=${uid} ...`);
try {
  await sendPush([uid], {
    title,
    body,
    data: { test: "true", source: "backend-smoke" },
    threadId: "test-push",
  });
  console.log("sendPush returned (fire-and-forget send complete).");
} catch (e) {
  console.error("sendPush threw:", e?.message ?? e);
  process.exit(3);
}
