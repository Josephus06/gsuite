#!/bin/bash
# Copies the Railway database onto the cloud server and the office server, so all three hold
# the same tables and the same rows.
#
# Run as root ON THE CLOUD SERVER (it has the fast link to Railway and the tailnet route to
# the office):
#   curl -fsSLO https://raw.githubusercontent.com/Josephus06/gsuite/main/server/src/db/copy-railway-to-servers.sh
#   sudo bash copy-railway-to-servers.sh
#
# THIS REPLACES THE CLOUD AND OFFICE DATABASES ENTIRELY. Both are backed up first, and the
# script refuses to go on if either backup fails -- a restore you cannot perform is not a
# backup. Nothing is dropped until both backups are on disk.
#
# WHAT THIS IS FOR, AND WHAT IT IS NOT. The application writes to Railway. A copy taken from it
# is a SNAPSHOT: correct at the moment it is taken and drifting from that second onward. This
# script exists to SEED -- to put all three databases on the same footing so that bidirectional
# replication between cloud and office can then keep the pair in step. It is not a substitute
# for replication, and running it nightly to paper over the drift would mean dropping and
# reloading a 460MB database every night to avoid fixing the actual problem.
#
# THE FORK YOU HAVE TO DECIDE. After this runs, either:
#   (a) Railway stays the writer -- cloud and office are read-only copies that will go stale
#       again. Useful for reporting, useless as a failover.
#   (b) The application is pointed at the cloud and Railway stops taking writes. Then the
#       cloud/office pair is the live system and replication keeps it current. That is the
#       hybrid setup this was all built for.
# The script does not choose for you; it gets the data onto both machines either way.
#
# WHY THE DUMP IS TAKEN WITHOUT --databases. Railway's schema lives in a database called
# `railway`; both servers here call it `gsuite_erp`. A dump taken without --databases carries no
# CREATE DATABASE or USE statement, so the same file loads into a database of any name. With
# --databases it would try to create and populate `railway` on both servers and leave
# gsuite_erp untouched -- and the script would report success having changed nothing anyone
# looks at.
set -uo pipefail
trap 'echo ""; echo "FAILED at line $LINENO. Nothing further was changed."; exit 1' ERR

OFFICE_IP="${OFFICE_IP:-100.77.225.53}"     # tailnet address, not the LAN one
DB_NAME="${DB_NAME:-gsuite_erp}"
WORK_DIR="${WORK_DIR:-/root/railway-copy}"
STAMP="$(date -u +%Y%m%d-%H%M)"
DUMP="${WORK_DIR}/railway-${STAMP}.sql.gz"

mkdir -p "$WORK_DIR"

echo "=================================================================="
echo " Copy Railway  ->  cloud ($(hostname))  +  office (${OFFICE_IP})"
echo "=================================================================="
echo

# ---------------------------------------------------------------------------------------
echo "== 1/8  what this needs"
# ---------------------------------------------------------------------------------------
# Asked for rather than stored. Prompted with -s so nothing lands in the shell history or in
# the process list of a machine other people can log into.
#
# The Railway URL is the PUBLIC one (MYSQL_PUBLIC_URL in the service's Variables tab). The
# internal *.railway.internal address only resolves inside Railway's own network.
read -rp "   Railway MYSQL_PUBLIC_URL (mysql://user:pass@host:port/railway): " RAILWAY_URL
read -rsp "   MySQL root password on THIS cloud server: " CLOUD_PW; echo
read -rsp "   MySQL root password on the OFFICE server: " OFFICE_PW; echo

