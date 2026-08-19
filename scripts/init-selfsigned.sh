#!/usr/bin/env bash
# Self-signed HTTPS setup for a private/internal-network deployment with NO
# public domain -- an IP address only, or reachable solely inside a
# VPN/office LAN. See README.md's "Enable HTTPS" section.
#
# Why this script exists as a SEPARATE thing from scripts/init-letsencrypt.sh:
# Let's Encrypt only ever validates domain ownership over the real public
# internet. A server that's only reachable on a private network, or only
# has a bare IP and no domain, can never obtain a certificate from it --
# not a configuration problem to work around, a hard constraint of how
# public CAs work. The only real option for a private/internal deployment
# is a certificate nobody but you vouches for.
#
# What this generates: a small private Certificate Authority (once, on
# first run) plus a "leaf" certificate for DOMAIN_NAME (your IP address or
# internal hostname), signed by that CA -- deliberately NOT a single bare
# self-signed certificate. The difference matters: with a CA-signed
# approach, you install/trust the CA certificate ONCE on each device that
# needs to reach this server, and every certificate that CA ever signs
# (this one, and any future rotation) is then trusted automatically with no
# more per-certificate browser warnings. A bare self-signed cert would need
# every single visiting device to individually click through (or bypass) a
# warning, and re-approve it again on every rotation.
#
# Writes into the exact same /etc/letsencrypt/live/$DOMAIN_NAME/ path
# frontend/nginx.conf.template already expects (fullchain.pem/privkey.pem)
# -- so nginx's config never needs to know or care which of the two
# bootstrap scripts (this one or init-letsencrypt.sh) was actually run.
#
# Safe to re-run: reuses the existing local CA if one is already there
# (so previously-trusted devices stay trusted), only regenerates the leaf
# certificate for DOMAIN_NAME.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DOMAIN_NAME:?Set DOMAIN_NAME in .env first -- for this private-network path, this is the IP address or internal hostname you and your team will actually type into a browser to reach this server, e.g. 192.168.1.50}"

# Self-signed/private-CA certificates aren't subject to the shorter
# validity windows public CA root programs (Apple/Google/Mozilla) enforce
# on PUBLICLY trusted certificates -- those only apply once something is
# cross-signed by a root already in an OS/browser trust store out of the
# box. Since you're manually trusting this CA yourself, a long validity is
# fine and means far less manual upkeep for an internal tool. Override with
# SELFSIGNED_DAYS in .env if you want something shorter.
DAYS="${SELFSIGNED_DAYS:-3650}"

# A modern browser/OS validates a certificate's Subject Alternative Name
# against exactly how the address was typed in the URL bar -- the legacy
# CN field alone is not enough on its own anymore. IP:x.x.x.x if
# DOMAIN_NAME looks like a dotted-quad, DNS:name otherwise (an internal
# hostname resolved via your own DNS/hosts file).
if [[ "$DOMAIN_NAME" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  SAN="IP:$DOMAIN_NAME"
else
  SAN="DNS:$DOMAIN_NAME"
fi

echo "== Generating local CA (first run only) and a certificate for $DOMAIN_NAME ($SAN), valid $DAYS days =="
docker compose run --rm -e DOMAIN_NAME="$DOMAIN_NAME" -e SAN="$SAN" -e DAYS="$DAYS" --entrypoint sh certbot -c '
  set -e
  mkdir -p /etc/letsencrypt/local-ca "/etc/letsencrypt/live/$DOMAIN_NAME"
  if [ ! -f /etc/letsencrypt/local-ca/ca.key ]; then
    echo "-- no existing local CA found -- creating one now (this is the ONE thing to install/trust on client devices) --"
    openssl req -x509 -new -nodes -newkey rsa:4096 -days "$DAYS" \
      -keyout /etc/letsencrypt/local-ca/ca.key \
      -out /etc/letsencrypt/local-ca/ca.crt \
      -subj "/CN=QA Portal Local CA"
  else
    echo "-- reusing existing local CA (devices that already trust it stay trusted) --"
  fi
  openssl req -new -nodes -newkey rsa:2048 \
    -keyout "/etc/letsencrypt/live/$DOMAIN_NAME/privkey.pem" \
    -out /tmp/leaf.csr \
    -subj "/CN=$DOMAIN_NAME"
  printf "subjectAltName=%s\n" "$SAN" > /tmp/leaf.ext
  openssl x509 -req -in /tmp/leaf.csr -days "$DAYS" \
    -CA /etc/letsencrypt/local-ca/ca.crt -CAkey /etc/letsencrypt/local-ca/ca.key -CAcreateserial \
    -extfile /tmp/leaf.ext \
    -out "/etc/letsencrypt/live/$DOMAIN_NAME/leaf.pem"
  cat "/etc/letsencrypt/live/$DOMAIN_NAME/leaf.pem" /etc/letsencrypt/local-ca/ca.crt \
    > "/etc/letsencrypt/live/$DOMAIN_NAME/fullchain.pem"
  rm -f /tmp/leaf.csr /tmp/leaf.ext
'

mkdir -p certs
echo "== Extracting the CA certificate to ./certs/qa-portal-local-ca.crt =="
docker compose run --rm --entrypoint sh certbot -c 'cat /etc/letsencrypt/local-ca/ca.crt' > certs/qa-portal-local-ca.crt

echo "== Starting/reloading nginx =="
docker compose up -d frontend
docker compose exec frontend nginx -s reload 2>/dev/null || true

echo "== Done. https://$DOMAIN_NAME is now serving a certificate signed by your local CA. =="
echo "   It will show a browser trust warning on any device that has not installed"
echo "   ./certs/qa-portal-local-ca.crt yet -- see README.md's \"Enable HTTPS\" section"
echo "   for per-OS/browser install steps, then distribute that one file to your team."
