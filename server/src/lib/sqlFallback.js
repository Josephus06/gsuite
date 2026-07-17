const pool = require('../db');
const { resolveScope } = require('../routes/dashboard');
const { ticketVisibilityClause } = require('./ticketVisibility');

// Last-resort fallback for the chatbot when no hand-built intent matches: answer using
// an LLM instead of more regex.
//
// Tables fall into two kinds, handled differently:
// - "Owned" tables (estimates, sales_orders, job_orders, tickets) have a real per-user
//   visibility boundary (a rep only sees their own orders, etc). A regex/text check on
//   LLM-generated SQL can't reliably enforce that -- it can't catch an `IN (5, 12)` that
//   smuggles another rep's id in alongside the caller's own, and there's no SQL parser
//   here to verify it properly. So for non-admins these are never queried live: we
//   pre-fetch *only* the rows this user is already allowed to see (via the exact same
//   resolveScope()/ticketVisibilityClause() helpers the Dashboard and Tickets routes
//   use) and hand that fixed snapshot to the model as data. It structurally cannot
//   answer from anything outside that snapshot.
// - "Catalog" tables (customers, suppliers, inventories, service_items, departments,
//   chart_of_accounts) have no per-user ownership concept at all -- a price list or
//   customer directory isn't "owned" by anyone the way a sales order is. Text-to-SQL
//   against these is safe for every authenticated user, admin or not, so both paths can
//   use it.
// System Admin additionally gets the owned tables via validated SQL too, since an admin
// has no personal-scope boundary to begin with.
const OPENAI_MODEL = 'gpt-4o-mini';

const CATALOG_TABLES = [
  'customers', 'suppliers', 'departments', 'inventories', 'inventory_locations',
  'chart_of_accounts', 'service_items', 'employees',
];
const OWNED_TABLES = [
  'estimates', 'sales_orders', 'job_orders', 'tickets', 'purchase_orders',
  'purchase_requisitions', 'vendor_bills', 'sales_invoices',
];
// `users` (password_hash, JWT-relevant fields) and `audit_logs` (system internals) stay
// excluded entirely. `employees` has no sensitive columns (no salary/SSN/address, just
// name/department/position/contact info, the same fields anyone with Employees page
// view access already sees) so it's a catalog table like any other -- real SQL (a real
// COUNT(*), not the model hand-counting a JSON array) for aggregate/list questions.
// Single-named-person lookups still go through fetchEmployeeDirectory's pre-fetched
// snapshot instead (see findNameMatches) -- that's a different failure mode (the model
// picking the wrong row out of a long list), not one SQL fixes.
const ADMIN_ALLOWED_TABLES = [...CATALOG_TABLES, ...OWNED_TABLES];

const CATALOG_SCHEMA_DESCRIPTION = `
customers(id, customer_code, name, company_name, credit_limit, is_active)
suppliers(id, supplier_code, name, company_name, is_active)
departments(id, name, description, head_user_id, is_active)
inventories(id, item_code, display_name, item_type, selling_price, average_cost, reorder_point, is_active)
inventory_locations(id, inventory_id -> inventories.id, location_id, qty_on_hand, qty_committed)
chart_of_accounts(id, account_code, account_name, account_type, is_active)
service_items(id, item_code, display_name, unit_price, is_active)
employees(id, employee_code, first_name, last_name, department_id -> departments.id, position_title, is_active)
`.trim();

