#!/usr/bin/env bash
set -euo pipefail

# Docker names are generated for this invocation. The result volume contains only audit metadata.
lab="os-dashboard-workshop-audit-$(cat /proc/sys/kernel/random/uuid)"
label="os-dashboard.audit.run=$lab"
out="$lab-result"
completed=0
cleanup() {
  local ids
  mapfile -t ids < <(docker ps -aq --filter "label=$label")
  if (( ${#ids[@]} )); then docker rm -f "${ids[@]}" >/dev/null; fi
  mapfile -t ids < <(docker network ls -q --filter "label=$label")
  if (( ${#ids[@]} )); then docker network rm "${ids[@]}" >/dev/null; fi
  mapfile -t ids < <(docker volume ls -q --filter "label=$label")
  for id in "${ids[@]}"; do
    if [[ "$id" != "$out" || "$completed" == 0 ]]; then docker volume rm "$id" >/dev/null; fi
  done
}
trap cleanup EXIT
docker network create --internal --label "$label" "$lab-net" >/dev/null
for volume in "$lab-worker" "$lab-auth" "$lab-db" "$lab-audit" "$out"; do
  docker volume create --label "$label" "$volume" >/dev/null
done
# The Workshop image runs as UID 1000 and owns its own service-export mount.
docker run --rm --network none -v "$lab-audit:/audit" node:24-bookworm-slim chown 1000:1000 /audit
start() {
  local role=$1
  shift
  docker run -d --pull=never --label "$label" --name "$lab-$role" --network "$lab-net" --network-alias "$role" "$@" >/dev/null
}
start model os-dashboard/workshop-audit-model:local
start ai-gateway -v "$lab-db:/data" -v "$lab-auth:/auth" os-dashboard/workshop-audit-ai-gateway:local
start workshop -v "$lab-worker:/data" -v "$lab-audit:/os-dashboard-audit" -e PUBLIC_BASE_URL=http://web:8080 \
  -e 'ADMINS=["auditdemo"]' -e GATEKEEPERS=google -e 'SELF_HOSTED_MODEL_BASE_URLS=["http://ai-gateway:4322/v1"]' \
  -e OS_DASHBOARD_WORKSHOP_AUDIT_FILE=/os-dashboard-audit/workshop.sqlite \
  -e OS_DASHBOARD_AI_GATEWAY_ROOT=http://ai-gateway:4322/v1 "${OS_DASHBOARD_AUDIT_WORKSHOP_IMAGE:-os-dashboard/workshop:local}"
start web dockerflare/web:local
docker run --rm --pull=never --label "$label" --network "$lab-net" -v "$lab-auth:/auth:ro" os-dashboard/workshop-audit-checks:local
docker exec "$lab-workshop" node /os-dashboard-export/export.mjs --once
docker run --rm --pull=never --label "$label" --network none -v "$lab-db:/data:ro" -v "$lab-audit:/audit" -v "$out:/result" \
  os-dashboard/workshop-audit-ai-gateway:local node /demo/verify.mjs
docker run --rm --pull=never --network none --user 1000:1000 -v "$out:/result:ro" node:24-bookworm-slim \
  node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";
    for (const [file, table] of [["workshop","chat"],["ai-gateway","workshop_charge"]]) {
      const db = new DatabaseSync("/result/"+file+".sqlite",{readOnly:true}); db.prepare("SELECT 1 FROM "+table).get(); db.close();
    }'
completed=1
printf 'Metadata volume: %s\n' "$out"
