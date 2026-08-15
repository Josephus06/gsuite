// Creates the tables behind the customer-facing quote site's product catalog.
//
// The site offers a short list of common products -- Picture Frame (wood), Menu (Sintra Board),
// Flyers, Yearbook -- each one a pre-built estimate the customer can adjust. Rather than invent a
// second pricing model, a web product is a THIN POINTER at what the ERP already has: a job type,
// and a set of process + material lines with default sizes and quantities. Pricing then runs
// through shared/costing.js, the same code the estimate wizard uses, so a customer's quote and an
// in-house estimate for identical inputs cannot disagree.
//
//   web_products        one row per product on the site
//   web_product_lines   its default process/material lines -- the estimate skeleton
//
// A line mirrors the fields estimate_job_order_processes needs to price: process_id (the costing
// bracket source), item_id (the material), default size and quantity, and per-field flags for
// what the customer is allowed to change. The customer edits values, never which process or
// material is used -- that is the shop's decision, not theirs.
//
// Idempotent -- safe to re-run:
//   node src/db/add-web-products.js
const pool = require('../db');
require('dotenv').config();

async function main() {
  console.log(`Local DB: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_products (
      id               BIGINT NOT NULL AUTO_INCREMENT,
      slug             VARCHAR(80)  NOT NULL,
      name             VARCHAR(160) NOT NULL,
      tagline          VARCHAR(255) NULL,
      description      TEXT         NULL,
      image_url        VARCHAR(500) NULL,
      job_type_id      BIGINT       NULL,
      -- The estimate this product creates is booked to Marketing; kept as columns rather than
      -- hard-coded so a rename or a second web division does not need a code change.
      sales_division_id BIGINT      NULL,
      department_id    BIGINT       NULL,
      -- Quantity the site quotes by default, and the range a customer may ask for.
      default_qty      DECIMAL(14,4) NOT NULL DEFAULT 1,
      min_qty          DECIMAL(14,4) NOT NULL DEFAULT 1,
      max_qty          DECIMAL(14,4) NULL,
      lead_time_days   INT          NULL,
      sort_order       INT          NOT NULL DEFAULT 0,
      is_published     TINYINT      NOT NULL DEFAULT 0,
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_web_product_slug (slug),
      KEY idx_published (is_published, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('web_products ready.');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_product_lines (
      id                BIGINT NOT NULL AUTO_INCREMENT,
      web_product_id    BIGINT NOT NULL,
      line_no           INT    NOT NULL DEFAULT 1,
      label             VARCHAR(160) NULL,
      process_id        BIGINT NULL,
      item_id           BIGINT NULL,
      -- Defaults the customer starts from; the same fields an estimate process line prices on.
      default_process_qty DECIMAL(14,4) NULL,
      default_qty       DECIMAL(14,4) NULL,
      default_length    DECIMAL(14,4) NULL,
      default_width     DECIMAL(14,4) NULL,
      uom               VARCHAR(20)  NULL,
      -- What the customer may change. Size and quantity are editable by default because that is
      -- the whole point of the builder; the process and material never are.
      allow_qty         TINYINT NOT NULL DEFAULT 1,
      allow_size        TINYINT NOT NULL DEFAULT 1,
      min_length        DECIMAL(14,4) NULL,
      max_length        DECIMAL(14,4) NULL,
      min_width         DECIMAL(14,4) NULL,
      max_width         DECIMAL(14,4) NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_product (web_product_id, line_no),
      CONSTRAINT fk_web_product_line_product FOREIGN KEY (web_product_id)
        REFERENCES web_products (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('web_product_lines ready.');

  // Where a web quote lands. Marketing exists as both a department and a sales division here;
  // resolved by name so this does not bake in ids that differ between local and Railway.
  const [[dept]] = await pool.query("SELECT id FROM departments WHERE name = 'Marketing' LIMIT 1");
  const [[div]] = await pool.query("SELECT id FROM sales_divisions WHERE name = 'Marketing' LIMIT 1");
  console.log(`Marketing department: ${dept ? dept.id : 'NOT FOUND'} | sales division: ${div ? div.id : 'NOT FOUND'}`);

  // Marks the customers a web quote creates, so Sales can tell them from ones they raised and
  // the site can find a returning visitor by email instead of duplicating them.
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'customers' AND COLUMN_NAME = 'source'`,
    [process.env.DB_NAME]
  );
  if (!cols.length) {
    await pool.query("ALTER TABLE customers ADD COLUMN source VARCHAR(20) NULL");
    console.log('customers.source added.');
  } else {
    console.log('customers.source already present.');
  }

  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM web_products');
  console.log(`web_products holds ${n.n} row(s).`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
