#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MINIO_ROOT="$BACKEND_DIR/.minio"
MINIO_DATA_DIR="$MINIO_ROOT/data"
MINIO_LOG="$MINIO_ROOT/minio.log"
WRANGLER_LOG="$MINIO_ROOT/wrangler.log"
WRANGLER_STATE="$BACKEND_DIR/.wrangler/smoke"
SMOKE_ENV="$MINIO_ROOT/smoke.env"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/transfer-smoke.XXXXXX")"

MINIO_PID=""
WRANGLER_PID=""
MINIO_ENDPOINT="http://127.0.0.1:9000"
WORKER_ORIGIN="http://127.0.0.1:8787"
S3_BUCKET="transfer-smoke"
S3_ACCESS_KEY_ID="transfer-local"
S3_SECRET_ACCESS_KEY="transfer-local-secret"
UPLOAD_KEY="local-upload-key-for-smoke-tests-only"

cleanup() {
  if [[ -n "$WRANGLER_PID" ]] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  if [[ -n "$MINIO_PID" ]] && kill -0 "$MINIO_PID" 2>/dev/null; then
    kill "$MINIO_PID" 2>/dev/null || true
    wait "$MINIO_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_DIR"
  rm -f "$SMOKE_ENV"
}
trap cleanup EXIT INT TERM

for command in curl minio mc node cmp; do
  command -v "$command" >/dev/null || {
    echo "missing command: $command" >&2
    exit 1
  }
done

if curl --silent --output /dev/null "$MINIO_ENDPOINT/minio/health/live"; then
  echo "MinIO port 9000 is already in use" >&2
  exit 1
fi
if curl --silent --output /dev/null "$WORKER_ORIGIN"; then
  echo "Worker port 8787 is already in use" >&2
  exit 1
fi

mkdir -p "$MINIO_DATA_DIR" "$WRANGLER_STATE"
cat >"$SMOKE_ENV" <<EOF
UPLOAD_KEY=$UPLOAD_KEY
S3_ENDPOINT=$MINIO_ENDPOINT
S3_REGION=us-east-1
S3_BUCKET=$S3_BUCKET
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
EOF

MINIO_ROOT_USER="$S3_ACCESS_KEY_ID" \
MINIO_ROOT_PASSWORD="$S3_SECRET_ACCESS_KEY" \
  minio server "$MINIO_DATA_DIR" \
    --address 127.0.0.1:9000 \
    --console-address 127.0.0.1:9001 \
    >"$MINIO_LOG" 2>&1 &
MINIO_PID=$!

for _ in {1..100}; do
  if curl --fail --silent --output /dev/null "$MINIO_ENDPOINT/minio/health/live"; then
    break
  fi
  kill -0 "$MINIO_PID" 2>/dev/null || {
    cat "$MINIO_LOG" >&2
    exit 1
  }
  sleep 0.1
done
curl --fail --silent --output /dev/null "$MINIO_ENDPOINT/minio/health/live"

MC_CONFIG_DIR="$MINIO_ROOT/mc" mc alias set local \
  "$MINIO_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" \
  >/dev/null
MC_CONFIG_DIR="$MINIO_ROOT/mc" mc mb --ignore-existing "local/$S3_BUCKET" \
  >/dev/null

"$BACKEND_DIR/node_modules/.bin/wrangler" dev \
  --local \
  --env s3 \
  --ip 127.0.0.1 \
  --port 8787 \
  --persist-to "$WRANGLER_STATE" \
  --env-file "$SMOKE_ENV" \
  --show-interactive-dev-session=false \
  --log-level=error \
  >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!

for _ in {1..200}; do
  if curl --silent --output /dev/null "$WORKER_ORIGIN"; then
    break
  fi
  kill -0 "$WRANGLER_PID" 2>/dev/null || {
    cat "$WRANGLER_LOG" >&2
    exit 1
  }
  sleep 0.1
