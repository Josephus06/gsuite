// CRM > relationship layer: the parts of a CRM that are about the PEOPLE at a customer and how
// often we see them, rather than the deals (the Pipeline already derives those from estimates ->
// sales orders -> job orders, see routes/crmPipeline.js).
//
//   customer_contacts.birthday / personal_notes   who the people are
//   customers.crm_priority                        high / normal / low
//   customers.visit_every_days                    how often this account should be seen;
//                                                 NULL = the priority's default (lib/crmCadence.js)
//   crm_tags, customer_tags                       free-form labels
//   crm_activities.starts_at / ends_at / location / contact_id / outcome
//                                                 so a visit or meeting has a time and a place,
//                                                 not just the date-only due_date a task has
//
//   crm_attention, crm_attention_snoozes          the nightly "needs attention" ranking and the
//                                                 reps' snoozes on it (lib/crmAttention.js)
//   crm_activities.invite_sent_at                 calendar invite emailed to the contact
//   crm_email_drafts, crm_email_optouts           AI-drafted, rep-approved emails, and who
//                                                 unsubscribed (lib/crmDrafts.js)
//
// Visits are crm_activities rows with activity_type = 'visit' -- the same log calls and notes
// already go in, so "last visit" is a MAX() over it, not a second table to keep in step.
//
// No pages row: all of this is read and written through the customer it belongs to, under
// /customers' own permissions (see routes/crm.js).
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/create-crm-relationship.js
const pool = require('../db');

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

async function indexExists(table, index) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index],
  );
  return r.n > 0;
}

async function addColumn(table, column, ddl) {
  if (await columnExists(table, column)) {
    console.log(`  ${table}.${column} already exists.`);
    return;
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`  Added ${table}.${column}.`);
}

// The new tables take the collation customer_contacts already has, not the server default. The
// email columns here are compared with customer_contacts.email, and MySQL refuses "=" across two
// different utf8mb4 collations (the imported tables are utf8mb4_unicode_ci; a MySQL 8 default is
// utf8mb4_0900_ai_ci). Read per install rather than hard-coded, since they need not all match.
let collation = null;

async function createTable(name, ddl) {
  if (await tableExists(name)) {
    console.log(`  Table ${name} already exists.`);
    return;
  }
  await pool.query(ddl.replace('DEFAULT CHARSET=utf8mb4', `DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`));
  console.log(`  Created table ${name}.`);
}

