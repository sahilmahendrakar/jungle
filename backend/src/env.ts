// Load secrets (DATABASE_URL, ANTHROPIC_API_KEY, …) from the secure env file.
// Imported first by db.ts / index.ts so process.env is populated before use.
import dotenv from "dotenv";

dotenv.config({
  path: process.env.JUNGLE_ENV_FILE ?? "/home/ec2-user/.config/jungle/.env",
});
