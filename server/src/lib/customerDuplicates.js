// One customer per name (asked 2026-10-03: "don't allow duplicate saving of customer"). Two
// customers are the same name when they agree after dropping case, spaces and punctuation --
// "ADR GLOBAL TRANSPORT INC." and "ADR GLOBAL TRANSPORT, INC." are one company, as are the two
// "ARLYN CHING" rows saved a minute apart on 2026-10-02. 153 such groups were already on file
// then; this stops new ones, it does not merge the old.
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The existing customer a name would duplicate, or null. `excludeId` skips the record being
// edited, so re-saving a customer under its own name is not a clash.
async function findCustomerByName(conn, name, excludeId = null) {
  const key = nameKey(name);
  if (!key) return null;
  const [[row]] = await conn.query(
    `SELECT id, name, customer_code FROM customers
      WHERE LOWER(REGEXP_REPLACE(name, '[^A-Za-z0-9]', '')) = ? AND id <> ?
      ORDER BY id LIMIT 1`,
    [key, excludeId || 0]);
  return row || null;
}

function duplicateMessage(existing) {
  return `A customer named "${existing.name}"${existing.customer_code ? ` (${existing.customer_code})` : ''} already exists. Use that customer instead of saving another.`;
}

module.exports = { nameKey, findCustomerByName, duplicateMessage };
