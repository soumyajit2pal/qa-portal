#!/usr/bin/env bash
# One-time bootstrap for HTTPS (see README.md's "Enable HTTPS" section).
#
# Why this script exists at all: frontend/nginx.conf.template's 443 server
# block references a certificate under /etc/letsencrypt/live/$DOMAIN_NAME/,
# but nginx refuses to even START if that file doesn't exist yet -- and
# Let's Encrypt's certbot can't issue the FIRST certificate until something
# is already serving the ACME HTTP-01 challenge on port 80, which is nginx.
# Chicken, meet egg. The standard fix (used by this script): give nginx a
# throwaway self-signed "dummy" certificate just so it can start, obtain
# the real certificate from Let's Encrypt against that running nginx, then
# swap the dummy certificate out for the real one and reload.
#
# Run this ONCE per (fresh host, domain) pair, before `docker compose up
# -d`. It is safe to re-run (e.g. if it fails partway through) -- it always
# starts by wiping out only that one domain's existing dummy/real cert
# under the certbot_conf volume before proceeding.
#
# Prerequisites:
#   - DOMAIN_NAME and CERTBOT_EMAIL set in the root .env (see .env.example
#     additions documented in README.md).
#   - The domain's DNS A/AAAA record already points at this host's public
#     IP, and ports 80 and 443 are reachable from the internet on it --
#     Let's Encrypt validates the HTTP-01 challenge over the real internet,
#     not just inside this Docker network.
#
# Every docker-compose invocation below passes DOMAIN_NAME/CERTBOT_EMAIL/
# STAGING_ARG in via `-e` (container environment) rather than interpolating
# them into a quoted shell string -- deliberately, to sidestep nested-quote
# escaping bugs entirely rather than getting them right by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DOMAIN_NAME:?Set DOMAIN_NAME in .env first (the domain this cert is for, e.g. qa-portal.example.com)}"
# Note: this :? message deliberately avoids apostrophes/contractions --
# bash parses the ${VAR:?message} text for its own quoting even inside an
# outer double-quoted string, so an unescaped apostrophe here (e.g.
# "Let's") breaks the script with a confusing "unexpected EOF" error.
: "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL in .env first (Let us Encrypt uses this for expiry and security notices, not shown to users)}"

STAGING="${CERTBOT_STAGING:-0}"
STAGING_ARG=""
if [ "$STAGING" != "0" ]; then
  STAGING_ARG="--staging"
  echo "(staging mode -- issues a cert your browser won't trust, but doesn't count against Let's Encrypt's real rate limits. Use this first while testing.)"
fi

echo "== Removing any existing cert for $DOMAIN_NAME (safe to no-op on a fresh volume) =="
docker compose run --rm -e DOMAIN_NAME="$DOMAIN_NAME" --entrypoint sh certbot -c \
  'rm -rf "/etc/letsencrypt/live/$DOMAIN_NAME" "/etc/letsencrypt/archive/$DOMAIN_NAME" "/etc/letsencrypt/renewal/$DOMAIN_NAME.conf"'

echo "== Creating a temporary dummy certificate so nginx can start =="
docker compose run --rm -e DOMAIN_NAME="$DOMAIN_NAME" --entrypoint sh certbot -c \
  'mkdir -p "/etc/letsencrypt/live/$DOMAIN_NAME" && \
   openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
     -keyout "/etc/letsencrypt/live/$DOMAIN_NAME/privkey.pem" \
     -out "/etc/letsencrypt/live/$DOMAIN_NAME/fullchain.pem" \
     -subj "/CN=$DOMAIN_NAME"'

echo "== Starting nginx (frontend) with the dummy certificate =="
docker compose up -d frontend

echo "== Deleting the dummy certificate so certbot writes the real one in its place =="
docker compose run --rm -e DOMAIN_NAME="$DOMAIN_NAME" --entrypoint sh certbot -c \
  'rm -rf "/etc/letsencrypt/live/$DOMAIN_NAME" "/etc/letsencrypt/archive/$DOMAIN_NAME" "/etc/letsencrypt/renewal/$DOMAIN_NAME.conf"'

echo "== Requesting the real certificate from Let's Encrypt (staging=$STAGING) =="
docker compose run --rm \
  -e DOMAIN_NAME="$DOMAIN_NAME" -e CERTBOT_EMAIL="$CERTBOT_EMAIL" -e STAGING_ARG="$STAGING_ARG" \
  --entrypoint sh certbot -c \
  'certbot certonly --webroot -w /var/www/certbot $STAGING_ARG \
     --email "$CERTBOT_EMAIL" --agree-tos --no-eff-email -d "$DOMAIN_NAME"'

echo "== Reloading nginx to pick up the real certificate =="
docker compose exec frontend nginx -s reload

echo "== Done. $DOMAIN_NAME should now be serving HTTPS on port 443. =="
echo "   Bring up the rest of the stack with: docker compose up -d"
echo "   The certbot service (already defined in docker-compose.yml) renews this certificate automatically every ~12h check / ~60 day cycle."
echo "   IMPORTANT: nginx does not pick up a renewed certificate on its own -- see README.md's"
echo "   'Enable HTTPS' section for the recommended cron entry to reload it periodically."
