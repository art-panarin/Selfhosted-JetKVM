#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# ── Check prerequisites ──────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || error "Docker is not installed"
command -v openssl >/dev/null 2>&1 || error "openssl is not installed"

# ── Collect input ─────────────────────────────────────────────────────────────
echo ""
echo "=== JetKVM Cloud — Production Setup ==="
echo ""

read -rp "Domain name (e.g. kvm.example.com): " DOMAIN
[ -z "$DOMAIN" ] && error "Domain is required"

read -rp "Server public IP: " PUBLIC_IP
[ -z "$PUBLIC_IP" ] && error "Public IP is required"

read -rp "Admin email (for Let's Encrypt, optional): " ADMIN_EMAIL

# ── Generate secrets ──────────────────────────────────────────────────────────
info "Generating secrets..."
DB_PASSWORD=$(openssl rand -hex 16)
COOKIE_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
TURN_SECRET=$(openssl rand -hex 32)

# ── Write .env.prod ───────────────────────────────────────────────────────────
info "Creating .env.prod..."
cat > .env.prod << EOF
DOMAIN=${DOMAIN}
NODE_ENV=production
PORT=3000
API_HOSTNAME=https://${DOMAIN}
APP_HOSTNAME=https://${DOMAIN}
DB_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgresql://jetkvm:${DB_PASSWORD}@db:5432/jetkvm?schema=public
COOKIE_SECRET=${COOKIE_SECRET}
JWT_SECRET=${JWT_SECRET}
TURN_SECRET=${TURN_SECRET}
TURN_HOST=${PUBLIC_IP}
TURN_PORT=3478
ICE_SERVERS=stun:stun.l.google.com:19302
CORS_ORIGINS=https://${DOMAIN}
REAL_IP_HEADER=X-Forwarded-For
ALLOWED_IDENTITIES=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_CDN_URL=
EOF

# ── Write Caddyfile ───────────────────────────────────────────────────────────
info "Creating Caddyfile..."
cat > Caddyfile << EOF
${DOMAIN} {
	reverse_proxy app:3000
}
EOF

if [ -n "$ADMIN_EMAIL" ]; then
    sed -i.bak "1i\\
{\\
    email ${ADMIN_EMAIL}\\
}\\
" Caddyfile && rm -f Caddyfile.bak
fi

# ── Write coturn config ───────────────────────────────────────────────────────
info "Creating coturn/turnserver.prod.conf..."
mkdir -p coturn
cat > coturn/turnserver.prod.conf << EOF
listening-port=3478
tls-listening-port=5349
external-ip=${PUBLIC_IP}
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${DOMAIN}
simple-log
min-port=49152
max-port=65535
no-multicast-peers
no-cli
EOF

# ── Build and start ───────────────────────────────────────────────────────────
if docker image inspect jetkvm-cloud:latest >/dev/null 2>&1; then
    info "Pre-built image jetkvm-cloud:latest found — skipping build"
else
    info "Building Docker image (this may take a few minutes)..."
    docker compose -f docker-compose.prod.yaml build
fi

info "Starting services..."
docker compose -f docker-compose.prod.yaml up -d

echo ""
info "Waiting for services to start..."
sleep 5

# ── Verify ────────────────────────────────────────────────────────────────────
if curl -sf "http://localhost:3000/healthz" > /dev/null 2>&1; then
    info "API is healthy"
else
    warn "API health check failed (may still be starting)"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Domain:    https://${DOMAIN}"
echo "  TURN:      ${PUBLIC_IP}:3478"
echo ""
echo "  Required firewall ports:"
echo "    TCP 80, 443     — HTTP/HTTPS (Caddy)"
echo "    TCP+UDP 3478    — TURN signaling"
echo "    UDP 49152-65535 — TURN media relay"
echo ""
echo "  Next steps:"
echo "    1. Ensure DNS A record: ${DOMAIN} -> ${PUBLIC_IP}"
echo "    2. Open the firewall ports listed above"
echo "    3. Open https://${DOMAIN}/signup to create your account"
echo "    4. Point your JetKVM device to https://${DOMAIN}"
echo ""
