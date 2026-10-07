#!/bin/bash
# Prepares the SM branch server as the THIRD box of the replicated set (2026-10-07), joined to the
# cloud as a hub:   Office <-> Cloud (droplet) <-> SM.   Office and SM never replicate directly;
# each other's changes travel through the cloud (log_replica_updates, GTIDs stop any loop).
#
# Run as root on the SM machine (Ubuntu 26.04):
#   sudo bash setup-sm-server.sh
#
# BEFORE running it, /home/gsuite/.sm-setup.env must exist (root-readable, put there from the
# cloud -- it never needs to be typed or shown) holding:
#   CLOUD_DB_PW=   the cloud's gsuite DB password      (to take the seed dump)
#   REPL_PW=       the repl password the cloud/office pair use (SM connects to the cloud with it,
#                  and the cloud connects to SM with it)
#   JWT_SECRET=    the cloud's JWT secret (/root/.jwt_shared) -- sessions must carry between boxes
#
# Same MySQL install as setup-office-server.sh (expired-key workaround, 9.7 LTS) with: server-id 3,
# auto_increment_offset 3, Tailscale forced through its relay (the head-office network throttles
# Tailscale's direct UDP path -- REPLICATION-RECOVERY.md), the seed loaded from the cloud, SM
# following the cloud, and the T1S app installed against SM's own MySQL.
#
# AFTER this, on the cloud: the 'from_sm' channel (see the end of the output). And BEFORE staff use
# the app on SM: app_settings.doc_no_slots must be 3 (lib/docNumber.js) -- with 2, SM's offset 3
# lands on the cloud's odd numbers.
set -uo pipefail
trap 'echo ""; echo "FAILED at line $LINENO. Nothing further was run."; exit 1' ERR

CLOUD_TS="100.111.65.92"         # the cloud over Tailscale
MYSQL_SERIES="mysql-9.7-lts"
SECRETS=/home/gsuite/.sm-setup.env
APP_DIR=/opt/gsuite

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ -s "$SECRETS" ] || { echo "Missing $SECRETS -- ask for it to be placed first."; exit 1; }
set -a; . "$SECRETS"; set +a
: "${CLOUD_DB_PW:?}" "${REPL_PW:?}" "${JWT_SECRET:?}"

echo "== 1/10  Tailscale through its relay"
command -v tailscale > /dev/null || { echo "Tailscale is not installed."; exit 1; }
grep -q '^TS_DEBUG_ALWAYS_USE_DERP=true' /etc/default/tailscaled 2>/dev/null \
  || echo 'TS_DEBUG_ALWAYS_USE_DERP=true' >> /etc/default/tailscaled
systemctl restart tailscaled
for i in $(seq 1 20); do tailscale status > /dev/null 2>&1 && break; sleep 2; done
# The relay takes a little while to come up after the restart: keep trying for a minute.
REACHED=no
for i in $(seq 1 20); do ping -c 1 -W 3 "$CLOUD_TS" > /dev/null 2>&1 && { REACHED=yes; break; }; sleep 3; done
[ "$REACHED" = yes ] || { echo "Cannot reach the cloud at $CLOUD_TS over Tailscale (tried for a minute)."; exit 1; }
echo "   cloud reachable: $(tailscale status | grep "$CLOUD_TS" | awk '{print $NF, $(NF-1)}')"

echo "== 2/10  system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq gnupg dirmngr curl ufw git openssl > /dev/null

echo "== 3/10  MySQL signing key"
install -d -m 0755 /etc/apt/keyrings
KEY_URL="https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0xB7B3B788A8D3785C"
if curl -fsSL "$KEY_URL" -o /tmp/mysql-key.asc && [ -s /tmp/mysql-key.asc ]; then
  gpg --dearmor < /tmp/mysql-key.asc > /etc/apt/keyrings/mysql-ks.gpg
else
  gpg --no-default-keyring --keyring /tmp/mysql-ks.gpg --keyserver keyserver.ubuntu.com --recv-keys B7B3B788A8D3785C
  gpg --no-default-keyring --keyring /tmp/mysql-ks.gpg --export > /etc/apt/keyrings/mysql-ks.gpg
fi
[ -s /etc/apt/keyrings/mysql-ks.gpg ] || { echo "ERROR: could not obtain the MySQL signing key"; exit 1; }

