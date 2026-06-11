#!/bin/sh
# Require the Tempo endpoint to be supplied at deploy time. Caddy would
# otherwise start with an empty upstream and only fail per request, so fail
# fast here with a clear message instead.
set -e

if [ -z "${TEMPO_URL}" ]; then
  echo "ERROR: TEMPO_URL is required — set it to the Tempo API endpoint," >&2
  echo "       e.g. -e TEMPO_URL=tempo:3200 or -e TEMPO_URL=https://tempo.example.com" >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
