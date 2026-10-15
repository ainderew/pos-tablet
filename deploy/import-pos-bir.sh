#!/usr/bin/env bash
# Import a PC store's POS-bir database into one environment (catalog, opening stock, customers with
# their balances, users with their PINs; see packages/db/src/import/pos-bir.ts):
#   deploy/import-pos-bir.sh staging|production <pos.db> --org-id <uuid> --store-id <uuid> --imported-by <uuid> [--dry-run]
# Close POS-bir first (its pos.db is in the folder it logs as "userData path" at startup), and try
# --dry-run first: it checks everything and writes nothing. A real import is one transaction, so on
# any error nothing is written; importing the same pos.db twice is refused.
# Copies the file (with the pos.db-wal POS-bir may have left) to a private folder on the VPS, removed
# on exit, and runs the importer CLI from the deployed source (so it matches the deployed schema) in a
# one-off node:22-alpine container on the environment's compose network. The JSON report goes to
# stdout, progress to stderr.
set -euo pipefail
usage() {
  echo "usage: deploy/import-pos-bir.sh staging|production <pos.db> --org-id <uuid> --store-id <uuid> --imported-by <uuid> [--dry-run]" >&2
  exit 2
}
[ $# -ge 2 ] || usage
ENV_NAME="$1"
SQLITE="$2"
shift 2
case "$ENV_NAME" in
  staging | production) ;;
  *) echo "unknown environment: $ENV_NAME" >&2; exit 1 ;;
esac
[ -f "$SQLITE" ] || { echo "no such file: $SQLITE" >&2; exit 1; }
ORG_ID=""; STORE_ID=""; IMPORTED_BY=""; DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --org-id) [ $# -ge 2 ] || usage; ORG_ID="$2"; shift 2 ;;
    --store-id) [ $# -ge 2 ] || usage; STORE_ID="$2"; shift 2 ;;
    --imported-by) [ $# -ge 2 ] || usage; IMPORTED_BY="$2"; shift 2 ;;
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    *) usage ;;
  esac
done
# Also what makes them safe to pass through ssh's command line
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
for value in "$ORG_ID" "$STORE_ID" "$IMPORTED_BY"; do
  [[ "$value" =~ $UUID_RE ]] || { echo "--org-id, --store-id and --imported-by must be UUIDs" >&2; usage; }
done
HOST="${DEPLOY_HOST:-ssh_bb}"
DIR="/opt/pos-$ENV_NAME"

# The pos.db holds customers' personal data: a folder only we can read, removed when this script exits
REMOTE_TMP="$(ssh "$HOST" 'umask 077 && mktemp -d /tmp/pos-import.XXXXXX')"
[[ "$REMOTE_TMP" =~ ^/tmp/pos-import\.[A-Za-z0-9]+$ ]] || { echo "unexpected remote folder: $REMOTE_TMP" >&2; exit 1; }
cleanup() { ssh "$HOST" "rm -rf -- '${REMOTE_TMP:?}'" || echo "could not remove $HOST:$REMOTE_TMP" >&2; }
trap cleanup EXIT

echo "-> copying $SQLITE to $HOST" >&2
rsync -az "$SQLITE" "$HOST:$REMOTE_TMP/pos.db"
if [ -s "$SQLITE-wal" ]; then
  # Committed writes POS-bir hadn't folded into pos.db yet; it removes the file when it closes cleanly
  echo "   with its pos.db-wal (is POS-bir still running? close it, or this copy may be inconsistent)" >&2
  rsync -az "$SQLITE-wal" "$HOST:$REMOTE_TMP/pos.db-wal"
fi

echo "-> importing into pos-$ENV_NAME${DRY_RUN:+ (dry run)}" >&2
ssh "$HOST" bash -s -- "$DIR" "$ENV_NAME" "$REMOTE_TMP" "$ORG_ID" "$STORE_ID" "$IMPORTED_BY" "$DRY_RUN" <<'REMOTE'
set -euo pipefail
DIR="$1"; ENV_NAME="$2"; WORK="$3"; ORG_ID="$4"; STORE_ID="$5"; IMPORTED_BY="$6"; DRY_RUN="${7:-}"
if [ ! -f "$DIR/src/packages/db/src/import/cli.ts" ]; then
  echo "   $DIR/src has no importer: run deploy/deploy.sh $ENV_NAME first" >&2
  exit 1
fi
NETWORK="pos-${ENV_NAME}_default"
docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "   no $NETWORK network: is pos-$ENV_NAME running?" >&2; exit 1; }
# The database password is read inside the container from the mounted .env, so it is never on a
# command line, in the container's configuration or in the output
docker run --rm --network "$NETWORK" \
  -v "$DIR/.env:/run/pos.env:ro" -v "$DIR/src:/src:ro" -v "$WORK:/data:ro" \
  node:22-alpine sh -euc '
    POSTGRES_PASSWORD="$(sed -n "s/^POSTGRES_PASSWORD=//p" /run/pos.env | tail -n 1)"
    [ -n "$POSTGRES_PASSWORD" ] || { echo "   no POSTGRES_PASSWORD in the .env" >&2; exit 1; }
    export DATABASE_URL="postgres://pos:${POSTGRES_PASSWORD}@db:5432/pos"
    unset POSTGRES_PASSWORD
    cp -R /src /work && cd /work
    npm install -g --silent pnpm@9.15.9 >&2
    pnpm install --frozen-lockfile --prod --filter @pos/db --reporter=silent >&2
    exec node --experimental-strip-types --disable-warning=ExperimentalWarning packages/db/src/import/cli.ts --sqlite /data/pos.db "$@"
  ' import-pos-bir --org-id "$ORG_ID" --store-id "$STORE_ID" --imported-by "$IMPORTED_BY" ${DRY_RUN:+"$DRY_RUN"}
REMOTE
