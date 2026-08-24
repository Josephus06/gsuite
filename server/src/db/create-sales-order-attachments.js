// Files attached to the sales order itself, alongside the ones it inherits from its estimate.
//
// The estimate's attachments are the paperwork the order was raised from and stay read-only
// on the order screen -- letting the order delete them would leave the two screens disagreeing
// about what was submitted. But an order picks up its own documents afterwards: a revised PO,
// a signed conforme, a delivery instruction. Those belong to the order, so they live here.
//
// Mirrors estimate_attachments column for column, including the longblob: attachments in this
// system are stored in the row, not on disk.
const pool = require('../db');

async function tableExists(name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

(async () => {
  try {
    if (await tableExists('sales_order_attachments')) {
      console.log('sales_order_attachments exists');
    } else {
      await pool.query(`
        CREATE TABLE sales_order_attachments (
          id BIGINT NOT NULL AUTO_INCREMENT,
          sales_order_id BIGINT NOT NULL,
          file_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(100) NOT NULL,
          size_bytes INT NOT NULL,
          file_data LONGBLOB NOT NULL,
          uploaded_by_user_id BIGINT DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_sales_order_attachments (sales_order_id),
          CONSTRAINT fk_sales_order_attachment FOREIGN KEY (sales_order_id)
            REFERENCES sales_orders (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('Created sales_order_attachments');
    }
    console.log('Done.');
    process.exit(0);
  } catch (err) { console.error(err); process.exit(1); }
})();