// Status/priority columns are stored as underscore_case machine values, not the
// human phrasing a question uses ("pending for customer approval" typed by a user is
// really the stored 'pending_customer_approval') -- spelling out the exact valid
// values here is what keeps a LIKE-based guess from confidently matching zero rows.
// The estimates/sales_orders lists are the real ENUM definitions (exhaustive); the
// rest are plain VARCHAR columns so the listed values are what's actually been
// observed in the data, not a guaranteed-exhaustive set.
const OWNED_SCHEMA_DESCRIPTION = `
estimates(id, estimate_no, date_created, customer_id -> customers.id, sales_division_id, contract_description, status [one of: pending_supervisor_approval, pending_customer_approval, approved, cancelled, disapproved], total_amount)
sales_orders(id, sales_order_no, estimate_id -> estimates.id, date_created, customer_id -> customers.id, sales_division_id, status [one of: pending_for_jo, jo_in_process, pending_delivery, partially_delivered, pending_billing, pending_billing_partially_delivered, billed, cancelled], total_amount)
job_orders(id, job_order_no, sales_order_id -> sales_orders.id, description, quantity, status [e.g. 'Planned - Pending for BOM', 'Released', 'Completed'], sub_status [e.g. 'For Artist', 'For Design Supervisor', 'Approved', 'For QI'], planned_start_at, planned_end_at, layout_started_at, layout_ended_at)
tickets(id, ticket_no, department_id -> departments.id, subject, description, status [one of: open, in_progress, resolved, closed], priority [one of: low, normal, high], created_at, resolved_at)
purchase_orders(id, po_no, date_created, supplier_id -> suppliers.id, status [e.g. 'pending_approval', 'pending_approval_gm', 'approved'], subtotal, net_of_tax, tax_amount)
purchase_requisitions(id, pr_no, date_created, department_id -> departments.id, status [e.g. 'pending_request', 'request_in_process'])
vendor_bills(id, bill_no, purchase_order_id -> purchase_orders.id, date_created, date_due, gross_amount)
sales_invoices(id, invoice_no, sales_order_id -> sales_orders.id, date_created, date_due, subtotal)
`.trim();

const FK_NOTE = 'Note: "X -> Y.id" means that column is a foreign key you can JOIN to table Y.';

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|into\s+outfile|load_file|call|exec)\b/i;

function extractTableNames(sql) {
  const names = [];
  const re = /\b(?:from|join)\s+`?(\w+)`?/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(sql))) names.push(m[1].toLowerCase());
  return names;
}

// The actual security boundary -- not the LLM's good behavior. `allowedTables` is the
// only thing that differs between the admin call site and the catalog-only call site.
function validateSql(sql, allowedTables) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (/;/.test(trimmed)) return { ok: false, reason: 'multiple statements' };
  if (!/^select\s/i.test(trimmed)) return { ok: false, reason: 'not a SELECT' };
  if (WRITE_KEYWORDS.test(trimmed)) return { ok: false, reason: 'write/DDL keyword' };
  if (/--|\/\*|#/.test(trimmed)) return { ok: false, reason: 'comment syntax' };

  const tables = extractTableNames(trimmed);
  if (tables.length === 0) return { ok: false, reason: 'no table referenced' };
  const disallowed = tables.filter((t) => !allowedTables.includes(t));
  if (disallowed.length) return { ok: false, reason: `disallowed table(s): ${disallowed.join(', ')}` };

  const withLimit = /\blimit\s+\d+/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 20`;
  return { ok: true, sql: withLimit };
}

async function chatCompletion(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function formatRows(rows) {
  if (!rows.length) return 'No matching records found.';
  return rows
    .slice(0, 20)
    .map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v ?? '—'}`).join(', '))
    .join('\n');
}

// Deliberately data, not text-to-SQL -- see the module comment. Text-to-SQL turned out
// to be unreliable specifically for personnel/org-directory questions (the model would
// self-refuse "what department is X in" even with the FK relationship spelled out,
// seemingly out of an overcautious reflex around anything shaped like an employee
// lookup). Handing over the directory as plain data sidesteps that reflex entirely and
// is small/cheap either way.
async function fetchEmployeeDirectory() {
  const [rows] = await pool.query(
    `SELECT e.first_name, e.last_name, d.name AS department_name, e.position_title,
            e.is_active, u.is_supervisor
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.employee_id = e.id
     LIMIT 400`
  );
  return rows;
}

// A 271-row JSON array is enough for the model to reliably lose track of which row is
// which -- verified this directly: fed it a directory containing the single correct
// row for "Arjie Bayagna" (department: Sales - 1) and it still answered "Production -
// DPOD" 100% of the time across repeated identical calls, even at temperature 0. Not
// randomness -- a "lost in a long list" failure. Pulling out anyone actually named in
// the question into their own small, unambiguous block fixes it: the model doesn't
// have to find the needle in the haystack if the needle is handed over separately.
function findNameMatches(question, directory) {
  const q = question.toLowerCase();
  return directory.filter((row) => {
    const first = (row.first_name || '').toLowerCase();
    const last = (row.last_name || '').toLowerCase();
    return (first.length > 2 && q.includes(first)) || (last.length > 2 && q.includes(last));
  });
}

