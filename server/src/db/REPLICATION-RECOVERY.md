# Replication stopped — what to do

The office and cloud servers replicate **both ways**. Either direction can stop on its own
while the other keeps running, and a stopped direction is silent: the app keeps serving, it
just serves data that has stopped changing. This is how to find it and fix it.

You do not need anyone's help for this. Follow it top to bottom.

---

## Which server is which

| | Address | Channel name | Notes |
|---|---|---|---|
| Cloud (Singapore) | `100.111.65.92` / `146.190.103.165` | `from_office` | you are `root` |
| Office (Cebu) | `100.77.225.53` / `192.168.0.175` | *(unnamed default)* | you are `gsuite`, use `sudo` |

The `100.x` addresses are Tailscale. Replication uses those, not the public IP.

MySQL root password is in `/root/.mysql_root_pw` on each box — unless it has been changed
since, in which case that file is stale. The password in use as of 2026-08-24 was
`ChangeMe#2026`. Every command below assumes you have run:

    export MYSQL_PWD='<the mysql root password>'

---

## 1. Check both directions

**On the cloud:**

    mysql -uroot -E -e "SHOW REPLICA STATUS FOR CHANNEL 'from_office'" \
      | grep -E "IO_Running|SQL_Running|Seconds_Behind_Source"

**On the office:**

    sudo mysql -uroot -p -E -e "SHOW REPLICA STATUS" \
      | grep -E "IO_Running|SQL_Running|Seconds_Behind_Source"

Healthy is both `Yes` with `Seconds_Behind_Source: 0`.

- `SQL_Running: No` — the applier stopped on an error. Go to step 2.
- `IO_Running: No` — it cannot reach the other server. Check `tailscale status` and that
  MySQL is up, then `START REPLICA` (adding `FOR CHANNEL 'from_office'` on the cloud).
- Both `Yes` but `Seconds_Behind_Source` large — it is catching up. Leave it alone.
- Nothing printed at all — replication is not configured on that box. That is step 5.

Check **both** servers. One direction dying while the other runs is the normal failure here,
and it is why the problem looks like "some data is old" rather than an outage.

---

## 2. Read the real error

`Last_Error` in the status output is a generic wrapper naming no cause. The actual error is:

    mysql -uroot -N -e "SELECT LAST_ERROR_NUMBER, LEFT(LAST_ERROR_MESSAGE,200)
      FROM performance_schema.replication_applier_status_by_worker
      WHERE LAST_ERROR_NUMBER <> 0"

The error **number** decides everything that follows.

---

## 3. Only these two are safe to skip

| Error | Meaning | Why skipping is safe |
|---|---|---|
| **1032** | `Delete_rows` / `Update_rows`, record not found | The row is already gone. What the transaction wanted is already true. |
| **1060** | Duplicate column name | The column already exists, because the migration was run on this server directly. |

Both mean *the end state this transaction was trying to reach already holds here.* Skipping
changes no data.

**Anything else — stop and do not skip.** 1062 (duplicate entry), 1452 (foreign key), 1146
(table missing) and the rest can mean the two databases genuinely disagree. Skipping those
buries real divergence in a database holding invoices and payments, and nothing will ever
tell you afterwards. Go to step 5.

---

## 4. Skip and restart

`sql_replica_skip_counter` does **not** work here — this pair uses GTID auto-positioning.
You skip a transaction by committing an empty one in its place.

Paste this whole block. It skips only 1032/1060, stops on anything else, and bounds itself
at 30 attempts so it cannot spin.

**On the office** (unnamed channel):

    export MYSQL_PWD='<mysql root password>'
    for i in $(seq 1 30); do
      E=$(mysql -uroot -N -e "SELECT COALESCE(MAX(LAST_ERROR_NUMBER),0) FROM performance_schema.replication_applier_status_by_worker")
      if [ "$E" = "0" ]; then echo "CLEAN after $((i-1)) skip(s)"; break; fi
      if [ "$E" != "1032" ] && [ "$E" != "1060" ]; then
        echo "ABORT unexpected error $E -- do NOT skip this one, see step 5"
        mysql -uroot -N -e "SELECT LEFT(LAST_ERROR_MESSAGE,200) FROM performance_schema.replication_applier_status_by_worker WHERE LAST_ERROR_NUMBER<>0" | head -1
        break
      fi
      G=$(mysql -uroot -N -e "SELECT LAST_ERROR_MESSAGE FROM performance_schema.replication_applier_status_by_worker WHERE LAST_ERROR_NUMBER<>0" | grep -oE "[0-9a-f-]{36}:[0-9]+" | head -1)
      echo "skip $G (err $E)"
      mysql -uroot -e "STOP REPLICA; SET GTID_NEXT='$G'; BEGIN; COMMIT; SET GTID_NEXT='AUTOMATIC'; START REPLICA;"
      sleep 6
    done
    mysql -uroot -E -e "SHOW REPLICA STATUS" | grep -E "IO_Running|SQL_Running|Seconds_Behind_Source"

