#!/bin/bash
# Deploys the ERP application onto the office server, pointed at the office's own MySQL.
#
# Run as root on the office machine (Ubuntu):
#   curl -fsSLO https://raw.githubusercontent.com/Josephus06/gsuite/main/server/src/db/deploy-office-app.sh
#   sudo bash deploy-office-app.sh
#
# WHY THIS EXISTS. The cloud runs the same application against the cloud database. This runs it
# against the office database. Both hold the same data, kept in step by replication, so staff can
# use either -- and when the internet goes, the office copy keeps working with no failover step
# beyond opening a different address.
#
# The database is reached at 127.0.0.1: this app talks to the server it is installed beside, never
# across the internet. If it pointed at the cloud it would stop working during exactly the outage
# it exists to survive.
set -uo pipefail
trap 'echo ""; echo "FAILED at line $LINENO."; exit 1' ERR

APP_DIR=/opt/gsuite
DB_NAME=gsuite_erp
DB_USER=gsuite
PORT=4000

echo "== 1/6  Node.js and git"
export DEBIAN_FRONTEND=noninteractive
if ! command -v node > /dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ] 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/node.sh
  bash /tmp/node.sh > /tmp/node-setup.log 2>&1
  apt-get install -y -qq nodejs > /tmp/node-install.log 2>&1
fi
apt-get install -y -qq git > /dev/null 2>&1
echo "   node $(node -v), npm $(npm -v)"

echo "== 2/6  application source"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin && git -C "$APP_DIR" reset -q --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone -q https://github.com/Josephus06/gsuite.git "$APP_DIR"
fi
echo "   at commit $(git -C "$APP_DIR" rev-parse --short HEAD)"

echo "== 3/6  dependencies"
npm install --prefix "$APP_DIR/server" --omit=dev --silent > /tmp/npm-server.log 2>&1
npm install --prefix "$APP_DIR/client" --silent > /tmp/npm-client.log 2>&1
echo "   installed"

echo "== 4/6  configuration"
# The application's database password. It must match the gsuite account on THIS server; the
# password is prompted for rather than guessed, because it is not derivable from anything here.
if [ -f "$APP_DIR/server/.env" ] && grep -q DB_PASSWORD "$APP_DIR/server/.env"; then
  echo "   server/.env already present, left alone"
else
  read -rsp "   MySQL password for ${DB_USER}@localhost: " DBPW; echo
  # THE JWT SECRET MUST MATCH THE CLOUD'S.
  #
  # One hostname resolves to both servers, so a browser can be served by the cloud for one request
  # and the office for the next. A session is a signed token; if the two servers sign with
  # different secrets, each rejects the other's tokens and users are logged out at random -- which
  # looks like a flaky application rather than a configuration mismatch.
  #
  # Retrieve it from the cloud with:
  #   ssh root@146.190.103.165 cat /root/.jwt_shared
  read -rp "   JWT secret from the cloud (blank to generate a NEW one, which breaks shared sessions): " JWT
  if [ -z "$JWT" ]; then
    JWT=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
    echo "   !! generated a fresh secret -- sessions will NOT carry between the two servers"
  fi
  cat > "$APP_DIR/server/.env" <<ENVEOF
PORT=${PORT}
# 127.0.0.1, never the cloud: this instance exists to work when the internet does not.
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DBPW}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT}
JWT_EXPIRES_IN=12h
ENVEOF
  chmod 600 "$APP_DIR/server/.env"
  echo "   server/.env written"
fi

echo "== 5/6  building the client"
npm run build --prefix "$APP_DIR/client" > /tmp/build.log 2>&1
echo "   built ($(du -sh "$APP_DIR/client/dist" | cut -f1))"

echo "== 6/6  service"
cat > /etc/systemd/system/gsuite.service <<'UNITEOF'
[Unit]
Description=GSUITE ERP API (office)
StartLimitBurst=5
StartLimitIntervalSec=60
# The database is on this machine; starting before it is ready only produces a burst of
# connection errors before things settle.
After=network-online.target mysql.service
Wants=network-online.target
Requires=mysql.service

[Service]
Type=simple
WorkingDirectory=/opt/gsuite/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gsuite-api

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable --now gsuite > /dev/null 2>&1
sleep 5
systemctl restart gsuite
sleep 5

echo
echo "service : $(systemctl is-active gsuite)"
echo "health  : $(curl -s --max-time 10 http://127.0.0.1:${PORT}/api/health || echo 'no response')"
echo "LAN URL : http://$(hostname -I | awk '{print $1}'):${PORT}"
echo
echo "If the service is not active:  journalctl -u gsuite -n 40 --no-pager"