echo "== 4/10  MySQL 9.7 LTS"
. /etc/os-release
cat > /etc/apt/sources.list.d/mysql.list <<EOF
deb [signed-by=/etc/apt/keyrings/mysql-ks.gpg] http://repo.mysql.com/apt/ubuntu/ ${VERSION_CODENAME} ${MYSQL_SERIES}
deb [signed-by=/etc/apt/keyrings/mysql-ks.gpg] http://repo.mysql.com/apt/ubuntu/ ${VERSION_CODENAME} mysql-tools
EOF
apt-get update -qq
if ! command -v mysqld > /dev/null; then
  ROOT_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
  echo "$ROOT_PW" > /root/.mysql_root_pw; chmod 600 /root/.mysql_root_pw
  debconf-set-selections <<EOF
mysql-community-server mysql-community-server/root-pass password ${ROOT_PW}
mysql-community-server mysql-community-server/re-root-pass password ${ROOT_PW}
mysql-community-server mysql-server/default-auth-override select Use Strong Password Encryption (RECOMMENDED)
EOF
  apt-get install -y -qq mysql-community-server mysql-community-client > /tmp/mysql-install.log 2>&1
fi
ROOT_PW=$(cat /root/.mysql_root_pw)
export MYSQL_PWD="$ROOT_PW"
systemctl enable --now mysql > /dev/null
echo "   $(mysql --version)"

echo "== 5/10  replication settings"
cat > /etc/mysql/mysql.conf.d/replication.cnf <<'EOF'
[mysqld]
# SM is server 3; the cloud is 1, the office 2. All must differ.
server-id = 3

log-bin = gsuite-bin
binlog_format = ROW
binlog_expire_logs_seconds = 604800
max_binlog_size = 256M
# SM is a replica of the cloud AND a source for it: what is done at SM goes up from here.
log_replica_updates = ON

gtid_mode = ON
enforce_gtid_consistency = ON

# Ids never collide across the three boxes: cloud 1, 11, 21... office 2, 12... SM 3, 13, 23...
auto_increment_increment = 10
auto_increment_offset = 3

replica_parallel_workers = 4

bind-address = 0.0.0.0
innodb_buffer_pool_size = 6G
EOF
systemctl restart mysql
sleep 5
echo "   restarted: $(mysql -uroot -N -e 'SELECT CONCAT(@@server_id, " / offset ", @@auto_increment_offset, " / gtid ", @@gtid_mode)')"

echo "== 6/10  firewall"
ufw allow OpenSSH > /dev/null 2>&1
ufw allow from 100.64.0.0/10 to any port 3306 proto tcp > /dev/null 2>&1   # the cloud, over Tailscale
ufw allow from 192.168.0.0/16 to any port 4000 proto tcp > /dev/null 2>&1  # staff on the LAN -> T1S
ufw allow from 10.0.0.0/8 to any port 4000 proto tcp > /dev/null 2>&1
ufw allow from 172.16.0.0/12 to any port 4000 proto tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
echo "   SSH, MySQL from Tailscale, T1S (4000) from the LAN"

echo "== 7/10  seed from the cloud (a full copy, with its replication position)"
# The dump is taken ON THE CLOUD as root and copied here as /home/gsuite/sm-seed.sql.gz: a consistent
# dump with its GTID position needs FLUSH TABLES (RELOAD), which the cloud's gsuite account does not
# hold. Without the file, fall back to dumping over Tailscale as gsuite.
SEED_GZ=/home/gsuite/sm-seed.sql.gz
if [ -s "$SEED_GZ" ]; then
  zcat "$SEED_GZ" | tail -1 | grep -q 'Dump completed' || { echo "ERROR: $SEED_GZ is incomplete -- not loading it."; exit 1; }
  echo "   using the dump taken on the cloud ($(du -h "$SEED_GZ" | cut -f1) compressed)"
  mysql -uroot -e "STOP REPLICA; DROP DATABASE IF EXISTS gsuite_erp; CREATE DATABASE gsuite_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; RESET BINARY LOGS AND GTIDS;"
  zcat "$SEED_GZ" | mysql -uroot gsuite_erp
else
  MYSQL_PWD="$CLOUD_DB_PW" mysqldump --host="$CLOUD_TS" --user=gsuite --compression-algorithms=zlib \
    --single-transaction --set-gtid-purged=ON --no-tablespaces --routines --events --triggers \
    --hex-blob --quick gsuite_erp --result-file=/root/seed.sql
  tail -1 /root/seed.sql | grep -q 'Dump completed' || { echo "ERROR: the dump did not complete -- not loading it."; exit 1; }
  echo "   dump complete ($(du -h /root/seed.sql | cut -f1))"
  mysql -uroot -e "STOP REPLICA; DROP DATABASE IF EXISTS gsuite_erp; CREATE DATABASE gsuite_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; RESET BINARY LOGS AND GTIDS;"
  mysql -uroot gsuite_erp < /root/seed.sql