done
curl --silent --output /dev/null "$WORKER_ORIGIN"

json_field() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value !== "string") process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2"
}

expect_status() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected $expected, got $actual" >&2
    exit 1
  fi
  echo "$label: $actual" >&2
}

create_share() {
  local input_file="$1"
  local ttl="$2"
  local output_prefix="$3"
  local size
  size="$(wc -c <"$input_file" | tr -d ' ')"
  local payload
  payload="$(node -e '
    process.stdout.write(JSON.stringify({
      name: "smoke.txt",
      size: Number(process.argv[1]),
      type: "text/plain",
      ttlSeconds: Number(process.argv[2]),
    }));
  ' "$size" "$ttl")"

  local create_body="$TEMP_DIR/${output_prefix}-create.json"
  local status
  status="$(curl --silent --show-error \
    --output "$create_body" \
    --write-out "%{http_code}" \
    --request POST \
    --header "Authorization: Bearer $UPLOAD_KEY" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "$WORKER_ORIGIN/v1/uploads")"
  expect_status "$output_prefix create" 201 "$status"

  local id
  local upload_url
  id="$(json_field "$create_body" id)"
  upload_url="$(json_field "$create_body" uploadURL)"

  status="$(curl --silent --show-error \
    --output /dev/null \
    --write-out "%{http_code}" \
    --request PUT \
    --header "Authorization: Bearer $UPLOAD_KEY" \
    --header "Content-Type: text/plain" \
    --data-binary "@$input_file" \
    "$upload_url")"
  expect_status "$output_prefix upload" 204 "$status"

  local complete_body="$TEMP_DIR/${output_prefix}-complete.json"
  status="$(curl --silent --show-error \
    --output "$complete_body" \
    --write-out "%{http_code}" \
    --request POST \
    --header "Authorization: Bearer $UPLOAD_KEY" \
    "$WORKER_ORIGIN/v1/uploads/$id/complete")"
  expect_status "$output_prefix complete" 200 "$status"
  json_field "$complete_body" shareURL
}

printf "one-time smoke payload\n" >"$TEMP_DIR/input.txt"
SHARE_URL="$(create_share "$TEMP_DIR/input.txt" 86400 primary)"

STATUS="$(curl --silent --show-error \
  --output "$TEMP_DIR/interstitial.html" \
  --write-out "%{http_code}" \
  "$SHARE_URL")"
expect_status "interstitial" 200 "$STATUS"

STATUS="$(curl --silent --show-error \
  --output /dev/null \
  --write-out "%{http_code}" \
  --head \
  "$SHARE_URL")"
expect_status "head" 200 "$STATUS"

STATUS="$(curl --silent --show-error \
  --output "$TEMP_DIR/download.txt" \
  --write-out "%{http_code}" \
  --request POST \
  "$SHARE_URL/download")"
expect_status "download" 200 "$STATUS"
cmp "$TEMP_DIR/input.txt" "$TEMP_DIR/download.txt"
echo "download body: match"

STATUS="$(curl --silent --show-error \
  --output /dev/null \
  --write-out "%{http_code}" \
  --request POST \
  "$SHARE_URL/download")"
expect_status "second download" 410 "$STATUS"

printf "short ttl\n" >"$TEMP_DIR/expiring.txt"
EXPIRING_URL="$(create_share "$TEMP_DIR/expiring.txt" 1 expiring)"
sleep 2
STATUS="$(curl --silent --show-error \
  --output /dev/null \
  --write-out "%{http_code}" \
  "$EXPIRING_URL")"
expect_status "expired share" 410 "$STATUS"

STATUS="$(curl --silent --show-error \
  --output /dev/null \
  --write-out "%{http_code}" \
  --header "Authorization: Bearer $UPLOAD_KEY" \
  "$WORKER_ORIGIN/v1/limits")"
expect_status "limits" 200 "$STATUS"

echo "smoke: PASS"
