-- 002_drop_ma_columns.sql — finish the Managed Agents cutover.
--
-- After migrating every agent to the SDK runner (runtime='sdk') and removing ma.ts, these
-- columns are unreferenced by the backend. Dropping them stops them leaking (null) into
-- `select *` API responses and keeps the schema honest. Safe to run only once the SDK-runtime
-- backend (which no longer selects/inserts these) is deployed.
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/002_drop_ma_columns.sql

alter table participants drop column if exists ma_session_id;
alter table participants drop column if exists vault_id;
alter table participants drop column if exists repo_resource_id;
alter table participants drop column if exists mcp_credential_id;

-- New agents default to the SDK runner. (Existing rows were already migrated/deleted.)
alter table participants alter column runtime set default 'sdk';