# Pulled apart with a regex rather than by splitting on punctuation: Railway passwords are
# generated and routinely contain :, / and @, which is exactly what naive splitting breaks on.
if [[ ! "$RAILWAY_URL" =~ ^mysql://([^:]+):(.+)@([^:/@]+):([0-9]+)/(.+)$ ]]; then
  echo "   That does not look like a mysql:// URL. Copy it verbatim from Railway > MySQL > Variables."
  exit 1
fi
R_USER="${BASH_REMATCH[1]}"; R_PASS="${BASH_REMATCH[2]}"
R_HOST="${BASH_REMATCH[3]}"; R_PORT="${BASH_REMATCH[4]}"; R_DB="${BASH_REMATCH[5]}"
echo "   Railway : ${R_DB} on ${R_HOST}:${R_PORT}"
echo "   target  : ${DB_NAME} on this server and on ${OFFICE_IP}"

command -v mysqldump > /dev/null || { echo "   mysqldump is not installed here."; exit 1; }

# Every one of these must work before anything is dropped. Discovering the office is
# unreachable AFTER wiping the cloud would leave one good copy and one hole.
echo -n "   reaching Railway...  "
mysql --host="$R_HOST" --port="$R_PORT" --user="$R_USER" --password="$R_PASS" \
      --connect-timeout=20 -e "SELECT 1" "$R_DB" > /dev/null && echo "ok"
echo -n "   reaching the cloud database...  "
mysql -uroot --password="$CLOUD_PW" --connect-timeout=10 -e "SELECT 1" > /dev/null && echo "ok"
echo -n "   reaching the office database over the tailnet...  "
mysql --host="$OFFICE_IP" -uroot --password="$OFFICE_PW" --connect-timeout=25 -e "SELECT 1" > /dev/null && echo "ok"

# What is about to be destroyed, stated in rows rather than in the abstract, because "this will
# replace your database" does not land the way "this will replace 124,109 job orders" does.
CLOUD_JOS=$(mysql -uroot --password="$CLOUD_PW" -N -B -e \
  "SELECT COUNT(*) FROM ${DB_NAME}.job_orders" 2>/dev/null || echo "?")
OFFICE_JOS=$(mysql --host="$OFFICE_IP" -uroot --password="$OFFICE_PW" -N -B -e \
  "SELECT COUNT(*) FROM ${DB_NAME}.job_orders" 2>/dev/null || echo "?")
RAILWAY_JOS=$(mysql --host="$R_HOST" --port="$R_PORT" --user="$R_USER" --password="$R_PASS" -N -B -e \
  "SELECT COUNT(*) FROM job_orders" "$R_DB" 2>/dev/null || echo "?")

echo
echo "   Railway holds ${RAILWAY_JOS} job orders and is the source."
echo "   The cloud copy (${CLOUD_JOS} job orders) will be REPLACED."
echo "   The office copy (${OFFICE_JOS} job orders) will be REPLACED."
echo
read -rp "   Type REPLACE to go ahead: " CONFIRM
[ "$CONFIRM" = "REPLACE" ] || { echo "   Stopped. Nothing was changed."; exit 0; }

# ---------------------------------------------------------------------------------------
echo
echo "== 2/8  backing up what is about to be replaced"
# ---------------------------------------------------------------------------------------
# Before the source dump, not after. If Railway turns out to be unreachable halfway through a
# 460MB transfer, the two things that already existed are still safe on disk.
CLOUD_BAK="${WORK_DIR}/cloud-before-${STAMP}.sql.gz"
OFFICE_BAK="${WORK_DIR}/office-before-${STAMP}.sql.gz"

MYSQL_PWD="$CLOUD_PW" mysqldump -uroot --single-transaction --routines --events --triggers \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 "$DB_NAME" | gzip > "$CLOUD_BAK"
echo "   cloud  -> $(du -h "$CLOUD_BAK" | cut -f1)  $CLOUD_BAK"

MYSQL_PWD="$OFFICE_PW" mysqldump --host="$OFFICE_IP" -uroot --single-transaction --routines --events --triggers \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 "$DB_NAME" | gzip > "$OFFICE_BAK"
echo "   office -> $(du -h "$OFFICE_BAK" | cut -f1)  $OFFICE_BAK"

# A dump that failed halfway still leaves a file, and a truncated file that looks like a backup
# is worse than no backup at all.
for f in "$CLOUD_BAK" "$OFFICE_BAK"; do
  gzip -t "$f" 2>/dev/null || { echo "   $f is not a valid archive. Stopping."; exit 1; }
  zcat "$f" | tail -c 200 | grep -q "Dump completed" \
    || { echo "   $f has no completion marker -- treat it as truncated. Stopping."; exit 1; }
done
echo "   both verified complete."

# ---------------------------------------------------------------------------------------
echo
echo "== 3/8  dumping Railway"
# ---------------------------------------------------------------------------------------
# --set-gtid-purged=OFF because Railway's managed MySQL runs with log_bin=OFF; asking for the
#   replication position makes mysqldump refuse outright rather than skip it.
# --no-tablespaces because the Railway user is not granted PROCESS, which the tablespace query
#   needs; without this the dump dies on the first table.
# --single-transaction so the snapshot is consistent without locking the live application out
#   while 460MB is read.
MYSQL_PWD="$R_PASS" mysqldump \
  --host="$R_HOST" --port="$R_PORT" --user="$R_USER" \
  --single-transaction --quick \
  --routines --events --triggers \
  --set-gtid-purged=OFF --no-tablespaces \
  --default-character-set=utf8mb4 \
  "$R_DB" | gzip > "$DUMP"

gzip -t "$DUMP" || { echo "   the dump is not a valid archive. Stopping."; exit 1; }
zcat "$DUMP" | tail -c 200 | grep -q "Dump completed" \
  || { echo "   the dump has no completion marker -- it was cut short. Stopping."; exit 1; }
TABLES_IN_DUMP=$(zcat "$DUMP" | grep -c "^CREATE TABLE" || true)
echo "   $(du -h "$DUMP" | cut -f1), ${TABLES_IN_DUMP} tables, complete."

# ---------------------------------------------------------------------------------------
echo
echo "== 4/8  stopping replication between cloud and office"
# ---------------------------------------------------------------------------------------
# The pair replicates both ways. Loading a whole database while that is running would send every
# row of the load across the link as replication traffic, and then collide with the same rows
# arriving from the other side. Both sides are loaded independently instead, and the link is
# rebuilt afterwards from a clean, identical starting point.
for TARGET in cloud office; do
  if [ "$TARGET" = "cloud" ]; then H=""; P="$CLOUD_PW"; else H="--host=$OFFICE_IP"; P="$OFFICE_PW"; fi
  # STOP REPLICA on a server with no channel is an error, not a no-op -- tolerated here because
  # "there was nothing to stop" is a perfectly good outcome.
  mysql $H -uroot --password="$P" -e "STOP REPLICA;" 2>/dev/null || true
  mysql $H -uroot --password="$P" -e "RESET REPLICA ALL;" 2>/dev/null || true
  echo "   ${TARGET}: replication stopped and cleared"
done

# ---------------------------------------------------------------------------------------
echo
echo "== 5/8  loading the cloud"
# ---------------------------------------------------------------------------------------
# sql_log_bin=0 keeps the load out of the binary log. Without it the load writes a binlog the
# size of the database, which the office would then try to apply on top of the copy it is
# loading itself -- the same rows arriving twice by two routes.
#
# FOREIGN_KEY_CHECKS=0 because mysqldump writes tables in alphabetical order, not dependency
# order, so a child table is routinely restored before its parent.
load() {
  local H="$1" LABEL="$3"
  # Through the environment, not argv: the load is the longest-running command here, and an
  # argument would sit in the process list for the whole of it.
  export MYSQL_PWD="$2"
  mysql $H -uroot -e "DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
  { echo "SET sql_log_bin=0; SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0;";
    zcat "$DUMP";
    echo "SET FOREIGN_KEY_CHECKS=1; SET UNIQUE_CHECKS=1;"; } \
  | mysql $H -uroot "$DB_NAME"
  unset MYSQL_PWD
  echo "   ${LABEL}: loaded"
}
load "" "$CLOUD_PW" "cloud"

# ---------------------------------------------------------------------------------------
echo
echo "== 6/8  loading the office"
# ---------------------------------------------------------------------------------------
# The compressed dump goes over the tailnet and is expanded on the far side. Piping the
# uncompressed SQL straight into a remote mysql would push roughly six times as many bytes
# between Singapore and Cebu, over a link that is the slowest part of this whole operation.
if ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${OFFICE_IP}" true 2>/dev/null; then
  scp -q "$DUMP" "root@${OFFICE_IP}:/root/$(basename "$DUMP")"
  # The password is sent to the remote shell's stdin and read into a variable there, rather than
  # written into the command line. An argument would be visible in the office machine's process
  # list to anyone with a shell on it for as long as the load runs -- which, for 460MB, is a
  # while. MYSQL_PWD is how the local half of this script passes it too.
  printf '%s\n' "$OFFICE_PW" | ssh "root@${OFFICE_IP}" "
    set -e
    read -r OPW
    export MYSQL_PWD=\"\$OPW\"
    mysql -uroot -e \"DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\"
    { echo 'SET sql_log_bin=0; SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0;';
      zcat /root/$(basename "$DUMP");
      echo 'SET FOREIGN_KEY_CHECKS=1; SET UNIQUE_CHECKS=1;'; } | mysql -uroot ${DB_NAME}
    rm -f /root/$(basename "$DUMP")
  "
  echo "   office: loaded (copied over, expanded there)"
else
  # No SSH key between the machines. Slower, but it does not require one, and it is better than
  # stopping here with the cloud already replaced and the office not.
  echo "   no SSH key to the office -- streaming over the tailnet instead, this is slower."
  load "--host=$OFFICE_IP" "$OFFICE_PW" "office"
fi

# ---------------------------------------------------------------------------------------
echo
echo "== 7/8  rebuilding replication"
# ---------------------------------------------------------------------------------------
# Both sides now hold identical data, but each still carries its own record of every transaction
# it has ever executed. Left alone, replication would try to reconcile two unrelated histories
# and stop on the first conflict. Clearing the GTID history on both gives the pair a common
# starting point: from here, "everything before now" is agreed, and only new work is exchanged.
#
# This is also why the load ran with sql_log_bin=0 -- there is nothing in either binary log that
# the other side needs to be told about.
for TARGET in cloud office; do
  if [ "$TARGET" = "cloud" ]; then H=""; P="$CLOUD_PW"; else H="--host=$OFFICE_IP"; P="$OFFICE_PW"; fi
  mysql $H -uroot --password="$P" -e "RESET BINARY LOGS AND GTIDS;" 2>/dev/null \
    || mysql $H -uroot --password="$P" -e "RESET MASTER;"   # pre-8.4 spelling
  echo "   ${TARGET}: transaction history cleared"
done

read -rsp "   replication password for the 'repl' account: " REPL_PW; echo
CLOUD_IP_SELF="${CLOUD_TAILNET_IP:-100.111.65.92}"

mysql -uroot --password="$CLOUD_PW" -e "
  CHANGE REPLICATION SOURCE TO SOURCE_HOST='${OFFICE_IP}', SOURCE_USER='repl',
    SOURCE_PASSWORD='${REPL_PW}', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1
    FOR CHANNEL 'from_office';
  START REPLICA FOR CHANNEL 'from_office';"
mysql --host="$OFFICE_IP" -uroot --password="$OFFICE_PW" -e "
  CHANGE REPLICATION SOURCE TO SOURCE_HOST='${CLOUD_IP_SELF}', SOURCE_USER='repl',
    SOURCE_PASSWORD='${REPL_PW}', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1
    FOR CHANNEL 'from_cloud';
  START REPLICA FOR CHANNEL 'from_cloud';"
sleep 6
echo "   both channels started"

# ---------------------------------------------------------------------------------------
echo
echo "== 8/8  checking all three agree"
# ---------------------------------------------------------------------------------------
# Counted from the servers themselves rather than trusted from the loader's exit code. A load
# that reports success and leaves a table empty is the failure worth catching here.
count_on() {
  mysql $1 -uroot --password="$2" -N -B -e "
    SELECT CONCAT(
      (SELECT COUNT(*) FROM ${DB_NAME}.job_orders), ' / ',
      (SELECT COUNT(*) FROM ${DB_NAME}.sales_orders), ' / ',
      (SELECT COUNT(*) FROM ${DB_NAME}.estimates), ' / ',
      (SELECT COUNT(*) FROM ${DB_NAME}.customer_payments))" 2>/dev/null || echo "unreadable"
}
R_COUNTS=$(mysql --host="$R_HOST" --port="$R_PORT" --user="$R_USER" --password="$R_PASS" -N -B -e "
  SELECT CONCAT(
    (SELECT COUNT(*) FROM job_orders), ' / ',
    (SELECT COUNT(*) FROM sales_orders), ' / ',
    (SELECT COUNT(*) FROM estimates), ' / ',
    (SELECT COUNT(*) FROM customer_payments))" "$R_DB")
C_COUNTS=$(count_on "" "$CLOUD_PW")
O_COUNTS=$(count_on "--host=$OFFICE_IP" "$OFFICE_PW")

echo "   job orders / sales orders / estimates / payments"
echo "   Railway : ${R_COUNTS}"
echo "   cloud   : ${C_COUNTS}"
echo "   office  : ${O_COUNTS}"
echo

if [ "$R_COUNTS" = "$C_COUNTS" ] && [ "$R_COUNTS" = "$O_COUNTS" ]; then
  echo "   All three agree."
else
  # Railway is live, so a handful of rows written during the copy is expected and harmless.
  # Cloud and office disagreeing with EACH OTHER is not -- they were loaded from one file.
  echo "   !! They do not all match."
  echo "   Railway drifting slightly from the other two is expected: it kept taking writes"
  echo "   while this ran. Cloud and office differing from each other is not -- they came"
  echo "   from the same file, so check the load output above before trusting either."
fi

echo
echo "replication:"
mysql -uroot --password="$CLOUD_PW" -e "SHOW REPLICA STATUS\G" \
  | grep -E "Channel_Name|Replica_IO_Running|Replica_SQL_Running|Seconds_Behind_Source|Last_Error" \
  | sed 's/^/   cloud  /'
mysql --host="$OFFICE_IP" -uroot --password="$OFFICE_PW" -e "SHOW REPLICA STATUS\G" \
  | grep -E "Channel_Name|Replica_IO_Running|Replica_SQL_Running|Seconds_Behind_Source|Last_Error" \
  | sed 's/^/   office /'

echo
echo "Backups of what was replaced, kept on this machine:"
echo "   ${CLOUD_BAK}"
echo "   ${OFFICE_BAK}"
echo "Restore one with:  zcat <file> | mysql -uroot -p ${DB_NAME}"
echo
echo "The two migrations from the latest release still need running against whichever"
echo "database the application actually uses:"
echo "   node /opt/gsuite/server/src/db/add-nstdjo-sales-revision.js"
echo "   node /opt/gsuite/server/src/db/add-ticket-attachments.js"
