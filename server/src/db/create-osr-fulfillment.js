// One-off migration: creates the OSR Fulfillment (OSRF-####) tables. Fulfilling an Office Supply
// Requisition creates one of these -- the document that actually moves the stock and posts the GL
// (DR 30504 Materials, Tools & Supplies / CR 15400 Supplies Inventory) and flips the OSR to served.
// No page of its own -- viewed from the OSR, reusing the OSR page's permission scope.
//
//   node src/db/create-osr-fulfillment.js
const pool = require('../db');
require('dotenv').config();

const TABLES = [
  ['osr_fulfillments', `
CREATE TABLE osr_fulfillments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    osrf_no VARCHAR(40) UNIQUE NOT NULL,
    osr_id BIGINT NOT NULL,
    date_created DATE NOT NULL,
    withdraw_from_location_id BIGINT NULL,
    transfer_to_location_id BIGINT NULL,
    requestor_id BIGINT NULL,
    memo VARCHAR(1000) NULL,
    total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'posted',
    created_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_osrf_osr (osr_id)
)`],
  ['osr_fulfillment_lines', `
CREATE TABLE osr_fulfillment_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    osrf_id BIGINT NOT NULL,
    osr_line_id BIGINT NULL,
    item_id BIGINT NULL,
    requested_qty DECIMAL(16,4) NOT NULL DEFAULT 0,
    fulfilled_qty DECIMAL(16,4) NOT NULL DEFAULT 0,
    uom VARCHAR(50) NULL,
    unit VARCHAR(50) NULL,
    cost DECIMAL(18,6) NOT NULL DEFAULT 0,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    INDEX idx_osrfl_parent (osrf_id)
)`],
];

async function tableExists(name) { const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]); return rows.length > 0; }

(async () => {
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
    for (const [name, ddl] of TABLES) {
      if (await tableExists(name)) console.log(`Table ${name} already exists.`);
      else { await pool.query(ddl); console.log(`Created table ${name}.`); }
    }
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
