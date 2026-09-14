#!/usr/bin/env bash
# Put the previous build back. The deploy keeps one, and only one, good build beside the live tree;
# this swaps them and reloads. It is the only destructive thing Warden can reach, and even then only
# when a service's policy grants `redeploy_previous` — which none of them do by default.
set -euo pipefail
APP="${1:?usage: rollback.sh <pm2-app-name>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREV="$DIR/.next-previous"
[ -d "$PREV" ] || { echo "no previous build kept for $APP — nothing to roll back to"; exit 1; }
rm -rf "$DIR/.next-rolling" && cp -a "$DIR/.next" "$DIR/.next-rolling"
rm -rf "$DIR/.next" && cp -a "$PREV" "$DIR/.next"
rm -rf "$PREV" && mv "$DIR/.next-rolling" "$PREV"
pm2 restart "$APP" --update-env
echo "rolled $APP back to the previous build"
