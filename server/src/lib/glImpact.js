const pool = require('../db');
const { booksStart, openingGlLines } = require('./openingBalances');
const { depositGlRows } = require('./depositGl');

// ---------------------------------------------------------------------------------------
// Run-scoped reference-data cache.
//
// The compute*Gl functions below each re-read the same reference rows -- the chart of
// accounts, tax codes, process cost brackets -- once per source document. That is invisible
// when they're called one document at a time, which is how the per-transaction GL Impact
// tabs call them. But a report run walks tens of thousands of documents, and those repeated
// reads were ~60% of its queries (e.g. 2,732 identical lookups of account 12100 for a single
// month of data). All three tables are tiny (276 accounts, 1 tax, 2,147 brackets), so one
// snapshot serves an entire run.
//
// The snapshot exists ONLY while a getPostedGlLines run is in flight. Outside a run these
// helpers read straight through to the DB, so the GL Impact tabs never see a cached row and
// an edited account or cost bracket takes effect immediately. Nested/overlapping runs are
// refcounted, and the in-flight promise is shared so concurrent runs load it once.
let refRuns = 0;
let refSnapshotPromise = null;

async function loadRefSnapshot() {
  const [coa] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts');
  const [taxes] = await pool.query('SELECT code, tax_account_id FROM taxes');
  const [brackets] = await pool.query('SELECT * FROM process_cost_brackets WHERE is_active = TRUE ORDER BY qty_min');
  const bracketsByProcess = new Map();
  for (const b of brackets) {
    if (!bracketsByProcess.has(b.process_id)) bracketsByProcess.set(b.process_id, []);
    bracketsByProcess.get(b.process_id).push(b);
  }
  return {
    coaById: new Map(coa.map((c) => [c.id, c])),
    coaByCode: new Map(coa.map((c) => [c.account_code, c])),
    taxByCode: new Map(taxes.map((t) => [t.code, t])),
    bracketsByProcess,
  };
}

async function beginRefRun() {
  refRuns += 1;
  if (!refSnapshotPromise) refSnapshotPromise = loadRefSnapshot();
  try { await refSnapshotPromise; } catch (e) { endRefRun(); throw e; }
}
function endRefRun() {
  refRuns -= 1;
  if (refRuns <= 0) { refRuns = 0; refSnapshotPromise = null; }
}
// Non-null only while a run is active -- that's what makes read-through the default.
async function snapshot() {
  return refRuns && refSnapshotPromise ? refSnapshotPromise : null;
}

// Reference-data accessors. Each returns the same shape its original inline query did, so
// callers are unchanged apart from swapping the query for the helper. `db` lets a caller
// pass a transaction connection for the read-through path.
async function coaByCode(code, db = pool) {
  const snap = await snapshot();
  if (snap) return snap.coaByCode.get(code) || null;
  const [[r]] = await db.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE account_code = ?', [code]);
  return r || null;
}
async function coaById(id, db = pool) {
  if (!id) return null;
  const snap = await snapshot();
  if (snap) return snap.coaById.get(id) || null;
  const [[r]] = await db.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id = ?', [id]);
  return r || null;
}
async function coaByIds(ids, db = pool) {
  if (!ids || !ids.length) return [];
  const snap = await snapshot();
  if (snap) return ids.map((id) => snap.coaById.get(id)).filter(Boolean);
  const [rows] = await db.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [ids]);
  return rows;
}
async function taxByCode(code, db = pool) {
  const snap = await snapshot();
  if (snap) return snap.taxByCode.get(code) || null;
  const [[r]] = await db.query('SELECT tax_account_id FROM taxes WHERE code = ?', [code]);
  return r || null;
}
async function bracketsForProcesses(processIds, db = pool) {
  const byProcess = new Map();
  if (!processIds || !processIds.length) return byProcess;
  const snap = await snapshot();
  if (snap) {
    for (const pid of processIds) if (snap.bracketsByProcess.has(pid)) byProcess.set(pid, snap.bracketsByProcess.get(pid));
    return byProcess;
  }
  const [brackets] = await db.query(
    'SELECT * FROM process_cost_brackets WHERE process_id IN (?) AND is_active = TRUE ORDER BY qty_min', [processIds]);
  for (const b of brackets) {
    if (!byProcess.has(b.process_id)) byProcess.set(b.process_id, []);
    byProcess.get(b.process_id).push(b);
  }
  return byProcess;
}
// ---------------------------------------------------------------------------------------

// GL Impact: standard revenue-recognition entry, reverse-engineered directly from the
// real system's sandbox (10 real invoices checked across different customers/amounts --
// always the exact same 3 accounts, no per-customer or per-item variation): debit
// Accounts Receivable Trade for the invoice's gross total, credit Sales for the
// net-of-tax amount, credit VAT on Sales for the tax. Unlike Assembly Build/Item
// Delivery's inventory-category routing, AR and Sales are genuinely fixed accounts here
// (confirmed by the real data, not assumed) -- only VAT is routed per tax code, via
// taxes.tax_account_id, since sales_invoice_lines carries a tax_code per line (a string
// snapshot, not a FK) and a future second tax code should route correctly rather than
// silently landing on the wrong account.
async function computeSalesInvoiceGl(si, lines) {
  const arAcct = await coaByCode('12100');
  const salesAcct = await coaByCode('30100');
  if (!arAcct || !salesAcct) return [];

  const rows = [];
  const grossAmount = Number(si.gross_amount) || 0;
  const netOfTax = Number(si.net_of_tax) || 0;
  if (grossAmount) rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: grossAmount, credit: 0 });

  // A line billing an inventory item (a standalone invoice's lines -- RENTAL, say) credits that
  // item's own income account; everything else, and any item with none set, credits Sales. The
  // split is taken out of the header's Net of Tax, so the entry balances exactly as it always did.
  const incomeByAccount = new Map(); // account id -> net
  const itemLines = lines.filter((l) => l.item_id && Number(l.net_of_tax));
  if (itemLines.length) {
    const missing = [...new Set(itemLines.filter((l) => l.income_account_id === undefined).map((l) => l.item_id))];
    const incomeOf = new Map(itemLines.filter((l) => l.income_account_id !== undefined).map((l) => [l.item_id, l.income_account_id]));
    if (missing.length) {
      const [inv] = await pool.query('SELECT id, income_account_id FROM inventories WHERE id IN (?)', [missing]);
      for (const i of inv) incomeOf.set(i.id, i.income_account_id);
    }
    for (const l of itemLines) {
      const acctId = incomeOf.get(l.item_id);
      if (acctId) incomeByAccount.set(acctId, (incomeByAccount.get(acctId) || 0) + Number(l.net_of_tax));
    }
  }
  let toSales = netOfTax;
  for (const [acctId, amt] of incomeByAccount) {
    const acct = await coaById(acctId);
    if (!acct) continue;
    const credit = Number(amt.toFixed(2));
    rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit });
    toSales -= credit;
  }
  toSales = Number(toSales.toFixed(2));
  if (toSales) rows.push({ account_code: salesAcct.account_code, account_name: salesAcct.account_name, debit: 0, credit: toSales });

  const taxTotals = new Map(); // tax_code -> amount
  for (const l of lines) {
    const amt = Number(l.tax_amount) || 0;
    if (!amt) continue;
    taxTotals.set(l.tax_code || null, (taxTotals.get(l.tax_code || null) || 0) + amt);
  }
  if (taxTotals.size === 0 && Number(si.tax_amount)) taxTotals.set(null, Number(si.tax_amount));

  for (const [code, amt] of taxTotals) {
    let acct = null;
    if (code) {
      const t = await taxByCode(code);
      if (t?.tax_account_id) acct = await coaById(t.tax_account_id);
    }
    if (!acct) acct = await coaByCode('21100');
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amt.toFixed(2)) });
  }
  return rows;
}

// GL Impact: a standard manufacturing cost-absorption entry, derived live (not
// persisted as real ledger rows -- no Journal/GL module in this build, same convention
// already used by Inventory Adjustment's GL Impact tab). Reverse-engineered directly
// from the real system's sandbox (Assembly Build > GL Impact tab, live API's
// transaction_transactionledgerentries): debit Finished Goods Inventory (the build's
// Job Type's own asset account) for the total cost; credit each process line's material
// cost to that item's own asset account (falling back to a generic "Direct Materials"
// account for non-inventory items like a labor placeholder); credit the labor/overhead
// portion of each line's process cost split across Direct Labor / Indirect Labor /
// Depreciation-FOH / Repairs&Maintenance-FOH / Electricity Expense / Materials-Tools&
// Supplies, using the *ratio* of those components on the process's current cost bracket
// (matched by this line's Total Qty to Build) -- ratios only, applied to the already-
// stored process_cost, so the split always sums exactly to the real persisted total even
// if bracket rates changed since the line's cost was first computed.
const ASSEMBLY_BUILD_FIXED_GL_CODES = {
  directLabor: '30402', indirectLabor: '30501', powerEquipment: '30627',
  depreciation: '30507', repairsMaintenance: '30513', indirectMaterials: '30504',
  // click_charge/ink_cost/other_charges have no confirmed real-system mapping (never
  // observed non-zero on the live sandbox samples used to reverse-engineer this) --
  // bucketed into Direct Materials as the closest sensible account, same fallback used
  // for material cost on non-inventory items.
  directMaterials: '30401',
};

