// One-off migration: creates the Return Material Inventory (RMI) tables and registers its
// page under Inventory.
//
// An RMI returns material from a branch or satellite warehouse back to a central one --
// leftovers from a job, wrong items pulled, stock being consolidated. Live models it as its
// own transaction type (RMI-####, Module_TransH = 'RMI') under the Inventory menu, and so
// does this.
//
// SHAPE, and why it is not a Transfer Order. The two look alike -- material leaves one
// location and arrives at another -- but a Transfer Order in this system is a three-document
// chain (order -> fulfilment -> receipt, each with its own numbering and lines). An RMI is a
// single document that carries its own received quantities per line, which is why it gets its
// own pair of tables rather than being bent into that chain.
//
// STATUS lives on the header and mirrors live's own vocabulary, with the per-line detail in
// rmi_lines.qty vs rmi_lines.received:
//
//   pending_receipt     nothing received yet          (live: "Pending Receipt")
//   partially_received  some lines short              (live: "Partially Received")
//   received            every line fully received     (live: "Received")
//   cancelled                                         (live: "Cancelled")
//
// Snake_case keys rather than live's display strings, for the same reason transfer orders
// store them that way: the list's status tabs filter on the key, and storing "Received "
// (live really does carry the trailing space) leaves every tab empty.
//
// STOCK IS NOT MOVED BY THIS SCRIPT, nor by the importer that fills these tables. Local
// inventory_locations holds token quantities rather than a mirror of live's on-hand, and no
// other importer in this repo replays movements either -- replaying 199 historical RMIs
// against balances whose inbound history was never replayed would drive every source
// warehouse negative. Movement belongs to documents raised in this app from here on.
//
// Idempotent -- safe to re-run:
//   node src/db/create-rmi.js --dry-run   (report only, no writes)
//   node src/db/create-rmi.js             (apply)
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const ROUTE = '/rmis';
const NAME = 'RMI';
const MODULE = 'Inventory';

const CREATE_RMIS = `
CREATE TABLE rmis (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    rmi_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    -- Return From / Return To on the form. Both NOT NULL: a return with only one end of the
    -- move is not a document anyone can act on.
    return_from_location_id BIGINT NOT NULL REFERENCES locations(id),
    return_to_location_id BIGINT NOT NULL REFERENCES locations(id),
    -- Who physically returned the material. An employee on live; nullable because a handful
    -- of historical documents name nobody.
    returned_by_employee_id BIGINT NULL REFERENCES employees(id),
    memo VARCHAR(500),
    status VARCHAR(30) NOT NULL DEFAULT 'pending_receipt',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    received_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    -- Live's own primary key, so a re-run of the importer updates the document it already
    -- created instead of inserting a second copy. Null for anything raised in this app.
    live_pk VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rmis_live_pk (live_pk),
    INDEX idx_rmis_status (status, date_created),
    INDEX idx_rmis_from (return_from_location_id),
    INDEX idx_rmis_to (return_to_location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const CREATE_RMI_LINES = `
CREATE TABLE rmi_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    rmi_id BIGINT NOT NULL,
    line_no INT NOT NULL DEFAULT 1,
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    -- The job the material came off, when it came off one. Most returns name no job.
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    -- qty is what the document says is being returned; received is how much actually
    -- arrived. Equal on a fully received line, short on a partially received one, zero on
    -- one still in transit -- which is exactly how the live grid's Qty and Received read.
    qty DECIMAL(14,4) NOT NULL DEFAULT 0,
    received DECIMAL(14,4) NOT NULL DEFAULT 0,
    -- Snapshotted at document time, like every other line table here: the item's UOM can be
    -- edited later and an old document must keep reading the way it was raised.
    uom VARCHAR(30),
    unit VARCHAR(60),
    qty_on_hand DECIMAL(14,4) NOT NULL DEFAULT 0,
    rate DECIMAL(18,10) NOT NULL DEFAULT 0,
    cost DECIMAL(18,10) NOT NULL DEFAULT 0,
    live_pk VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rmi_lines_live_pk (live_pk),
    INDEX idx_rmi_lines_rmi (rmi_id, line_no),
    CONSTRAINT fk_rmi_lines_rmi FOREIGN KEY (rmi_id) REFERENCES rmis(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function tableExists(name) {
  const [r] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return r.length > 0;
}

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Local DB: ${db}`);
  console.log(DRY_RUN ? 'DRY RUN -- report only.\n' : 'APPLYING.\n');

  for (const [name, sql] of [['rmis', CREATE_RMIS], ['rmi_lines', CREATE_RMI_LINES]]) {
    if (await tableExists(name)) {
      console.log(`  = ${name} already exists, skipping`);
    } else if (DRY_RUN) {
      console.log(`  ~ would create ${name}`);
    } else {
      await pool.query(sql);
      console.log(`  + created ${name}`);
    }
  }

  // The page row and the admin grants happen here, in the same migration that creates the
  // tables, so the module can never be left unreachable: requirePermission resolves a route
  // to a page before it checks anything, so a missing row 403s every user, System Admin
  // included.
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [ROUTE]);
  if (page) {
    console.log(`\n= ${ROUTE} already registered (page id ${page.id}).`);
  } else if (DRY_RUN) {
    console.log(`\n~ would register ${ROUTE} as "${NAME}".`);
  } else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name'];
    const values = [ROUTE, NAME];
    if (has.has('module')) { fields.push('module'); values.push(MODULE); }
    const [result] = await pool.query(
      `INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
      values,
    );
    page = { id: result.insertId };
    console.log(`\nRegistered ${ROUTE} as "${NAME}" (id ${page.id}).`);
  }

  const [admins] = await pool.query(
    "SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE",
  );
  if (!page) {
    console.log(`Would grant full access to ${admins.length} admin(s) once the page row exists.`);
  } else {
    for (const user of admins) {
      const [[existing]] = await pool.query(
        'SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [user.id, page.id],
      );
      if (DRY_RUN) { console.log(`  ~ ${user.display_name}: would get full access.`); continue; }
      if (existing) {
        await pool.query(
          'UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?',
          [existing.id],
        );
      } else {
        await pool.query(
          `INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve)
           VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)`,
          [user.id, page.id],
        );
      }
      console.log(`  + ${user.display_name}: full access.`);
    }
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await pool.end();
  process.exit(1);
});
