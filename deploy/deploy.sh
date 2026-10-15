#!/usr/bin/env bash
# Build and (re)start the server for one environment on the VPS: deploy/deploy.sh staging|production
# Copies the working tree over SSH and builds on the VPS; the database password is generated there.
set -euo pipefail
ENV_NAME="${1:?usage: deploy/deploy.sh staging|production}"
case "$ENV_NAME" in
  staging) PORT=3100; PUBLIC_URL=https://pos-staging.techpal.store ;;
  production) PORT=3101; PUBLIC_URL=https://pos.techpal.store ;;
  *) echo "unknown environment: $ENV_NAME" >&2; exit 1 ;;
esac
HOST="${DEPLOY_HOST:-ssh_bb}"
DIR="/opt/pos-$ENV_NAME"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(git -C "$ROOT" describe --tags --always --dirty)"

echo "-> syncing source to $HOST:$DIR/src"
ssh "$HOST" "mkdir -p $DIR/src"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude .turbo --exclude dist \
  --exclude apps/tablet/android --exclude '.env*' \
  "$ROOT/" "$HOST:$DIR/src/"

echo "-> building and starting pos-$ENV_NAME ($VERSION)"
ssh "$HOST" bash -s -- "$DIR" "$PORT" "$VERSION" "$ENV_NAME" "$PUBLIC_URL" <<'REMOTE'
set -euo pipefail
DIR="$1"; PORT="$2"; VERSION="$3"; ENV_NAME="$4"; PUBLIC_URL="$5"
cd "$DIR"
if [ ! -f .env ]; then
  (umask 077; printf 'HOST_PORT=%s\nPOSTGRES_PASSWORD=%s\n' "$PORT" "$(openssl rand -hex 24)" > .env)
  echo "   created $DIR/.env with a new database password"
fi
# Generated once, kept on the VPS only; needed for the one-time /api/setup
grep -q '^SETUP_TOKEN=' .env || (umask 077; echo "SETUP_TOKEN=$(openssl rand -hex 24)" >> .env)
sed -i '/^APP_VERSION=/d; /^PUBLIC_URL=/d' .env && printf 'APP_VERSION=%s\nPUBLIC_URL=%s\n' "$VERSION" "$PUBLIC_URL" >> .env
COMPOSE="docker compose -p pos-$ENV_NAME --env-file .env -f src/deploy/compose.yml"
$COMPOSE up -d --build --remove-orphans
for _ in $(seq 1 30); do
  if body=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
    echo "   healthy: $body"; exit 0
  fi
  sleep 2
done
echo "   server did not become healthy" >&2
$COMPOSE logs --tail 50 server >&2
exit 1
REMOTE