async function computeAssemblyBuildGl(conn, ab, lines) {
  if (!ab.fg_account_id) return [];

  const coaRows = [
    await coaById(ab.fg_account_id, conn),
    ...await Promise.all(Object.values(ASSEMBLY_BUILD_FIXED_GL_CODES).map((c) => coaByCode(c, conn))),
    ...await coaByIds([...new Set(lines.map((l) => l.item_asset_account_id).filter(Boolean))], conn),
  ].filter(Boolean);
  const acctById = new Map(coaRows.map((c) => [c.id, c]));
  const acctByCode = new Map(coaRows.map((c) => [c.account_code, c]));

  const bracketsByProcess = await bracketsForProcesses(
    [...new Set(lines.map((l) => l.process_id).filter(Boolean))], conn);

  const credits = new Map(); // account_id -> amount
  function credit(accountId, amount) {
    if (!accountId || !amount) return;
    credits.set(accountId, (credits.get(accountId) || 0) + amount);
  }

  for (const line of lines) {
    const materialCost = Number(line.material_cost) || 0;
    if (materialCost) {
      const acct = line.item_asset_account_id ? acctById.get(line.item_asset_account_id) : null;
      credit(acct ? acct.id : acctByCode.get(ASSEMBLY_BUILD_FIXED_GL_CODES.directMaterials)?.id, materialCost);
    }

    const processCost = Number(line.process_cost) || 0;
    if (processCost) {
      const bracketList = bracketsByProcess.get(line.process_id) || [];
      const qtyBasis = Number(line.total_qty_to_build) || 0;
      const bracket = bracketList.find((b) => qtyBasis >= Number(b.qty_min) && qtyBasis <= Number(b.qty_max)) || bracketList[0];

      const components = bracket ? {
        [ASSEMBLY_BUILD_FIXED_GL_CODES.directLabor]: Number(bracket.direct_labor) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.indirectLabor]: Number(bracket.moh_indirect_labor) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.powerEquipment]: Number(bracket.moh_power_equipment) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.depreciation]: Number(bracket.moh_depreciation) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.repairsMaintenance]: Number(bracket.moh_repairs_maintenance) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.indirectMaterials]: Number(bracket.moh_indirect_materials) || 0,
        [ASSEMBLY_BUILD_FIXED_GL_CODES.directMaterials]: (Number(bracket.click_charge) || 0) + (Number(bracket.ink_cost) || 0) + (Number(bracket.other_charges) || 0),
      } : {};
      const componentTotal = Object.values(components).reduce((a, b) => a + b, 0);

      if (componentTotal > 0) {
        for (const [code, amount] of Object.entries(components)) {
          if (!amount) continue;
          credit(acctByCode.get(code)?.id, processCost * (amount / componentTotal));
        }
      } else {
        // No bracket found (or every component is zero) -- can't split, so don't
        // silently drop the cost: land it all on Direct Labor as the single most
        // common component rather than fabricating a breakdown we don't have data for.
        credit(acctByCode.get(ASSEMBLY_BUILD_FIXED_GL_CODES.directLabor)?.id, processCost);
      }
    }
  }

  const rows = [];
  let creditTotal = 0;
  for (const [accountId, amount] of credits) {
    const acct = acctById.get(accountId);
    if (!acct) continue;
    const rounded = Number(amount.toFixed(2));
    creditTotal += rounded;
    rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: rounded });
  }
  // The Finished Goods debit is the sum of what was actually credited, NOT the lines' own
  // total_cost column.
  //
  // This entry is cost absorption: what goes INTO finished goods is exactly what came OUT of
  // materials plus what was absorbed from labour and overhead. Those are the credits above, so
  // the debit follows them by construction and the entry cannot be one-sided.
  //
  // total_cost was being used instead, and it disagrees with material_cost + process_cost on
  // 156,247 of 412,181 lines -- 21,157,949.59 against 48,729,560.85 across the table, which was
  // 27,529,468.80 of the trial balance's imbalance and 94% of what remained after vendor bills.
  // Neither figure reconciles to assembly_builds.total_amount either (28,203 builds match the
  // one, 22,562 the other, out of 124,496), so total_cost is not a more authoritative total --
  // it is a third number.
  //
  // Scaling the credits down to total_cost instead was the alternative and is worse: the material
  // leg credits each item's own asset account, so it has to equal the inventory that actually
  // left. Bending it to fit a summary column would misstate inventory to make a total tie out.
  // Item Delivery already depends on this reading -- it credits Finished Goods for "the exact
  // account Assembly Build debited when the cost first went INTO inventory".
  const fgAcct = acctById.get(ab.fg_account_id);
  if (fgAcct && creditTotal) {
    rows.unshift({ account_code: fgAcct.account_code, account_name: fgAcct.account_name, debit: Number(creditTotal.toFixed(2)), credit: 0 });
  }
  return rows;
}

// GL Impact: recognizing cost-of-sale at delivery time, the mirror image of Assembly
// Build's cost-absorption entry -- reverse-engineered directly from the real system's
// sandbox (Item Delivery > GL Impact tab): debit Cost of Goods Sold (the delivered
// line's Job Type's own cogs_account_id) and credit Finished Goods Inventory (that same
// Job Type's asset_account_id, the exact account Assembly Build debited when the cost
// first went INTO inventory), for the delivered quantity's share of that Job Order's
// total built cost.
//
// item_delivery_lines only stores job_order_id + qty_delivered -- no per-process link
// and no cost snapshot at all (unlike assembly_build_lines) -- so cost is derived live:
// (SUM of that JO's job_order_processes.total_cost) / jo.quantity gives a per-unit cost,
// multiplied by this line's qty_delivered. This assumes cost is spread evenly across the
// JO's full required quantity, which is the only basis available; if a JO's per-unit
// cost genuinely varies within its own run this would be an approximation, not exact.
async function computeItemDeliveryGl(lines) {
  const accountIds = [...new Set(lines.flatMap((l) => [l.cogs_account_id, l.asset_account_id]).filter(Boolean))];
  if (!accountIds.length) return [];
  const acctById = new Map((await coaByIds(accountIds)).map((c) => [c.id, c]));

  const debits = new Map();
  const credits = new Map();
  for (const l of lines) {
    if (!l.cogs_account_id || !l.asset_account_id) continue;
    const joQuantity = Number(l.jo_quantity) || 0;
    if (!joQuantity) continue;
    const unitCost = (Number(l.jo_total_cost) || 0) / joQuantity;
    const amount = unitCost * (Number(l.qty_delivered) || 0);
    if (!amount) continue;
    debits.set(l.cogs_account_id, (debits.get(l.cogs_account_id) || 0) + amount);
    credits.set(l.asset_account_id, (credits.get(l.asset_account_id) || 0) + amount);
  }

  const rows = [];
  for (const [id, amt] of debits) {
    const acct = acctById.get(id);
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: Number(amt.toFixed(2)), credit: 0 });
  }
  for (const [id, amt] of credits) {
    const acct = acctById.get(id);
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amt.toFixed(2)) });
  }
  return rows;
}

// GL Impact for Item Fulfillment / Item Receipt -- the real system's sandbox (GL Impact
// tab, `transaction_transactionledgerentries`) posts these as a two-step stock move
// through a fixed "Inventory In Transit" clearing account (15900), not a direct
// inventory-to-inventory entry: Item Fulfillment credits the item's own inventory asset
// account and debits the clearing account (stock leaves Withdraw From immediately);
// Item Receipt is the exact mirror, debiting the item's asset account and crediting the
// same clearing account (stock lands at Transfer To). Both legs use the same item, so
// they reference the same `inventories.asset_account_id` -- confirmed against two real
// paired examples (IF-9252/qty 1 ROLL crediting "Raw Materials Inventory - LFP", and
// IR-9296/qty 24 SHT debiting "Raw Materials Inventory - Dpod" -- different items,
// different accounts, but each internally consistent with its own item).
// `qtyField`/`assetIsDebit` let one function serve both (Fulfillment: qty_fulfilled,
// asset account credited; Receipt: qty_received, asset account debited).
async function computeTransitGl(lines, { qtyField, assetIsDebit }) {
  const transitAcct = await coaByCode('15900');
  if (!transitAcct) return [];

  const assetAmounts = new Map(); // account_id -> amount
  let transitTotal = 0;
  for (const l of lines) {
    const amount = Number(l[qtyField]) * Number(l.average_cost || 0);
    if (!amount || !l.asset_account_id) continue;
    assetAmounts.set(l.asset_account_id, (assetAmounts.get(l.asset_account_id) || 0) + amount);
    transitTotal += amount;
  }
  if (!assetAmounts.size) return [];

  const assetAccts = await coaByIds([...assetAmounts.keys()]);
  const rows = [];
  for (const acct of assetAccts) {
    const amount = Number((assetAmounts.get(acct.id) || 0).toFixed(2));
    if (!amount) continue;
    rows.push({
      account_code: acct.account_code, account_name: acct.account_name,
      debit: assetIsDebit ? amount : 0, credit: assetIsDebit ? 0 : amount,
    });
  }
  const total = Number(transitTotal.toFixed(2));
  if (total) {
    rows.push({
      account_code: transitAcct.account_code, account_name: transitAcct.account_name,
      debit: assetIsDebit ? 0 : total, credit: assetIsDebit ? total : 0,
    });
  }
  return rows;
}

// GL Impact for a Customer Payment -- the AR mirror of a Bill Payment: debit whichever
// cash/bank account the money landed in, credit Accounts Receivable Trade (12100) for the
// same amount, settling the invoices this payment was applied to.
//
// Only the portion applied to *invoices* posts. A line applied against one of the
// customer's own Credit Memos moves no cash -- it offsets the payment with a credit that
// already posted its own entry when the memo was raised, so posting it here would
// double-count. Unapplied cash doesn't touch AR either.
//
// UNAPPLIED CASH on a payment entered in this app posts DR cash / CR 23000 Customer Deposits: it
// is money received for invoices not yet raised (or not yet chosen), so it is owed back to the
// customer until it is applied. Once a payment could be saved with nothing applied, leaving it
// unposted meant real cash with no entry at all -- and a later Bank Deposit would credit
// Undeposited Funds for money that never went into it. Editing the payment to apply it later
// moves the amount from 23000 to AR on its own, since this entry is derived on every read.
//
// ONLY IN-APP PAYMENTS (created_by_user_id set). The ~58k PAY-* receipts imported from live apply
// to nothing because live exposes no payment->invoice detail, not because they are advances, and
// the same cash is already booked through the synthetic CPAY-* payments. Posting their unapplied
// amount would add roughly PHP 500M to the ledger twice. See customer-payments-cpay-vs-pay.
// GL Impact for a Bill Payment, as the source posts it (read off BPAY-13714 and BPAY-13700):
//   DR the payable it settles (its A/P account, Accounts Payable - Trade 20100 by default)
//   CR the bank account it is drawn on
// both for the full amount -- applied or not: an unapplied payment is an advance against the
// vendor, which the source also books as a debit to AP. Bill Payments posted nothing at all before
// this, so from the cut-over every one left AP overstated and the bank overstated by its amount.
async function computeBillPaymentGl(bp) {
  const amount = Number((Number(bp.total_amount) || 0).toFixed(2));
  if (!amount || !bp.bank_account_id) return [];
  const ap = bp.ap_account_id ? await coaById(bp.ap_account_id) : await coaByCode('20100');
  const bank = await coaById(bp.bank_account_id);
  if (!ap || !bank) return [];
  return [
    { account_code: ap.account_code, account_name: ap.account_name, debit: amount, credit: 0 },
    { account_code: bank.account_code, account_name: bank.account_name, debit: 0, credit: amount },
  ];
}

