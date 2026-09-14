#!/usr/bin/env bash
# Ship Vigil to the VM: sync the source (never node_modules, .env or the database), build there under
# Node 22, then start or reload the pm2 apps from ecosystem.config.cjs.
set -euo pipefail
KEY=${VIGIL_SSH_KEY:-$HOME/Documents/ssh-key3.key}
HOST=${VIGIL_HOST:-ubuntu@80.225.209.190}
cd "$(dirname "$0")/.."
rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=no" --exclude node_modules --exclude .next --exclude var --exclude .env --exclude .git --exclude tsconfig.tsbuildinfo ./ "$HOST:/home/ubuntu/vigil/"
ssh -o StrictHostKeyChecking=no -i "$KEY" "$HOST" bash -s <<'REMOTE'
set -eo pipefail
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null
cd /home/ubuntu/vigil
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -1
fi
# Build in a sibling directory: a build that writes into the live .next makes the running app serve
# chunks that no longer exist (400s) for the whole four minutes. The finished build is copied over in
# seconds, then pm2 reloads.
STAGE=/home/ubuntu/vigil-build
mkdir -p "$STAGE"
rsync -a --delete --exclude node_modules --exclude .next --exclude var --exclude .env --exclude build.log /home/ubuntu/vigil/ "$STAGE/"
ln -sfn /home/ubuntu/vigil/node_modules "$STAGE/node_modules"
cp /home/ubuntu/vigil/.env "$STAGE/.env"   # NEXT_PUBLIC_* values are inlined at build time
(cd "$STAGE" && VIGIL_TURBO_ROOT=/home/ubuntu npm run build > build.log 2>&1) || { tail -25 "$STAGE/build.log"; echo "BUILD FAILED"; exit 1; }
tail -3 "$STAGE/build.log"
rsync -a --delete "$STAGE/.next/" /home/ubuntu/vigil/.next/
pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null
sleep 2; pm2 ls | grep -E "vigil"
curl -s -o /dev/null -w "local :3100 → %{http_code}\n" http://127.0.0.1:3100/
REMOTE
