const pool = require('../db');

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
  const [[arAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");
  const [[salesAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '30100'");
  if (!arAcct || !salesAcct) return [];

  const rows = [];
  const grossAmount = Number(si.gross_amount) || 0;
  const netOfTax = Number(si.net_of_tax) || 0;
  if (grossAmount) rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: grossAmount, credit: 0 });
  if (netOfTax) rows.push({ account_code: salesAcct.account_code, account_name: salesAcct.account_name, debit: 0, credit: netOfTax });

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
      const [[t]] = await pool.query('SELECT tax_account_id FROM taxes WHERE code = ?', [code]);
      if (t?.tax_account_id) {
        const [[a]] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE id = ?', [t.tax_account_id]);
        acct = a;
      }
    }
    if (!acct) {
      const [[fallback]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '21100'");
      acct = fallback;
    }
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

  const [coaRows] = await conn.query(
    'SELECT id, account_code, account_name FROM chart_of_accounts WHERE id = ? OR account_code IN (?)',
    [ab.fg_account_id, Object.values(ASSEMBLY_BUILD_FIXED_GL_CODES)]
  );
  const itemAccountIds = [...new Set(lines.map((l) => l.item_asset_account_id).filter(Boolean))];
  if (itemAccountIds.length) {
    const [itemCoaRows] = await conn.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [itemAccountIds]);
    coaRows.push(...itemCoaRows);
  }
  const coaById = new Map(coaRows.map((c) => [c.id, c]));
  const coaByCode = new Map(coaRows.map((c) => [c.account_code, c]));

  const processIds = [...new Set(lines.map((l) => l.process_id).filter(Boolean))];
  const bracketsByProcess = new Map();
  if (processIds.length) {
    const [brackets] = await conn.query(
      'SELECT * FROM process_cost_brackets WHERE process_id IN (?) AND is_active = TRUE ORDER BY qty_min',
      [processIds]
    );
    for (const b of brackets) {
      if (!bracketsByProcess.has(b.process_id)) bracketsByProcess.set(b.process_id, []);
      bracketsByProcess.get(b.process_id).push(b);
    }
  }

  const credits = new Map(); // account_id -> amount
  function credit(accountId, amount) {
    if (!accountId || !amount) return;
    credits.set(accountId, (credits.get(accountId) || 0) + amount);
  }

  let debitTotal = 0;
  for (const line of lines) {
    debitTotal += Number(line.total_cost) || 0;

    const materialCost = Number(line.material_cost) || 0;
    if (materialCost) {
      const acct = line.item_asset_account_id ? coaById.get(line.item_asset_account_id) : null;
      credit(acct ? acct.id : coaByCode.get(ASSEMBLY_BUILD_FIXED_GL_CODES.directMaterials)?.id, materialCost);
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
          credit(coaByCode.get(code)?.id, processCost * (amount / componentTotal));
        }
      } else {
        // No bracket found (or every component is zero) -- can't split, so don't
        // silently drop the cost: land it all on Direct Labor as the single most
        // common component rather than fabricating a breakdown we don't have data for.
        credit(coaByCode.get(ASSEMBLY_BUILD_FIXED_GL_CODES.directLabor)?.id, processCost);
      }
    }
  }

  const rows = [];
  for (const [accountId, amount] of credits) {
    const acct = coaById.get(accountId);
    if (!acct) continue;
    rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: 0, credit: Number(amount.toFixed(2)) });
  }
  const fgAcct = coaById.get(ab.fg_account_id);
  if (fgAcct && debitTotal) {
    rows.unshift({ account_code: fgAcct.account_code, account_name: fgAcct.account_name, debit: Number(debitTotal.toFixed(2)), credit: 0 });
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
  const [coaRows] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [accountIds]);
  const coaById = new Map(coaRows.map((c) => [c.id, c]));

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
    const acct = coaById.get(id);
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: Number(amt.toFixed(2)), credit: 0 });
  }
  for (const [id, amt] of credits) {
    const acct = coaById.get(id);
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
  const [[transitAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '15900'");
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

  const [assetAccts] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [[...assetAmounts.keys()]]);
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
// double-count. Unapplied cash likewise doesn't touch AR; it sits as an on-account
// balance this build tracks on the payment itself rather than in the ledger.
async function computeCustomerPaymentGl(cp, lines) {
  const [[arAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");
  if (!arAcct || !cp.deposit_account_id) return [];
  const [[depositAcct]] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE id = ?', [cp.deposit_account_id]);
  if (!depositAcct) return [];

  const appliedToInvoices = lines
    .filter((l) => l.sales_invoice_id)
    .reduce((s, l) => s + Number(l.applied_amount || 0), 0);
  const amount = Number(appliedToInvoices.toFixed(2));
  if (!amount) return [];

  return [
    { account_code: depositAcct.account_code, account_name: depositAcct.account_name, debit: amount, credit: 0 },
    { account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: amount },
  ];
}

// GL Impact for a Credit Memo -- the exact reversal of the Sales Invoice entry it credits
// back: debit Sales (30100) for the net amount and VAT on Sales for the tax (both of
// which the invoice credited), and credit Accounts Receivable Trade (12100) for the gross
// the customer no longer owes.
//
// VAT is routed per line tax code via taxes.tax_account_id, same as the invoice's own
// entry, so a credit reverses tax onto exactly the account the sale put it on.
async function computeCreditMemoGl(cm, lines) {
  const [[arAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '12100'");
  const [[salesAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '30100'");
  if (!arAcct || !salesAcct) return [];

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
      const [[t]] = await pool.query('SELECT tax_account_id FROM taxes WHERE code = ?', [code]);
      if (t?.tax_account_id) {
        const [[a]] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE id = ?', [t.tax_account_id]);
        acct = a;
      }
    }
    if (!acct) {
      const [[fallback]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '21100'");
      acct = fallback;
    }
    if (acct) rows.push({ account_code: acct.account_code, account_name: acct.account_name, debit: Number(amt.toFixed(2)), credit: 0 });
  }

  if (grossAmount) rows.push({ account_code: arAcct.account_code, account_name: arAcct.account_name, debit: 0, credit: grossAmount });
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
async function computeDeliveryTicketGl(dt, lines) {
  const [[arUnbilled]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '12101'");
  const [[salesAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '30100'");
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
      const [[t]] = await pool.query('SELECT tax_account_id FROM taxes WHERE code = ?', [code]);
      if (t?.tax_account_id) {
        const [[a]] = await pool.query('SELECT account_code, account_name FROM chart_of_accounts WHERE id = ?', [t.tax_account_id]);
        acct = a;
      }
    }
    if (!acct) {
      const [[fallback]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '21100'");
      acct = fallback;
    }
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
  const [[apAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '20100'");
  const [[vatAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '14300'");
  if (!apAcct) return [];

  const rows = [];
  const grossAmount = Number(vb.gross_amount) || 0;
  const netOfTax = Number(vb.net_of_tax) || 0;
  const taxAmount = Number(vb.tax_amount) || 0;
  if (grossAmount) rows.push({ account_code: apAcct.account_code, account_name: apAcct.account_name, debit: 0, credit: grossAmount });
  if (netOfTax && vb.account_code) rows.push({ account_code: vb.account_code, account_name: vb.account_name, debit: netOfTax, credit: 0 });
  if (taxAmount && vatAcct) rows.push({ account_code: vatAcct.account_code, account_name: vatAcct.account_name, debit: taxAmount, credit: 0 });
  return rows;
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

  const [itemAccts] = await pool.query('SELECT id, account_code, account_name FROM chart_of_accounts WHERE id IN (?)', [[...itemAccountAmounts.keys()]]);
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
    const [[vatAcct]] = await pool.query("SELECT account_code, account_name FROM chart_of_accounts WHERE account_code = '14300'");
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
async function getPostedGlLines({ toDate, fromDate }) {
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

  // Sales Invoices
  {
    const { sql, params } = dateFilter('si.date_created');
    const [headers] = await pool.query(
      `SELECT si.* FROM sales_invoices si WHERE si.status != 'cancelled' AND ${sql}`, params
    );
    for (const si of headers) {
      const [lines] = await pool.query('SELECT * FROM sales_invoice_lines WHERE sales_invoice_id = ?', [si.id]);
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
      `SELECT ab.*, jt.asset_account_id AS fg_account_id, jo.job_location_id AS location_id
       FROM assembly_builds ab
       JOIN job_orders jo ON jo.id = ab.job_order_id
       LEFT JOIN job_types jt ON jt.id = jo.job_type_id
       WHERE ab.status != 'cancelled' AND ${sql}`, params
    );
    for (const ab of headers) {
      const [lines] = await pool.query(
        `SELECT abl.*, i.asset_account_id AS item_asset_account_id
         FROM assembly_build_lines abl
         LEFT JOIN inventories i ON i.id = abl.item_id
         WHERE abl.assembly_build_id = ?`, [ab.id]
      );
      const rows = await computeAssemblyBuildGl(pool, ab, lines);
      push(rows, {
        entry_date: ab.date_created, source_type: 'assembly_build', source_no: ab.ab_no, source_id: ab.id, memo: ab.memo || null,
        location_id: ab.location_id || null, department_id: null,
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
               WHERE idl2.item_delivery_id = del.id LIMIT 1) AS location_id
       FROM item_deliveries del WHERE del.status != 'cancelled' AND ${sql}`, params
    );
    for (const d of headers) {
      const [lines] = await pool.query(
        `SELECT idl.*, jo.quantity AS jo_quantity,
                jt.cogs_account_id, jt.asset_account_id,
                (SELECT COALESCE(SUM(total_cost), 0) FROM job_order_processes WHERE job_order_id = jo.id) AS jo_total_cost
         FROM item_delivery_lines idl
         LEFT JOIN job_orders jo ON jo.id = idl.job_order_id
         LEFT JOIN job_types jt ON jt.id = jo.job_type_id
         WHERE idl.item_delivery_id = ?`, [d.id]
      );
      const rows = await computeItemDeliveryGl(lines);
      push(rows, {
        entry_date: d.date_created, source_type: 'item_delivery', source_no: d.delivery_no, source_id: d.id, memo: d.memo || null,
        location_id: d.location_id || null, department_id: null,
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
    for (const f of headers) {
      const [lines] = await pool.query(
        `SELECT ifl.*, i.average_cost, i.asset_account_id
         FROM item_fulfillment_lines ifl
         LEFT JOIN inventories i ON i.id = ifl.item_id
         WHERE ifl.item_fulfillment_id = ?`, [f.id]
      );
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
    for (const r of headers) {
      const [lines] = await pool.query(
        `SELECT rl.*, i.average_cost, i.asset_account_id
         FROM item_receipt_lines rl
         LEFT JOIN inventories i ON i.id = rl.item_id
         WHERE rl.item_receipt_id = ?`, [r.id]
      );
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
    for (const cp of headers) {
      const [lines] = await pool.query('SELECT * FROM customer_payment_lines WHERE customer_payment_id = ?', [cp.id]);
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
    for (const cm of headers) {
      const [lines] = await pool.query('SELECT * FROM credit_memo_lines WHERE credit_memo_id = ?', [cm.id]);
      const rows = await computeCreditMemoGl(cm, lines);
      push(rows, {
        entry_date: cm.date_created, source_type: 'credit_memo', source_no: cm.credit_memo_no, source_id: cm.id, memo: cm.memo || null,
        location_id: cm.office_location_id || null, department_id: null,
      });
    }
  }

  // Delivery Tickets. Only *open* ones post: a void ticket never happened, and a
  // 'converted' one has been superseded by the Sales Invoice raised from it, which posts
  // the same revenue against AR Trade (12100). Leaving converted tickets in would
  // double-count both the sale and the VAT.
  {
    const { sql, params } = dateFilter('dt.date_created');
    const [headers] = await pool.query(
      `SELECT dt.*, so.office_location_id FROM delivery_tickets dt
       JOIN sales_orders so ON so.id = dt.sales_order_id
       WHERE dt.status = 'open' AND ${sql}`, params
    );
    for (const dt of headers) {
      const [lines] = await pool.query('SELECT * FROM delivery_ticket_lines WHERE delivery_ticket_id = ?', [dt.id]);
      const rows = await computeDeliveryTicketGl(dt, lines);
      push(rows, {
        entry_date: dt.date_created, source_type: 'delivery_ticket', source_no: dt.dt_no, source_id: dt.id, memo: dt.memo || null,
        location_id: dt.office_location_id || null, department_id: dt.department_id || null,
      });
    }
  }

  // Vendor Bills
  {
    const { sql, params } = dateFilter('vb.date_created');
    const [headers] = await pool.query(
      `SELECT vb.*, coa.account_code, coa.account_name
       FROM vendor_bills vb
       LEFT JOIN chart_of_accounts coa ON coa.id = vb.account_id
       WHERE vb.status != 'cancelled' AND ${sql}`, params
    );
    for (const vb of headers) {
      const rows = await computeVendorBillGl(vb, []);
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
    for (const adj of headers) {
      const [lines] = await pool.query(
        `SELECT l.*, i.asset_account_id,
                l.est_unit_cost / COALESCE(NULLIF(i.conversion_factor, 0), 1) AS est_unit_cost_base
         FROM inventory_adjustment_lines l
         LEFT JOIN inventories i ON i.id = l.item_id
         WHERE l.inventory_adjustment_id = ?`, [adj.id]
      );
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
    for (const bc of headers) {
      const [lines] = await pool.query(
        `SELECT bcl.*, coa.account_code, coa.account_name
         FROM bill_credit_lines bcl
         LEFT JOIN chart_of_accounts coa ON coa.id = bcl.account_id
         WHERE bcl.bill_credit_id = ?`, [bc.id]
      );
      const rows = await computeBillCreditGl(bc, lines);
      push(rows, {
        entry_date: bc.date_created, source_type: 'bill_credit', source_no: bc.bill_credit_no, source_id: bc.id, memo: bc.memo || null,
        location_id: bc.office_location_id || null, department_id: bc.department_id || null,
      });
    }
  }

  return out;
}

module.exports = {
  computeSalesInvoiceGl,
  computeAssemblyBuildGl,
  computeItemDeliveryGl,
  computeTransitGl,
  computeDeliveryTicketGl,
  computeCustomerPaymentGl,
  computeCreditMemoGl,
  computeVendorBillGl,
  computeInventoryAdjustmentGl,
  computeBillCreditGl,
  getPostedGlLines,
};