async function computeCustomerPaymentGl(cp, lines) {
  const arAcct = await coaByCode('12100');
  // An in-app payment saved without a Deposit To account is cash waiting to be banked, which is
  // exactly what Undeposited Funds holds -- the Bank Deposit then moves it DR bank / CR 10006.
  // Returning nothing here instead meant 10 of 11 in-app payments on production (PHP 308k) posted
  // no entry at all, and depositing one would credit 10006 for money never put in. Imported
  // payments with no deposit account are the PAY-* receipts whose cash is booked elsewhere (see
  // below), so they still post nothing.
  const heldUndeposited = !cp.deposit_account_id && !!cp.created_by_user_id;
  if (!arAcct || (!cp.deposit_account_id && !heldUndeposited)) return [];
  // Once a payment is rolled into a Bank Deposit, its cash sits in Undeposited Funds (10006) until
  // the deposit moves it to the bank -- so its own entry debits 10006, and the Deposit does the
  // DR bank / CR 10006. A payment with no deposit keeps debiting its deposit account directly (this
  // preserves historical payments, which have no deposit document).
  const depositAcct = (cp.deposit_id || heldUndeposited)
    ? await coaByCode('10006')
    : await coaById(cp.deposit_account_id);
  if (!depositAcct) return [];

  const appliedToInvoices = lines
    .filter((l) => l.sales_invoice_id)
    .reduce((s, l) => s + Number(l.applied_amount || 0), 0);
  const amount = Number(appliedToInvoices.toFixed(2));
  const unapplied = cp.created_by_user_id ? Number((Number(cp.unapplied_amount) || 0).toFixed(2)) : 0;
  const custDeposits = unapplied > 0 ? await coaByCode('23000') : null;
  const onAccount = custDeposits ? unapplied : 0;
  if (!amount && !onAccount) return [];

  const rows = [
    { account_code: depositAcct.account_code, account_name: depositAcct.account_name, debit: Number((amount + onAccount).toFixed(2)), credit: 0 },
  ];
  if (amount) rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: amount });
  if (onAccount) rows.push({ account_code: custDeposits.account_code, account_name: custDeposits.account_name, debit: 0, credit: onAccount });
  return rows;
}

// GL Impact for a Credit Memo -- the exact reversal of the Sales Invoice entry it credits
// back: debit Sales (30100) for the net amount and VAT on Sales for the tax (both of
// which the invoice credited), and credit Accounts Receivable Trade (12100) for the gross
// the customer no longer owes.
//
// VAT is routed per line tax code via taxes.tax_account_id, same as the invoice's own
// entry, so a credit reverses tax onto exactly the account the sale put it on.
async function computeCreditMemoGl(cm, lines, applications = []) {
  const arAcct = await coaByCode('12100');
  const salesAcct = await coaByCode('30100');
  if (!arAcct || !salesAcct) return [];

  // Imported memos carry the account live actually debited, and have no item lines -- a
  // credit memo there is an amount applied against invoices, not a list of returned goods.
  // Reproduce live's shape: one debit for the whole memo, then one A/R credit per invoice it
  // was applied to. Assuming 30100 (Sales) here would be wrong for most of them: CM-5290
  // debits 14200 Creditable Withholding Tax, because the customer withheld tax.
  if (cm.source_account_id && !lines.length) {
    const src = await coaById(cm.source_account_id);
    const gross = Number(cm.gross_amount) || 0;
    const rows = [];
    if (src && gross) rows.push({ account_code: src.account_code, account_name: src.account_name, debit: gross, credit: 0 });
    const applied = applications.filter((a) => Number(a.applied_amount));
    if (applied.length) {
      for (const a of applied) {
        rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: Number(a.applied_amount) });
      }
    } else if (gross) {
      // Nothing applied yet -- the credit still sits against A/R as a single balance.
      rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: gross });
    }
    return rows;
  }

  const rows = [];
  const netOfTax = Number(cm.net_of_tax) || 0;
  const grossAmount = Number(cm.gross_amount) || 0;
  if (netOfTax) rows.push({ account_code: salesAcct.account_code, account_name: salesAcct.account_name, debit: netOfTax, credit: 0 });

  const taxTotals = new Map(); // tax_code -> amount
  for (const l of lines) {
    const amt = Number(l.tax_amount) || 0;
    if (!amt) continue;
    taxTotals.set(l.tax_code || null, (taxTotals.get(l.tax_code || null) || 0) + amt);
  }
  if (taxTotals.size === 0 && Number(cm.tax_amount)) taxTotals.set(null, Number(cm.tax_amount));

  for (const [code, amt] of taxTotals) {
    let acct = null;
    if (code) {
      const t = await taxByCode(code);
      if (t?.tax_account_id) acct = await coaById(t.tax_account_id);
    }
    if (!acct) acct = await coaByCode('21100');
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: Number(amt.toFixed(2)), credit: 0 });
  }

  if (grossAmount) rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: grossAmount });
  return rows;
}

// GL Impact for a Customer Refund -- returning cash a customer had paid. Reverse-engineered
// from the live GL Impact tab (CRFND-48): debit the A/R account (Accounts Receivable Trade
// 12100) and credit the Customer Refund clearing account (10005) for the total refunded, both
// carried on the refund header. Voided refunds post nothing.
async function computeCustomerRefundGl(cr) {
  if (!cr.ar_account_id || !cr.account_id) return [];
  const ar = await coaById(cr.ar_account_id);
  const acct = await coaById(cr.account_id);
  if (!ar || !acct) return [];
  const amount = Number(cr.refund_amount) || 0;
  if (!amount) return [];
  return [
    { account_code: ar.account_code, account_name: ar.account_name, debit: amount, credit: 0 },
    { account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: amount },
  ];
}

// GL Impact for a Commission Payable -- DR Commission Expense - Internal (the employee's
// department) / CR Commission Payable, both booked at the full Expected Commission. The payable's
// amount_due carries the currently-owed Commissionable Amount (confirmed commission), matching the
// live GL Impact tab where the credit is the expected figure but only the commissionable part is
// due now. amount_due / paid_amount are extra display fields (the reports engine reads only
// debit/credit/account_code); they drive the view's Amount Due / Paid Amount columns.
const cpRound = (n) => Number((Number(n) || 0).toFixed(2));

// A Sales Manager / Marketing Director / SBU Head earns commission on the whole business, so their
// commission expense is a cross-division cost the live system spreads EQUALLY across every sales
// division. Everyone else (account officer / supervisor) charges their own department in one line.
async function employeeIsSalesManager(employeeId) {
  if (!employeeId) return false;
  const [[u]] = await pool.query(
    'SELECT is_sales_manager AS m, is_sales_marketing_director AS dir, is_sales_business_unit AS sbu FROM users WHERE employee_id = ? LIMIT 1',
    [employeeId]
  );
  return !!(u && (u.m || u.dir || u.sbu));
}

// The sales divisions a manager's expense is split across (every active sales division except the
// non-sales "Support"), each mapped to its department for the reports engine. Display name is
// normalised to the live "Sales-N" form.
async function salesDivisionDepartments() {
  const [divs] = await pool.query("SELECT id, name FROM sales_divisions WHERE is_active = TRUE AND name <> 'Support' ORDER BY id");
  const [depts] = await pool.query('SELECT id, name FROM departments');
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const deptByNorm = new Map(depts.map((d) => [norm(d.name), d.id]));
  return divs.map((dv) => ({ name: String(dv.name).replace(/\s*-\s*/g, '-'), department_id: deptByNorm.get(norm(dv.name)) || null }));
}

async function computeCommissionPayableGl(cp) {
  if (!cp.expense_account_id || !cp.payable_account_id) return [];
  const exp = await coaById(cp.expense_account_id);
  const pay = await coaById(cp.payable_account_id);
  if (!exp || !pay) return [];
  const amount = cpRound(cp.expected_commission);
  if (!amount) return [];
  const due = cpRound(cp.commissionable_amount);
  const paid = cpRound(cp.amount_paid);

  // Credit side: always one Commission Payable line to Accounting (the whole expected commission;
  // amount_due carries the commissionable figure, paid_amount the settled figure).
  const [[acctDept]] = await pool.query("SELECT id, name FROM departments WHERE name = 'Accounting' LIMIT 1");
  const creditRow = {
    account_code: pay.account_code, account_name: pay.account_name, debit: 0, credit: amount,
    amount_due: due, paid_amount: paid, department_id: acctDept?.id || null, department: acctDept?.name || 'Accounting',
  };

  // Debit side: split across sales divisions for a manager, else a single line to their department.
  const debitRows = [];
  if (await employeeIsSalesManager(cp.employee_id)) {
    const divisions = await salesDivisionDepartments();
    const n = divisions.length || 1;
    let allocated = 0;
    divisions.forEach((div, i) => {
      const share = i === n - 1 ? cpRound(amount - allocated) : cpRound(amount / n);
      allocated = cpRound(allocated + share);
      debitRows.push({ account_code: exp.account_code, account_name: exp.account_name, debit: share, credit: 0, amount_due: 0, paid_amount: 0, department_id: div.department_id, department: div.name });
    });
  } else {
    let deptName = null;
    if (cp.department_id) { const [[d]] = await pool.query('SELECT name FROM departments WHERE id = ?', [cp.department_id]); deptName = d?.name || null; }
    debitRows.push({ account_code: exp.account_code, account_name: exp.account_name, debit: amount, credit: 0, amount_due: 0, paid_amount: 0, department_id: cp.department_id || null, department: deptName });
  }

  return [creditRow, ...debitRows];
}

// GL Impact for a Commission Voucher -- the release/payment of Commission Payables. Debits
// Commission Payable (24200) once per commission released (settling the liability), applies each
// expense adjustment by sign (a positive amount debits its account, a negative one credits it),
// and credits the cash/bank account for the net Total Payments (= total released + sum of
// expenses). Voided vouchers post nothing.
async function computeCommissionVoucherGl(cv, lines, expenses) {
  if (cv.status === 'void') return [];
  const rows = [];
  const payAcct = await coaByCode('24200');

  let totalReleased = 0;
  for (const l of (lines || [])) {
    const amt = cpRound(l.released_amount);
    if (!amt || !payAcct) continue;
    totalReleased = cpRound(totalReleased + amt);
    rows.push({ account_code: payAcct.account_code, account_name: payAcct.account_name, debit: amt, credit: 0 });
  }

  let expSum = 0;
  for (const e of (expenses || [])) {
    const amt = cpRound(e.amount);
    if (!amt) continue;
    expSum = cpRound(expSum + amt);
    const a = await coaById(e.account_id);
    if (!a) continue;
    if (amt > 0) rows.push({ account_code: a.account_code, account_name: a.account_name, debit: amt, credit: 0 });
    else rows.push({ account_code: a.account_code, account_name: a.account_name, debit: 0, credit: cpRound(-amt) });
  }

  const cash = cpRound(totalReleased + expSum);
  if (cv.cash_bank_account_id && cash) {
    const c = await coaById(cv.cash_bank_account_id);
    if (c) {
      if (cash >= 0) rows.push({ account_code: c.account_code, account_name: c.account_name, debit: 0, credit: cash });
      else rows.push({ account_code: c.account_code, account_name: c.account_name, debit: cpRound(-cash), credit: 0 });
    }
  }
  return rows;
}

