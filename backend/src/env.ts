// Load secrets from the secure config dir. Imported first by db.ts / index.ts so
// process.env is populated before use.
//   .env            -> DATABASE_URL, ANTHROPIC_API_KEY
//   github-app.env  -> GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (Step 7)
// dotenv does not override already-set vars, so load order is harmless.
import dotenv from "dotenv";

const dir = process.env.JUNGLE_CONFIG_DIR ?? "/home/ec2-user/.config/jungle";
dotenv.config({ path: process.env.JUNGLE_ENV_FILE ?? `${dir}/.env` });
dotenv.config({ path: `${dir}/github-app.env` });