fi
echo "   loaded: $(mysql -uroot -N -e 'SELECT COUNT(*) FROM gsuite_erp.sales_invoices') invoices"

echo "== 8/10  accounts (kept out of the binlog, so they never replicate to the cloud)"
APP_DB_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
mysql -uroot <<SQL
SET sql_log_bin = 0;
CREATE USER IF NOT EXISTS 'repl'@'100.%' IDENTIFIED BY '${REPL_PW}';
ALTER USER 'repl'@'100.%' IDENTIFIED BY '${REPL_PW}';
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'repl'@'100.%';
CREATE USER IF NOT EXISTS 'gsuite'@'localhost' IDENTIFIED BY '${APP_DB_PW}';
CREATE USER IF NOT EXISTS 'gsuite'@'127.0.0.1' IDENTIFIED BY '${APP_DB_PW}';
ALTER USER 'gsuite'@'localhost' IDENTIFIED BY '${APP_DB_PW}';
ALTER USER 'gsuite'@'127.0.0.1' IDENTIFIED BY '${APP_DB_PW}';
GRANT ALL PRIVILEGES ON gsuite_erp.* TO 'gsuite'@'localhost';
GRANT ALL PRIVILEGES ON gsuite_erp.* TO 'gsuite'@'127.0.0.1';
SQL
echo "   repl (for the cloud) and gsuite (for the app) ready"

echo "== 9/10  follow the cloud"
mysql -uroot -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='${CLOUD_TS}', SOURCE_USER='repl', SOURCE_PASSWORD='${REPL_PW}', SOURCE_AUTO_POSITION=1, SOURCE_SSL=1; START REPLICA;"
for i in $(seq 1 30); do
  IO=$(mysql -uroot -E -e 'SHOW REPLICA STATUS' | awk '/Replica_IO_Running:/{print $2}')
  SQLR=$(mysql -uroot -E -e 'SHOW REPLICA STATUS' | awk '/Replica_SQL_Running:/{print $2}')
  [ "$IO" = "Yes" ] && [ "$SQLR" = "Yes" ] && break; sleep 2
done
mysql -uroot -E -e 'SHOW REPLICA STATUS' | grep -E 'Replica_(IO|SQL)_Running:|Seconds_Behind|Last_(IO|SQL)_Error:'

echo "== 10/10  the T1S app"
if [ ! -d "$APP_DIR/.git" ]; then git clone -q https://github.com/Josephus06/gsuite.git "$APP_DIR"; fi
cat > "$APP_DIR/server/.env" <<ENVEOF
PORT=4000
# 127.0.0.1: the app talks to the MySQL beside it, so the branch keeps working offline.
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=gsuite
DB_PASSWORD=${APP_DB_PW}
DB_NAME=gsuite_erp
# The SAME secret as the cloud and office, so a session carries between boxes.
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=12h
ENVEOF
chmod 600 "$APP_DIR/server/.env"
# The office deploy script installs Node, dependencies, the client build and the service; it keeps
# the .env written above.
bash "$APP_DIR/server/src/db/deploy-office-app.sh"

shred -u "$SECRETS" 2>/dev/null || rm -f "$SECRETS"
rm -f /root/seed.sql "$SEED_GZ"

cat <<EOF

SM is set up: MySQL 9.7 as server 3 (offset 3), following the cloud; T1S on port 4000.
MySQL root password: /root/.mysql_root_pw     The setup secrets file has been removed.

STILL TO DO (by the person setting up replication):
  1. On the cloud, the channel that brings SM's work up:
       CHANGE REPLICATION SOURCE TO SOURCE_HOST='$(tailscale ip -4 | head -1)', SOURCE_USER='repl',
         SOURCE_PASSWORD='<repl password>', SOURCE_AUTO_POSITION=1, SOURCE_SSL=1 FOR CHANNEL 'from_sm';
       START REPLICA FOR CHANNEL 'from_sm';
  2. app_settings.doc_no_slots = 3 on the cloud (after the office runs the new code), BEFORE staff
     create anything on SM.
EOF