// GL Impact for a Delivery Ticket -- the same three-account revenue-recognition shape as
// Sales Invoice, with one deliberate difference taken straight from the real system's
// DT screen (DT-1316: Dr 12101 280.00 / Cr 30100 250.00 / Cr 21100 30.00): the debit goes
// to "Accounts Receivable Trade - Unbilled" (12101), NOT AR Trade (12100). That is the
// whole distinction between the two documents -- a DT recognises the sale and the
// receivable when goods leave, while the receivable is still unbilled; the DT's own Bill
// button is what later raises the invoice that moves it to 12100.
//
// VAT is routed per line tax code via taxes.tax_account_id, same as computeSalesInvoiceGl
// -- so a future second tax code lands on its own account rather than silently on VAT on
// Sales.
// Pay expenses out of a bank account: DR each expense account (+ VAT input 14300 on tax) /
// CR Expanded Withholding Tax (21402) for any withheld / CR the bank account for the net.
//
// `c` must carry bank_code/bank_name (chart_of_accounts joined on cheques.account_id) and `lines`
// the cheque's own lines with their account_code/account_name already resolved -- the shape the
// Cheques block in getPostedGlLines builds. Lifted out of that block so the void path can post the
// mirror of the very same entry rather than a second opinion about what a cheque posts.
// `credits`: the vendor's Bill Credits used up on the cheque (cheque_bill_credits), each with its
// credit's AP account. A bill credit left the vendor's AP with a debit balance; using it here
// clears that (CR AP) and the bank pays that much less -- total_amount is already net of them.
// A negative leg (a reversal cheque or bill, allowed 2026-10-03) posts on the opposite side as a
// positive amount -- a "-4,555 debit" becomes a 4,555 credit. Debit minus credit is unchanged.
function sideNegatives(rows) {
  return rows.map((r) => {
    const d = Number(r.debit) || 0; const c = Number(r.credit) || 0;
    if (d >= 0 && c >= 0) return r;
    const net = d - c;
    return { ...r, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
}

async function computeChequeGl(c, lines, credits = []) {
  const rows = (lines || []).filter((l) => Number(l.amount)).map((l) => ({
    account_code: l.account_code, account_name: l.account_name, debit: Number(l.amount) || 0, credit: 0, department_id: l.department_id || null,
  }));
  const tax = Number(c.tax_amount) || 0;
  const wtax = Number(c.withholding_tax_amount) || 0;
  const total = Number(c.total_amount) || 0;
  if (tax) { const v = await coaByCode('14300'); if (v) rows.push({ account_code: v.account_code, account_name: v.account_name, debit: tax, credit: 0 }); }
  if (wtax) { const w = await coaByCode('21402'); if (w) rows.push({ account_code: w.account_code, account_name: w.account_name, debit: 0, credit: wtax }); }
  for (const cr of credits || []) {
    const amt = Number(cr.applied_amount) || 0;
    if (amt && cr.ap_account_code) rows.push({ account_code: cr.ap_account_code, account_name: cr.ap_account_name, debit: 0, credit: amt });
  }
  if (total && c.bank_code) rows.push({ account_code: c.bank_code, account_name: c.bank_name, debit: 0, credit: total });
  return sideNegatives(rows);
}

async function computeDeliveryTicketGl(dt, lines) {
  const arUnbilled = await coaByCode('12101');
  const salesAcct = await coaByCode('30100');
  if (!arUnbilled || !salesAcct) return [];

  const rows = [];
  const grossAmount = Number(dt.gross_amount) || 0;
  const netOfTax = Number(dt.net_of_tax) || 0;
  if (grossAmount) rows.push({ account_code: arUnbilled.account_code, account_name: arUnbilled.account_name, debit: grossAmount, credit: 0 });
  if (netOfTax) rows.push({ account_code: salesAcct.account_code, account_name: salesAcct.account_name, debit: 0, credit: netOfTax });

  const taxTotals = new Map(); // tax_code -> amount
  for (const l of lines) {
    const amt = Number(l.tax_amount) || 0;
    if (!amt) continue;
    taxTotals.set(l.tax_code || null, (taxTotals.get(l.tax_code || null) || 0) + amt);
  }
  if (taxTotals.size === 0 && Number(dt.tax_amount)) taxTotals.set(null, Number(dt.tax_amount));

  for (const [code, amt] of taxTotals) {
    let acct = null;
    if (code) {
      const t = await taxByCode(code);
      if (t?.tax_account_id) acct = await coaById(t.tax_account_id);
    }
    if (!acct) acct = await coaByCode('21100');
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amt.toFixed(2)) });
  }
  return rows;
}

// GL Impact: the AP-side mirror of Sales Invoice's revenue-recognition entry, same
// reverse-engineering pass against the real system's sandbox: credit Accounts Payable -
// Trade (20100) for the bill's gross total, debit the bill's own selected account
// (`vb.account_id`, whatever the goods/expense offset is -- typically "Inventory
// Received Not Billed" for a PO-linked bill) for the net-of-tax amount, debit VAT on
// Purchases (14300, fixed) for the tax.
//
// Deliberately NOT routed per-line via `taxes.tax_account_id` the way Sales Invoice
// routes its VAT credit -- checked this build's real data and there's currently only
// one tax code (VAT12) in the whole `taxes` table, and its `tax_account_id` is
// correctly scoped to Sales (VAT on Sales, 21100), since that's the only context it's
// been used in so far. Reusing that same field here would incorrectly land purchase-
// side input tax on the sales-side output-tax account. If/when this build ever needs
// genuinely separate sales vs. purchase tax codes, `taxes` would need its own second
// account field for the purchase side -- not guessing that shape now.
async function computeVendorBillGl(vb, lines) {
  const apAcct = await coaByCode('20100');
  const vatAcct = await coaByCode('14300');
  if (!apAcct) return [];

  const rows = [];
  const grossAmount = Number(vb.gross_amount) || 0;
  const netOfTax = Number(vb.net_of_tax) || 0;
  const taxAmount = Number(vb.tax_amount) || 0;
  // A standalone bill's header Account is the payable it credits (default AP - Trade); on a PO bill
  // the header account is the debit offset and AP - Trade is always the credit.
  // From 2026-10-03 a PO bill's header account defaults to AP - Trade, as at the source (whose PO
  // bills credit 20100 and debit 20300 Inventory Received Not Billed, or the line's expense). So a
  // PO bill whose header account IS a payable (20100 / 20200) credits it and debits 20300 below;
  // older PO bills holding 20300 (or any other) as their header keep posting exactly as before.
  const PAYABLE = ['20100', '20200'];
  const poHeaderIsPayable = !!vb.purchase_order_id && PAYABLE.includes(String(vb.account_code || ''));
  const creditAcct = (!vb.purchase_order_id || poHeaderIsPayable) && vb.account_code
    ? { account_code: vb.account_code, account_name: vb.account_name } : apAcct;
  const irnbAcct = poHeaderIsPayable ? await coaByCode('20300') : null;
  // Withholding is credited to 21402 and the payable net of it, as the source posts a bill
  // (VB-23778: CR 20100 49.55 / CR 21402 0.45 on a 50.00 bill). Crediting the payable the full gross
  // overstated AP by the tax withheld on every bill that withholds.
  const wtax = Number(Number(vb.wtax_amount || 0).toFixed(2));
  const ewtAcct = wtax > 0 ? await coaByCode('21402') : null;
  if (grossAmount) {
    const payable = ewtAcct ? Number((grossAmount - wtax).toFixed(2)) : grossAmount;
    rows.push({ account_code: creditAcct.account_code, account_name: creditAcct.account_name, debit: 0, credit: payable });
    if (ewtAcct) rows.push({ account_code: ewtAcct.account_code, account_name: ewtAcct.account_name, debit: 0, credit: wtax });
  }
  // A standalone (expense) bill's lines each name the account they debit; a PO bill debits its one
  // header account for the whole net, as it always has.
  const acctLines = lines.filter((l) => l.account_id && Number(l.net_of_tax));
  if (acctLines.length) {
    const byAcct = new Map();
    for (const l of acctLines) byAcct.set(l.account_id, (byAcct.get(l.account_id) || 0) + Number(l.net_of_tax));
    for (const acct of await coaByIds([...byAcct.keys()])) {
      const amt = Number(byAcct.get(acct.id).toFixed(2));
      if (amt) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: amt, credit: 0 });
    }
  } else if (netOfTax && poHeaderIsPayable && irnbAcct) {
    rows.push({ account_code: irnbAcct.account_code, account_name: irnbAcct.account_name, debit: netOfTax, credit: 0 });
  } else if (netOfTax && vb.account_code) {
    rows.push({ account_code: vb.account_code, account_name: vb.account_name, debit: netOfTax, credit: 0 });
  }
  if (taxAmount && vatAcct) rows.push({ account_code: vatAcct.account_code, account_name: vatAcct.account_name, debit: taxAmount, credit: 0 });
  return sideNegatives(rows);
}

// GL Impact: the adjustment-account leg (credited on an increase, debited on a
// decrease) was already correct -- this adds the missing counter-leg, each line's own
// item asset account, for the opposite direction and the same amount (new_qty -
// qty_on_hand, in Base Unit, times the per-Base-Unit cost -- the exact figure
// `recomputeTotal` already sums into `estimated_total_value`, so this always ties out
// to the header total exactly). Real system's sandbox confirms this asset/adjustment-
// account pairing (IA-330: Dr Raw Materials Inventory - Dpod 142.50 / Cr Direct
// Materials 142.50 for a +150 qty increase) -- direction here matches that example.
async function computeInventoryAdjustmentGl(adj, lines) {
  if (!adj.adjustment_account_id || !adj.adjustment_account_code) return [];

  const itemAccountAmounts = new Map(); // account_id -> signed amount (positive = qty increase)
  let adjustmentTotal = 0;
  for (const l of lines) {
    const amount = (Number(l.new_qty) - Number(l.qty_on_hand)) * Number(l.est_unit_cost_base || 0);
    if (!amount || !l.asset_account_id) continue;
    itemAccountAmounts.set(l.asset_account_id, (itemAccountAmounts.get(l.asset_account_id) || 0) + amount);
    adjustmentTotal += amount;
  }
  if (!itemAccountAmounts.size) return [];

  const itemAccts = await coaByIds([...itemAccountAmounts.keys()]);
  const rows = [];
  for (const acct of itemAccts) {
    const amount = Number((itemAccountAmounts.get(acct.id) || 0).toFixed(2));
    if (!amount) continue;
    rows.push({
      account_code: acct.account_code, account_name: acct.account_name,
      debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0,
    });
  }
  const total = Number(adjustmentTotal.toFixed(2));
  if (total) {
    rows.push({
      account_code: adj.adjustment_account_code, account_name: adj.adjustment_account_name,
      debit: total < 0 ? -total : 0, credit: total > 0 ? total : 0,
    });
  }
  return rows;
}

