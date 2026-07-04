#!/usr/bin/env bash
# Migrate one agent's runner from Docker-on-EC2 to a Fly Machine, preserving its workspace
# (SDK session + repo working tree, minus regenerable node_modules).
#
# Usage: scripts/migrate-agent-to-fly.sh <agent-id>
#
# Steps: stop docker container -> tar workspace (excl node_modules) -> create Fly machine
# (FlyProvisioner.create) -> flip runner_provider=fly -> ssh-upload tarball -> atomic restore
# -> restart machine -> verify reconnect -> tear down docker container+volume (tarball kept in
# /tmp/mig/<id>.tgz as a rollback artifact). Idempotent-ish: safe to re-run if a step fails
# before the docker teardown.
set -euo pipefail

AID="${1:?usage: migrate-agent-to-fly.sh <agent-id>}"
APP="${FLY_APP:-jungle-runners}"
export PATH="$HOME/.fly/bin:$PATH"
cd /home/ec2-user/dev/jungle
set -a; source .env; set +a

VOL="jungle-agent-$AID-ws"
CTR="jungle-agent-$AID"
HANDLE=$(psql "$DATABASE_URL" -tAc "select handle from participants where id='$AID'" | tr -d '[:space:]')
[ -n "$HANDLE" ] || { echo "no agent $AID"; exit 1; }
echo "[$HANDLE / $AID] starting migration"

echo "1. stop docker container"
sg docker -c "docker stop $CTR" >/dev/null 2>&1 || true

echo "2. tar workspace (excl node_modules)"
mkdir -p /tmp/mig
sg docker -c "docker run --rm -v $VOL:/w -v /tmp/mig:/out alpine tar czf /out/$AID.tgz -C /w --exclude=repo/node_modules ."
LSIZE=$(stat -c%s "/tmp/mig/$AID.tgz"); echo "   tarball $LSIZE bytes"

echo "3. create Fly machine"
CREATE_TS="/tmp/mig/create-$AID.mts"
cat > "$CREATE_TS" <<TSEOF
import { FlyProvisioner } from "/home/ec2-user/dev/jungle/backend/src/provisioner-fly.ts";
import * as db from "/home/ec2-user/dev/jungle/backend/src/db.ts";
const row = await db.getAgentRow("$AID");
await new FlyProvisioner().create({ id: "$AID", handle: row!.handle, runnerToken: row!.runner_token! });
process.exit(0);
TSEOF
npx tsx "$CREATE_TS" 2>&1 | grep -vE "inject|dotenv" || true
rm -f "$CREATE_TS"
MID=$(psql "$DATABASE_URL" -tAc "select runner_meta->>'machineId' from participants where id='$AID'" | tr -d '[:space:]')
[ -n "$MID" ] || { echo "   create failed (no machineId)"; exit 1; }
echo "   machine $MID"

echo "4. flip runner_provider=fly"
psql "$DATABASE_URL" -c "update participants set runner_provider='fly' where id='$AID'" >/dev/null

echo "5. wait for machine started"
for i in $(seq 1 24); do
  S=$(fly machine status "$MID" -a "$APP" 2>/dev/null | grep -iE "^State:" | awk '{print $2}')
  [ "$S" = "started" ] && break
  sleep 5
done
[ "$S" = "started" ] || { echo "   machine never started (state=$S)"; exit 1; }

echo "6. upload tarball (ssh stdin) + verify size"
cat "/tmp/mig/$AID.tgz" | fly ssh console -a "$APP" --machine "$MID" -C "sh -c 'cat > /workspace/_mig.tgz'"
RSIZE=$(fly ssh console -a "$APP" --machine "$MID" -C "sh -c 'stat -c %s /workspace/_mig.tgz'" 2>/dev/null | tr -dc '0-9')
[ "$RSIZE" = "$LSIZE" ] || { echo "   size mismatch (local=$LSIZE remote=$RSIZE)"; exit 1; }

echo "7. atomic restore (wipe except tarball, untar)"
fly ssh console -a "$APP" --machine "$MID" -C "sh -c 'cd /workspace && find . -maxdepth 1 -mindepth 1 ! -name _mig.tgz -exec rm -rf {} + && tar xzf _mig.tgz && rm _mig.tgz'"

echo "8. restart machine (runner reboots into restored workspace)"
fly machine restart "$MID" -a "$APP" >/dev/null

echo "9. verify runner reconnect"
OK=""
for i in $(seq 1 15); do
  ST=$(curl -s localhost:3001/api/participants | python3 -c "import sys,json;ps=json.load(sys.stdin);print(next((p.get('status') for p in ps if p.get('id')=='$AID'),'?'))" 2>/dev/null)
  if [ "$ST" = "idle" ] || [ "$ST" = "working" ]; then OK=1; break; fi
  sleep 6
done
[ -n "$OK" ] || { echo "   runner did NOT reconnect (status=$ST) — NOT tearing down docker"; exit 1; }
echo "   reconnected (status=$ST)"

echo "10. teardown docker (tarball kept at /tmp/mig/$AID.tgz)"
sg docker -c "docker rm -f $CTR" >/dev/null 2>&1 || true
sg docker -c "docker volume rm $VOL" >/dev/null 2>&1 || true
echo "[$HANDLE] MIGRATED to fly (machine $MID)"
