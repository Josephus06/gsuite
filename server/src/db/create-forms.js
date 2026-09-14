// Forms -- the request forms module ported from the Booking system (Laravel) at
// C:\Users\Administrator\Desktop\Booking system, app/Http/Controllers/RequestDocumentController.php.
//
// One document, four shapes. Every form is a row in form_requests carrying the workflow, and the
// fields peculiar to its type live in a side table:
//
//   liquidation     form_liquidation_details    + items + purposes
//   payment         form_payment_details        + items
//   revolving_fund  form_revolving_fund_details + items
//   business_trip   form_business_trip_details  (no items -- a trip is not a list of expenses)
//
// WHY A SIDE TABLE PER TYPE rather than one wide table of mostly-NULL columns: the four forms are
// separate printed documents with their own boxes to fill in, and a liquidation's cash advance has
// nothing to say about a business trip's speedometer reading. The source models it this way and
// the shape is right.
//
// THE WORKFLOW, unchanged from the source:
//
//   draft -> submitted -> noted -> approved
//                     \-> rejected
//
// Rejection is not an ending. The owner edits and the form returns to where it was: back to NOTED
// if it had been noted, otherwise to SUBMITTED, with the rejection cleared and the per-line remarks
// wiped. That is why noted_at/noted_by survive a rejection -- they are what the return path reads.
//
// WHAT CHANGED IN THE PORT, and why:
//
//   Roles -> permissions. The source gates on user->role: 'unitadmin' may note, 'administrator'
//   may approve. This system has no roles, so the two stages became two ACTIONS on the approval
//   page: can_edit on /forms/approval notes, can_approve on /forms/approval approves or rejects.
//   Separate grants, because noting and approving are still different jobs.
//
//   Numbering -> insertNumbered. The source reads MAX(id) and formats REQ-YYYY-000001, which is a
//   race between two people creating at once and loses its padding on re-read. Numbers here go
//   through lib/docNumber.js like every other document in this system: REQ-1, REQ-2, written in
//   the INSERT and retried on a clash.
//
//   Tables carry a form_ prefix. 'request_documents' says nothing about which module owns it in a
//   schema this size, and 'request_items' would sit one letter from the requisition tables.
//
// IDEMPOTENT: safe to re-run. Existing tables are left alone.
//
//   node src/db/create-forms.js
const pool = require('../db');

const PAGES = [
  // Two pages, because filling a form in and ruling on one are different jobs.
  //   /forms            can_view  see your own forms      can_add  raise and submit one
  //                     can_edit  revise your draft or a rejected form
  //                     can_delete  discard your own draft   can_print  print an approved form
  //                     can_view_all  see everyone's, not only your own
  //   /forms/approval   can_view  see the approval queue
  //                     can_edit  NOTE a submitted form
  //                     can_approve  APPROVE or REJECT a submitted or noted form
  { route: '/forms', name: 'Forms' },
  { route: '/forms/approval', name: 'Forms Approval' },
];

async function tableExists(name) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name],
  );
  return r.n > 0;
}

async function columnExists(table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column],
  );
  return r.n > 0;
}

