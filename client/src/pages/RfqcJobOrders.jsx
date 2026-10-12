import ReworkJobOrderList from '../components/ReworkJobOrderList';

// RFQC Job Orders under Production -- the shared rework list (components/ReworkJobOrderList.jsx).
export default function RfqcJobOrders() {
  return <ReworkJobOrderList prefix="RFQC" />;
}
