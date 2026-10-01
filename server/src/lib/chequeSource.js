// How a live CHEQUE transaction maps onto the local cheques row -- shared by the importer, the
// status sync and the repair script so the three cannot drift apart again.
//
// STATUS. Live: OPEN / FULLY APPLIED / VOID (CANCELLED on old rows). FULLY APPLIED used to be
// folded into 'open', so a settled cheque read OPEN against live's FULLY APPLIED. It is kept as
// its own status; every consumer that matters (bank ledger, disbursement report, void/edit
// guards) tests `status <> 'void'`, so a settled cheque still posts and still prints.
function chequeStatus(liveStatus) {
  const v = String(liveStatus || '').trim().toUpperCase();
  if (v === 'VOID' || v === 'CANCELLED' || v === 'CANCELED') return 'void';
  if (v === 'FULLY APPLIED') return 'fully_applied';
  return 'open';
}

// PAYEE. Live keeps two things the importer used to collapse into one:
//   SysFK_Accnt_TransH + TransactionAccountType_TransH -> the Payee (a vendor/customer/employee)
//   PayeeName_TransH                                    -> Payee Name, free text (often the person
//                                                          who collected the cheque)
// The importer matched PayeeName_TransH against suppliers, so a cheque to vendor YUTYCO collected
// by RANDILL CAPARROSO was stored with no payee at all and printed RANDILL twice.
//
// payee_type uses the form's codes (VENDOR/CUSTOMER/EMPLOYEE) -- the importer wrote lower-case
// 'supplier' etc., which the edit form did not recognise.
const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

async function makePayeeResolver(pool) {
  const [sups] = await pool.query('SELECT id, name, live_pk FROM suppliers');
  const supByPk = new Map(sups.filter((s) => s.live_pk).map((s) => [s.live_pk, s.id]));
  const supByName = new Map(sups.map((s) => [norm(s.name), s.id]));
  const [custs] = await pool.query('SELECT id, name FROM customers');
  const custByName = new Map(custs.map((c) => [norm(c.name), c.id]));
  const [emps] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS nm FROM employees");
  const empByName = new Map(emps.map((e) => [norm(e.nm), e.id]));

  // h: the live transaction header; accountName: the payee account's Name_Accnt (from
  // transaction_account or the get_cheques list row).
  return function resolvePayee(h, accountName) {
    const liveType = String(h.TransactionAccountType_TransH || '').toUpperCase();
    const an = norm(accountName);
    // Employee (and some customer) payees come back with no transaction_account, so the typed
    // Payee Name is the only handle on them.
    const pn = norm(h.PayeeName_TransH);
    let payeeType = null; let payeeId = null;
    if (liveType === 'VENDOR' || (!liveType && an && supByName.has(an))) {
      payeeType = 'VENDOR'; payeeId = supByPk.get(h.SysFK_Accnt_TransH) || supByName.get(an) || null;
    } else if (liveType === 'CUSTOMER') {
      payeeType = 'CUSTOMER'; payeeId = custByName.get(an) || custByName.get(pn) || null;
    } else if (liveType === 'EMPLOYEE') {
      payeeType = 'EMPLOYEE'; payeeId = empByName.get(an) || empByName.get(pn) || null;
    }
    // Payee Name is what live printed; fall back to the account name when it was left blank.
    const payeeName = (h.PayeeName_TransH || '').trim() || accountName || null;
    return { payeeType, payeeId, payeeName };
  };
}

module.exports = { chequeStatus, makePayeeResolver };
