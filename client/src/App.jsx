import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Employees from './pages/Employees';
import Users from './pages/Users';
import UserWizard from './pages/UserWizard';
import Customers from './pages/Customers';
import CustomerView from './pages/CustomerView';
import Leads from './pages/Leads';
import Opportunities from './pages/Opportunities';
import OpportunityView from './pages/OpportunityView';
import CrmDashboard from './pages/CrmDashboard';
import Suppliers from './pages/Suppliers';
import Inventory from './pages/Inventory';
import InventoryView from './pages/InventoryView';
import InventoryEdit from './pages/InventoryEdit';
import ServiceItems from './pages/ServiceItems';
import Estimates from './pages/Estimates';
import EstimateView from './pages/EstimateView';
import EstimateWizard from './pages/EstimateWizard';
import EstimatePrint from './pages/EstimatePrint';
import SalesOrders from './pages/SalesOrders';
import SalesOrderView from './pages/SalesOrderView';
import JobOrders from './pages/JobOrders';
import JobOrderView from './pages/JobOrderView';
import JobOrderEdit from './pages/JobOrderEdit';
import PmsJobTypes from './pages/PmsJobTypes';
import JobTypes from './pages/JobTypes';
import JobTypeEdit from './pages/JobTypeEdit';
import AssignedJobOrders from './pages/AssignedJobOrders';
import AssignedJobOrderRun from './pages/AssignedJobOrderRun';
import Production from './pages/Production';
import ProductionJobOrderView from './pages/ProductionJobOrderView';
import StockLedgerReport from './pages/StockLedgerReport';
import BinCardReport from './pages/BinCardReport';
import InventoryAdjustments from './pages/InventoryAdjustments';
import InventoryAdjustmentEdit from './pages/InventoryAdjustmentEdit';
import InventoryAdjustmentView from './pages/InventoryAdjustmentView';
import TransferOrders from './pages/TransferOrders';
import TransferOrderEdit from './pages/TransferOrderEdit';
import TransferOrderView from './pages/TransferOrderView';
import ReallocateItems from './pages/ReallocateItems';
import ItemFulfillments from './pages/ItemFulfillments';
import ItemFulfillmentView from './pages/ItemFulfillmentView';
import ItemReceipts from './pages/ItemReceipts';
import ItemReceiptView from './pages/ItemReceiptView';
import QualityInspectionView from './pages/QualityInspectionView';
import ItemDelivery from './pages/ItemDelivery';
import ItemDeliveryView from './pages/ItemDeliveryView';
import ItemDeliveries from './pages/ItemDeliveries';
import QualityInspections from './pages/QualityInspections';
import SalesInvoiceView from './pages/SalesInvoiceView';
import SalesInvoices from './pages/SalesInvoices';
import PurchaseRequisitions from './pages/PurchaseRequisitions';
import PurchaseRequisitionEdit from './pages/PurchaseRequisitionEdit';
import PurchaseRequisitionView from './pages/PurchaseRequisitionView';
import PlaceOrderForm from './pages/PlaceOrderForm';
import PurchaseOrders from './pages/PurchaseOrders';
import PurchaseOrderView from './pages/PurchaseOrderView';
import PurchaseOrderCreate from './pages/PurchaseOrderCreate';
import PurchaseOrderEdit from './pages/PurchaseOrderEdit';
import LandedCostEdit from './pages/LandedCostEdit';
import ReceivingReportEdit from './pages/ReceivingReportEdit';
import ReceivingReportView from './pages/ReceivingReportView';
import PurchaseReturnEdit from './pages/PurchaseReturnEdit';
import PurchaseReturnView from './pages/PurchaseReturnView';
import VendorBills from './pages/VendorBills';
import VendorBillView from './pages/VendorBillView';
import BillPayments from './pages/BillPayments';
import BillPaymentView from './pages/BillPaymentView';
import BillCredits from './pages/BillCredits';
import BillCreditView from './pages/BillCreditView';
import ChartOfAccountTypes from './pages/ChartOfAccountTypes';
import ChartOfAccounts from './pages/ChartOfAccounts';
import ChartOfAccountEdit from './pages/ChartOfAccountEdit';
import ChartOfAccountView from './pages/ChartOfAccountView';
import TrialBalance from './pages/reports/TrialBalance';
import IncomeStatement from './pages/reports/IncomeStatement';
import BalanceSheet from './pages/reports/BalanceSheet';
import GeneralLedger from './pages/reports/GeneralLedger';
import Lookups from './pages/Lookups';
import ProcessCosting from './pages/ProcessCosting';
import MaterialCosting from './pages/MaterialCosting';
import ScheduledJobOrders from './pages/ScheduledJobOrders';
import ScheduledJobOrderTasks from './pages/ScheduledJobOrderTasks';
import ScheduledJobOrderRun from './pages/ScheduledJobOrderRun';
import AssemblyBuilds from './pages/AssemblyBuilds';
import AssemblyBuildView from './pages/AssemblyBuildView';
import Tickets from './pages/Tickets';
import TicketView from './pages/TicketView';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/tickets/:id" element={<TicketView />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/new" element={<UserWizard />} />
        <Route path="/users/:id/edit" element={<UserWizard />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerView />} />
        <Route path="/crm-dashboard" element={<CrmDashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/opportunities" element={<Opportunities />} />
        <Route path="/opportunities/:id" element={<OpportunityView />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/inventory/new" element={<InventoryEdit />} />
        <Route path="/inventory/:id/edit" element={<InventoryEdit />} />
        <Route path="/inventory/:id" element={<InventoryView />} />
        <Route path="/service-items" element={<ServiceItems />} />
        <Route path="/estimates" element={<Estimates />} />
        <Route path="/estimates/new" element={<EstimateWizard />} />
        <Route path="/estimates/:id/edit" element={<EstimateWizard />} />
        <Route path="/estimates/:id" element={<EstimateView />} />
        <Route path="/estimates/:id/print" element={<EstimatePrint />} />
        <Route path="/sales-orders" element={<SalesOrders />} />
        <Route path="/sales-orders/:id" element={<SalesOrderView />} />
        <Route path="/job-orders" element={<JobOrders />} />
        <Route path="/job-orders/:id" element={<JobOrderView />} />
        <Route path="/job-orders/:id/edit" element={<JobOrderEdit />} />
        <Route path="/pms-job-types" element={<PmsJobTypes />} />
        <Route path="/job-types" element={<JobTypes />} />
        <Route path="/job-types/new" element={<JobTypeEdit />} />
        <Route path="/job-types/:id/edit" element={<JobTypeEdit />} />
        <Route path="/assigned-jo" element={<AssignedJobOrders />} />
        <Route path="/assigned-jo/:id" element={<AssignedJobOrderRun />} />
        <Route path="/production" element={<Production />} />
        <Route path="/production/:id" element={<ProductionJobOrderView />} />
        <Route path="/scheduled-jo" element={<ScheduledJobOrders />} />
        <Route path="/scheduled-jo/process/:id" element={<ScheduledJobOrderRun />} />
        <Route path="/scheduled-jo/:id" element={<ScheduledJobOrderTasks />} />
        <Route path="/assembly-builds" element={<AssemblyBuilds />} />
        <Route path="/assembly-builds/:id" element={<AssemblyBuildView />} />
        <Route path="/stock-ledger-reports" element={<StockLedgerReport />} />
        <Route path="/bin-card-reports" element={<BinCardReport />} />
        <Route path="/inventory-adjustments" element={<InventoryAdjustments />} />
        <Route path="/inventory-adjustments/new" element={<InventoryAdjustmentEdit />} />
        <Route path="/inventory-adjustments/:id/edit" element={<InventoryAdjustmentEdit />} />
        <Route path="/inventory-adjustments/:id" element={<InventoryAdjustmentView />} />
        <Route path="/transfer-orders" element={<TransferOrders />} />
        <Route path="/transfer-orders/new" element={<TransferOrderEdit />} />
        <Route path="/transfer-orders/:id/edit" element={<TransferOrderEdit />} />
        <Route path="/transfer-orders/:id" element={<TransferOrderView />} />
        <Route path="/transfer-orders/:id/lines/:lineId/reallocate" element={<ReallocateItems />} />
        <Route path="/transfer-orders/item-fulfillments/:fulfillmentId" element={<ItemFulfillmentView />} />
        <Route path="/transfer-orders/item-receipts/:receiptId" element={<ItemReceiptView />} />
        <Route path="/item-fulfillments" element={<ItemFulfillments />} />
        <Route path="/item-receipts" element={<ItemReceipts />} />
        <Route path="/quality-inspections" element={<QualityInspections />} />
        <Route path="/quality-inspections/:id" element={<QualityInspectionView />} />
        <Route path="/sales-orders/:id/item-delivery/new" element={<ItemDelivery />} />
        <Route path="/item-deliveries" element={<ItemDeliveries />} />
        <Route path="/item-deliveries/:id" element={<ItemDeliveryView />} />
        <Route path="/sales-invoices" element={<SalesInvoices />} />
        <Route path="/sales-invoices/:id" element={<SalesInvoiceView />} />
        <Route path="/purchase-requisitions" element={<PurchaseRequisitions />} />
        <Route path="/purchase-requisitions/new" element={<PurchaseRequisitionEdit />} />
        <Route path="/purchase-requisitions/:id/edit" element={<PurchaseRequisitionEdit />} />
        <Route path="/purchase-requisitions/:id" element={<PurchaseRequisitionView />} />
        <Route path="/place-order-form" element={<PlaceOrderForm />} />
        <Route path="/purchase-orders" element={<PurchaseOrders />} />
        <Route path="/purchase-orders/new" element={<PurchaseOrderCreate />} />
        <Route path="/purchase-orders/:id/edit" element={<PurchaseOrderEdit />} />
        <Route path="/purchase-orders/:id/landed-cost/new" element={<LandedCostEdit />} />
        <Route path="/purchase-orders/:id/receive" element={<ReceivingReportEdit />} />
        <Route path="/purchase-orders/receipts/:receiptId" element={<ReceivingReportView />} />
        <Route path="/purchase-orders/:id/return" element={<PurchaseReturnEdit />} />
        <Route path="/purchase-orders/returns/:returnId" element={<PurchaseReturnView />} />
        <Route path="/purchase-orders/:id" element={<PurchaseOrderView />} />
        <Route path="/vendor-bills" element={<VendorBills />} />
        <Route path="/vendor-bills/:id" element={<VendorBillView />} />
        <Route path="/bill-payments" element={<BillPayments />} />
        <Route path="/bill-payments/:id" element={<BillPaymentView />} />
        <Route path="/bill-credits" element={<BillCredits />} />
        <Route path="/bill-credits/:id" element={<BillCreditView />} />
        <Route path="/chart-of-account-types" element={<ChartOfAccountTypes />} />
        <Route path="/chart-of-accounts" element={<ChartOfAccounts />} />
        <Route path="/chart-of-accounts/new" element={<ChartOfAccountEdit />} />
        <Route path="/chart-of-accounts/:id/edit" element={<ChartOfAccountEdit />} />
        <Route path="/chart-of-accounts/:id" element={<ChartOfAccountView />} />
        <Route path="/reports/trial-balance" element={<TrialBalance />} />
        <Route path="/reports/income-statement" element={<IncomeStatement />} />
        <Route path="/reports/balance-sheet" element={<BalanceSheet />} />
        <Route path="/reports/general-ledger" element={<GeneralLedger />} />
        <Route path="/lookups" element={<Lookups />} />
        <Route path="/process-costing" element={<ProcessCosting />} />
        <Route path="/material-costing" element={<MaterialCosting />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
