#!/usr/bin/env bash
# Skriver workerens adresse: variablen WORKER_URL hvis den er sat, ellers
# https://silo-arkiv.<workers.dev-subdomæne>.workers.dev slået op via Cloudflares API.
set -euo pipefail
if [ -n "${WORKER_URL:-}" ]; then echo "${WORKER_URL%/}"; exit 0; fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then exit 0; fi
sub=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
[ -n "$sub" ] && echo "https://silo-arkiv.$sub.workers.dev"
