#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAN_IP="${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
SAN="subjectAltName=DNS:localhost,IP:127.0.0.1"
if [[ -n "${LAN_IP:-}" && "$LAN_IP" != "127.0.0.1" ]]; then
  SAN="$SAN,IP:$LAN_IP"
fi
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$SCRIPT_DIR/localhost-key.pem" \
  -out "$SCRIPT_DIR/localhost-cert.pem" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "$SAN"
echo "Generated:"
echo "  $SCRIPT_DIR/localhost-key.pem"
echo "  $SCRIPT_DIR/localhost-cert.pem"
echo "  SAN: $SAN"
