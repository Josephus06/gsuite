// One-off migration for the device gate (lib/deviceGate.js, 2026-11-20):
//   - registered_devices          one row per device that asked for access
//   - app_settings rows           device_gate_enabled = '0' (OFF -- nothing changes until an admin
//                                 switches it on), device_gate_networks = the office networks
//   - pages /registered-devices   System > Registered Devices, full access for every System Admin
//
//   node src/db/create-device-gate.js [--dry-run] [--networks=14.1.64.248,192.168.0.0/16]
//
// The droplet, office and SM boxes replicate: run on ONE box (the droplet). Railway has its own
// database: run it there separately. --networks only seeds an EMPTY list; edit it on the page after.
const pool = require('../db');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const netArg = (process.argv.find((a) => a.startsWith('--networks=')) || '').slice('--networks='.length);
// The head office's public address (seen from the droplet, 2026-11-20) and the private LAN ranges the
// office / SM servers' own users come from.
const DEFAULT_NETWORKS = netArg || '14.1.64.248,192.168.0.0/16';
const PAGE = { route: '/registered-devices', name: 'Registered Devices', module: 'System' };

async function main() {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`DB: ${db}${DRY_RUN ? ' -- DRY RUN' : ''}`);

  const [exists] = await pool.query("SHOW TABLES LIKE 'registered_devices'");
  if (exists.length) console.log('  = registered_devices already exists');
  else if (DRY_RUN) console.log('  ~ would create registered_devices');
  else {
    await pool.query(`CREATE TABLE registered_devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        key_hash CHAR(64) NOT NULL,
        device_name VARCHAR(100) NOT NULL,
        user_agent VARCHAR(255) NULL,
        status ENUM('pending','approved','rejected','revoked') NOT NULL DEFAULT 'pending',
        requested_by INT NULL,
        requested_ip VARCHAR(64) NULL,
        requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        decided_by INT NULL,
        decided_at DATETIME NULL,
        last_seen_at DATETIME NULL,
        last_seen_ip VARCHAR(64) NULL,
        UNIQUE KEY uq_registered_devices_key (key_hash),
        KEY idx_registered_devices_status (status, requested_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('  + created registered_devices');
  }

  const [appSettings] = await pool.query("SHOW TABLES LIKE 'app_settings'");
  if (!appSettings.length) throw new Error('app_settings is missing -- run create-app-settings.js first.');
  if (DRY_RUN) console.log(`  ~ would seed device_gate_enabled = 0, device_gate_networks = ${DEFAULT_NETWORKS} (if unset)`);
  else {
    await pool.query("INSERT IGNORE INTO app_settings (name, value) VALUES ('device_gate_enabled', '0')");
    await pool.query("INSERT IGNORE INTO app_settings (name, value) VALUES ('device_gate_networks', ?)", [DEFAULT_NETWORKS]);
    const [rows] = await pool.query("SELECT name, value FROM app_settings WHERE name LIKE 'device_gate_%'");
    for (const r of rows) console.log(`  ${r.name} = ${r.value}`);
  }

  const [admins] = await pool.query("SELECT id, display_name FROM users WHERE account_type = 'System Admin' AND is_active = TRUE");
  let [[page]] = await pool.query('SELECT id FROM pages WHERE route = ?', [PAGE.route]);
  if (page) console.log(`  = page ${PAGE.route} already registered (id ${page.id})`);
  else if (DRY_RUN) console.log(`  ~ would register ${PAGE.route}`);
  else {
    const [cols] = await pool.query('SHOW COLUMNS FROM pages');
    const has = new Set(cols.map((c) => c.Field));
    const fields = ['route', 'name']; const values = [PAGE.route, PAGE.name];
    if (has.has('module')) { fields.push('module'); values.push(PAGE.module); }
    const [r] = await pool.query(`INSERT INTO pages (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
    page = { id: r.insertId };
    console.log(`  + registered ${PAGE.route} (id ${page.id})`);
  }
  if (page && !DRY_RUN) {
    for (const u of admins) {
      const [[existing]] = await pool.query('SELECT id FROM user_page_permissions WHERE user_id = ? AND page_id = ?', [u.id, page.id]);
      if (existing) await pool.query('UPDATE user_page_permissions SET can_view=TRUE, can_add=TRUE, can_edit=TRUE, can_delete=TRUE, can_approve=TRUE WHERE id = ?', [existing.id]);
      else await pool.query('INSERT INTO user_page_permissions (user_id, page_id, can_view, can_add, can_edit, can_delete, can_approve) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, TRUE)', [u.id, page.id]);
    }
    console.log(`  + full access for ${admins.length} System Admin(s)`);
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
