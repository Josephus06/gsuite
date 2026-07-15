function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Recursively renders one COA node (Trial Balance/Balance Sheet's shared shape:
// account_code, account_name, is_summary, amount, children[]), indenting each level
// to visualize the parent/child rollup -- summary/parent rows are bolded since their
// amount is a computed sum of their children, not a directly posted balance.
export default function CoaTreeRows({ node, depth = 0, normal }) {
  const rows = [];
  const isDebitCol = normal === 'DEBIT';
  rows.push(
    <tr key={node.account_code}>
      <td data-label="Account Code" style={{ paddingLeft: 12 + depth * 20 }}>{node.account_code}</td>
      <td data-label="Account Title" style={node.is_summary ? { fontWeight: 600 } : undefined}>{node.account_name}</td>
      <td data-label="Debit" style={{ textAlign: 'right' }}>{isDebitCol ? money(node.amount) : ''}</td>
      <td data-label="Credit" style={{ textAlign: 'right' }}>{!isDebitCol ? money(node.amount) : ''}</td>
    </tr>
  );
  for (const child of node.children || []) {
    rows.push(<CoaTreeRows key={child.account_code} node={child} depth={depth + 1} normal={normal} />);
  }
  return rows;
}

export { money };
