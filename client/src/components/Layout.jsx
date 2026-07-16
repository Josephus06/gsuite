import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import Avatar from './Avatar';

// Mirrors the real GraphicStar system's topbar arrangement: a row of category
// dropdowns (Master Lists, Inventory, Sales, Costing, ...) instead of a left
// sidebar. Each category groups the pages we've actually built under the same
// names the real system uses for them.
const NAV_STRUCTURE = [
  { route: '/dashboard', label: 'Dashboard' },
  {
    label: 'CRM',
    children: [
      { route: '/crm-dashboard', label: 'CRM Dashboard' },
      { route: '/leads', label: 'Leads' },
      { route: '/opportunities', label: 'Opportunities' },
    ],
  },
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
      { route: '/item-fulfillments', permRoute: '/transfer-orders', label: 'Item Fulfillment' },
      { route: '/item-receipts', permRoute: '/transfer-orders', label: 'Item Receipt' },
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
      { route: '/reports/trial-balance', label: 'Trial Balance' },
      { route: '/reports/income-statement', label: 'Income Statement' },
      { route: '/reports/balance-sheet', label: 'Balance Sheet' },
      { route: '/reports/general-ledger', label: 'General Ledger' },
    ],
  },
];

// Flattened route -> label lookup for the browser tab title, reusing the exact same
// labels the nav menu shows -- one source of truth instead of a second hardcoded list.
// Sorted longest-route-first so a detail/edit sub-route (e.g. /chart-of-accounts/123)
// prefix-matches its own section (/chart-of-accounts) rather than a shorter unrelated
// route that happens to also be a prefix.
const FLAT_ROUTES = NAV_STRUCTURE
  .flatMap((item) => (item.children ? item.children : [item]))
  .map((c) => ({ route: c.route, label: c.label }))
  .sort((a, b) => b.route.length - a.route.length);

const TITLE_SUFFIX_WORDS = { new: 'New', edit: 'Edit', print: 'Print' };

// Derives "{Section} | {Mode}" generically for every page in the app, not just one
// section -- every route here follows the same nesting convention (base = the section's
// own page/list, /new = Create, /:id = View, /:id/edit = Edit, /:id/<action> = that
// action), so the mode can be inferred from the URL shape itself instead of every
// individual page component having to set its own document.title. The base route stays
// unsuffixed (works equally well whether that section is a real list, like Purchase
// Orders, or a single-page utility, like Dashboard/Lookups). Numeric segments (record
// IDs) are stripped out before picking the mode word, so e.g. /purchase-orders/29/return
// reads as "Purchase Orders | Return", not "Purchase Orders | 29".
function deriveTitle(pathname) {
  const match = FLAT_ROUTES.find((r) => pathname === r.route || pathname.startsWith(`${r.route}/`));
  if (!match) return null;

  const remainder = pathname.slice(match.route.length).split('/').filter(Boolean);
  if (remainder.length === 0) return match.label;

  const words = remainder.filter((seg) => !/^\d+$/.test(seg));
  if (words.length === 0) return `${match.label} | View`;

  const last = words[words.length - 1];
  const suffix = TITLE_SUFFIX_WORDS[last] || last.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${match.label} | ${suffix}`;
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null);

  // Closing on every route change covers both a leaf-link tap (goes straight to the new
  // page) and the browser back/forward buttons -- either way the mobile panel shouldn't
  // still be covering the screen afterward.
  useEffect(() => {
    setMobileOpen(false);
    setExpandedGroup(null);
  }, [location.pathname]);

  useEffect(() => {
    const title = deriveTitle(location.pathname);
    document.title = title ? `${title} - GSuite` : 'GSuite';
  }, [location.pathname]);

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
        <button
          type="button"
          className="topnav-hamburger"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMobileOpen((o) => !o)}
        >
          {mobileOpen ? '✕' : '☰'}
        </button>
        <div className="topnav-brand">
          <span className="topnav-brand-full">Cebu Graphicstar Imaging Corp.</span>
          <span className="topnav-brand-short">GSuite</span>
        </div>
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
          <Avatar user={user} size={28} />
          <span className="muted topnav-user-name">{user?.display_name}</span>
          <button className="btn btn-sm" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      {mobileOpen && (
        <>
          <div className="topnav-mobile-backdrop" onClick={() => setMobileOpen(false)} />
          {/* Click-to-expand accordion instead of the desktop menu's hover flyouts --
              hover has no equivalent on touch, so each group toggles open in place. */}
          <nav className="topnav-mobile-panel">
            {visibleStructure.map((item) => (item.children ? (
              <div key={item.label} className="topnav-mobile-group">
                <button
                  type="button"
                  className={`topnav-mobile-group-toggle ${item.children.some((c) => location.pathname.startsWith(c.route)) ? 'active' : ''}`}
                  onClick={() => setExpandedGroup((g) => (g === item.label ? null : item.label))}
                >
                  {item.label}
                  <span className={`caret ${expandedGroup === item.label ? 'open' : ''}`}>▾</span>
                </button>
                {expandedGroup === item.label && (
                  <div className="topnav-mobile-group-items">
                    {item.children.map((c) => (
                      <NavLink key={c.route} to={c.route} className={({ isActive }) => (isActive ? 'active' : '')}>
                        {c.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <NavLink key={item.route} to={item.route} className={({ isActive }) => `topnav-mobile-link ${isActive ? 'active' : ''}`}>
                {item.label}
              </NavLink>
            )))}
          </nav>
        </>
      )}

      <div className="main">
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