// For tables made by an earlier run of this script before it matched collations.
async function matchCollation(name) {
  const [[t]] = await pool.query(
    'SELECT table_collation AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name],
  );
  if (!t || t.c === collation) return;
  await pool.query(`ALTER TABLE ${name} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${collation}`);
  console.log(`  Converted ${name} from ${t.c} to ${collation}.`);
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}\n`);
  const [[cc]] = await pool.query(
    "SELECT table_collation AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'customer_contacts'",
  );
  collation = cc.c;
  if (!/^utf8mb4_[a-z0-9_]+$/.test(collation)) throw new Error(`Unexpected customer_contacts collation: ${collation}`);
  console.log(`  Collation for new tables: ${collation}`);

  await addColumn('customer_contacts', 'birthday', 'DATE NULL');
  await addColumn('customer_contacts', 'personal_notes', 'VARCHAR(1000) NULL');

  await addColumn('customers', 'crm_priority', "VARCHAR(10) NOT NULL DEFAULT 'normal'");
  await addColumn('customers', 'visit_every_days', 'INT NULL');

  await createTable('crm_tags', `
    CREATE TABLE crm_tags (
      id BIGINT NOT NULL AUTO_INCREMENT,
      name VARCHAR(60) NOT NULL,
      color VARCHAR(20) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_crm_tags_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await createTable('customer_tags', `
    CREATE TABLE customer_tags (
      customer_id BIGINT NOT NULL,
      tag_id BIGINT NOT NULL,
      PRIMARY KEY (customer_id, tag_id),
      KEY idx_customer_tags_tag (tag_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await addColumn('crm_activities', 'starts_at', 'DATETIME NULL');
  await addColumn('crm_activities', 'ends_at', 'DATETIME NULL');
  await addColumn('crm_activities', 'location', 'VARCHAR(300) NULL');
  await addColumn('crm_activities', 'contact_id', 'BIGINT NULL');
  await addColumn('crm_activities', 'outcome', 'VARCHAR(1000) NULL');

  // "Last visit per customer" is the query the whole needs-attention list is built on.
  if (await indexExists('crm_activities', 'idx_crm_activities_type_related')) {
    console.log('  Index idx_crm_activities_type_related already exists.');
  } else {
    await pool.query(
      `ALTER TABLE crm_activities
         ADD INDEX idx_crm_activities_type_related (activity_type, related_type, related_id, is_done)`,
    );
    console.log('  Added index idx_crm_activities_type_related.');
  }

  // --- Needs Attention (lib/crmAttention.js) ---
  // A nightly snapshot, not a live query: the signals read two years of sales orders and the whole
  // open-AR ledger, which is seconds of work that should not happen on every page load. One row
  // per customer who scored above zero; the job replaces the lot each run.
  await createTable('crm_attention', `
    CREATE TABLE crm_attention (
      customer_id BIGINT NOT NULL,
      owner_employee_id BIGINT NULL,
      score DECIMAL(8,2) NOT NULL,
      reasons JSON NOT NULL,
      last_order_date DATE NULL,
      last_visit_at DATETIME NULL,
      next_scheduled_at DATETIME NULL,
      revenue_12m DECIMAL(16,2) NOT NULL DEFAULT 0,
      overdue_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      computed_at DATETIME NOT NULL,
      PRIMARY KEY (customer_id),
      KEY idx_crm_attention_owner_score (owner_employee_id, score),
      KEY idx_crm_attention_score (score)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Kept apart from crm_attention so the nightly rebuild does not wipe a rep's "not now".
  await createTable('crm_attention_snoozes', `
    CREATE TABLE crm_attention_snoozes (
      customer_id BIGINT NOT NULL,
      snoozed_until DATE NOT NULL,
      snoozed_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // When a calendar invitation for a visit/meeting was last emailed to the contact.
  await addColumn('crm_activities', 'invite_sent_at', 'DATETIME NULL');

  // --- Email drafts (lib/crmDrafts.js) ---
  // Check-in and birthday emails the AI (or a template) writes and a rep reviews. Nothing reaches
  // a customer without a person pressing Send -- status goes draft -> sent | discarded | failed.
  // owner_employee_id is copied from crm_attention at creation so the list can be scoped by
  // lib/salesVisibility.js without re-deriving who owns the customer.
  await createTable('crm_email_drafts', `
    CREATE TABLE crm_email_drafts (
      id BIGINT NOT NULL AUTO_INCREMENT,
      customer_id BIGINT NOT NULL,
      contact_id BIGINT NULL,
      owner_employee_id BIGINT NULL,
      to_email VARCHAR(150) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      reason VARCHAR(500) NULL,
      subject VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      generated_by VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      error VARCHAR(500) NULL,
      activity_id BIGINT NULL,
      created_by_user_id BIGINT NULL,
      sent_by_user_id BIGINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      sent_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_crm_email_drafts_status_owner (status, owner_employee_id),
      KEY idx_crm_email_drafts_customer (customer_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Addresses that clicked "unsubscribe". Keyed by address, not contact: the same person is often
  // on file under several customers, and asking to stop means stop.
  await createTable('crm_email_optouts', `
    CREATE TABLE crm_email_optouts (
      email VARCHAR(150) NOT NULL,
      opted_out_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source VARCHAR(30) NOT NULL DEFAULT 'unsubscribe_link',
      PRIMARY KEY (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  for (const t of ['crm_tags', 'customer_tags', 'crm_attention', 'crm_attention_snoozes', 'crm_email_drafts', 'crm_email_optouts']) {
    await matchCollation(t);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
