// Lets people attach an image or a PDF to a ticket.
//
// A ticket is usually raised about something the person can SEE -- a broken screen, a wrong
// figure on a printout, a scanned form. Until now the only way to convey that was to describe
// it in prose, which is slow for them and ambiguous for whoever picks the ticket up.
//
// The file lives in the database, in a longblob, exactly as job_order_attachments already does.
// That is not the cheapest way to store files, but it is the same way the rest of this system
// stores them, and it means an attachment is covered by the same backup and the same
// replication as the ticket it belongs to -- a file on a disk on one of the two servers would
// be present on one side and missing on the other.
//
// Only images and PDFs are accepted, which is what was asked for and is also the narrower,
// safer choice: a ticket queue is exactly the kind of place someone would otherwise post an
// executable and expect the next person to open it.
//
// Idempotent -- safe to re-run:
//   node src/db/add-ticket-attachments.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[exists]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'ticket_attachments'`,
    [process.env.DB_NAME],
  );

  if (exists.n) {
    console.log('ticket_attachments already present.');
  } else {
    await pool.query(`
      CREATE TABLE ticket_attachments (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ticket_id BIGINT NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        size_bytes INT NOT NULL,
        file_data LONGBLOB NOT NULL,
        uploaded_by_user_id BIGINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_ticket_attachments_ticket (ticket_id),
        -- Deleting a ticket takes its attachments with it. They have no meaning on their own,
        -- and leaving orphaned blobs behind would quietly grow the volume forever.
        CONSTRAINT fk_ticket_attachments_ticket FOREIGN KEY (ticket_id)
          REFERENCES tickets(id) ON DELETE CASCADE,
        -- The uploader is kept for display only, so removing a user must not remove the
        -- evidence they attached -- it goes to NULL and the file stays.
        CONSTRAINT fk_ticket_attachments_user FOREIGN KEY (uploaded_by_user_id)
          REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log('ticket_attachments created.');
  }

  const [[n]] = await pool.query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM ticket_attachments',
  );
  console.log(`\nticket_attachments: ${n.n} file(s), ${(Number(n.bytes) / 1024 / 1024).toFixed(2)} MB.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