// GL Impact: no tab existed for this transaction type at all -- added following the
// same reverse-engineered pattern as Sales Invoice/Vendor Bill (fixed-account debit/
// credit + a per-line credit to whichever account each expense line targets). Debits
// the credit's own AP account (`bc.ap_account_id`, reducing what's owed to the
// supplier) for the full total; credits each line's own selected account for its net
// amount, and VAT on Purchases (14300, fixed -- see the note on Vendor Bill's
// computeVendorBillGl on why this isn't routed per-tax-code) for any per-line tax -- i.e.
// this reverses whichever account(s)/tax the original Vendor Bill posted, proportional
// to what this credit actually covers. (The one real sandbox example available credited
// "Advances To Suppliers" instead, because that particular credit was fully applied
// against a supplier prepayment -- a concept this build's bill_credits schema doesn't
// model, so reversing the bill's own line accounts is the closest correct analog here,
// not a literal copy of that one example.)
async function computeBillCreditGl(bc, lines) {
  if (!bc.ap_account_id || !bc.ap_account_code) return [];
  const totalAmount = Number(bc.total_amount) || 0;
  if (!totalAmount) return [];

  const rows = [{ account_code: bc.ap_account_code, account_name: bc.ap_account_name, debit: totalAmount, credit: 0 }];

  for (const l of lines) {
    const amount = Number(l.amount) || 0;
    if (amount && l.account_code) {
      rows.push({ account_code: l.account_code, account_name: l.account_name, debit: 0, credit: amount });
    }
  }

  const taxTotal = lines.reduce((s, l) => s + (Number(l.tax_amount) || 0), 0);
  if (taxTotal) {
    const vatAcct = await coaByCode('14300');
    if (vatAcct) rows.push({ account_code: vatAcct.account_code, account_name: vatAcct.account_name, debit: 0, credit: Number(taxTotal.toFixed(2)) });
  }
  return rows;
}

// Aggregates every posted transaction across all 8 types into one flat list of GL
// lines, for the 4 financial-statement reports (reportsEngine.js). Reuses the exact
// same compute*Gl functions the live per-transaction GL Impact tabs already call, so
// the reports can never drift from what those tabs show -- no persisted ledger table,
// computed fresh on every request. `toDate` is required (all 4 reports are "as of"
// reports); `fromDate` is optional (Income Statement uses it for its YTD period).
// Fetches a whole document type's lines in chunked `IN (...)` queries and groups them by
// parent id, so each type costs a handful of queries instead of one per document. `sql` must
// select the parent column and end in `IN (?)`. Chunked so a window holding tens of thousands
// of documents doesn't build one enormous statement (or blow max_allowed_packet).
// Bill Credits used on cheques, by cheque id, with each credit's AP account. Empty where the
// table is not there yet (code deployed ahead of db/create-cheque-bill-credits.js).
async function chequeCreditsByCheque(ids) {
  if (!ids.length) return new Map();
  try {
    return await linesByParent(
      `SELECT cbc.cheque_id, cbc.bill_credit_id, cbc.applied_amount, bc.bill_credit_no,
              coa.account_code AS ap_account_code, coa.account_name AS ap_account_name
         FROM cheque_bill_credits cbc
         JOIN bill_credits bc ON bc.id = cbc.bill_credit_id
         LEFT JOIN chart_of_accounts coa ON coa.id = bc.ap_account_id
        WHERE cbc.cheque_id IN (?) ORDER BY cbc.id`, 'cheque_id', ids);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return new Map();
    throw e;
  }
}

async function linesByParent(sql, parentCol, ids, chunkSize = 1000) {
  const byParent = new Map();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const [rows] = await pool.query(sql, [ids.slice(i, i + chunkSize)]);
    for (const r of rows) {
      if (!byParent.has(r[parentCol])) byParent.set(r[parentCol], []);
      byParent.get(r[parentCol]).push(r);
    }
  }
  return byParent;
}

// A depreciation run is stored as the first of the month it covers but posts on the month's last
// day. Computed on the string rather than through a Date, so it cannot be shifted by a timezone --
// the same trap that put dateStrings:true in db.js.
function lastDayOfMonth(period) {
  const [y, m] = String(period).slice(0, 7).split('-').map(Number);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// Depreciation run: Dr depreciation expense, Cr accumulated depreciation.
//
// Aggregated by account pair rather than one debit/credit per asset. A month can carry hundreds of
// lines that all post to the same two accounts, and the ledger wants the period's charge, not a
// row per machine -- the per-asset detail lives on the run document, which is where anyone asking
// "which assets made up this figure?" should be looking.
//
// The account CODES come off the line, not from the class, because they were snapshotted when the
// run was built; re-pointing a class next year must not restate what last year's Trial Balance said.
async function computeAssetDepreciationRunGl(lines) {
  const byPair = new Map();
  for (const l of lines) {
    const amount = Number(l.amount) || 0;
    if (!amount || !l.expense_account_code || !l.accumulated_account_code) continue;
    const key = `${l.expense_account_code}|${l.accumulated_account_code}`;
    byPair.set(key, (byPair.get(key) || 0) + amount);
  }
  const rows = [];
  for (const [key, total] of byPair) {
    const amount = Number(total.toFixed(2));
    if (!amount) continue;
    const [expenseCode, accumCode] = key.split('|');
    const expense = await coaByCode(expenseCode);
    const accumulated = await coaByCode(accumCode);
    if (!expense || !accumulated) continue;
    rows.push({ account_code: expense.account_code, account_name: expense.account_name, debit: amount, credit: 0 });
    rows.push({ account_code: accumulated.account_code, account_name: accumulated.account_name, debit: 0, credit: amount });
  }
  return rows;
}

// Disposal: remove the asset's cost and the accumulated depreciation standing against it, bring in
// the proceeds, and let the gain or loss fall out as the balancing figure.
//
//   Dr Accumulated Depreciation  (all depreciation taken to date)
//   Dr Cash / Receivable         (proceeds, when sold)
//   Cr Fixed Asset - cost        (full capitalised cost)
//   Dr/Cr Gain or Loss           (proceeds - net book value)
//
// The gain/loss line is computed from the other three rather than trusted from the document, so the
// entry balances by construction even if a stored figure were ever stale.
async function computeAssetDisposalGl(d) {
  const cost = Number(d.cost_at_disposal) || 0;
  const accumulated = Number(d.accumulated_at_disposal) || 0;
  const proceeds = Number(d.proceeds) || 0;
  if (!cost && !accumulated && !proceeds) return [];
  if (!d.cost_account_id || !d.accumulated_account_id) return [];

  const costAcct = await coaById(d.cost_account_id);
  const accumAcct = await coaById(d.accumulated_account_id);
  if (!costAcct || !accumAcct) return [];

  const rows = [];
  if (accumulated) rows.push({ account_code: accumAcct.account_code, account_name: accumAcct.account_name, debit: accumulated, credit: 0 });
  if (proceeds && d.proceeds_account_id) {
    const cash = await coaById(d.proceeds_account_id);
    if (cash) rows.push({ account_code: cash.account_code, account_name: cash.account_name, debit: proceeds, credit: 0 });
  }
  if (cost) rows.push({ account_code: costAcct.account_code, account_name: costAcct.account_name, debit: 0, credit: cost });

  // Whatever it takes to balance: a credit is a gain, a debit is a loss. Their chart uses one
  // account (30803 Gain/Loss on Sale of Asset) for both directions.
  const debits = rows.reduce((n, r) => n + r.debit, 0);
  const credits = rows.reduce((n, r) => n + r.credit, 0);
  const diff = Number((credits - debits).toFixed(2));
  if (diff && d.gain_loss_account_id) {
    const gl = await coaById(d.gain_loss_account_id);
    if (gl) rows.push({ account_code: gl.account_code, account_name: gl.account_name, debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0 });
  }
  return rows;
}

// GL Impact for a Liquidation (asked 2026-10-06), as the journals AP used to key by hand for one
// (JRNL-5976): DEBIT each item's COGS / expense account for its amount, memo the item's particulars;
// CREDIT the account AP chose for the liquidation -- 13305 Advances To Employees - For Liquidation
// unless they picked another -- for the total. Both sides carry the liquidation's department. Items
// without a COGS account post nothing (AP cannot note one in that state, so an approved liquidation
// always has them all).
const LIQUIDATION_DEFAULT_CREDIT = '13305';
async function computeLiquidationGl(doc, items) {
  const rows = [];
  let total = 0;
  for (const it of items || []) {
    const amount = Number(Number(it.amount || 0).toFixed(2));
    if (!amount || !it.cogs_account_id) continue;
    const acct = await coaById(it.cogs_account_id);
    if (!acct) continue;
    rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: amount, credit: 0, department_id: doc.department_id || null, memo: it.particulars || null });
    total += amount;
  }
  total = Number(total.toFixed(2));
  if (!total) return [];
  const credit = (doc.credit_account_id ? await coaById(doc.credit_account_id) : null) || await coaByCode(LIQUIDATION_DEFAULT_CREDIT);
  if (!credit) return [];
  rows.push({ account_code: credit.account_code, account_name: credit.account_name, debit: 0, credit: total, department_id: doc.department_id || null, memo: doc.request_no || null });
  return rows;
}

