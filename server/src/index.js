require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const lookupRoutes = require('./routes/lookups');
const employeeRoutes = require('./routes/employees');
const userRoutes = require('./routes/users');
const customerRoutes = require('./routes/customers');
const supplierRoutes = require('./routes/suppliers');
const inventoryRoutes = require('./routes/inventories');
const estimateRoutes = require('./routes/estimates');
const blanketPoRoutes = require('./routes/blanketPos');
const processCostingRoutes = require('./routes/processCosting');
const salesOrderRoutes = require('./routes/salesOrders');
const jobOrderRoutes = require('./routes/jobOrders');
const pmsJobTypeRoutes = require('./routes/pmsJobTypes');
const jobTypeRoutes = require('./routes/jobTypes');
const assignedJobOrderRoutes = require('./routes/assignedJobOrders');
const productionRoutes = require('./routes/production');
const stockLedgerRoutes = require('./routes/stockLedger');
const binCardRoutes = require('./routes/binCard');
const inventoryAdjustmentRoutes = require('./routes/inventoryAdjustments');
const chartOfAccountTypeRoutes = require('./routes/chartOfAccountTypes');
const chartOfAccountRoutes = require('./routes/chartOfAccounts');
const scheduledJobOrderRoutes = require('./routes/scheduledJobOrders');
const assemblyBuildRoutes = require('./routes/assemblyBuilds');
const dashboardRoutes = require('./routes/dashboard');
const transferOrderRoutes = require('./routes/transferOrders');
const qualityInspectionRoutes = require('./routes/qualityInspections');
const itemDeliveryRoutes = require('./routes/itemDeliveries');
const salesInvoiceRoutes = require('./routes/salesInvoices');
const purchaseRequisitionRoutes = require('./routes/purchaseRequisitions');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
const vendorBillRoutes = require('./routes/vendorBills');
const billPaymentRoutes = require('./routes/billPayments');
const billCreditRoutes = require('./routes/billCredits');
const adminRoutes = require('./routes/admin');
const reportsRoutes = require('./routes/reports');
const leadRoutes = require('./routes/leads');
const crmPipelineRoutes = require('./routes/crmPipeline');
const crmActivityRoutes = require('./routes/crmActivities');
const chatbotRoutes = require('./routes/chatbot');
const ticketRoutes = require('./routes/tickets');
const ticketReportRoutes = require('./routes/ticketReport');
const notificationRoutes = require('./routes/notifications');
const nonStandardJobOrderRoutes = require('./routes/nonStandardJobOrders');
const { ensureAssignedAtColumn } = require('./db/ensureSchema');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' })); // room for the base64 profile-picture payload

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/lookups', lookupRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/blanket-pos', blanketPoRoutes);
app.use('/api/processes', processCostingRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/job-orders', jobOrderRoutes);
app.use('/api/pms-job-types', pmsJobTypeRoutes);
app.use('/api/job-types', jobTypeRoutes);
app.use('/api/assigned-jo', assignedJobOrderRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/stock-ledger-reports', stockLedgerRoutes);
app.use('/api/bin-card-reports', binCardRoutes);
app.use('/api/inventory-adjustments', inventoryAdjustmentRoutes);
app.use('/api/chart-of-account-types', chartOfAccountTypeRoutes);
app.use('/api/chart-of-accounts', chartOfAccountRoutes);
app.use('/api/scheduled-jo', scheduledJobOrderRoutes);
app.use('/api/assembly-builds', assemblyBuildRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/transfer-orders', transferOrderRoutes);
app.use('/api/quality-inspections', qualityInspectionRoutes);
app.use('/api/item-deliveries', itemDeliveryRoutes);
app.use('/api/sales-invoices', salesInvoiceRoutes);
app.use('/api/purchase-requisitions', purchaseRequisitionRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/vendor-bills', vendorBillRoutes);
app.use('/api/bill-payments', billPaymentRoutes);
app.use('/api/bill-credits', billCreditRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/crm-pipeline', crmPipelineRoutes);
app.use('/api/crm-activities', crmActivityRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/reports/tickets', ticketReportRoutes);
app.use('/api/tickets/report', ticketReportRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/non-standard-job-orders', nonStandardJobOrderRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// In production (Railway) the client is built into client/dist and this server
// serves it directly -- single deployable service, same origin as /api so the
// client's relative baseURL('/api') keeps working with no config.
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.sqlMessage || err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    await ensureAssignedAtColumn();
    app.listen(PORT, () => console.log(`GSUITE ERP API listening on http://localhost:${PORT}`));
  } catch (error) {
    console.error('Failed to ensure database schema:', error);
    process.exit(1);
  }
}

startServer();