**On the cloud**, the same block with `FOR CHANNEL 'from_office'` added to `STOP REPLICA` and
`START REPLICA`, and `CHANNEL_NAME='from_office' AND` added to each `WHERE`.

Then let it drain — it may be thousands of transactions behind — and confirm the two agree:

    mysql -uroot gsuite_erp -e "
      SELECT 'customer_payments' t, COUNT(*) n FROM customer_payments
      UNION ALL SELECT 'sales_invoices', COUNT(*) FROM sales_invoices
      UNION ALL SELECT 'users', COUNT(*) FROM users"

Run it on **both** servers. The numbers must match. Replication reporting healthy across two
different datasets is worse than a stopped replica, because nothing will ever flag it.

---

## 4b. If the SAME table keeps breaking it — repair that table

Skipping clears the queue but does not fix anything. If the same table appears in the error
again and again, that table's contents genuinely differ between the two servers and every
future delete on it will stop replication again.

This happened on 2026-08-24: `notifications` had disagreed since the Railway cutover, and
replication was skipped past it five times in one day before the table itself was repaired.

**Confirm the tables differ** — run on BOTH servers and compare:

    mysql -uroot gsuite_erp -e "CHECKSUM TABLE notifications, tickets, users"

Note: `users` and `notifications` change constantly (`users.last_seen_at` is the presence
heartbeat, written on nearly every request), so their checksums are moving targets and will
rarely match to the second. Read them on both sides close together, and treat a *large*
difference as real. `tickets` and similar are stable enough to compare directly.

**Then copy the cloud's copy over the office's.** On the office:

    sudo MYSQL_PWD='<cloud DB_PASSWORD>' mysqldump --host=100.111.65.92 --user=gsuite \
      --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --hex-blob \
      gsuite_erp <table> --result-file=/tmp/fix.sql
    tail -3 /tmp/fix.sql            # MUST end "-- Dump completed on"
    grep -c GTID_PURGED /tmp/fix.sql  # MUST print 0

    mysql -uroot -e "STOP REPLICA"
    ( echo "SET sql_log_bin=0;"; cat /tmp/fix.sql ) | mysql -uroot gsuite_erp
    mysql -uroot -e "START REPLICA"
    mysql -uroot gsuite_erp -e "CHECKSUM TABLE <table>"

Three flags matter here, all learned the hard way:

- **`--set-gtid-purged=OFF`** — without it a partial dump carries `SET @@GLOBAL.GTID_PURGED`,
  which on load tries to rewrite the office's GTID state and breaks replication outright.
  Always verify with the `grep -c` above.
- **`--skip-lock-tables`** — `--single-transaction` makes mysqldump issue `FLUSH TABLES`,
  which `gsuite` lacks the privilege for. For a single table being repaired with the replica
  stopped, a consistent snapshot is not needed.
- **`SET sql_log_bin=0`** — keeps the repair out of the office's binlog so it does not
  replicate back to the cloud and start the same fight from the other direction. It must be
  in the SAME session as the load, which is why it is piped in rather than run separately.

---

## 5. When skipping is not the answer: re-seed the office

Use this when the error is not 1032/1060, when the counts still disagree after catching up,
or when `SHOW REPLICA STATUS` prints nothing.

**This destroys the office database and rebuilds it from the cloud.**

### First: make sure the office's own work reached the cloud

The office is a live server; people write to it. On the office:

    mysql -uroot -N -e "SELECT @@server_uuid"      # note this UUID
    mysql -uroot -N -e "SELECT @@gtid_executed"    # note its range for that UUID

On the cloud, check that same UUID has reached at least that number:

    mysql -uroot -N -e "SELECT @@gtid_executed" | tr ',' '\n'

If the cloud is behind, fix the `from_office` channel first (steps 1–4). Re-seeding before
that throws away everything that had not arrived yet.