async function computePostedGlLines({ toDate, fromDate }) {
  const dateFilter = (col) => {
    const clauses = [`${col} <= ?`];
    const params = [toDate];
    if (fromDate) { clauses.push(`${col} >= ?`); params.push(fromDate); }
    return { sql: clauses.join(' AND '), params };
  };

  const out = [];
  const push = (rows, meta) => {
    for (const r of rows) {
      if (!r.debit && !r.credit) continue;
      out.push({ ...r, ...meta });
    }
  };

  // Live's own posted GL, for the documents whose entries this app cannot correctly re-derive
  // (see src/db/add-live-gl-entries.js). Loaded once and keyed by source_type|source_id; each
  // document type below prefers its imported entries and falls back to the computed ones, so a
  // newly created document still posts normally.
  const importedGl = new Map();
  try {
    const [rows] = await pool.query(
      'SELECT source_type, source_id, account_code, account_name, debit, credit FROM live_gl_entries'
    );
    for (const r of rows) {
      const k = `${r.source_type}|${r.source_id}`;
      if (!importedGl.has(k)) importedGl.set(k, []);
      importedGl.get(k).push({
        account_code: r.account_code, account_name: r.account_name,
        debit: Number(r.debit) || 0, credit: Number(r.credit) || 0,
      });
    }
  } catch (e) {
    // A deploy can reach here before add-live-gl-entries.js has run; degrade to computed rows.
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const glFor = (sourceType, sourceId, computed) => importedGl.get(`${sourceType}|${sourceId}`) || computed;

  // Hold the reference-data snapshot open for the whole run (see top of file).
  await beginRefRun();
  try {

  // Sales Invoices
  //
  // CANCELLED ONES POST TOO, and must. Dropping them here used to be how a void was modelled, but
  // that erases the original entry from the period it was written in. Voiding now writes a REVERSAL
  // journal instead (lib/reversalJournal.js) which cancels the entry in the period of the void, so
  // excluding the invoice as well would reverse it twice and leave the ledger short by its value.
  {
    const { sql, params } = dateFilter('si.date_created');
    const [headers] = await pool.query(
      `SELECT si.* FROM sales_invoices si WHERE ${sql}`, params
    );
    const linesBy = await linesByParent(
      'SELECT * FROM sales_invoice_lines WHERE sales_invoice_id IN (?)', 'sales_invoice_id',
      headers.map((h) => h.id));
    for (const si of headers) {
      const lines = linesBy.get(si.id) || [];
      const rows = await computeSalesInvoiceGl(si, lines);
      push(rows, {
        entry_date: si.date_created, source_type: 'sales_invoice', source_no: si.invoice_no, source_id: si.id, memo: si.memo || null,
        location_id: si.office_location_id || null, department_id: si.department_id || null,
      });
    }
  }

  // Assembly Builds
  {
    const { sql, params } = dateFilter('ab.date_created');
    const [headers] = await pool.query(
      `SELECT ab.*, jt.asset_account_id AS fg_account_id, jo.job_location_id AS location_id,
              (SELECT dept.id FROM sales_orders so
                 JOIN sales_divisions sd ON sd.id = so.sales_division_id
                 JOIN departments dept ON REPLACE(REPLACE(LOWER(dept.name),' ',''),'-','') = REPLACE(REPLACE(LOWER(sd.name),' ',''),'-','')
                WHERE so.id = jo.sales_order_id LIMIT 1) AS dept_id
       FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       WHERE ab.status != 'cancelled' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT abl.*, i.asset_account_id AS item_asset_account_id
         FROM assembly_build_lines abl
         LEFT JOIN inventories i ON i.id = abl.item_id
        WHERE abl.assembly_build_id IN (?)`, 'assembly_build_id', headers.map((h) => h.id));
    for (const ab of headers) {
      const lines = linesBy.get(ab.id) || [];
      const rows = await computeAssemblyBuildGl(pool, ab, lines);
      push(rows, {
        entry_date: ab.date_created, source_type: 'assembly_build', source_no: ab.ab_no, source_id: ab.id, memo: ab.memo || null,
        location_id: ab.location_id || null, department_id: ab.dept_id || null,
      });
    }
  }

  // Item Deliveries
  {
    const { sql, params } = dateFilter('del.date_created');
    const [headers] = await pool.query(
      `SELECT del.*,
              (SELECT jo.job_location_id FROM item_delivery_lines idl2
               LEFT JOIN job_orders jo ON jo.id = idl2.job_order_id
               WHERE idl2.item_delivery_id = del.id LIMIT 1) AS location_id,
              (SELECT dept.id FROM sales_orders so
                 JOIN sales_divisions sd ON sd.id = so.sales_division_id
                 JOIN departments dept ON REPLACE(REPLACE(LOWER(dept.name),' ',''),'-','') = REPLACE(REPLACE(LOWER(sd.name),' ',''),'-','')
                WHERE so.id = del.sales_order_id LIMIT 1) AS dept_id
       FROM item_deliveries del WHERE del.status != 'cancelled' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT idl.*, jo.quantity AS jo_quantity,
              jt.cogs_account_id, jt.asset_account_id,
              (SELECT COALESCE(SUM(total_cost), 0) FROM job_order_processes WHERE job_order_id = jo.id) AS jo_total_cost
         FROM item_delivery_lines idl
         LEFT JOIN job_orders jo ON jo.id = idl.job_order_id
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
        WHERE idl.item_delivery_id IN (?)`, 'item_delivery_id', headers.map((h) => h.id));
    for (const d of headers) {
      const lines = linesBy.get(d.id) || [];
      const rows = await computeItemDeliveryGl(lines);
      push(rows, {
        entry_date: d.date_created, source_type: 'item_delivery', source_no: d.delivery_no, source_id: d.id, memo: d.memo || null,
        location_id: d.location_id || null, department_id: d.dept_id || null,
      });
    }
  }

  // Item Fulfillments (cancellation lives on the parent Transfer Order, not the fulfillment itself)
  {
    const { sql, params } = dateFilter('f.date_created');
    const [headers] = await pool.query(
      `SELECT f.*, t.withdraw_from_location_id AS location_id FROM item_fulfillments f
       JOIN transfer_orders t ON t.id = f.transfer_order_id
       WHERE t.status != 'cancelled' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT ifl.*, i.average_cost, i.asset_account_id
         FROM item_fulfillment_lines ifl
         LEFT JOIN inventories i ON i.id = ifl.item_id
        WHERE ifl.item_fulfillment_id IN (?)`, 'item_fulfillment_id', headers.map((h) => h.id));
    for (const f of headers) {
      const lines = linesBy.get(f.id) || [];
      const rows = await computeTransitGl(lines, { qtyField: 'qty_fulfilled', assetIsDebit: false });
      push(rows, {
        entry_date: f.date_created, source_type: 'item_fulfillment', source_no: f.fulfillment_no, source_id: f.id, memo: f.memo || null,
        location_id: f.location_id || null, department_id: null,
      });
    }
  }

  // Item Receipts
  {
    const { sql, params } = dateFilter('r.date_created');
    const [headers] = await pool.query(
      `SELECT r.*, t.transfer_to_location_id AS location_id FROM item_receipts r
       JOIN transfer_orders t ON t.id = r.transfer_order_id
       WHERE t.status != 'cancelled' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT rl.*, i.average_cost, i.asset_account_id
         FROM item_receipt_lines rl
         LEFT JOIN inventories i ON i.id = rl.item_id
        WHERE rl.item_receipt_id IN (?)`, 'item_receipt_id', headers.map((h) => h.id));
    for (const r of headers) {
      const lines = linesBy.get(r.id) || [];
      const rows = await computeTransitGl(lines, { qtyField: 'qty_received', assetIsDebit: true });
      push(rows, {
        entry_date: r.date_created, source_type: 'item_receipt', source_no: r.receipt_no, source_id: r.id, memo: r.memo || null,
        location_id: r.location_id || null, department_id: null,
      });
    }
  }

  // Customer Payments (voided ones post nothing)
  {
    const { sql, params } = dateFilter('cp.date_created');
    const [headers] = await pool.query(
      `SELECT cp.* FROM customer_payments cp WHERE cp.status != 'voided' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      'SELECT * FROM customer_payment_lines WHERE customer_payment_id IN (?)', 'customer_payment_id',
      headers.map((h) => h.id));
    for (const cp of headers) {
      const lines = linesBy.get(cp.id) || [];
      const rows = await computeCustomerPaymentGl(cp, lines);
      push(rows, {
        entry_date: cp.date_created, source_type: 'customer_payment', source_no: cp.customer_payment_no, source_id: cp.id, memo: cp.memo || null,
        location_id: cp.office_location_id || null, department_id: cp.department_id || null,
      });
    }
  }

  // Credit Memos (voided ones post nothing)
  {
    const { sql, params } = dateFilter('cm.date_created');
    const [headers] = await pool.query(
      `SELECT cm.* FROM credit_memos cm WHERE cm.status != 'voided' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      'SELECT * FROM credit_memo_lines WHERE credit_memo_id IN (?)', 'credit_memo_id',
      headers.map((h) => h.id));
    // Imported memos have no lines and post one A/R credit per applied invoice, so the
    // ledger needs the applications for the same reason the document view does.
    const appsBy = await linesByParent(
      'SELECT * FROM credit_memo_applications WHERE credit_memo_id IN (?)', 'credit_memo_id',
      headers.map((h) => h.id));
    for (const cm of headers) {
      const lines = linesBy.get(cm.id) || [];
      const rows = glFor('credit_memo', cm.id, await computeCreditMemoGl(cm, lines, appsBy.get(cm.id) || []));
      push(rows, {
        entry_date: cm.date_created, source_type: 'credit_memo', source_no: cm.credit_memo_no, source_id: cm.id, memo: cm.memo || null,
        location_id: cm.office_location_id || null, department_id: null,
      });
    }
  }

  // Customer Refunds (voided ones post nothing)
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'customer_refunds'");
    if (tbl.length) {
      const { sql, params } = dateFilter('cr.date_created');
      const [headers] = await pool.query(
        `SELECT cr.* FROM customer_refunds cr WHERE cr.status != 'voided' AND ${sql}`, params
      );
      for (const cr of headers) {
        const rows = await computeCustomerRefundGl(cr);
        push(rows, {
          entry_date: cr.date_created, source_type: 'customer_refund', source_no: cr.customer_refund_no, source_id: cr.id, memo: cr.memo || null,
          location_id: cr.office_location_id || null, department_id: cr.department_id || null,
        });
      }
    }
  }

  // Journals (manual general-journal entries; void ones post nothing). Each line posts directly
  // to the GL at its own account/department -- a journal's GL Impact IS its lines.
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'journals'");
    if (tbl.length) {
      const { sql, params } = dateFilter('j.date_created');
      const [headers] = await pool.query(`SELECT j.* FROM journals j WHERE j.status <> 'void' AND ${sql}`, params);
      const linesBy = await linesByParent(
        `SELECT jl.journal_id, jl.debit, jl.credit, jl.department_id, coa.account_code, coa.account_name
           FROM journal_lines jl LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE jl.journal_id IN (?) ORDER BY jl.line_no`, 'journal_id', headers.map((h) => h.id));
      for (const j of headers) {
        const lines = linesBy.get(j.id) || [];
        const rows = glFor('journal', j.id, lines.map((l) => ({
          account_code: l.account_code, account_name: l.account_name,
          debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, department_id: l.department_id || null,
        })));
        // No department_id in meta so each line keeps its own (push spreads meta over the row).
        push(rows, { entry_date: j.date_created, source_type: 'journal', source_no: j.journal_no, source_id: j.id, memo: j.memo || null, location_id: j.location_id || null });
      }
    }
  }

  // Liquidations (Forms) post on the day they are APPROVED -- noted by AP with every item's COGS
  // assigned, then approved. Each line keeps its own memo and department (no memo/department in meta).
  {
    const [tbl] = await pool.query("SHOW COLUMNS FROM form_request_items LIKE 'cogs_account_id'");
    if (tbl.length) {
      const { sql, params } = dateFilter('DATE(f.approved_at)');
      const [headers] = await pool.query(
        `SELECT f.id, f.request_no, f.department_id, f.credit_account_id, f.approved_at
           FROM form_requests f WHERE f.type = 'liquidation' AND f.status = 'approved' AND f.approved_at IS NOT NULL AND ${sql}`, params);
      const linesBy = await linesByParent(
        'SELECT form_request_id, particulars, amount, cogs_account_id FROM form_request_items WHERE form_request_id IN (?) ORDER BY id',
        'form_request_id', headers.map((h) => h.id));
      for (const f of headers) {
        const rows = await computeLiquidationGl(f, linesBy.get(f.id) || []);
        push(rows, { entry_date: f.approved_at, source_type: 'liquidation', source_no: f.request_no, source_id: f.id, location_id: null });
      }
    }
  }

  // Cheques -- computeChequeGl above has the entry.
  //
  // VOID ONES POST. This is the case that proved the rule: the imported cheque journals are all
  // reversals, they were posting here, and the cheques they reverse were excluded by this very
  // clause -- 676 reversals cancelling nothing, 52.5M of ledger. Either both sides are present or
  // neither is, and both is what an auditable ledger means.
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'cheques'");
    if (tbl.length) {
      const { sql, params } = dateFilter('c.date_created');
      const [headers] = await pool.query(
        `SELECT c.*, coa.account_code AS bank_code, coa.account_name AS bank_name FROM cheques c
         LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id WHERE ${sql}`, params
      );
      const linesBy = await linesByParent(
        `SELECT cl.cheque_id, cl.amount, cl.department_id, coa.account_code, coa.account_name
           FROM cheque_lines cl LEFT JOIN chart_of_accounts coa ON coa.id = cl.account_id
          WHERE cl.cheque_id IN (?) ORDER BY cl.line_no`, 'cheque_id', headers.map((h) => h.id));
      const creditsBy = await chequeCreditsByCheque(headers.map((h) => h.id));
      for (const c of headers) {
        const rows = await computeChequeGl(c, linesBy.get(c.id) || [], creditsBy.get(c.id) || []);
        push(glFor('cheque', c.id, rows), { entry_date: c.date_created, source_type: 'cheque', source_no: c.cheque_no, source_id: c.id, memo: c.memo || null, location_id: c.office_location_id || null });
      }
    }
  }

  // Bill Payments -- computeBillPaymentGl above. VOID ONES POST, cancelled by their reversal journal
  // in the period of the void (lib/reversalJournal.js), as Cheques do: excluding them as well would
  // reverse them twice.
  {
    const { sql, params } = dateFilter('bp.date_created');
    const [headers] = await pool.query(`SELECT bp.* FROM bill_payments bp WHERE ${sql}`, params);
    for (const bp of headers) {
      const rows = await computeBillPaymentGl(bp);
      push(glFor('bill_payment', bp.id, rows), {
        entry_date: bp.date_created, source_type: 'bill_payment', source_no: bp.bill_payment_no, source_id: bp.id,
        memo: bp.memo || null, location_id: bp.office_location_id || null,
      });
    }
  }

  // Fund Transfers -- move money between two bank accounts: DR the To account / CR the From account.
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'fund_transfers'");
    if (tbl.length) {
      const { sql, params } = dateFilter('ft.date_created');
      const [headers] = await pool.query(
        `SELECT ft.*, fa.account_code AS from_code, fa.account_name AS from_name, ta.account_code AS to_code, ta.account_name AS to_name
         FROM fund_transfers ft
         LEFT JOIN chart_of_accounts fa ON fa.id = ft.from_account_id
         LEFT JOIN chart_of_accounts ta ON ta.id = ft.to_account_id
         WHERE ft.status <> 'void' AND ${sql}`, params
      );
      for (const ft of headers) {
        const amt = Number(ft.amount) || 0;
        if (!amt || !ft.from_code || !ft.to_code) continue;
        const rows = [
          { account_code: ft.to_code, account_name: ft.to_name, debit: amt, credit: 0 },
          { account_code: ft.from_code, account_name: ft.from_name, debit: 0, credit: amt },
        ];
        push(rows, { entry_date: ft.date_created, source_type: 'fund_transfer', source_no: ft.ft_no, source_id: ft.id, memo: ft.memo || null });
      }
    }
  }

  // Bank Deposits -- move cash from Undeposited Funds into a bank account, plus any Other Deposit /
  // Cash Back lines. Built by lib/depositGl.js, which the deposit's own GL Impact tab also uses.
  // Void ones post nothing.
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'bank_deposits'");
    if (tbl.length) {
      const { sql, params } = dateFilter('d.date_created');
      const [headers] = await pool.query(
        `SELECT d.*, coa.account_code, coa.account_name FROM bank_deposits d
         LEFT JOIN chart_of_accounts coa ON coa.id = d.account_id WHERE d.status <> 'void' AND ${sql}`, params
      );
      if (headers.length) {
        const uf = await coaByCode('10006');
        // Guarded like the header table: an install that has not run add-deposit-other-lines.js
        // yet still posts its deposits, just without lines.
        const linesByDeposit = new Map();
        const [lineTbl] = await pool.query("SHOW TABLES LIKE 'bank_deposit_lines'");
        if (lineTbl.length) {
          // Same filter as the headers, rather than an IN list of every deposit id in range.
          const [lines] = await pool.query(
            `SELECT l.*, coa.account_code, coa.account_name FROM bank_deposit_lines l
             JOIN bank_deposits d ON d.id = l.deposit_id
             JOIN chart_of_accounts coa ON coa.id = l.account_id
             WHERE d.status <> 'void' AND ${sql} ORDER BY l.deposit_id, l.line_no`, params
          );
          for (const l of lines) {
            if (!linesByDeposit.has(l.deposit_id)) linesByDeposit.set(l.deposit_id, []);
            linesByDeposit.get(l.deposit_id).push(l);
          }
        }
        for (const d of headers) {
          const rows = depositGlRows(d, linesByDeposit.get(d.id) || [], uf);
          if (!rows.length) continue;
          // No location_id in meta, so each Other Deposit / Cash Back row keeps its own.
          push(rows, { entry_date: d.date_created, source_type: 'bank_deposit', source_no: d.bd_no, source_id: d.id, memo: d.memo || null });
        }
      }
    }
  }

  // OSR Fulfillments -- withdrawing office supplies expenses them out of inventory:
  // DR 30504 Materials, Tools & Supplies / CR 15400 Supplies Inventory for the value moved.
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'osr_fulfillments'");
    if (tbl.length) {
      const { sql, params } = dateFilter('f.date_created');
      const [headers] = await pool.query(`SELECT f.* FROM osr_fulfillments f WHERE f.status <> 'void' AND ${sql}`, params);
      if (headers.length) {
        const dr = await coaByCode('30504');
        const cr = await coaByCode('15400');
        for (const f of headers) {
          const amt = Number(f.total_amount) || 0;
          if (!amt) continue;
          const rows = [
            { account_code: dr?.account_code || '30504', account_name: dr?.account_name || 'Materials, Tools & Supplies', debit: amt, credit: 0 },
            { account_code: cr?.account_code || '15400', account_name: cr?.account_name || 'Supplies Inventory', debit: 0, credit: amt },
          ];
          push(rows, { entry_date: f.date_created, source_type: 'osr_fulfillment', source_no: f.osrf_no, source_id: f.id, memo: f.memo || null, location_id: f.transfer_to_location_id || null });
        }
      }
    }
  }

  // Commission Payables (void ones post nothing)
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'commission_payables'");
    if (tbl.length) {
      const { sql, params } = dateFilter('cp.date_created');
      const [headers] = await pool.query(`SELECT cp.* FROM commission_payables cp WHERE cp.status != 'void' AND ${sql}`, params);
      for (const cp of headers) {
        const rows = await computeCommissionPayableGl(cp);
        // No department_id in meta: each GL row carries its own (a manager's expense is split across
        // sales divisions), and push() keeps row fields when meta omits them.
        push(rows, {
          entry_date: cp.date_created, source_type: 'commission_payable', source_no: cp.commission_payable_no,
          source_id: cp.id, memo: cp.memo || null, location_id: cp.office_location_id || null,
        });
      }
    }
  }

  // Commission Vouchers (void ones post nothing)
  {
    const [tbl] = await pool.query("SHOW TABLES LIKE 'commission_vouchers'");
    if (tbl.length) {
      const { sql, params } = dateFilter('cv.date_created');
      const [headers] = await pool.query(`SELECT cv.* FROM commission_vouchers cv WHERE cv.status != 'void' AND ${sql}`, params);
      const cvIds = headers.map((h) => h.id);
      const vlinesBy = await linesByParent(
        'SELECT * FROM commission_voucher_lines WHERE commission_voucher_id IN (?)', 'commission_voucher_id', cvIds);
      const vexpBy = await linesByParent(
        'SELECT * FROM commission_voucher_expenses WHERE commission_voucher_id IN (?)', 'commission_voucher_id', cvIds);
      for (const cv of headers) {
        const rows = await computeCommissionVoucherGl(cv, vlinesBy.get(cv.id) || [], vexpBy.get(cv.id) || []);
        push(rows, {
          entry_date: cv.date_created, source_type: 'commission_voucher', source_no: cv.voucher_no,
          source_id: cv.id, memo: cv.memo || null, location_id: null, department_id: null,
        });
      }
    }
  }

  // Delivery Tickets. 'converted' ones stay out: such a ticket has been superseded by the Sales
  // Invoice raised from it, which posts the same revenue against AR Trade (12100), so leaving them
  // in would double-count both the sale and the VAT. That is a different thing from a void, which
  // is why the two statuses are no longer treated alike.
  //
  // VOID ONES POST, and are cancelled by their REVERSAL journal in the period they were voided in
  // -- see the Sales Invoices block above and lib/reversalJournal.js. Excluding them here as well
  // would reverse them twice.
  {
    const { sql, params } = dateFilter('dt.date_created');
    const [headers] = await pool.query(
      `SELECT dt.*, so.office_location_id FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       WHERE dt.status IN ('open', 'void') AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      'SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id IN (?)', 'delivery_ticket_id',
      headers.map((h) => h.id));
    for (const dt of headers) {
      const lines = linesBy.get(dt.id) || [];
      const rows = await computeDeliveryTicketGl(dt, lines);
      push(rows, {
        entry_date: dt.date_created, source_type: 'delivery_ticket', source_no: dt.dt_no, source_id: dt.id, memo: dt.memo || null,
        location_id: dt.office_location_id || null, department_id: dt.department_id || null,
      });
    }
  }

  // Vendor Bills
  //
  // Prefer live's own posted entries where they were imported (live_gl_entries, filled by
  // src/db/import-vendor-bill-gl.js). computeVendorBillGl cannot reproduce these: the expense
  // account sits on live's GL line rather than the bill header, so vendor_bills.account_id is
  // null on 19,162 of 19,164 bills and the debit leg was being dropped while the Accounts
  // Payable credit still posted -- 212,383,275.57 of one-sided entries, 88% of the trial
  // balance's imbalance. Bills with no imported entries still fall back to the computed rows,
  // so a newly created bill keeps working.
  {
    const { sql, params } = dateFilter('vb.date_created');
    const [headers] = await pool.query(
      `SELECT vb.*, coa.account_code, coa.account_name
       FROM vendor_bills vb
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       WHERE vb.status != 'cancelled' AND ${sql}`, params
    );
    // A standalone (no-PO) bill debits its lines' own accounts, so its lines have to come along;
    // a PO bill's entry is its header alone, as before.
    const standaloneIds = headers.filter((h) => !h.purchase_order_id).map((h) => h.id);
    const standaloneLines = standaloneIds.length
      ? await linesByParent('SELECT * FROM vendor_bill_lines WHERE vendor_bill_id IN (?)', 'vendor_bill_id', standaloneIds)
      : new Map();
    for (const vb of headers) {
      const rows = glFor('vendor_bill', vb.id, await computeVendorBillGl(vb, standaloneLines.get(vb.id) || []));
      push(rows, {
        entry_date: vb.date_created, source_type: 'vendor_bill', source_no: vb.bill_no, source_id: vb.id, memo: vb.memo || null,
        location_id: vb.office_location_id || null, department_id: null,
      });
    }
  }

  // Inventory Adjustments (only approved ones post, per the existing live GL tab's gate)
  {
    const { sql, params } = dateFilter('ia.date_created');
    const [headers] = await pool.query(
      `SELECT ia.*, coa.account_code AS adjustment_account_code, coa.account_name AS adjustment_account_name,
              (SELECT location_id FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ia.id LIMIT 1) AS location_id,
              (SELECT department_id FROM inventory_adjustment_lines WHERE inventory_adjustment_id = ia.id LIMIT 1) AS department_id
       FROM inventory_adjustments ia
       LEFT JOIN chart_of_accounts coa ON coa.id = ia.adjustment_account_id
       WHERE ia.status = 'approved' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT l.*, i.asset_account_id,
              l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1) AS est_unit_cost_base
         FROM inventory_adjustment_lines l
         LEFT JOIN inventories i ON i.id = l.item_id
        WHERE l.inventory_adjustment_id IN (?)`, 'inventory_adjustment_id', headers.map((h) => h.id));
    for (const adj of headers) {
      const lines = linesBy.get(adj.id) || [];
      const rows = await computeInventoryAdjustmentGl(adj, lines);
      push(rows, {
        entry_date: adj.date_created, source_type: 'inventory_adjustment', source_no: adj.adjustment_no, source_id: adj.id, memo: adj.memo || null,
        location_id: adj.location_id || null, department_id: adj.department_id || null,
      });
    }
  }

  // Bill Credits (no cancel/void concept in this schema -- every row posts)
  {
    const { sql, params } = dateFilter('bc.date_created');
    const [headers] = await pool.query(
      `SELECT bc.*, apcoa.account_code AS ap_account_code, apcoa.account_name AS ap_account_name,
              (SELECT department_id FROM bill_credit_lines WHERE bill_credit_id = bc.id LIMIT 1) AS department_id
       FROM bill_credits bc
       LEFT JOIN chart_of_accounts apcoa ON apcoa.id = bc.ap_account_id
       WHERE ${sql}`, params
    );
    const linesBy = await linesByParent(
      `SELECT bcl.*, coa.account_code, coa.account_name
         FROM bill_credit_lines bcl
         LEFT JOIN chart_of_accounts coa ON coa.id = bcl.account_id
        WHERE bcl.bill_credit_id IN (?)`, 'bill_credit_id', headers.map((h) => h.id));
    for (const bc of headers) {
      const lines = linesBy.get(bc.id) || [];
      const rows = await computeBillCreditGl(bc, lines);
      push(rows, {
        entry_date: bc.date_created, source_type: 'bill_credit', source_no: bc.bill_credit_no, source_id: bc.id, memo: bc.memo || null,
        location_id: bc.office_location_id || null, department_id: bc.department_id || null,
      });
    }
  }

  // Asset Depreciation Runs
  //
  // Dated to the LAST day of the period they cover, not the first: depreciation is the expense of a
  // month that has finished, so September's charge belongs at 30 September. Only posted runs
  // count -- a voided one leaves the ledger entirely, which is safe because accumulated
  // depreciation is summed from posted lines rather than stored on the asset.
  {
    const { sql, params } = dateFilter('LAST_DAY(r.period_month)');
    const [headers] = await pool.query(
      `SELECT r.* FROM asset_depreciation_runs r WHERE r.status = 'posted' AND ${sql}`, params
    );
    const linesBy = await linesByParent(
      'SELECT * FROM asset_depreciation_lines WHERE run_id IN (?)', 'run_id',
      headers.map((h) => h.id));
    for (const run of headers) {
      const lines = linesBy.get(run.id) || [];
      const rows = await computeAssetDepreciationRunGl(lines);
      push(rows, {
        entry_date: lastDayOfMonth(run.period_month), source_type: 'asset_depreciation_run',
        source_no: run.run_no, source_id: run.id, memo: run.memo || `Depreciation for ${String(run.period_month).slice(0, 7)}`,
        location_id: null, department_id: null,
      });
    }
  }

  // Asset Disposals
  {
    const { sql, params } = dateFilter('d.disposal_date');
    const [headers] = await pool.query(
      `SELECT d.* FROM asset_disposals d WHERE d.status = 'posted' AND ${sql}`, params
    );
    for (const d of headers) {
      const rows = await computeAssetDisposalGl(d);
      push(rows, {
        entry_date: d.disposal_date, source_type: 'asset_disposal', source_no: d.disposal_no, source_id: d.id,
        memo: d.reason || d.memo || null, location_id: null, department_id: null,
      });
    }
  }

  return out;
  } finally {
    endRefRun();
  }
}

// The ledger every financial report reads. When the source system's figures are loaded
// (lib/openingBalances.js) T1S continues the source's books: its 2025-12-31 balances and its own
// month-by-month activity up to the cut-over, then T1S's ledger computed from documents after
// that. Documents before the cut-over stay in T1S as records to look up and act on, but do not
// feed balances -- migrated with known gaps, and T1S's posting rules did not reproduce the
// source's for production/inventory/purchasing. With nothing loaded nothing changes at all.
// Journals keyed in T1S itself (through the Journal screen -- the only path that writes a
// 'Created' audit row; migrated journals have none) but DATED before the books start: a late
// adjustment to a period the source closed, entered here rather than there (JRNL-6236, a
// September payroll entry made 2026-10-03). Asked 2026-10-03 to count them in T1S on top of the
// source's figures, so T1S's books for that period knowingly differ from the source by exactly
// these entries. Reversal journals (source_type set) are left out -- they belong to their document.
async function preStartT1sJournalLines(books, to, from) {
  const upTo = to < books.start ? to : (() => { const d = new Date(`${books.start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const params = [upTo, books.first]; let fromSql = '';
  if (from) { fromSql = ' AND j.date_created >= ?'; params.push(from); }
  const [headers] = await pool.query(
    `SELECT j.* FROM journals j
      WHERE j.status <> 'void' AND j.source_type IS NULL AND j.date_created <= ? AND j.date_created > ?${fromSql}
        AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.auditable_type = 'Journal' AND a.auditable_id = j.id AND a.event_type = 'Created')`,
    params,
  );
  if (!headers.length) return [];
  const [lines] = await pool.query(
    `SELECT jl.journal_id, jl.debit, jl.credit, jl.department_id, coa.account_code, coa.account_name
       FROM journal_lines jl LEFT JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE jl.journal_id IN (?) ORDER BY jl.journal_id, jl.line_no`, [headers.map((h) => h.id)]);
  const byId = new Map(headers.map((h) => [h.id, h]));
  return lines.filter((l) => Number(l.debit) || Number(l.credit)).map((l) => {
    const j = byId.get(l.journal_id);
    return {
      account_code: l.account_code, account_name: l.account_name, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
      department_id: l.department_id || null, entry_date: j.date_created, source_type: 'journal', source_no: j.journal_no,
      source_id: j.id, memo: j.memo || null, location_id: j.location_id || null,
    };
  });
}

async function getPostedGlLines({ toDate, fromDate }) {
  const books = await booksStart();
  const to = String(toDate).slice(0, 10);
  const from = fromDate ? String(fromDate).slice(0, 10) : null;
  // Before the first source figure (2025-12-31): history, exactly as before.
  if (!books || to < books.first) return computePostedGlLines({ toDate, fromDate });
  // The source's own figures -- the 2025-12-31 balances and each month's activity -- dated inside
  // the window. A report ending before the books start reads ONLY these (plus any journal keyed
  // in T1S for that period, above): up to the cut-over the source is the book of record.
  const source = await openingGlLines(to, from);
  const late = (!from || from < books.start) ? await preStartT1sJournalLines(books, to, from) : [];
  if (to < books.start) return [...source, ...late];
  // After the last source date, T1S's own ledger from its documents.
  const computed = await computePostedGlLines({ toDate, fromDate: from && from > books.start ? from : books.start });
  return [...source, ...late, ...computed];
}

module.exports = {
  computeSalesInvoiceGl,
  computeAssemblyBuildGl,
  computeItemDeliveryGl,
  computeTransitGl,
  computeDeliveryTicketGl,
  computeChequeGl,
  chequeCreditsByCheque,
  computeCustomerPaymentGl,
  computeBillPaymentGl,
  computeCreditMemoGl,
  computeCustomerRefundGl,
  computeCommissionPayableGl,
  computeCommissionVoucherGl,
  computeVendorBillGl,
  computeInventoryAdjustmentGl,
  computeBillCreditGl,
  computeAssetDepreciationRunGl,
  computeAssetDisposalGl,
  computeLiquidationGl,
  getPostedGlLines,
};
