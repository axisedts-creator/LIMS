#!/usr/bin/env bash
# CR TENANT-LOGO-1 (storage wiring): proves the API's S3 client and the per-tenant file kit against a REAL Supabase Storage server
# (same image as tools/devstack: storage-api with the S3 protocol on, local file backend) instead of the in-memory fake.
# Boots a throwaway Postgres + storage-api pair on a private docker network, creates one private bucket, runs
# services/api/src/core/storage/__tests__/kit.live.test.ts, removes everything. Random throwaway secrets; synthetic bytes only.
# Run from the repo root. Exit code = vitest's.
set -euo pipefail
PG_IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
ST_IMAGE="${LIMS_STORAGE_IMAGE:-supabase/storage-api:v1.89.12}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
ID="lims_stkit_$$"; NET="$ID"; DBC="${ID}_db"; STC="${ID}_st"
cleanup() { docker rm -f "$STC" "$DBC" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
RND() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
PGPW="$(RND 24)"; JWT_SECRET="$(RND 48)"; S3_ID="$(RND 20)"; S3_SECRET="$(RND 40)"; BUCKET="lims-kit-test"
# HS256 service-role token for the one bucket-create call (node:crypto only; never printed)
SERVICE_KEY="$(JWT_SECRET="$JWT_SECRET" node -e '
const c=require("node:crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iss:"supabase",iat:Math.floor(Date.now()/1e3),exp:Math.floor(Date.now()/1e3)+3600});
process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"));')"

docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" --network-alias db -e POSTGRES_PASSWORD="$PGPW" -e JWT_SECRET="$JWT_SECRET" \
  -v "$HOSTPWD/tools/devstack/db-init/99-service-roles.sql":/docker-entrypoint-initdb.d/init-scripts/99-service-roles.sql:ro "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$DBC" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$DBC" pg_isready -U postgres -h localhost >/dev/null
docker run -d --name "$STC" --network "$NET" -p 127.0.0.1::5000 --env-file tools/devstack/env/storage.env \
  -e DATABASE_URL="postgres://supabase_storage_admin:$PGPW@db:5432/postgres" -e ANON_KEY="$SERVICE_KEY" -e SERVICE_KEY="$SERVICE_KEY" \
  -e PGRST_JWT_SECRET="$JWT_SECRET" -e AUTH_JWT_SECRET="$JWT_SECRET" \
  -e S3_PROTOCOL_ACCESS_KEY_ID="$S3_ID" -e S3_PROTOCOL_ACCESS_KEY_SECRET="$S3_SECRET" "$ST_IMAGE" >/dev/null
PORT=""
for _ in $(seq 1 60); do
  PORT="$(docker port "$STC" 5000/tcp 2>/dev/null | head -n1 | sed 's/.*://')" || true
  [ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null 2>&1 && break; sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null
curl -fsS -X POST "http://127.0.0.1:$PORT/bucket" -H "authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' \
  -d "{\"id\":\"$BUCKET\",\"name\":\"$BUCKET\",\"public\":false}" >/dev/null

export LIMS_TEST_STORAGE=1 STORAGE_PROVIDER=s3_compatible STORAGE_ENDPOINT="http://127.0.0.1:$PORT/s3" STORAGE_REGION=stub STORAGE_BUCKET="$BUCKET" \
  STORAGE_ACCESS_KEY_ID="$S3_ID" STORAGE_SECRET_ACCESS_KEY="$S3_SECRET" STORAGE_FORCE_PATH_STYLE=true
# STORAGE_KIT_CMD: run something else against the same throwaway server (debugging); default = the live test.
bash -c "${STORAGE_KIT_CMD:-pnpm --dir services/api exec vitest run src/core/storage/__tests__/kit.live.test.ts}"
