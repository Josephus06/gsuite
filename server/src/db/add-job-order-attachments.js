// Artist Attachments: the PDFs an artist produces for a job order -- the perspective drawing
// and the Cutting List / Bill of Materials -- kept against the JO so Sales can see what they
// are approving. A JO cannot be forwarded to Sales Approval with none attached.
//
// Stored as a LONGBLOB in MySQL rather than on disk: Railway app containers have no
// persistent volume of their own, so anything written to the filesystem is lost on the next
// deploy. The trade-off is that these rows grow the database volume, hence MAX_UPLOAD_BYTES
// in the route -- see routes/jobOrders.js.
//
// IDEMPOTENT: safe to re-run.
//
//   node src/db/add-job-order-attachments.js
const pool = require('../db');

const DDL = `
CREATE TABLE job_order_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_order_id BIGINT NOT NULL,
    kind VARCHAR(40) NOT NULL DEFAULT 'Perspective',
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    file_data LONGBLOB NOT NULL,
    uploaded_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_joa_job_order (job_order_id),
    CONSTRAINT fk_joa_job_order FOREIGN KEY (job_order_id) REFERENCES job_orders(id)
)`;

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'job_order_attachments'`
  );
  if (t.n) {
    console.log('  job_order_attachments already exists -- skipped.');
  } else {
    await pool.query(DDL);
    console.log('  job_order_attachments created.');
  }

  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM job_order_attachments');
  console.log(`\n${c.n} attachment(s) on file.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