async function answerAsAdmin(question) {
  const directory = await fetchEmployeeDirectory();
  const namedMatches = findNameMatches(question, directory);

  const rawSql = await chatCompletion([
    {
      role: 'system',
      content: `You translate questions about an ERP's data into a single read-only MySQL SELECT statement, OR answer directly from pre-fetched employee directory data when that's sufficient.
Schema (only these tables/columns exist and may be used for SQL):
${CATALOG_SCHEMA_DESCRIPTION}
${OWNED_SCHEMA_DESCRIPTION}
${FK_NOTE}
${namedMatches.length ? `DIRECTLY_NAMED_EMPLOYEE(S) (extracted from the question -- this is the authoritative, exact data for them, use this over anything else for facts about them):
${JSON.stringify(namedMatches)}
` : ''}EMPLOYEE_DIRECTORY_DATA (already fetched -- use ONLY for a question about one specific named person, e.g. "what department is X in". Do NOT use this for counts, totals, or lists spanning multiple employees -- you're prone to mis-counting a long JSON array by hand. For those, write a real SQL query against employees/departments instead, e.g. SELECT COUNT(*) FROM employees WHERE is_active = TRUE):
${JSON.stringify(directory)}
Rules:
- If the question is about ONE specific named person and EMPLOYEE_DIRECTORY_DATA/DIRECTLY_NAMED_EMPLOYEE(S) answers it, output the answer as plain text prefixed with "ANSWER: " (one or two sentences, no markdown).
- If the question isn't about this database at all -- general knowledge, unit conversion, plain arithmetic (e.g. "how many sqft is 2x2 ft") -- just answer it directly, prefixed with "ANSWER: ". Don't refuse or force it into a SQL query it was never asking for.
- Otherwise output ONLY a SQL statement. No markdown fences, no explanation, no trailing semicolon.
- SELECT only -- never write/modify data.
- Only reference the tables listed in the schema. Do not invent columns.
- Always include a LIMIT clause (20 or fewer rows) unless the question asks for a single aggregate.
- For name/code lookups, use LIKE '%...%' rather than an exact match unless the user gave a full, exact code -- a real item/customer/etc. is often referenced by a partial or approximate name. For status/priority columns, use an EXACT match (=) against one of the listed values -- never LIKE a human phrasing like "pending for customer approval" against the real stored value 'pending_customer_approval', map it to the exact value first.
- Zero rows back is a perfectly good, honest answer ("no matching record"). Prefer writing a best-effort query over refusing -- only output NO_QUERY if the question is about something genuinely outside this schema entirely (e.g. asks to modify data, or about a topic no table here covers).`,
    },
    { role: 'user', content: question },
  ]);
  if (!rawSql || rawSql === 'NO_QUERY') return null;
  if (rawSql.startsWith('ANSWER:')) return rawSql.slice('ANSWER:'.length).trim();

  const { ok, sql, reason } = validateSql(rawSql, ADMIN_ALLOWED_TABLES);
  if (!ok) return `I couldn't safely answer that (${reason}). Try rephrasing.`;

  const [rows] = await pool.query(sql);
  return formatRows(rows);
}

