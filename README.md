# GSUITE ERP

A web-based ERP built on the GraphicStar ERP schema. It covers core master data and
authentication (RBAC-secured login, employees, users & page permissions, customers,
suppliers, inventory items, shared lookup tables) plus a Sales/Estimates module for
building estimates with job order and process line items.

> **Note on the schema:** the original source file (`graphicstar_erp_schema (1).sql`)
> was truncated mid-statement inside `transaction_setting_lines`, and Sections 7
> (Costing) and 8 (Sales) referenced in its header were not present in the file at all.
> Sections 1–6 are reproduced as-is in [`server/db/schema.sql`](server/db/schema.sql).
> A separate "creating an estimate" schema drop was later reconciled into the same file
> as Section 8 (Sales/Estimates) — see the reconciliation notes at the top of that
> section in `schema.sql` for how its `customers`/`employees`/`sales_divisions`/
> `locations`/`job_types`/`processes` tables were merged into the existing ones instead
> of duplicated, and how `contact_persons`, `tax_codes`, and `estimate_audit_logs` map
> onto `customer_contacts`, `taxes`, and the existing generic `audit_logs` table.
> Section 7 (Costing) was never supplied either — it's now reverse-engineered from the
> live site's own JSON API instead (see "Costing module" below). `transaction_settings`
> (Section 6) is created in the database for completeness but has no API/UI yet.

## Stack

- **Backend:** Node.js + Express + MySQL (`mysql2`), JWT auth
- **Frontend:** React (Vite) + React Router + Axios
- **Database:** MySQL 8 (or compatible)

## Project layout

```
server/         Express API
  db/schema.sql   Database schema (Sections 1-6)
  src/
    db.js           MySQL connection pool
    db/migrate.js   Applies schema.sql to the configured database
    db/seed.js      Seeds an admin user + sample lookup data
    middleware/     JWT auth + page-permission (RBAC) middleware
    routes/         auth, lookups (generic), employees, users, customers, suppliers,
                    inventory, estimates, blanketPos, processCosting
    db/import-live-data.js   One-off script: pulls real Processes/Inventories + their
                              costing data from the live site (see "Costing module")
client/         React app (Vite)
  src/
    api/client.js        Axios instance with auth header + 401 handling
    context/             AuthContext (provider) + useAuth hook, `can(route, action)` helper
    components/          Layout (sidebar/topbar), DataTable, Modal, ProtectedRoute, EntityPicker
    utils/costing.js     Cost-plus pricing formulas shared by ProcessCosting + EstimateWizard
    pages/                Dashboard, Employees, Users, Customers, Suppliers, Inventory,
                          Estimates, EstimateWizard, ProcessCosting, Lookups
```

## Setup

### 1. Database

Create a `.env` in `server/` (copy `.env.example`) with your MySQL credentials, then:

```bash
cd server
npm install
npm run db:migrate   # creates the database + applies schema.sql
npm run db:seed      # seeds pages, sample lookups, and an admin user
```

Seeding prints the admin login, by default:

- **username:** `admin`
- **password:** `Admin123!`

### 2. Backend

```bash
cd server
npm run dev           # http://localhost:4000
```

### 3. Frontend

```bash
cd client
npm install
npm run dev            # http://localhost:5173 (proxies /api to :4000)
```

Open http://localhost:5173 and log in with the seeded admin account.

## How RBAC works

- `pages` holds the navigable sections of the app (Dashboard, Employees, Users, ...).
- `user_page_permissions` grants each user `can_view` / `can_add` / `can_edit` /
  `can_delete` / `can_approve` per page.
- The API's `requirePermission(route, action)` middleware checks this table on every
  protected request; the sidebar and action buttons in the UI hide themselves when the
  logged-in user lacks the corresponding permission.
- New users have no permissions until an admin grants them via **Users & Permissions →
  Permissions** in the UI.

## Estimates module

The create/edit flow (`client/src/pages/EstimateWizard.jsx`, routed at
`/estimates/new` and `/estimates/:id/edit`) is modeled on the real, live GraphicStar
ERP (`gsuite.graphicstar.com.ph`), not just the schema — logged in read-only and
compared layouts before building:

- A **4-step wizard** (Customer and Estimate → Job Orders → Billing → Completed), not a
  modal. The estimate header is created via POST as soon as Step 1's "Next" is clicked;
  Steps 2–4 are disabled until then.
- Entity fields (Customer, Contact, Sales Rep, Sales Division, Office Location, Blanket
  PO, Job Type, Process, Item, Tax Code) use `EntityPicker`
  (`client/src/components/EntityPicker.jsx`) — a searchable modal picker (search box,
  paginated table, click-to-select) instead of a plain `<select>`, matching the real
  site's pattern for anything that could have a long list of options.
