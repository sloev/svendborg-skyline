#!/usr/bin/env bash
# Prints the worker's URL: the WORKER_URL variable if set, otherwise
# https://silo-arkiv.<workers.dev subdomain>.workers.dev looked up with the Cloudflare API.
set -euo pipefail
if [ -n "${WORKER_URL:-}" ]; then echo "${WORKER_URL%/}"; exit 0; fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then exit 0; fi
sub=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
[ -n "$sub" ] && echo "https://silo-arkiv.$sub.workers.dev"