// Real GROUP BY counts, uncapped -- the detail rows below are capped at 150 for
// prompt size, so asking the model to count "how many of my estimates are X" by
// scanning that array is exactly the same "lost in a long list" failure as the
// employee-count bug (verified: a rep with 50 estimates got a wrong count back that
// didn't match the data or even the fetched subset). Handing over the exact
// pre-computed breakdown removes the need for the model to count anything itself.
async function countByStatus(fromSql, alias, whereSql, params, statusCol = 'status') {
  const [rows] = await pool.query(
    `SELECT ${alias}.${statusCol} AS status, COUNT(*) AS count FROM ${fromSql} WHERE ${whereSql} GROUP BY ${alias}.${statusCol}`,
    params
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// Pulls exactly what resolveScope()/ticketVisibilityClause() already say this user may
// see -- the same helpers backing the Dashboard and Tickets routes -- capped per table
// so the prompt stays small. Nothing here is LLM-controlled.
async function fetchOwnScopeSnapshot(user) {
  const scope = await resolveScope(user.id);
  const employeeIds = scope.employeeIds || [];
  const snapshot = {};

  if (employeeIds.length) {
    const placeholders = employeeIds.map(() => '?').join(', ');
    const [estimates] = await pool.query(
      `SELECT e.estimate_no, e.date_created, e.status, e.total_amount, c.name AS customer_name
       FROM estimates e LEFT JOIN customers c ON c.id = e.customer_id
       WHERE e.sales_rep_id IN (${placeholders}) ORDER BY e.date_created DESC LIMIT 150`,
      employeeIds
    );
    const [salesOrders] = await pool.query(
      `SELECT so.sales_order_no, so.date_created, so.status, so.total_amount, c.name AS customer_name
       FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
       WHERE so.sales_rep_id IN (${placeholders}) ORDER BY so.date_created DESC LIMIT 150`,
      employeeIds
    );
    const [jobOrders] = await pool.query(
      `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.quantity, c.name AS customer_name,
              CONCAT(ar.first_name, ' ', ar.last_name) AS artist_name
       FROM job_orders jo
       JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN employees ar ON ar.id = jo.artist_id
       WHERE so.sales_rep_id IN (${placeholders}) ORDER BY jo.id DESC LIMIT 150`,
      employeeIds
    );
    snapshot.estimates = estimates;
    snapshot.sales_orders = salesOrders;
    snapshot.job_orders = jobOrders;
    snapshot.estimates_count_by_status = await countByStatus('estimates e', 'e', `e.sales_rep_id IN (${placeholders})`, employeeIds);
    snapshot.sales_orders_count_by_status = await countByStatus('sales_orders so', 'so', `so.sales_rep_id IN (${placeholders})`, employeeIds);
    snapshot.job_orders_count_by_status = await countByStatus(
      'job_orders jo JOIN sales_orders so ON so.id = jo.sales_order_id', 'jo',
      `so.sales_rep_id IN (${placeholders})`, employeeIds
    );
  }

  // Sales-rep scope (above) doesn't cover an artist's own assigned work -- job_orders
  // links to an artist via artist_id directly, not through the sales order's rep.
  // Mirrors assignedJobOrders.js's own GET / scoping (WHERE artist_id = own employee_id).
  const [[me]] = await pool.query('SELECT employee_id FROM users WHERE id = ?', [user.id]);
  if (me?.employee_id) {
    const [assignedAsArtist] = await pool.query(
      `SELECT jo.job_order_no, jo.status, jo.sub_status, jo.description, jo.quantity, c.name AS customer_name
       FROM job_orders jo
       LEFT JOIN sales_orders so ON so.id = jo.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       WHERE jo.artist_id = ? ORDER BY jo.id DESC LIMIT 150`,
      [me.employee_id]
    );
    if (assignedAsArtist.length) {
      const existing = snapshot.job_orders || [];
      const seen = new Set(existing.map((r) => r.job_order_no));
      snapshot.job_orders = [...existing, ...assignedAsArtist.filter((r) => !seen.has(r.job_order_no))];
    }
    const artistCounts = await countByStatus('job_orders jo', 'jo', 'jo.artist_id = ?', [me.employee_id]);
    const merged = { ...(snapshot.job_orders_count_by_status || {}) };
    for (const [status, count] of Object.entries(artistCounts)) merged[status] = (merged[status] || 0) + count;
    if (Object.keys(merged).length) snapshot.job_orders_count_by_status = merged;
  }

  const { sql: ticketSql, params: ticketParams } = await ticketVisibilityClause(user.id);
  const [tickets] = await pool.query(
    `SELECT t.ticket_no, d.name AS department_name, t.subject, t.status, t.priority, t.created_at
     FROM tickets t JOIN departments d ON d.id = t.department_id
     WHERE ${ticketSql} ORDER BY t.id DESC LIMIT 100`,
    ticketParams
  );
  snapshot.tickets = tickets;
  snapshot.tickets_count_by_status = await countByStatus('tickets t', 't', ticketSql, ticketParams);

  // Basic org-directory info (not personal-scope data) -- available to everyone
  // regardless of sales/artist/ticket scope, same as walking up to a coworker and
  // asking "what department is X in" or "is X still active". No email/phone here
  // since this path, unlike the Employees page itself, has no page-permission gate.
  snapshot.employee_directory = await fetchEmployeeDirectory();

  return snapshot;
}

async function answerFromOwnScope(user, question) {
  const snapshot = await fetchOwnScopeSnapshot(user);
  const namedMatches = findNameMatches(question, snapshot.employee_directory);

  const rawReply = await chatCompletion([
    {
      role: 'system',
      content: `You answer questions about an ERP user's own data. Two sources are available:

1. OWN_DATA below -- this user's own estimates/sales_orders/job_orders/tickets (or their team's, if they're a supervisor), plus a general employee_directory (name/department/position/active-status for any employee, not personal) for looking up ONE specific named person. This is fixed, already-fetched data -- use it directly, don't write SQL for it, and never claim to know anything about these topics beyond what's here. For "how many of my X are status Y" questions, use the matching *_count_by_status object (e.g. estimates_count_by_status) -- it's an exact, pre-computed breakdown, so use it instead of counting the estimates/sales_orders/job_orders/tickets arrays by hand, which you're prone to getting wrong on a long list. Status values there are the real stored values (e.g. 'pending_customer_approval'), not English phrasing -- match the closest one.
${namedMatches.length ? `DIRECTLY_NAMED_EMPLOYEE(S) (extracted from the question -- this is the authoritative, exact data for them within employee_directory, use this over anything else for facts about them):
${JSON.stringify(namedMatches)}
` : ''}OWN_DATA:
${JSON.stringify(snapshot)}

2. A separate read-only SQL option for catalog/reference data (item pricing, customer/supplier directory, chart of accounts, employees/departments) -- this data isn't personal to any one user, so it's fine to query live. For counts, totals, or lists spanning multiple employees specifically (not OWN_DATA's single-named-person case above), use this instead of counting employee_directory by hand -- e.g. SELECT COUNT(*) FROM employees WHERE is_active = TRUE:
${CATALOG_SCHEMA_DESCRIPTION}
${FK_NOTE}

Rules:
- If OWN_DATA (or DIRECTLY_NAMED_EMPLOYEE(S)) answers the question, reply with plain text (one or two sentences, no markdown, no prefix).
- If the question isn't about this database at all -- general knowledge, unit conversion, plain arithmetic (e.g. "how many sqft is 2x2 ft") -- just answer it directly as plain text. Don't force it into a SQL query it was never asking for.
- If it needs the catalog schema instead, output ONLY a SQL SELECT statement (no markdown fences, no explanation, no trailing semicolon, no write/DDL keywords, only the tables listed above, include a LIMIT of 20 or fewer unless it's a single aggregate). For name/code lookups use LIKE '%...%' rather than an exact match unless given a full, exact code. For status/priority columns use an EXACT match against a real stored value, not a LIKE against human phrasing. Zero rows back is a fine, honest answer -- prefer writing a best-effort query over refusing.
- Never write SQL referencing estimates, sales_orders, job_orders, tickets, or users -- those come only from OWN_DATA (users isn't available anywhere).
- If neither source can answer it, reply in plain text saying so.`,
    },
    { role: 'user', content: question },
  ]);

  const trimmed = rawReply.trim();
  if (/^select\s/i.test(trimmed)) {
    const { ok, sql, reason } = validateSql(trimmed, CATALOG_TABLES);
    if (!ok) return `I couldn't safely answer that (${reason}). Try rephrasing.`;
    const [rows] = await pool.query(sql);
    return formatRows(rows);
  }
  return trimmed;
}

async function runSqlFallback(user, question) {
  if (!process.env.OPENAI_API_KEY) return null;

  const [[row]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [user.id]);
  const isAdmin = row?.account_type === 'System Admin';

  return isAdmin ? answerAsAdmin(question) : answerFromOwnScope(user, question);
}

module.exports = { runSqlFallback, validateSql, ADMIN_ALLOWED_TABLES, CATALOG_TABLES };
