#!/usr/bin/env bash
# One-time per environment, after DNS points at the VPS: nginx site + Let's Encrypt certificate.
#   deploy/setup-domain.sh staging|production
# Never leaves a config in place that fails `nginx -t`, so the other sites on the VPS are unaffected.
set -euo pipefail
ENV_NAME="${1:?usage: deploy/setup-domain.sh staging|production}"
case "$ENV_NAME" in
  staging) DOMAIN=pos-staging.techpal.store; PORT=3100 ;;
  production) DOMAIN=pos.techpal.store; PORT=3101 ;;
  *) echo "unknown environment: $ENV_NAME" >&2; exit 1 ;;
esac
HOST="${DEPLOY_HOST:-ssh_bb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="pos-$ENV_NAME"
ACME="/var/www/$SITE-acme"

VPS_IP="$(ssh "$HOST" 'curl -s -4 ifconfig.me')"
# Ask the zone's own nameserver: public resolvers may still cache an earlier "no such name"
ZONE_NS="$(dig +short NS "${DOMAIN#*.}" @8.8.8.8 | head -1)"
DNS_IP="$(dig +short "$DOMAIN" A @"${ZONE_NS:-1.1.1.1}" | tail -1)"
if [ "$DNS_IP" != "$VPS_IP" ]; then
  echo "$DOMAIN resolves to '${DNS_IP:-nothing}', not $VPS_IP: add the A record first" >&2
  exit 1
fi

render() { sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" -e "s#__ACME_ROOT__#$ACME#g" "$ROOT/deploy/nginx/site.conf.template"; }
# Bootstrap = the port-80 block only (serves the ACME challenge before a certificate exists)
render | awk 'BEGIN{n=0} /^server \{/{n++} n<=1' > "/tmp/$SITE.http.conf"
render > "/tmp/$SITE.conf"
scp -q "/tmp/$SITE.http.conf" "/tmp/$SITE.conf" "$HOST:/tmp/"

ssh "$HOST" bash -s -- "$DOMAIN" "$SITE" "$ACME" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"; SITE="$2"; ACME="$3"
AVAILABLE="/etc/nginx/sites-available/$SITE"; ENABLED="/etc/nginx/sites-enabled/$SITE"
install_conf() {
  cp "$1" "$AVAILABLE" && ln -sf "$AVAILABLE" "$ENABLED"
  if ! nginx -t 2>/tmp/$SITE.nginx-test; then
    cat /tmp/$SITE.nginx-test >&2; rm -f "$ENABLED"; echo "nginx -t failed; removed $ENABLED" >&2; exit 1
  fi
  systemctl reload nginx
}
mkdir -p "$ACME"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  install_conf "/tmp/$SITE.http.conf"
  certbot certonly --webroot -w "$ACME" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
fi
install_conf "/tmp/$SITE.conf"
rm -f "/tmp/$SITE.http.conf" "/tmp/$SITE.conf"
echo "   https://$DOMAIN is live"
REMOTE
curl -fsS "https://$DOMAIN/api/health" && echo
