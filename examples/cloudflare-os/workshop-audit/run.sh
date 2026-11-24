#!/usr/bin/env bash
set -euo pipefail

# Docker names are generated for this invocation. The result volume contains only audit metadata.
lab="seyir-workshop-audit-$(cat /proc/sys/kernel/random/uuid)"
label="seyir.audit.run=$lab"
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
start model seyir/workshop-audit-model:local
start gateway -v "$lab-db:/data" -v "$lab-auth:/auth" seyir/workshop-audit-gateway:local
start workshop -v "$lab-worker:/data" -v "$lab-audit:/seyir-audit" -e PUBLIC_BASE_URL=http://web:8080 \
  -e 'ADMINS=["auditdemo"]' -e GATEKEEPERS=google -e 'SELF_HOSTED_MODEL_BASE_URLS=["http://gateway:4322/v1"]' \
  -e SEYIR_WORKSHOP_AUDIT_FILE=/seyir-audit/workshop.sqlite \
  -e SEYIR_GATEWAY_ROOT=http://gateway:4322/v1 "${SEYIR_AUDIT_WORKSHOP_IMAGE:-seyir/workshop:local}"
start web dockerflare/web:local
docker run --rm --pull=never --label "$label" --network "$lab-net" -v "$lab-auth:/auth:ro" seyir/workshop-audit-checks:local
docker exec "$lab-workshop" node /seyir-export/export.mjs --once
docker run --rm --pull=never --label "$label" --network none -v "$lab-db:/data:ro" -v "$lab-audit:/audit" -v "$out:/result" \
  seyir/workshop-audit-gateway:local node /demo/verify.mjs
docker run --rm --pull=never --network none --user 1000:1000 -v "$out:/result:ro" node:24-bookworm-slim \
  node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";
    for (const [file, table] of [["workshop","chat"],["gateway","workshop_charge"]]) {
      const db = new DatabaseSync("/result/"+file+".sqlite",{readOnly:true}); db.prepare("SELECT 1 FROM "+table).get(); db.close();
    }'
completed=1
printf 'Metadata volume: %s\n' "$out"
