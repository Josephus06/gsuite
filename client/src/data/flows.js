// The workflows the Manual module can draw.
//
// Each entry is a self-contained chart -- its own canvas size, nodes, edges, per-node guide and
// legend -- so adding another manual means adding a data file here and nothing else. The page
// itself knows only how to draw "a flow".
//
// Node and diamond SIZES are shared across all of them (processFlow.js owns those constants), so
// one chart never renders at a different scale from another.
import * as regular from './processFlow';
import * as bankReconciliation from './bankReconciliationFlow';

export const FLOWS = [
  {
    key: 'regular',
    label: 'Regular Work Flow',
    title: 'Process Flow',
    blurb: 'The full order-to-cash process, start to finish. Click any box to open the step-by-step guide for that stage — where it lives, who can do it, and what to click.',
    data: regular,
  },
  {
    key: 'bank-reconciliation',
    label: 'Bank Reconciliation',
    title: 'Bank Reconciliation',
    blurb: 'How a bank statement is reconciled, from downloading it to closing the period. Click any box for what to do at that step, and what the buttons on that screen actually mean.',
    data: bankReconciliation,
  },
];

export const DEFAULT_FLOW = FLOWS[0].key;
