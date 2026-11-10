#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ $# -gt 0 ]]; then
  OUTDIR="$1"
else
  OUTDIR="${CHECK_DEPLOY_OUTDIR:-$HOME/Development/.scratch/transfer-deploy/dist}"
fi

R2_OUT="$OUTDIR/r2"
S3_OUT="$OUTDIR/s3"
WRANGLER="$BACKEND_DIR/node_modules/.bin/wrangler"

export WRANGLER_SEND_METRICS=false
export WRANGLER_SEND_ERROR_REPORTS=false

mkdir -p "$R2_OUT" "$S3_OUT"

strip_ansi() {
  sed -E $'s/\x1B\\[[0-9;]*[[:alpha:]]//g'
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  if ! grep -q -E "$pattern" "$file"; then
    echo "check-deploy: missing pattern: $pattern" >&2
    echo "----- output -----" >&2
    cat "$file" >&2
    exit 1
  fi
}

reject_pattern() {
  local file="$1"
  local pattern="$2"
  if grep -q -E "$pattern" "$file"; then
    echo "check-deploy: unexpected pattern: $pattern" >&2
    echo "----- output -----" >&2
    cat "$file" >&2
    exit 1
  fi
}

run_dry_run() {
  local outdir="$1"
  local logfile="$2"
  shift 2
  if ! (
    cd "$BACKEND_DIR"
    "$WRANGLER" deploy --dry-run --outdir "$outdir" "$@"
  ) 2>&1 | strip_ansi >"$logfile"; then
    echo "check-deploy: wrangler deploy --dry-run failed" >&2
    cat "$logfile" >&2
    exit 1
  fi
}

R2_LOG="$(mktemp)"
S3_LOG="$(mktemp)"
trap 'rm -f "$R2_LOG" "$S3_LOG"' EXIT

run_dry_run "$R2_OUT" "$R2_LOG" --env=""
run_dry_run "$S3_OUT" "$S3_LOG" --env s3

require_pattern "$R2_LOG" 'env\.FILES \(transfer-files\)'
require_pattern "$R2_LOG" 'env\.STORAGE_BACKEND \("r2"\)'
require_pattern "$S3_LOG" 'env\.STORAGE_BACKEND \("s3"\)'
reject_pattern "$S3_LOG" 'env\.FILES'
reject_pattern "$S3_LOG" 'transfer-files'
reject_pattern "$R2_LOG" 'required secrets have not been set'
reject_pattern "$S3_LOG" 'required secrets have not been set'
reject_pattern "$R2_LOG" '\[WARNING\]'
s3_warnings="$(grep -c -E '\[WARNING\]' "$S3_LOG" || true)"
if [[ "$s3_warnings" -ne 1 ]]; then
  echo "check-deploy: expected 1 s3 warning, found $s3_warnings" >&2
  cat "$S3_LOG" >&2
  exit 1
fi
require_pattern "$S3_LOG" 'binding with name "FILES"'

if [[ ! -f "$R2_OUT/index.js" ]]; then
  echo "check-deploy: missing bundle $R2_OUT/index.js" >&2
  exit 1
fi
if [[ ! -f "$S3_OUT/index.js" ]]; then
  echo "check-deploy: missing bundle $S3_OUT/index.js" >&2
  exit 1
fi

echo "check-deploy: PASS"
