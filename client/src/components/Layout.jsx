import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

// Mirrors the real GraphicStar system's topbar arrangement: a row of category
// dropdowns (Master Lists, Inventory, Sales, Costing, ...) instead of a left
// sidebar. Each category groups the pages we've actually built under the same
// names the real system uses for them.
const NAV_STRUCTURE = [
  { route: '/dashboard', label: 'Dashboard' },
  {
    label: 'Master Lists',
    children: [
      { route: '/employees', label: 'Employees' },
      { route: '/users', label: 'Users & Permissions' },
      { route: '/customers', label: 'Customers' },
      { route: '/suppliers', label: 'Suppliers' },
      { route: '/job-types', label: 'Job Types' },
      { route: '/pms-job-types', label: 'PMS Job Types' },
      { route: '/service-items', label: 'Service Items' },
      { route: '/lookups', label: 'Lookups' },
    ],
  },
  {
    label: 'Inventory',
    children: [
      { route: '/inventory', label: 'Inventory Items' },
      { route: '/inventory-adjustments', label: 'Inventory Adjustments' },
      { route: '/transfer-orders', label: 'Transfer Orders' },
      { route: '/stock-ledger-reports', label: 'Stock Ledger' },
      { route: '/bin-card-reports', label: 'Bin Card' },
    ],
  },
  {
    label: 'Sales',
    children: [
      { route: '/estimates', label: 'Estimates' },
      { route: '/sales-orders', label: 'Sales Orders' },
      { route: '/job-orders', label: 'Job Orders' },
    ],
  },
  {
    label: 'Costing',
    children: [
      { route: '/process-costing', label: 'Process Costing' },
      { route: '/material-costing', label: 'Material Costing' },
    ],
  },
  {
    label: 'Design',
    children: [
      { route: '/assigned-jo', label: 'Assigned JO' },
    ],
  },
  {
    label: 'Purchasing',
    children: [
      { route: '/purchase-requisitions', label: 'Purchase Requisitions' },
      { route: '/place-order-form', label: 'Place Order Form' },
      { route: '/purchase-orders', label: 'Purchase Orders' },
    ],
  },
  {
    label: 'Production',
    children: [
      { route: '/production', label: 'Production' },
      { route: '/scheduled-jo', label: 'Scheduled JO' },
      { route: '/assembly-builds', label: 'Assembly Build' },
      // Quality Inspection / Item Delivery don't have their own `pages` row -- their
      // backend routes intentionally reuse Production's / Sales Orders' permission
      // scope (see qualityInspections.js / itemDeliveries.js), so the nav visibility
      // check below needs to look at permRoute instead of the link's own route.
      { route: '/quality-inspections', permRoute: '/production', label: 'Quality Inspection' },
      { route: '/item-deliveries', permRoute: '/sales-orders', label: 'Item Delivery' },
    ],
  },
  {
    label: 'Accounting',
    children: [
      { route: '/chart-of-account-types', label: 'Chart of Account Types' },
      { route: '/chart-of-accounts', label: 'Chart of Accounts' },
      { route: '/sales-invoices', label: 'Invoices' },
      { route: '/vendor-bills', label: 'Vendor Bills' },
      { route: '/bill-payments', label: 'Bill Payments' },
      { route: '/bill-credits', label: 'Bill Credits' },
    ],
  },
];

export default function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const visibleStructure = NAV_STRUCTURE
    .map((item) => (item.children
      ? { ...item, children: item.children.filter((c) => can(c.permRoute || c.route, 'can_view')) }
      : item))
    .filter((item) => (item.children ? item.children.length > 0 : can(item.route, 'can_view')));

  return (
    <div className="app-shell">
      <header className="topnav">
        <div className="topnav-brand">Cebu Graphicstar Imaging Corp.</div>
        <nav className="topnav-menu">
          {visibleStructure.map((item) => (item.children ? (
            <div key={item.label} className="topnav-dropdown">
              <button
                type="button"
                className={item.children.some((c) => location.pathname.startsWith(c.route)) ? 'active' : ''}
              >
                {item.label} <span className="caret">▾</span>
              </button>
              <div className="topnav-dropdown-menu">
                {item.children.map((c) => (
                  <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {c.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ) : (
            <NavLink key={item.route} to={item.route} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          )))}
        </nav>
        <div className="topnav-user">
          <span className="muted">{user?.display_name}</span>
          <button className="btn btn-sm" onClick={handleLogout}>Log out</button>
        </div>
      </header>
      <div className="main">
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
