const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gsuite_erp',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  // Without this, mysql2 returns DATE/DATETIME columns as JS Date objects parsed in the
  // server's local timezone; res.json() then serializes them via toISOString() (UTC),
  // which silently shifts DATE values back a day in any timezone ahead of UTC (e.g.
  // 2026-08-01 local midnight -> "2026-07-31T16:00:00.000Z" at UTC+8). Every route
  // already treats date/datetime fields as strings (String(x).slice(0, 10)), so
  // returning them as raw strings instead of Date objects is a pure bug fix.
  dateStrings: true,
});

module.exports = pool;
