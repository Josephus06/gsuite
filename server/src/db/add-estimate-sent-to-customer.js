// Records that an estimate was emailed to the customer, and where it went.
//
// The button that sends it is the feature; this is what stops the obvious next problem. Without
// somewhere to write it down, "did we already send this to them?" has no answer, and the honest
// options are to ask around or to send it again. Two estimates arriving from two people is the
// kind of thing a customer remembers.
//
// The ADDRESS is stored, not just the timestamp. Most estimates carry no contact_email -- only 45
// of 69,466 do -- so the address is usually typed or taken from the contact record at the moment
// of sending. Recording only "sent at 2pm" would leave nobody able to say where it actually went,
// which is exactly what gets asked when a customer says they never received it.
//
// Idempotent -- safe to re-run:
//   node src/db/add-estimate-sent-to-customer.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS cn FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'estimates'
        AND COLUMN_NAME IN ('sent_to_customer_at', 'sent_to_customer_email', 'sent_to_customer_by_user_id')`,
    [process.env.DB_NAME],
  );
  const have = new Set(cols.map((c) => c.cn));

  const additions = [
    ['sent_to_customer_at', 'DATETIME NULL'],
    ['sent_to_customer_email', 'VARCHAR(255) NULL'],
    // Who pressed the button. Nullable and never enforced against users: an estimate emailed by
    // someone who has since left must keep the fact that it was sent.
    ['sent_to_customer_by_user_id', 'BIGINT NULL'],
  ];

  for (const [name, ddl] of additions) {
    if (have.has(name)) { console.log(`estimates.${name} already present.`); continue; }
    await pool.query(`ALTER TABLE estimates ADD COLUMN ${name} ${ddl}`);
    console.log(`estimates.${name} added.`);
  }

  const [[n]] = await pool.query(
    `SELECT COUNT(*) AS pending,
            SUM(sent_to_customer_at IS NOT NULL) AS already_sent
       FROM estimates WHERE status = 'pending_customer_approval'`,
  );
  console.log(`\n${n.pending} estimate(s) awaiting customer approval, ${n.already_sent || 0} recorded as sent.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
