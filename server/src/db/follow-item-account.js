// Re-runs lib/itemAccountFollow.js for an item whose Expense Account was changed before the item
// screen did it on save (2026-10-24: APACER SSD, 17800 -> 17400, VB-24367).
//
//   node src/db/follow-item-account.js --item=IT-SSD-APACER-AS350-512GB-2.5 --from=17800            # dry run
//   node src/db/follow-item-account.js --item=IT-SSD-APACER-AS350-512GB-2.5 --from=17800 --apply
require('dotenv').config();
const pool = require('../db');
const { followItemExpenseAccount } = require('../lib/itemAccountFollow');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(`DB ${process.env.DB_NAME} on ${process.env.DB_HOST}${APPLY ? '' : ' -- DRY RUN'}`);
  const [[item]] = await pool.query('SELECT id, item_code, expense_account_id FROM inventories WHERE item_code = ?', [arg('item')]);
  const [[from]] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = ?', [arg('from')]);
  if (!item || !from) { console.log('  item or --from account not found'); process.exit(1); }
  console.log(`  ${item.item_code}: ${from.account_code} ${from.account_name} -> account id ${item.expense_account_id}`);
  const [bills] = await pool.query(
    `SELECT DISTINCT vb.bill_no, vb.date_created FROM vendor_bill_lines l JOIN vendor_bills vb ON vb.id = l.vendor_bill_id
      WHERE l.item_id = ? AND vb.status <> 'cancelled' ORDER BY vb.date_created`, [item.id]);
  console.log(`  bills: ${bills.map((b) => `${b.bill_no} (${String(b.date_created).slice(0, 10)})`).join(', ')}`);
  if (APPLY) {
    const [[admin]] = await pool.query("SELECT id FROM users WHERE account_type = 'System Admin' ORDER BY id LIMIT 1");
    const r = await followItemExpenseAccount({ itemId: item.id, oldAccountId: from.id, newAccountId: item.expense_account_id, userId: admin?.id || null });
    console.log('  ', JSON.stringify(r));
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