### Then, on the office

    sudo systemctl stop gsuite
    mysql -uroot -e "STOP REPLICA"

    # safety copy of what you are about to destroy
    mysqldump -uroot --single-transaction --set-gtid-purged=OFF \
      --routines --events --triggers --hex-blob \
      gsuite_erp --result-file=/root/office-before-reseed.sql
    tail -3 /root/office-before-reseed.sql        # MUST end "-- Dump completed on"

    # seed from the cloud, over Tailscale
    sudo mysqldump --host=100.111.65.92 --user=gsuite -p --single-transaction \
      --set-gtid-purged=ON --no-tablespaces --routines --events --triggers --hex-blob --quick \
      gsuite_erp --result-file=/root/seed.sql
    tail -3 /root/seed.sql                        # MUST end "-- Dump completed on"

Use **`gsuite`**, not `repl`. `repl` holds only `REPLICATION SLAVE, REPLICATION CLIENT` — it
cannot read tables and cannot take a dump. `gsuite@%` has `ALL PRIVILEGES ON gsuite_erp` and
can connect from the office. Its password is the cloud's `DB_PASSWORD`:

    ssh root@146.190.103.165 "grep '^DB_PASSWORD=' /opt/gsuite/server/.env"

`--no-tablespaces` avoids a `PROCESS` privilege error that `gsuite` would otherwise hit.

    mysql -uroot -e "DROP DATABASE gsuite_erp; CREATE DATABASE gsuite_erp CHARACTER SET utf8mb4; RESET BINARY LOGS AND GTIDS;"
    mysql -uroot gsuite_erp < /root/seed.sql
    mysql -uroot -e "START REPLICA"
    mysql -uroot -E -e "SHOW REPLICA STATUS" | grep -E "IO_Running|SQL_Running"
    sudo systemctl start gsuite

`RESET BINARY LOGS AND GTIDS` is required — a `--set-gtid-purged=ON` dump refuses to load
unless `gtid_executed` is empty. `CHANGE REPLICATION SOURCE` is **not** needed: the source is
already configured and `Auto_Position: 1` survives the reset.

---

## Never skip the dump check

Run `tail -3` on every dump, every time. A dump cut short looks like a perfectly good file
and loads without complaining, leaving a database half from one source and half from another.

This has already happened once: a 131 MB dump that stopped at `feed_post_reactions` and would
have mixed one system's a–f tables with another's g–z tables. A complete dump ends with
`-- Dump completed on <date>`.

Related trap: **never redirect `mysqldump` with `>` in PowerShell.** It re-encodes to UTF-16
and the file fails to load with `ASCII '\0' appeared in the statement`. Use
`--result-file=` instead, which writes the bytes directly.

---

## Avoiding it next time

**Run schema migrations on ONE server only, and only while replication is healthy.** DDL
replicates. Running an `add-*.js` on both sides is what produces error 1060 — each server
then receives the other's copy of a change it has already made. Check step 1 first; if
replication is healthy, run the migration on the cloud and let it flow to the office.

If replication is already broken and you must run it on both, that is fine — just expect 1060
when the channels come back, and skip it (step 4).

**Keep the health check scheduled.** It reports only when something is wrong. It needs
credentials for BOTH servers in its environment, which cron does not have — so they live in a
root-only file rather than in the crontab. Installed on the office 2026-08-24:

    sudo tee /root/.replhealth.env >/dev/null <<'ENVEOF'
    CLOUD_HOST=100.111.65.92
    CLOUD_USER=gsuite
    CLOUD_PW=<cloud DB_PASSWORD>
    OFFICE_HOST=127.0.0.1
    OFFICE_USER=root
    OFFICE_PW=<office mysql root password>
    ENVEOF
    sudo chmod 600 /root/.replhealth.env

Test it before trusting it — a check that cannot authenticate reports nothing wrong precisely
because it never ran:

    sudo bash -c 'set -a; . /root/.replhealth.env; set +a; node /opt/gsuite/server/src/db/replication-health.js'

Then schedule it:

    ( sudo crontab -l 2>/dev/null; echo '*/10 * * * * set -a; . /root/.replhealth.env; set +a; /usr/bin/node /opt/gsuite/server/src/db/replication-health.js --quiet' ) | sudo crontab -

`gsuite` is the right user for the cloud side — it holds `REPLICATION CLIENT`. `setup`, the
script's default for OFFICE_USER, does not exist; use `root`.

Without this a stopped channel is invisible. The `from_office` channel was down from
2026-08-21 to 2026-08-24 and was noticed only because someone spotted stale data on screen.

**Expect 1032 as normal wear.** Both servers accept writes (`auto_increment_increment=10`,
offsets 1 and 2, one hostname resolving to both), so the same row can be deleted on each side
independently. The second delete to arrive finds nothing and stops the applier. It is not a
sign of corruption — it is the cost of running active-active, and step 4 is the routine fix.