async function createTable(name, ddl) {
  if (await tableExists(name)) {
    console.log(`  Table ${name} already exists.`);
    return;
  }
  await pool.query(ddl);
  console.log(`  Created table ${name}.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);

  // type is VARCHAR, not ENUM. The source started with an ENUM of two and had to ALTER it twice as
  // forms were added; the fifth form should be a line of code, not a migration.
  //
  // department and name are stored ON THE FORM rather than read from the user, for the same reason
  // the violation keeps its own copy: these are printed documents read years later, and somebody
  // moving department must not rewrite the form they filed.
  await createTable('form_requests', `
    CREATE TABLE form_requests (
      id BIGINT NOT NULL AUTO_INCREMENT,
      request_no VARCHAR(30) NOT NULL,
      type VARCHAR(50) NOT NULL,
      user_id BIGINT NOT NULL,
      department VARCHAR(255) NULL,
      name VARCHAR(255) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      submitted_at DATETIME NULL,
      noted_at DATETIME NULL,
      approved_at DATETIME NULL,
      rejected_at DATETIME NULL,
      noted_by BIGINT NULL,
      approved_by BIGINT NULL,
      rejected_by BIGINT NULL,
      rejection_reason TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_requests_no (request_no),
      KEY idx_form_requests_type_status (type, status),
      KEY idx_form_requests_user_status (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // rejection_remark is per LINE, not per form: an approver sends one back saying which expense is
  // the problem, and the owner needs to see it against that row.
  await createTable('form_request_items', `
    CREATE TABLE form_request_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      item_date DATE NULL,
      particulars VARCHAR(255) NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      rejection_remark TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_form_request_items_doc (form_request_id),
      CONSTRAINT fk_form_request_items_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // reimbursement_amount and ending_balance are COMPUTED on save (sum of items, and starting
  // balance less that sum) rather than typed. They are stored because the printed form shows them
  // and a printed document must not change when somebody later edits a line.
  await createTable('form_liquidation_details', `
    CREATE TABLE form_liquidation_details (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      week_no VARCHAR(50) NULL,
      form_no VARCHAR(50) NULL,
      date_from DATE NULL,
      date_to DATE NULL,
      cash_advance_amount DECIMAL(12,2) NULL,
      cash_advance_date DATE NULL,
      previous_balance DECIMAL(12,2) NULL,
      starting_balance DECIMAL(12,2) NULL,
      reimbursement_amount DECIMAL(12,2) NULL,
      ending_balance DECIMAL(12,2) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_liquidation_doc (form_request_id),
      CONSTRAINT fk_form_liquidation_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('form_liquidation_purposes', `
    CREATE TABLE form_liquidation_purposes (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      purpose VARCHAR(100) NOT NULL,
      other_text VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_form_liquidation_purposes_doc (form_request_id),
      CONSTRAINT fk_form_liquidation_purposes_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('form_payment_details', `
    CREATE TABLE form_payment_details (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      payable_to VARCHAR(255) NOT NULL,
      address VARCHAR(255) NULL,
      doc_date DATE NULL,
      total_amount DECIMAL(12,2) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_payment_doc (form_request_id),
      CONSTRAINT fk_form_payment_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('form_revolving_fund_details', `
    CREATE TABLE form_revolving_fund_details (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      week_no VARCHAR(50) NULL,
      date_from DATE NULL,
      date_to DATE NULL,
      cash_advance_amount DECIMAL(12,2) NULL,
      cash_advance_date DATE NULL,
      previous_balance DECIMAL(12,2) NULL,
      starting_balance DECIMAL(12,2) NULL,
      reimbursement_amount DECIMAL(12,2) NULL,
      ending_balance DECIMAL(12,2) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_revolving_doc (form_request_id),
      CONSTRAINT fk_form_revolving_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // speedometer readings are VARCHAR, matching the source: the printed sheet is hand-filled and
  // the figure arrives written as "120,000 km" as often as a bare number.
  await createTable('form_business_trip_details', `
    CREATE TABLE form_business_trip_details (
      id BIGINT NOT NULL AUTO_INCREMENT,
      form_request_id BIGINT NOT NULL,
      driver_name VARCHAR(255) NULL,
      vehicle_plate_no VARCHAR(255) NULL,
      speedometer_begin VARCHAR(255) NULL,
      speedometer_end VARCHAR(255) NULL,
      total_mileage_km DECIMAL(10,2) NULL,
      trip_date DATE NULL,
      time_out TIME NULL,
      time_in TIME NULL,
      purpose TEXT NULL,
      checked_by VARCHAR(255) NULL,
      noted_by_name VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_form_business_trip_doc (form_request_id),
      CONSTRAINT fk_form_business_trip_doc FOREIGN KEY (form_request_id)
        REFERENCES form_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  console.log('');
  const hasViewAll = await columnExists('user_page_permissions', 'can_view_all');
  const cols = ['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_print']
    .concat(hasViewAll ? ['can_view_all'] : []);

  for (const pg of PAGES) {
    const [[existing]] = await pool.query('SELECT id FROM pages WHERE route = ?', [pg.route]);
    let pageId = existing?.id;
    if (pageId) {
      console.log(`Page ${pg.route}: already registered (id ${pageId}).`);
    } else {
      const [r] = await pool.query('INSERT INTO pages (route, name) VALUES (?, ?)', [pg.route, pg.name]);
      pageId = r.insertId;
      console.log(`Page ${pg.route}: registered as "${pg.name}" (id ${pageId}).`);
    }

    await pool.query(
      `INSERT INTO user_page_permissions (user_id, page_id, ${cols.join(', ')})
       SELECT u.id, ?, ${cols.map(() => 'TRUE').join(', ')} FROM users u
        WHERE u.account_type = 'System Admin'
          AND NOT EXISTS (SELECT 1 FROM (SELECT user_id FROM user_page_permissions WHERE page_id = ?) e
                           WHERE e.user_id = u.id)`,
      [pageId, pageId],
    );
    await pool.query(
      `UPDATE user_page_permissions upp JOIN users u ON u.id = upp.user_id
          SET ${cols.map((c) => `upp.${c} = TRUE`).join(', ')}
        WHERE u.account_type = 'System Admin' AND upp.page_id = ?`, [pageId],
    );
    const [[atp]] = await pool.query(
      "SELECT COUNT(*) AS n FROM account_type_permissions WHERE account_type = 'System Admin' AND page_id = ?",
      [pageId],
    );
    if (!atp.n) {
      await pool.query(
        `INSERT INTO account_type_permissions (account_type, page_id, ${cols.join(', ')})
         VALUES ('System Admin', ?, ${cols.map(() => 'TRUE').join(', ')})`, [pageId],
      );
    }
  }
  console.log('System Admin granted in full on both.');

  console.log('\nNOBODY ELSE HAS ACCESS YET, deliberately -- there is no existing page whose grants');
  console.log('could be copied without guessing. Grant /forms to whoever files these forms and');
  console.log('/forms/approval to whoever rules on them, in Users & Permissions.');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
