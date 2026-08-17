#!/bin/bash
# Prepares the office server as the second half of the office/cloud replication pair.
#
# Run as root on the office machine (Ubuntu):
#   sudo bash setup-office-server.sh
#
# This is the same sequence that was run against the cloud droplet, with two values changed --
# server-id and auto_increment_offset. Everything else is deliberately identical, because a pair
# that differs in binlog format or GTID settings fails in ways that are tedious to diagnose.
#
# TWO THINGS THIS WORKS AROUND, both found the hard way on the cloud box:
#
#   1. Oracle ships an EXPIRED signing key in their own mysql-apt-config package. Installing it
#      leaves apt refusing the repository outright ("EXPKEYSIG ... not signed"). A current key is
#      fetched from a keyserver instead.
#
#   2. There is no MySQL 9.4 in the repository. The 9.x line is 9.7 LTS. That matters: replication
#      flows from older to newer only, so a 9.7 cloud cannot feed a 9.4 office, and office -> cloud
#      is precisely the channel that carries offline work back up. Both sides run 9.7.
set -uo pipefail
trap 'echo ""; echo "FAILED at line $LINENO. Nothing further was run."; exit 1' ERR

CLOUD_IP="146.190.103.165"
MYSQL_SERIES="mysql-9.7-lts"

echo "== 1/6  system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq gnupg dirmngr curl ufw > /dev/null

echo "== 2/6  MySQL signing key"
install -d -m 0755 /etc/apt/keyrings
# B7B3B788A8D3785C is MySQL's release key. The copy Oracle bundles has expired; a keyserver holds
# the same key with its expiry extended.
#
# Fetched over HTTPS rather than with --recv-keys. The keyserver protocol runs on port 11371,
# which office firewalls routinely block outbound -- and under `set -e` that failure aborts the
# whole script before anything is installed, which is exactly what happened on the first run.
# Port 443 is open anywhere this machine can reach GitHub.
KEY_URL="https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0xB7B3B788A8D3785C"
if curl -fsSL "$KEY_URL" -o /tmp/mysql-key.asc && [ -s /tmp/mysql-key.asc ]; then
  gpg --dearmor < /tmp/mysql-key.asc > /etc/apt/keyrings/mysql-ks.gpg
  echo "   key imported over HTTPS"
else
  # Fall back to the keyserver protocol in case HTTPS is the thing that is blocked.
  echo "   HTTPS fetch failed, trying the keyserver protocol..."
  gpg --no-default-keyring --keyring /tmp/mysql-ks.gpg \
      --keyserver keyserver.ubuntu.com --recv-keys B7B3B788A8D3785C
  gpg --no-default-keyring --keyring /tmp/mysql-ks.gpg --export > /etc/apt/keyrings/mysql-ks.gpg
  echo "   key imported from keyserver"
fi
# Refuse to continue with an empty keyring -- apt would then reject the repository with an error
# that reads like a network fault.
[ -s /etc/apt/keyrings/mysql-ks.gpg ] || { echo "ERROR: could not obtain the MySQL signing key"; exit 1; }

echo "== 3/6  MySQL 9.7 LTS"
. /etc/os-release
cat > /etc/apt/sources.list.d/mysql.list <<EOF
deb [signed-by=/etc/apt/keyrings/mysql-ks.gpg] http://repo.mysql.com/apt/ubuntu/ ${VERSION_CODENAME} ${MYSQL_SERIES}
deb [signed-by=/etc/apt/keyrings/mysql-ks.gpg] http://repo.mysql.com/apt/ubuntu/ ${VERSION_CODENAME} mysql-tools
EOF
apt-get update -qq

ROOT_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
echo "$ROOT_PW" > /root/.mysql_root_pw
chmod 600 /root/.mysql_root_pw
debconf-set-selections <<EOF
mysql-community-server mysql-community-server/root-pass password ${ROOT_PW}
mysql-community-server mysql-community-server/re-root-pass password ${ROOT_PW}
mysql-community-server mysql-server/default-auth-override select Use Strong Password Encryption (RECOMMENDED)
EOF
apt-get install -y -qq mysql-community-server > /tmp/mysql-install.log 2>&1
systemctl enable --now mysql > /dev/null
echo "   $(mysql --version)"

echo "== 4/6  replication settings"
# Identical to the cloud's file except server-id and auto_increment_offset.
cat > /etc/mysql/mysql.conf.d/replication.cnf <<'EOF'
[mysqld]
# Office is server 2; the cloud is 1. They must differ, or neither accepts the
# other's changes.
server-id = 2

# Needed in BOTH directions. The office is a replica in normal running, but it is
# also a source -- that is what carries work done during an outage back up.
log-bin = gsuite-bin
binlog_format = ROW
binlog_expire_logs_seconds = 604800
max_binlog_size = 256M

# GTIDs make catch-up exact: each side knows which transactions the other has
# already applied, so reconnecting after hours offline needs no manual work.
gtid_mode = ON
enforce_gtid_consistency = ON

# The application derives document numbers from primary keys, so two sides
# minting the same ids while apart would produce two different cheques sharing a
# number -- and a sync that cannot tell them apart. Office takes 2, 12, 22...
auto_increment_increment = 10
auto_increment_offset = 2

bind-address = 0.0.0.0
innodb_buffer_pool_size = 2G
EOF
systemctl restart mysql
sleep 4
echo "   restarted"

echo "== 5/6  firewall"
ufw allow OpenSSH > /dev/null 2>&1
# Staff on the LAN reach MySQL and the application; adjust the range if your
# office network is not 192.168.0.0/16.
ufw allow from 192.168.0.0/16 to any port 3306 proto tcp > /dev/null 2>&1
ufw allow from 10.0.0.0/8 to any port 3306 proto tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
echo "   enabled (SSH + MySQL from the LAN)"

echo "== 6/6  verification"
mysql -uroot -p"$ROOT_PW" -N -B 2>/dev/null <<'SQL'
SELECT CONCAT(VARIABLE_NAME, ' = ', VARIABLE_VALUE)
  FROM performance_schema.global_variables
 WHERE VARIABLE_NAME IN ('server_id','log_bin','binlog_format','gtid_mode',
       'enforce_gtid_consistency','auto_increment_increment','auto_increment_offset')
 ORDER BY VARIABLE_NAME;
SQL

cat <<EOF

Done. Expect: server_id 2, log_bin ON, binlog_format ROW, both GTID settings ON,
increment 10, offset 2.

MySQL root password is in /root/.mysql_root_pw

NEXT, from this machine:
  1. Seed it from the cloud, which also gives it a replication starting point:
       mysqldump --host=${CLOUD_IP} --user=repl -p --single-transaction \\
                 --set-gtid-purged=ON --routines --events --triggers \\
                 gsuite_erp > /root/seed.sql
       mysql -uroot -p -e "CREATE DATABASE gsuite_erp"
       mysql -uroot -p gsuite_erp < /root/seed.sql

  2. Then point it at the cloud and start following:
       CHANGE REPLICATION SOURCE TO
         SOURCE_HOST='${CLOUD_IP}', SOURCE_USER='repl',
         SOURCE_PASSWORD='<from /root/.mysql_repl_pw on the cloud>',
         SOURCE_AUTO_POSITION=1;
       START REPLICA;
       SHOW REPLICA STATUS\\G

  Both Replica_IO_Running and Replica_SQL_Running must read Yes.
EOF