- **Job Orders** is a wide, horizontally-scrolling **spreadsheet-style table**
  (one row per job order, all ~26 schema columns editable inline), with each row
  expandable to a nested **Process** sub-table beneath it. Rows are saved
  automatically: a new row is "draft" (local-only) until its required fields
  (Job Type, Quantity, Units for job orders; Process for processes) are filled, then
  it's POSTed; further edits PUT on blur.
- **Billing** (Step 3) has a "Recalculate from Job Orders" button that sums the job
  order lines' subtotal/discount/tax/gross into the header totals — still manually
  editable after.
- **Completed** (Step 4) is a read-only summary plus the **Audit Trail** — which reuses
  the generic `audit_logs` table (Section 1) rather than a separate table; nested job
  order/process edits are recorded there with field names like `job_order[2].quantity`
  or `job_order[2].process[1].process_price` so the whole history is one query.
- The Process line's "Material" field references real `inventories` rows directly (an
  earlier lightweight `items` catalog was dropped in favor of this — see "Costing
  module" below) and **auto-calculates price** from quantity/size — see below.
- `job_types` and `processes` (Section 5) got basic CRUD screens under **Lookups** since
  estimates can't be built without at least one of each — the rest of the Jobs module
  (process materials/ink costing, job-type-process mappings, PMS stages) still has no
  UI.

**Known deviations from the real site**, called out rather than silently matched:
incremental save-per-action instead of defer-until-final-submit (an abandoned wizard
leaves a partial but valid estimate behind); no "Add New" button inside picker modals;
no row duplicate/reorder icons on the spreadsheet table; no visual reskin of the rest of
the app (the real site's top mega-menu, icon rail, and blue theme aren't matched — this
pass only matches the Estimates flow and interaction patterns). The plan for this
rebuild, including what was observed on the live site, is in
`C:\Users\gfxsy\.claude\plans\parallel-singing-lerdorf.md`.

## Costing module (auto-calculate pricing)

Section 7 (Costing) was never supplied in any schema drop, so it's reverse-engineered
from the live site's own JSON API (`/api/get_costing`, `/api/get_inventories`) rather
than guessed from screenshots — see `server/db/schema.sql`'s "SECTION 9: COSTING"
comment for the exact formulas, verified against real numbers before being encoded.

- **`process_cost_brackets`**: a process's cost is banded by quantity (e.g. "1-269
  pieces", "280-538 pieces", ...). Each bracket holds raw cost inputs (Click Charge,
  Ink Cost, Direct Labor, 5 MOH components, Other Charges) and percentages (Costing
  Allowance, Mark-Up COGS, OPEX Admin, OPEX Selling) — managed on the new
  **Process Costing** page (`/process-costing`), which shows the computed
  SubTotal/COGS/Price live per row via `client/src/utils/costing.js`.
- **`inventories`** gained costing columns (Average Cost, Wastage Allowance %, Markup
  %, Selling Price, discount-ceiling %s for Account Officer/Supervisor/Manager/GM, plus
  `is_length_based`/`is_width_based` flags for area-priced materials) — managed in the
  Inventory item's edit form under a new "Costing" section.
- **In the Estimate wizard**, picking a Process and a Material on a process line, then
  entering Quantity (and Length/Width if the material is area-based), automatically
  computes and saves `process_cost`, `material_cost`, `total_cost`, `material_price`,
  `total_price`, and `gross_amount` — no manual price entry. Process cost is
  bracket-rate × quantity; material cost is unit cost × quantity × area (if
  applicable). The discount-ceiling percentages are stored as data (matching the real
  system) but there's no approval-gated override workflow built around them — that's a
  distinct feature from calculating a price.
- **Data**: `server/src/db/import-live-data.js` is a one-off script (not part of the
  running app) that logs into the live site with Playwright and pulls a representative
  batch — not the full 1,074 processes / 4,275 inventory items — covering CNC,
  blueprint/plotting, and electrical/raw-material categories, together with each one's
  real costing data. Requires `LIVE_SITE_USERNAME`/`LIVE_SITE_PASSWORD` in `server/.env`
  (not committed). Run once via `node src/db/import-live-data.js`; re-running skips
  items already imported.

## What's not built yet

Section 7 (Costing) was never supplied, so it's absent entirely. Section 6
(`transaction_settings`) exists as a table but has no API/UI. Attachments
(customer/supplier/inventory file uploads) are in the schema but not wired up. These
were out of scope for this pass — see `schema.sql` for the full table list if you want
to extend into them next.
