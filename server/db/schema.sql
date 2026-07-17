-- =====================================================================
-- GSUITE ERP — DATABASE SCHEMA
-- Sourced from graphicstar_erp_schema (1).sql, Sections 1-6.
-- NOTE: the source file was truncated mid-definition inside
-- `transaction_setting_lines` (Section 6) and Sections 7 (Costing) and
-- 8 (Sales) were not present at all. Both are omitted here rather than
-- guessed at. Everything above that point is reproduced as-is.
-- =====================================================================

-- =====================================================================
-- SECTION 1: SHARED / LOOKUP TABLES
-- =====================================================================

CREATE TABLE chart_of_accounts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    account_code VARCHAR(30) UNIQUE NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    account_type ENUM('Asset','Liability','Equity','Revenue','Expense','Cost of Sales') NOT NULL,
    parent_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE pages (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    parent_page_id BIGINT NULL REFERENCES pages(id),
    name VARCHAR(150) NOT NULL,
    route VARCHAR(150),
    icon VARCHAR(100),
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE locations (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    location_code VARCHAR(20) UNIQUE NOT NULL,
    location_name VARCHAR(150) NOT NULL,
    location_type ENUM('Branch','Warehouse','Design','Damaged','Delivery Charge','Technical','Subcon','Other') DEFAULT 'Other',
    address TEXT,
    telephone VARCHAR(50),
    contact_person VARCHAR(150),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE business_styles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE departments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE units_of_measure (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(20) UNIQUE NOT NULL,
    title VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE unit_conversions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    from_unit_id BIGINT NOT NULL REFERENCES units_of_measure(id),
    to_unit_id BIGINT NOT NULL REFERENCES units_of_measure(id),
    multiplier DECIMAL(14,6) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE inventory_categories (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    parent_category_id BIGINT NULL REFERENCES inventory_categories(id),
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE taxes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    rate DECIMAL(6,2) NOT NULL DEFAULT 0,
    tax_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE withholding_taxes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    rate DECIMAL(6,2) NOT NULL DEFAULT 0,
    atc_code VARCHAR(30),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE payment_terms (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    term_name VARCHAR(150) NOT NULL,
    no_of_days DECIMAL(6,2) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE payment_methods (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    requires_reference BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE warranties (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    warranty_type ENUM('Print','Structure','Electrical') NOT NULL,
    duration_label VARCHAR(30) NOT NULL,
    duration_months INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE reasons (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    reason_type ENUM('Cancellation','Disapproval','Return','Adjustment','Other') NOT NULL,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE gp_rates (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_type_id BIGINT NULL,
    rate DECIMAL(6,2) NOT NULL,
    effective_date DATE NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE sales_divisions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE audit_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    auditable_type VARCHAR(150) NOT NULL,
    auditable_id BIGINT NOT NULL,
    event_type ENUM('Created','Updated','Approved','Disapproved','Cancelled','Deleted','Status Change') NOT NULL,
    field_name VARCHAR(150) NULL,
    old_value TEXT NULL,
    new_value TEXT NULL,
    set_by_user_id BIGINT NOT NULL,
    set_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auditable (auditable_type, auditable_id)
);

-- =====================================================================
-- SECTION 2: EMPLOYEES, USERS, RBAC
-- =====================================================================

CREATE TABLE employees (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_code VARCHAR(30) UNIQUE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    department_id BIGINT NULL REFERENCES departments(id),
    position_title VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(50),
    date_hired DATE NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE user_groups (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    employee_id BIGINT NULL REFERENCES employees(id),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    default_branch_id BIGINT NULL REFERENCES locations(id),
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at DATETIME NULL,
    -- "Account Type" tab fields (mirrors the real system's 4th user-creation step)
    user_group_id BIGINT NULL REFERENCES user_groups(id),
    account_type VARCHAR(50),
    can_approve_sales_estimate BOOLEAN DEFAULT FALSE,
    is_account_officer BOOLEAN DEFAULT FALSE,
    is_supervisor BOOLEAN DEFAULT FALSE,
    is_sales_manager BOOLEAN DEFAULT FALSE,
    is_sales_marketing_director BOOLEAN DEFAULT FALSE,
    is_sales_business_unit BOOLEAN DEFAULT FALSE,
    approval_code VARCHAR(50),
    -- Reporting relationship for Dashboard scoping: a Supervisor's dashboard shows only
    -- the account officers with supervisor_id = them; a Sales Manager's dashboard shows
    -- all sales users regardless of this link (no self-reference needed at that level).
    supervisor_id BIGINT NULL REFERENCES users(id),
    -- Profile picture: a small (client-resized) JPEG stored inline as a data: URL rather
    -- than on disk -- this app has no object storage configured and Railway's filesystem
    -- is ephemeral across redeploys, so the DB (already the durable store for everything
    -- else) is the only place a file would reliably survive there.
    avatar_data MEDIUMTEXT NULL,
    -- Purchasing Supervisor: the first-tier approver for PO1/PO2 Purchase Orders (see
    -- purchaseOrders.js's approve route). Deliberately a separate flag from is_supervisor
    -- (that one is Sales-Supervisor-specific, relied on by dashboard.js's resolveScope and
    -- salesVisibility.js for sales-team scoping) so a Purchasing Supervisor doesn't get
    -- mis-scoped into the Sales Supervisor dashboard/visibility.
    is_purchasing_supervisor BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE user_branches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL REFERENCES users(id),
    location_id BIGINT NOT NULL REFERENCES locations(id),
    department_id BIGINT NULL REFERENCES departments(id),
    can_override_date BOOLEAN DEFAULT FALSE,
    remarks VARCHAR(255),
    is_default BOOLEAN DEFAULT FALSE,
    UNIQUE KEY uq_user_branch (user_id, location_id)
);

CREATE TABLE user_page_permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL REFERENCES users(id),
    page_id BIGINT NOT NULL REFERENCES pages(id),
    can_view BOOLEAN DEFAULT FALSE,
    can_add BOOLEAN DEFAULT FALSE,
    can_edit BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    can_approve BOOLEAN DEFAULT FALSE,
    UNIQUE KEY uq_user_page (user_id, page_id)
);

ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_user FOREIGN KEY (set_by_user_id) REFERENCES users(id);

-- =====================================================================
-- SECTION 3: CUSTOMERS & SUPPLIERS
-- =====================================================================

CREATE TABLE customers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_code VARCHAR(30) UNIQUE,
    name VARCHAR(200) NOT NULL,
    company_name VARCHAR(200) NULL,
    business_style_id BIGINT NULL REFERENCES business_styles(id),
    tin VARCHAR(30) NULL,
    payment_term_id BIGINT NULL REFERENCES payment_terms(id),
    credit_limit DECIMAL(14,2) DEFAULT 0,
    sales_division_id BIGINT NULL REFERENCES sales_divisions(id),
    default_sales_rep_id BIGINT NULL REFERENCES users(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE customer_contacts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    contact_name VARCHAR(150) NOT NULL,
    title VARCHAR(100),
    email VARCHAR(150),
    phone VARCHAR(50),
    description VARCHAR(255),
    is_primary BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE customer_addresses (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    address_type ENUM('Billing','Shipping','Other') DEFAULT 'Shipping',
    address_line TEXT NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE customer_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    uploaded_by_user_id BIGINT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE suppliers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    supplier_code VARCHAR(30) UNIQUE,
    name VARCHAR(200) NOT NULL,
    company_name VARCHAR(200) NULL,
    tin VARCHAR(30) NULL,
    payment_term_id BIGINT NULL REFERENCES payment_terms(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE supplier_contacts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    contact_name VARCHAR(150) NOT NULL,
    title VARCHAR(100),
    email VARCHAR(150),
    phone VARCHAR(50),
    is_primary BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE supplier_addresses (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    address_line TEXT NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE supplier_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    uploaded_by_user_id BIGINT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- SECTION 4: ITEMS & INVENTORY
-- =====================================================================

CREATE TABLE inventories (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_code VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    sales_description VARCHAR(255),
    category_id BIGINT NULL REFERENCES inventory_categories(id),
    base_unit_id BIGINT NOT NULL REFERENCES units_of_measure(id),
    item_type VARCHAR(50) DEFAULT 'Inventory',
    reorder_point DECIMAL(14,4) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE inventory_locations (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    location_id BIGINT NOT NULL REFERENCES locations(id),
    qty_on_hand DECIMAL(14,4) DEFAULT 0,
    qty_committed DECIMAL(14,4) DEFAULT 0,
    UNIQUE KEY uq_inv_loc (inventory_id, location_id)
);

CREATE TABLE inventory_price_tiers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    min_qty DECIMAL(14,4) NOT NULL,
    max_qty DECIMAL(14,4) NULL,
    unit_price DECIMAL(14,4) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE inventory_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fields mirrored from the real system's Inventory View/Edit screens (Purchasing/
-- Inventory, Inventory Detail, Sales/Pricing, Accounting tabs). "Related Records" (a
-- transaction history spanning Item Receipts/Invoices/Transfer Orders/Receiving
-- Reports/Vendor Bills/Purchase Requisitions/Purchase Orders) is deliberately not
-- modeled here -- it needs seven modules this build doesn't have.
ALTER TABLE inventories
    ADD COLUMN purchase_description VARCHAR(500),
    ADD COLUMN purchase_unit_id BIGINT NULL REFERENCES units_of_measure(id),
    ADD COLUMN stock_unit_id BIGINT NULL REFERENCES units_of_measure(id),
    ADD COLUMN sales_unit_id BIGINT NULL REFERENCES units_of_measure(id),
    ADD COLUMN conversion_factor DECIMAL(14,6) DEFAULT 1,
    ADD COLUMN to_type VARCHAR(30),
    ADD COLUMN is_office_supply BOOLEAN DEFAULT FALSE,
    ADD COLUMN is_to_item BOOLEAN DEFAULT TRUE,
    -- Real system's approval workflow for a new/changed item -- supersedes is_active
    -- for list filtering (is_active is kept in sync: TRUE unless status = 'inactive').
    ADD COLUMN status VARCHAR(30) DEFAULT 'approved',
    ADD COLUMN expense_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    ADD COLUMN asset_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    ADD COLUMN income_account_id BIGINT NULL REFERENCES chart_of_accounts(id);

-- The real Accounting tab actually has four account links, not three: Expense, COGS,
-- Asset, Income -- COGS (e.g. "Direct Materials") was missed when the first three were
-- added. Confirmed against the live system that Expense is commonly blank even on
-- Approved items (only ~7% of the real catalog has one set) while Asset/COGS/Income are
-- populated on nearly every approved item -- so accounting-approval readiness should
-- gate on Asset+COGS+Income, not Expense.
ALTER TABLE inventories
    ADD COLUMN cogs_account_id BIGINT NULL REFERENCES chart_of_accounts(id);

-- Service Items (Master Lists > Service Items) are rows in this same table with
-- item_type = 'Service' -- confirmed against the real system, which stores Inventories/
-- Non-Inventories/Service Items in one unified `inventories` table distinguished only by
-- a Module/Type flag. is_with_jo/is_po/is_jo mirror the real list's "W/JO"/"PO"/"JO"
-- columns (whether the item needs a Job Order, goes through a PO, or requires a JO to be
-- selected). Real data showed IsRequisition/IsWTAX/CanBeReceived/IsNeedJOItem always 0
-- across all 100 live Service Items, so those aren't modeled here.
ALTER TABLE inventories
    ADD COLUMN is_with_jo BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN is_po BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN is_jo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE inventory_locations
    ADD COLUMN qty_in_transit DECIMAL(14,4) DEFAULT 0;

CREATE TABLE inventory_supplier_prices (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    price DECIMAL(14,4) NOT NULL,
    last_purchase_date DATE,
    ref_no VARCHAR(100),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- "Unit of Measures" tab -- the set of unit codes usable for THIS item specifically
-- (e.g. a paint item sold in "PC" but also orderable by "GAL"/"LTR"), separate from the
-- global units_of_measure lookup used for the item's own base/purchase/stock/sales unit
-- fields. Populates the Estimate wizard's per-process-line Unit dropdown once an item is
-- selected on that line -- real system's UnitOfMeasures_Invty field, stored there as a
-- pipe-delimited string, modeled here as a proper child table instead.
CREATE TABLE inventory_unit_of_measures (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    code VARCHAR(50) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Sub-Items" tab (BOM/kit composition): rows here are the parent's kit components.
-- An item's own "Sub-Item Of" display is just the reverse lookup (any row where this
-- item is the child).
CREATE TABLE inventory_sub_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    parent_inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    child_inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    qty DECIMAL(14,4) DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE non_inventories (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_code VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    unit_price DECIMAL(14,4) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE service_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_code VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    unit_price DECIMAL(14,4) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE discount_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    discount_type ENUM('Percent','Fixed') DEFAULT 'Percent',
    value DECIMAL(14,4) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE landed_costs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    allocation_method ENUM('By Value','By Quantity','By Weight') DEFAULT 'By Value',
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- =====================================================================
-- SECTION 5: JOBS / PROCESSES
-- =====================================================================

CREATE TABLE processes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    process_code VARCHAR(100) UNIQUE NOT NULL,
    process_name VARCHAR(255) NOT NULL,
    base_unit_id BIGINT NOT NULL REFERENCES units_of_measure(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE process_materials (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    process_id BIGINT NOT NULL REFERENCES processes(id),
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    is_default BOOLEAN DEFAULT FALSE,
    consumption_rate DECIMAL(14,4) DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE process_ink_costing (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    process_id BIGINT NOT NULL REFERENCES processes(id),
    ink_inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    coverage_rate DECIMAL(14,4) DEFAULT 0,
    cost_per_unit DECIMAL(14,4) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- Mirrors the real system's "Setup Job" screen (#/jobs). unit_type/stock_unit/
-- purchase_unit/sales_unit/base_unit are plain strings, not FKs to units_of_measure --
-- confirmed against the live API (UnitType_Job/StockUnit_Job/etc. are free text like
-- "Each"/"EACH"/"SHT", not unit codes), matching how the real Setup Job form renders
-- them as plain text inputs rather than pickers.
CREATE TABLE job_types (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_code VARCHAR(150) NULL,
    display_name VARCHAR(255) UNIQUE NOT NULL,
    sales_description VARCHAR(500) NULL,
    purchase_description VARCHAR(500) NULL,
    jo_type VARCHAR(30) DEFAULT 'JO',
    parent_job_type_id BIGINT NULL REFERENCES job_types(id),
    department_id BIGINT NULL REFERENCES departments(id),
    unit_type VARCHAR(50) NULL,
    stock_unit VARCHAR(50) NULL,
    purchase_unit VARCHAR(50) NULL,
    sales_unit VARCHAR(50) NULL,
    base_unit VARCHAR(50) NULL,
    is_area BOOLEAN DEFAULT FALSE,
    is_piece BOOLEAN DEFAULT FALSE,
    is_for_sample BOOLEAN DEFAULT FALSE,
    is_direct_to_prod BOOLEAN DEFAULT FALSE,
    is_ecommerce BOOLEAN DEFAULT FALSE,
    income_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    cogs_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    asset_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    gp_rate_head DECIMAL(6,2) DEFAULT 0,
    gp_rate_branch DECIMAL(6,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE job_type_processes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_type_id BIGINT NOT NULL REFERENCES job_types(id),
    process_id BIGINT NOT NULL REFERENCES processes(id),
    sort_order INT DEFAULT 0,
    is_default BOOLEAN DEFAULT TRUE,
    UNIQUE KEY uq_jobtype_process (job_type_id, process_id)
);

-- "Customers" tab on the Setup Job screen: a per-customer GP Rate override for this
-- job type (real field GPRate_JCust), distinct from the job type's own default
-- gp_rate_head/gp_rate_branch.
CREATE TABLE job_type_customers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_type_id BIGINT NOT NULL REFERENCES job_types(id),
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    gp_rate DECIMAL(6,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_jobtype_customer (job_type_id, customer_id)
);

CREATE TABLE job_type_materials (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_type_id BIGINT NOT NULL REFERENCES job_types(id),
    inventory_id BIGINT NOT NULL REFERENCES inventories(id),
    is_default BOOLEAN DEFAULT FALSE,
    UNIQUE KEY uq_jobtype_material (job_type_id, inventory_id)
);

-- Mirrors the real system's "Master Lists > PMS - Job Types" screen: a granular,
-- time-tracking breakdown of production tasks (e.g. "RFNO" / "DESIGN-Ready file with
-- no changes" / 9.75 minutes), each tagged to one coarser ERP Job Type (the existing
-- job_types table, used by Estimates/Job Orders) and one Department ("Group").
-- Distinct from job_types itself -- that's the ERP-level category; this is the PMS-level
-- task list used for time/production tracking. minutes_consume is in MINUTES (despite
-- the real system's own field being labeled "Hours Consume" -- confirmed the values are
-- minute-scale, not hour-scale).
CREATE TABLE pms_job_types (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(500) NOT NULL,
    minutes_consume DECIMAL(10,2) DEFAULT 0,
    job_type_id BIGINT NULL REFERENCES job_types(id),
    department_id BIGINT NULL REFERENCES departments(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

ALTER TABLE gp_rates ADD CONSTRAINT fk_gprate_jobtype FOREIGN KEY (job_type_id) REFERENCES job_types(id);

-- =====================================================================
-- SECTION 6: ACCOUNTING / TRANSACTION SETTINGS
-- =====================================================================

CREATE TABLE transaction_settings (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_type VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- NOTE: source file was truncated inside `transaction_setting_lines`
-- (only `id` and a dangling `transaction` column start were present).
-- Omitted here; Section 7 (Costing) was never supplied.

-- =====================================================================
-- SECTION 8: SALES / ESTIMATES
-- Sourced from a separate "creating an estimate" schema drop.
-- Reconciliation notes (per user decision):
--  * customers, employees, sales_divisions, locations, job_types, processes
--    are NOT redefined here -- the pasted versions of those tables were
--    reference/context only. All FKs below point at the real tables from
--    Sections 1-5.
--  * contact_persons -> merged into the existing customer_contacts table.
--  * tax_codes -> merged into the existing taxes table (tax_code_id below
--    references taxes(id)).
--  * estimate_audit_logs -> merged into the existing generic audit_logs
--    table (Section 1). Use auditable_type = 'Estimate' with the estimate's
--    id; field_name is prefixed (e.g. 'job_order[3].quantity',
--    'process[7].process_price') to capture edits to nested lines under a
--    single queryable (auditable_type, auditable_id) pair.
--  * items is a new, small catalog (material/labor/service) scoped to
--    estimate/job-costing line items -- kept separate from the
--    inventories/non_inventories/service_items catalogs in Section 4,
--    since a single item_id column here can't polymorphically reference
--    three different tables.
-- =====================================================================

ALTER TABLE job_type_processes
    ADD COLUMN default_qty DECIMAL(14,4) NULL,
    ADD COLUMN default_uom VARCHAR(30) NULL;

-- NOTE: the `items` catalog (material/labor/service) originally here was dropped in
-- Section 9 -- estimate_job_order_processes.item_id now references inventories(id)
-- directly per the user's instruction to use real inventory items for material lines.

CREATE TABLE blanket_pos (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    po_number VARCHAR(100) NOT NULL,
    memo VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE estimates (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    estimate_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    contact_person_id BIGINT NULL REFERENCES customer_contacts(id),
    contact_email VARCHAR(255),
    contact_title VARCHAR(100),
    contact_phone VARCHAR(100),
    blanket_po_id BIGINT NULL REFERENCES blanket_pos(id),
    blanket_po_memo VARCHAR(500),
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    sales_division_id BIGINT NULL REFERENCES sales_divisions(id),
    office_location_id BIGINT NULL REFERENCES locations(id),
    contract_description VARCHAR(500) NOT NULL,
    memo VARCHAR(1000),
    shipping_address VARCHAR(500),
    has_multiple_shipping BOOLEAN DEFAULT FALSE,
    production_lead_time VARCHAR(50) NOT NULL,
    price_validity VARCHAR(30),
    order_confirmation_type VARCHAR(30),
    print_warranty BOOLEAN DEFAULT FALSE,
    print_warranty_term VARCHAR(30),
    structure_warranty BOOLEAN DEFAULT FALSE,
    structure_warranty_term VARCHAR(30),
    electrical_warranty BOOLEAN DEFAULT FALSE,
    electrical_warranty_term VARCHAR(30),
    prepared_by_id BIGINT NULL REFERENCES employees(id),
    approved_by_id BIGINT NULL REFERENCES employees(id),
    credit_term VARCHAR(50),
    credit_limit DECIMAL(14,2),
    credit_balance DECIMAL(14,2),
    bill_to_contact_number VARCHAR(100),
    status ENUM('pending_supervisor_approval','pending_customer_approval','approved','cancelled','disapproved')
        NOT NULL DEFAULT 'pending_supervisor_approval',
    subtotal DECIMAL(14,2),
    discount_total DECIMAL(14,2),
    net_of_tax DECIMAL(14,2),
    tax_total DECIMAL(14,2),
    total_amount DECIMAL(14,2),
    est_gp_rate DECIMAL(6,2),
    est_gp_amount DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE estimate_shipping_addresses (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    estimate_id BIGINT NOT NULL REFERENCES estimates(id),
    address VARCHAR(500) NOT NULL
);

CREATE TABLE estimate_job_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    estimate_id BIGINT NOT NULL REFERENCES estimates(id),
    line_no INT NOT NULL,
    nstdjo_no VARCHAR(50),
    job_type_id BIGINT NOT NULL REFERENCES job_types(id),
    job_location_id BIGINT NULL REFERENCES locations(id),
    description VARCHAR(500),
    quantity DECIMAL(14,4) NOT NULL,
    units VARCHAR(30) NOT NULL,
    price_per_unit DECIMAL(14,4),
    subtotal DECIMAL(14,2),
    disc_percent DECIMAL(6,2) DEFAULT 0,
    disc_per_unit DECIMAL(14,4) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    disc_price_per_unit DECIMAL(14,4),
    net_of_tax DECIMAL(14,2),
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    uom VARCHAR(30),
    shipping DECIMAL(14,2),
    remarks VARCHAR(500),
    memo VARCHAR(500),
    delivery_date DATE,
    delivery_time TIME,
    gp_rate DECIMAL(6,2),
    gp_amount DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE estimate_job_order_processes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    estimate_job_order_id BIGINT NOT NULL REFERENCES estimate_job_orders(id),
    line_no INT NOT NULL,
    process_id BIGINT NOT NULL REFERENCES processes(id),
    process_qty DECIMAL(14,4),
    process_uom VARCHAR(30),
    category VARCHAR(100),
    parts VARCHAR(100),
    item_id BIGINT NULL REFERENCES inventories(id),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    uom VARCHAR(30),
    qty DECIMAL(14,4),
    total DECIMAL(14,4),
    unit VARCHAR(30),
    process_price DECIMAL(14,2),
    process_disc_percent DECIMAL(6,2) DEFAULT 0,
    process_disc_amount DECIMAL(14,2) DEFAULT 0,
    disc_process_price DECIMAL(14,2),
    material_price DECIMAL(14,2),
    material_disc_percent DECIMAL(6,2) DEFAULT 0,
    material_disc_amount DECIMAL(14,2) DEFAULT 0,
    disc_material_price DECIMAL(14,2),
    net_of_tax DECIMAL(14,2),
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2),
    shipping DECIMAL(14,2),
    remarks VARCHAR(500),
    memo VARCHAR(500),
    delivery_date DATE,
    delivery_time TIME,
    gp_rate DECIMAL(6,2),
    process_cost DECIMAL(14,2),
    material_cost DECIMAL(14,2),
    total_cost DECIMAL(14,2),
    total_price DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- =====================================================================
-- SECTION 9: COSTING
-- Reverse-engineered from the live GraphicStar system's `/api/get_costing` and
-- `/api/get_inventories` responses (not from a supplied schema -- Section 7 in the
-- original source file was never provided). See the formulas documented in the
-- implementation plan for how these fields combine into a selling price; the derived
-- figures (SubTotal, COGS, etc.) are intentionally NOT stored here -- only the raw
-- cost inputs and percentages, computed on demand in `client/src/utils/costing.js`.
-- =====================================================================

CREATE TABLE process_cost_brackets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    process_id BIGINT NOT NULL REFERENCES processes(id),
    qty_min DECIMAL(14,4) NOT NULL,
    qty_max DECIMAL(14,4) NOT NULL,
    click_charge DECIMAL(14,4) DEFAULT 0,
    ink_cost DECIMAL(14,4) DEFAULT 0,
    direct_labor DECIMAL(14,4) DEFAULT 0,
    moh_power_equipment DECIMAL(14,4) DEFAULT 0,
    moh_depreciation DECIMAL(14,4) DEFAULT 0,
    moh_repairs_maintenance DECIMAL(14,4) DEFAULT 0,
    moh_indirect_materials DECIMAL(14,4) DEFAULT 0,
    moh_indirect_labor DECIMAL(14,4) DEFAULT 0,
    other_charges DECIMAL(14,4) DEFAULT 0,
    -- Subcontracted-out cost for this bracket -- a real production cost (unlike the
    -- markup/OPEX percentages below), included in process_cost/GP-rate reporting via
    -- costBasis = SubTotal MOH + Sub Con in client/src/utils/costing.js.
    sub_con DECIMAL(14,4) DEFAULT 0,
    costing_allowance_pct DECIMAL(6,2) DEFAULT 0,
    markup_cogs_pct DECIMAL(6,2) DEFAULT 0,
    opex_admin_pct DECIMAL(6,2) DEFAULT 0,
    opex_selling_pct DECIMAL(6,2) DEFAULT 0,
    disc_ceiling_pct DECIMAL(6,2) DEFAULT 0,
    disc_supervisor_pct DECIMAL(6,2) DEFAULT 0,
    disc_manager_pct DECIMAL(6,2) DEFAULT 0,
    disc_gm_pct DECIMAL(6,2) DEFAULT 0,
    selling_price_override DECIMAL(14,4) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

ALTER TABLE inventories
    ADD COLUMN is_length_based BOOLEAN DEFAULT FALSE,
    ADD COLUMN is_width_based BOOLEAN DEFAULT FALSE,
    ADD COLUMN last_purchase_price DECIMAL(14,4) NULL,
    ADD COLUMN last_purchase_date DATE NULL,
    -- average_cost: weighted-average purchase cost (stock/purchase unit), feeds stock
    -- valuation. material_cost: the (separately maintained) cost basis the Sales/Pricing
    -- costing formula runs on, already normalized to the item's base unit -- these are
    -- two distinct real-world figures, not the same number rounded differently.
    ADD COLUMN average_cost DECIMAL(14,4) NULL,
    ADD COLUMN material_cost DECIMAL(14,4) NULL,
    ADD COLUMN price_indicator DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN tolerance_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN wastage_allowance_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN markup_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN selling_price DECIMAL(14,4) NULL,
    ADD COLUMN beg_selling_price DECIMAL(14,4) NULL,
    ADD COLUMN disc_ceiling_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN disc_supervisor_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN disc_manager_pct DECIMAL(6,2) DEFAULT 0,
    ADD COLUMN disc_gm_pct DECIMAL(6,2) DEFAULT 0;

-- =====================================================================
-- SECTION 10: SALES ORDERS
-- Mirrors the real system: once an Estimate reaches "Approved", a Sales Order is
-- auto-generated from it (header + one row per job order, copied at that moment --
-- not a live reference, since the estimate can still be replicated/edited afterward
-- independently of the order already placed). No nested process breakdown here,
-- matching the real system's flatter "Items" tab on a Sales Order.
-- =====================================================================

CREATE TABLE sales_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    sales_order_no VARCHAR(30) UNIQUE NOT NULL,
    estimate_id BIGINT NOT NULL REFERENCES estimates(id),
    ref_no VARCHAR(100),
    date_created DATE NOT NULL,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    contact_person_id BIGINT NULL REFERENCES customer_contacts(id),
    contact_email VARCHAR(255),
    contact_title VARCHAR(100),
    contact_phone VARCHAR(100),
    blanket_po_id BIGINT NULL REFERENCES blanket_pos(id),
    blanket_po_memo VARCHAR(500),
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    sales_division_id BIGINT NULL REFERENCES sales_divisions(id),
    office_location_id BIGINT NULL REFERENCES locations(id),
    contract_description VARCHAR(500) NOT NULL,
    memo VARCHAR(1000),
    shipping_address VARCHAR(500),
    production_lead_time VARCHAR(50),
    price_validity VARCHAR(30),
    order_confirmation_type VARCHAR(30),
    prepared_by_id BIGINT NULL REFERENCES employees(id),
    approved_by_id BIGINT NULL REFERENCES employees(id),
    credit_term VARCHAR(100),
    credit_limit DECIMAL(14,2),
    credit_balance DECIMAL(14,2),
    bill_to_contact_number VARCHAR(100),
    status ENUM(
        'pending_for_jo', 'jo_in_process', 'pending_delivery', 'partially_delivered',
        'pending_billing', 'pending_billing_partially_delivered', 'billed', 'cancelled'
    ) DEFAULT 'pending_for_jo',
    subtotal DECIMAL(14,2), discount_total DECIMAL(14,2), net_of_tax DECIMAL(14,2),
    tax_total DECIMAL(14,2), total_amount DECIMAL(14,2),
    est_gp_rate DECIMAL(6,2), est_gp_amount DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE sales_order_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    sales_order_id BIGINT NOT NULL REFERENCES sales_orders(id),
    line_no INT NOT NULL,
    job_type_id BIGINT NULL REFERENCES job_types(id),
    job_location_id BIGINT NULL REFERENCES locations(id),
    description VARCHAR(500),
    quantity DECIMAL(14,4),
    units VARCHAR(30),
    price_per_unit DECIMAL(14,2),
    subtotal DECIMAL(14,2),
    disc_percent DECIMAL(6,2) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    disc_price_per_unit DECIMAL(14,2),
    net_of_tax DECIMAL(14,2),
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    uom VARCHAR(30),
    shipping DECIMAL(14,2),
    remarks VARCHAR(500),
    memo VARCHAR(500),
    delivery_date DATE,
    delivery_time TIME,
    gp_rate DECIMAL(6,2),
    gp_amount DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE estimates
    ADD COLUMN sales_order_id BIGINT NULL REFERENCES sales_orders(id);

-- =====================================================================
-- SECTION 11: JOB ORDERS
-- Mirrors the real system's "Create JO" action on a Sales Order line (Items tab):
-- clicking it turns that line into a Job Order (production record), and the cell
-- switches from a "Create JO" link to the resulting JO# as a link. This is a
-- deliberately minimal stand-in for the real system's much larger Job
-- Order/Production module (job execution, quality inspection, delivery, invoicing) --
-- only the create-and-view slice was asked for, not the full production pipeline.
-- =====================================================================

CREATE TABLE job_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_order_no VARCHAR(50) UNIQUE NOT NULL,
    sales_order_line_id BIGINT NOT NULL REFERENCES sales_order_lines(id),
    sales_order_id BIGINT NOT NULL REFERENCES sales_orders(id),
    job_type_id BIGINT NULL REFERENCES job_types(id),
    job_location_id BIGINT NULL REFERENCES locations(id),
    description VARCHAR(500),
    quantity DECIMAL(14,4),
    quantity_built DECIMAL(14,4) DEFAULT 0,
    quantity_inspected DECIMAL(14,4) DEFAULT 0,
    units VARCHAR(30),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    artist_id BIGINT NULL REFERENCES employees(id),
    memo VARCHAR(500),
    -- The real system's Job Order Edit page shows these as independently editable on
    -- the JO itself (not just inherited display from the Sales Order) -- initialized
    -- from the Sales Order at Create-JO time, editable thereafter without affecting it.
    contact_email VARCHAR(255),
    contact_title VARCHAR(100),
    contact_phone VARCHAR(100),
    shipping_address VARCHAR(500),
    delivery_date DATE,
    delivery_time TIME,
    -- Replaced the old single `date_forecast` field: Forecast is now a derived summary
    -- (total days) computed from these two editable planned dates rather than entered
    -- directly. Deliberately named _date (not _at, DATE not DATETIME) to stay distinct
    -- from planned_start_at/planned_end_at, which are the artist layout timer's
    -- allotted-minutes window for the Assigned JO module -- an unrelated concept.
    planned_start_date DATE,
    planned_end_date DATE,
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    -- Real system splits this into a Status ("Planned - Pending for BOM") and a Sub
    -- Status ("Pending" / "For Design Supervisor" / ...) -- kept as free text since the
    -- full real state machine wasn't observed, only its starting state.
    status VARCHAR(50) DEFAULT 'Planned - Pending for BOM',
    sub_status VARCHAR(50) DEFAULT 'Pending',
    is_on_hold BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- One row per process on the job order, copied from the originating estimate's process
-- lines at Create-JO time (the real system's Processes/Materials tabs). Inventory-
-- allocation columns from the real system (On Hand/Committed/Total Built/Back
-- Order/RWIP/Sub Con) aren't included -- those need a real stock-ledger module we
-- haven't built. Pricing columns are likewise omitted here (pricing was already locked
-- in at the Sales Order stage; the real edit form carries them through but they aren't
-- meaningfully editable at this stage).
CREATE TABLE job_order_processes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_order_id BIGINT NOT NULL REFERENCES job_orders(id),
    line_no INT NOT NULL,
    process_id BIGINT NULL REFERENCES processes(id),
    process_qty DECIMAL(14,4),
    process_uom VARCHAR(30),
    category VARCHAR(50),
    parts VARCHAR(100),
    item_id BIGINT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    artist_remarks VARCHAR(500),
    length DECIMAL(10,2),
    width DECIMAL(10,2),
    uom VARCHAR(30),
    qty DECIMAL(14,4),
    total DECIMAL(14,4),
    unit VARCHAR(30),
    remarks VARCHAR(500),
    memo VARCHAR(500),
    process_cost DECIMAL(14,2),
    material_cost DECIMAL(14,2),
    total_cost DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE sales_order_lines
    ADD COLUMN job_order_id BIGINT NULL REFERENCES job_orders(id),
    ADD COLUMN estimate_job_order_id BIGINT NULL REFERENCES estimate_job_orders(id);

-- Splits the single `status` approval flag into two independent approvals: a new item
-- starts pending both, so it shows up in BOTH the "For Approval Costing" and "For
-- Approval Accounting" list tabs at once. Costing can only be approved once Sales/
-- Pricing is filled in (selling_price set); Accounting can only be approved once all
-- three COA links are set. Once both are approved the item is "Approved". `status` is
-- no longer written to -- these two flags (plus is_active) are the source of truth.
ALTER TABLE inventories
    ADD COLUMN is_costing_approved BOOLEAN DEFAULT FALSE,
    ADD COLUMN is_accounting_approved BOOLEAN DEFAULT FALSE,
    ADD COLUMN costing_approved_at DATETIME NULL,
    ADD COLUMN costing_approved_by BIGINT NULL REFERENCES users(id),
    ADD COLUMN accounting_approved_at DATETIME NULL,
    ADD COLUMN accounting_approved_by BIGINT NULL REFERENCES users(id);

-- Real system's "Account Type" role flag gating the JO design-assignment action (mirrors
-- can_approve_sales_estimate's pattern above): only users with this flag can assign a
-- Layout - Job Type (PMS Job Type) + Artist to a JO that's Planned - Pending for BOM
-- For Design Supervisor. Doing so moves it to For Artist.
ALTER TABLE users
    ADD COLUMN is_design_supervisor BOOLEAN DEFAULT FALSE;

ALTER TABLE job_orders
    ADD COLUMN layout_job_type_id BIGINT NULL REFERENCES pms_job_types(id);

-- Powers the artist's "Assigned JO" module: layout_started_at/layout_ended_at are the
-- overall Actual Start/Actual End (first Play .. final Stop) for the whole task, shown
-- as-is in the Assigned JO module. Cleared back to NULL whenever a JO bounces back to
-- "For Artist (Revision)" so the clock restarts for the revision round.
ALTER TABLE job_orders
    ADD COLUMN layout_started_at DATETIME NULL;

-- Planned Start is set by the design supervisor at assignment time; Planned End is
-- computed server-side as Planned Start + (the selected PMS Job Type's minutes_consume
-- x layout_qty) -- minutes_consume alone is a per-unit allotment (e.g. minutes per
-- design/file), so a multi-piece layout task needs its own qty to scale the allotted
-- time and, downstream, the Assigned JO timer's countdown and Performance % basis.
ALTER TABLE job_orders
    ADD COLUMN planned_start_at DATETIME NULL,
    ADD COLUMN planned_end_at DATETIME NULL,
    ADD COLUMN layout_ended_at DATETIME NULL,
    ADD COLUMN layout_qty DECIMAL(14,4) NULL DEFAULT 1;

-- Supports Play/Hold/Stop as a real pause-aware timer instead of a single start/end
-- pair: each Play (or Resume-from-Hold) opens a new row (ended_at NULL); Hold closes it
-- (ended_at = NOW()); Stop closes any open row and marks job_orders.layout_ended_at.
-- Actual Time Consumed = SUM of every row's duration (excluding held gaps). Every
-- start/hold/stop is also written to audit_logs for a visible history on the JO's
-- System Info tab.
CREATE TABLE job_order_layout_sessions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_order_id BIGINT NOT NULL REFERENCES job_orders(id),
    started_at DATETIME NOT NULL,
    ended_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mirrors the real system's "Production > Production" screen ("Saved Job Order
-- Stages"): once a JO is Released (Sales-approved), it's forwarded into a separate
-- production-floor tracking pipeline with its own stage tabs (Pending for Sched., For
-- Revision, In-Process w/ Rev., In-Process, For QI, Part. Completed, Completed,
-- Invoiced) -- distinct from the Sales-side Status/Sub Status. "Hold" is not its own
-- stage value here; it reuses the existing is_on_hold flag as a cross-cutting filter,
-- same as the rest of this build's JO module. production_stage is only set once the JO
-- reaches Released; NULL beforehand means "not yet forwarded to production".
ALTER TABLE job_orders
    ADD COLUMN production_stage VARCHAR(50) NULL,
    ADD COLUMN date_forwarded DATETIME NULL;

-- The real "Production" detail view's Processes tab shows a wider column set than the
-- Sales-side Job Order view: Sales Remarks (the existing `remarks` column) alongside a
-- distinct Production Remarks, plus per-line cumulative Total Built/Total Completed
-- (Back Order and the Built/Completed input columns are derived from these: Back Order
-- = process_qty - total_built). On Hand/Committed are NOT stored here -- they're read
-- live from inventory_locations for the line's item+location, same as everywhere else
-- inventory quantities are shown. RWIP Qty/Total are always 0 (RWIP isn't modeled, same
-- decision as the RWIP JO tab itself), so no columns were added for those.
ALTER TABLE job_order_processes
    ADD COLUMN production_remarks VARCHAR(500),
    ADD COLUMN total_completed DECIMAL(14,4) DEFAULT 0,
    ADD COLUMN total_built DECIMAL(14,4) DEFAULT 0;

-- Mirrors the real system's "Inventory > Inventory Adjustments" module -- this is how
-- item on-hand qty is manually corrected per location (e.g. after a physical count).
-- Each line snapshots the item's Qty on Hand / Current Value at the moment it's added
-- to the adjustment; Adjust Qty By is the correction (+/-) and New Qty is simply
-- qty_on_hand + adjust_qty_by. Nothing actually changes in inventory_locations until
-- the adjustment is Approved -- approving copies each line's new_qty into
-- inventory_locations.qty_on_hand. GL Impact (the real system's own accounting-entry
-- tab) is derived on the fly from estimated_total_value rather than persisted as real
-- journal entries -- there's no Journal/GL module in this build to post to.
CREATE TABLE inventory_adjustments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    adjustment_no VARCHAR(50) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    adjustment_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    memo VARCHAR(500),
    estimated_total_value DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'pending_approval',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    approved_by_user_id BIGINT NULL REFERENCES users(id),
    approved_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE inventory_adjustment_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    inventory_adjustment_id BIGINT NOT NULL REFERENCES inventory_adjustments(id),
    line_no INT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    department_id BIGINT NULL REFERENCES departments(id),
    qty_on_hand DECIMAL(14,4) DEFAULT 0,
    unit VARCHAR(30),
    current_value DECIMAL(14,4) DEFAULT 0,
    adjust_qty_by DECIMAL(14,4) DEFAULT 0,
    new_qty DECIMAL(14,4) DEFAULT 0,
    est_unit_cost DECIMAL(14,4) DEFAULT 0,
    memo VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mirrors the real "Transfer Order" screen (Production module's "Create TO" button):
-- withdraws stock from one warehouse (almost always Warehouse - Central, the main
-- stock point) into the warehouse a Job Order's own materials are shortfall at, so
-- production there actually has enough on hand. Raised directly off a Job Order's
-- Processes tab -- each line snapshots which job_order_process triggered it.
CREATE TABLE transfer_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    to_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    date_needed DATE NULL,
    withdraw_from_location_id BIGINT NOT NULL REFERENCES locations(id),
    transfer_to_location_id BIGINT NOT NULL REFERENCES locations(id),
    requestor_id BIGINT NULL REFERENCES employees(id),
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    memo VARCHAR(500),
    -- Computed after every Item Fulfillment/Item Receipt from the sum of each line's
    -- qty/adjusted_qty vs fulfilled vs received (see computeTOStatus in
    -- routes/transferOrders.js) -- one of: pending_fulfillment, partially_fulfilled,
    -- pending_receipt, pending_receipt_partially_fulfilled, received, cancelled.
    -- 'cancelled' is the only value set manually rather than derived.
    status VARCHAR(40) DEFAULT 'pending_fulfillment',
    fulfilled_by_user_id BIGINT NULL REFERENCES users(id),
    fulfilled_at DATETIME NULL,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE transfer_order_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transfer_order_id BIGINT NOT NULL REFERENCES transfer_orders(id),
    line_no INT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    job_order_process_id BIGINT NULL REFERENCES job_order_processes(id),
    to_count INT DEFAULT 1,
    qty DECIMAL(14,4) NOT NULL,
    uom VARCHAR(30),
    unit VARCHAR(30),
    adjusted_qty DECIMAL(14,4) NULL,
    new_qty DECIMAL(14,4) DEFAULT 0,
    committed DECIMAL(14,4) DEFAULT 0,
    fulfilled DECIMAL(14,4) DEFAULT 0,
    received DECIMAL(14,4) DEFAULT 0,
    back_ordered DECIMAL(14,4) DEFAULT 0,
    qty_on_hand DECIMAL(14,4) DEFAULT 0,
    memo VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Item Fulfillment is a distinct transaction raised against a Transfer Order -- saving
-- it is what actually deducts stock, but only from the Withdraw From location. Landing
-- it at the Transfer To location is a separate later step (Item Receipt) that this
-- build doesn't model, so there's no corresponding qty_on_hand increase anywhere here.
CREATE TABLE item_fulfillments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    fulfillment_no VARCHAR(30) UNIQUE NOT NULL,
    transfer_order_id BIGINT NOT NULL REFERENCES transfer_orders(id),
    date_created DATE NOT NULL,
    memo VARCHAR(500),
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE item_fulfillment_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_fulfillment_id BIGINT NOT NULL REFERENCES item_fulfillments(id),
    transfer_order_line_id BIGINT NOT NULL REFERENCES transfer_order_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    qty_fulfilled DECIMAL(14,4) NOT NULL,
    -- Running total received *against this specific fulfillment batch* -- distinct from
    -- transfer_order_lines.received, which is the line's aggregate across every
    -- fulfillment/receipt pair raised against it. Once received >= qty_fulfilled on
    -- every line, the fulfillment itself is CLOSED (computed, not stored -- see
    -- computeIFStatus in routes/transferOrders.js).
    received DECIMAL(14,4) DEFAULT 0,
    memo VARCHAR(255)
);

-- Item Receipt is the other half of the two-step stock move Item Fulfillment starts --
-- saving one is what actually lands stock at the Transfer To location. Always raised
-- against one specific Item Fulfillment (never the Transfer Order directly), since
-- fulfillment happens in batches and each batch is received independently.
CREATE TABLE item_receipts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    receipt_no VARCHAR(30) UNIQUE NOT NULL,
    transfer_order_id BIGINT NOT NULL REFERENCES transfer_orders(id),
    item_fulfillment_id BIGINT NOT NULL REFERENCES item_fulfillments(id),
    date_created DATE NOT NULL,
    memo VARCHAR(500),
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE item_receipt_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_receipt_id BIGINT NOT NULL REFERENCES item_receipts(id),
    transfer_order_line_id BIGINT NOT NULL REFERENCES transfer_order_lines(id),
    item_fulfillment_line_id BIGINT NOT NULL REFERENCES item_fulfillment_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    qty_received DECIMAL(14,4) NOT NULL,
    memo VARCHAR(255)
);

-- Mirrors the real system's "Accounting > Chart of Account Types" master list -- the
-- real (Account Type, Account Sub-Type) pairing with its Normal Balance, editable as
-- its own list rather than a fixed enum. Fully migrated from the live site: 23 rows
-- across the 5 coarse types (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE).
CREATE TABLE chart_of_account_types (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    account_type VARCHAR(30) NOT NULL,
    account_sub_type VARCHAR(100) NOT NULL,
    normal_balance VARCHAR(10) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    UNIQUE KEY uq_coa_type (account_type, account_sub_type)
);

-- Extends the original chart_of_accounts (Section 2) with the real system's full field
-- set: coa_type_id links to the real (Account Type, Account Sub-Type) pairing above;
-- detail_type is the real system's own QuickBooks-style per-account "Type" (Bank, Fixed
-- Asset, Accounts Payable, ...) which is a separate, finer axis from coa_type_id; the
-- original `account_type` ENUM column is kept (and kept populated) purely for backward
-- compatibility with existing EntityPicker display columns elsewhere in this build.
ALTER TABLE chart_of_accounts
    ADD COLUMN coa_type_id BIGINT NULL REFERENCES chart_of_account_types(id),
    ADD COLUMN description VARCHAR(500),
    ADD COLUMN detail_type VARCHAR(50),
    ADD COLUMN is_summary BOOLEAN DEFAULT FALSE;

-- The real system's Inventory Adjustment Edit form (not visible on the read-only detail
-- view) has a per-line "Unit Used" toggle (Stock Unit / Base Unit) alongside "Est. Unit
-- Cost (Base)" -- a unit-conversion display, not a distinct stored cost, since this
-- build's inventories don't carry separately-tracked stock-vs-base costs. unit_used only
-- changes which of the item's stock_unit_id/base_unit_id titles are shown as UOM/Unit;
-- it doesn't convert Qty on Hand/Adjust Qty By figures.
ALTER TABLE inventory_adjustment_lines
    ADD COLUMN unit_used VARCHAR(10) DEFAULT 'stock';

-- "Scheduled JO": the production-floor counterpart to the artist's "Assigned JO"
-- module, but scoped per process line (not per whole JO) since a single Job Order's
-- processes can be split across different production staff. A production supervisor
-- assigns an employee to a process row (from ProductionJobOrderView.jsx's Processes
-- tab); that employee then sees it in their own "Scheduled JO" worklist and drives its
-- own Play/Hold/Stop clock, mirroring job_order_layout_sessions' pattern exactly but
-- against job_order_processes instead of job_orders. Unlike the artist timer, there's
-- no fixed allotted-minutes figure to count down from (no per-process duration field
-- exists anywhere in this schema), so this is a plain count-up elapsed timer.
ALTER TABLE job_order_processes
    ADD COLUMN assigned_employee_id BIGINT NULL REFERENCES employees(id),
    ADD COLUMN assignment_started_at DATETIME NULL,
    ADD COLUMN assignment_ended_at DATETIME NULL;

CREATE TABLE job_order_process_sessions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_order_process_id BIGINT NOT NULL REFERENCES job_order_processes(id),
    started_at DATETIME NOT NULL,
    ended_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Gives Scheduled JO its allotted-minutes countdown after all: minutes_per_unit lives on
-- the Process master (Master Lists > Processes), one rate per process type, reused
-- across every JO that uses it -- matching how process_cost/material_cost rates already
-- work. A job-order-process line's allotted minutes = its `total` (the material total
-- computed in Section 9's costing, e.g. 300 sqft) x the process's minutes_per_unit.
ALTER TABLE processes
    ADD COLUMN minutes_per_unit DECIMAL(10, 4) NULL;

-- Mirrors the real system's "Production > Assembly Build" module: saving an Assembly
-- Build (ProductionJobOrderView.jsx's modal) doesn't just mutate the JO in place, it
-- creates its own persisted transaction record (AB-{id}), linked back to the source JO
-- (shown in the JO's Related Records tab) with its own line-item snapshot of what was
-- built. Cancelling an Assembly Build reverses its effect: adds the deducted material
-- back to on-hand and subtracts what it contributed from total_built/quantity_built.
CREATE TABLE assembly_builds (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ab_no VARCHAR(50) UNIQUE NOT NULL,
    job_order_id BIGINT NOT NULL REFERENCES job_orders(id),
    date_created DATE NOT NULL,
    quantity_built DECIMAL(14,4) NOT NULL,
    total_amount DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'saved',
    memo VARCHAR(500),
    created_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE assembly_build_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    assembly_build_id BIGINT NOT NULL REFERENCES assembly_builds(id),
    job_order_process_id BIGINT NOT NULL REFERENCES job_order_processes(id),
    process_id BIGINT NULL REFERENCES processes(id),
    item_id BIGINT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    category VARCHAR(50),
    parts VARCHAR(100),
    process_qty DECIMAL(14,4),
    qty DECIMAL(14,4),
    qty_rwip DECIMAL(14,4) DEFAULT 0,
    total_qty_to_build DECIMAL(14,4),
    total_completed DECIMAL(14,4),
    total_build DECIMAL(14,4),
    unit VARCHAR(30),
    process_cost DECIMAL(14,2),
    material_cost DECIMAL(14,2),
    total_cost DECIMAL(14,2),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Running totals of how much of THIS Assembly Build's own quantity_built has been
-- Passed vs sent to RMA across every Quality Inspection raised against it -- a build
-- isn't necessarily inspected all in one pass, so quality_inspection_lines.pass_qty/
-- rma_qty accumulate here the same way Item Fulfillment's lines accumulate onto
-- transfer_order_lines.fulfilled.
ALTER TABLE assembly_builds ADD COLUMN passed_qty DECIMAL(14,4) DEFAULT 0;
ALTER TABLE assembly_builds ADD COLUMN rma_qty DECIMAL(14,4) DEFAULT 0;

-- Mirrors the real system's "Quality Inspection" transaction -- reached from a Job
-- Order's Production view once it has Assembly Build batches with something still
-- uninspected. One QI can cover several Assembly Builds at once (one line per AB), each
-- line splitting that batch's own remaining qty into Pass Qty (cleared for delivery) and
-- RMA Qty (kicked back for rework/return), with a memo and an action plan for anything
-- that failed.
CREATE TABLE quality_inspections (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    qi_no VARCHAR(30) UNIQUE NOT NULL,
    job_order_id BIGINT NOT NULL REFERENCES job_orders(id),
    date_created DATE NOT NULL,
    memo VARCHAR(500),
    status VARCHAR(30) DEFAULT 'saved',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL
);

CREATE TABLE quality_inspection_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    quality_inspection_id BIGINT NOT NULL REFERENCES quality_inspections(id),
    assembly_build_id BIGINT NOT NULL REFERENCES assembly_builds(id),
    ab_qty DECIMAL(14,4) NOT NULL,
    pass_qty DECIMAL(14,4) DEFAULT 0,
    rma_qty DECIMAL(14,4) DEFAULT 0,
    rma_memo VARCHAR(255),
    action_to_be_taken VARCHAR(255)
);

-- Running total of how much of this JO's own quantity has actually shipped -- caps Qty
-- to Deliver on the Item Delivery form the same way quantity_built/quantity_inspected
-- cap Assembly Build/Quality Inspection.
ALTER TABLE job_orders ADD COLUMN quantity_delivered DECIMAL(14,4) DEFAULT 0;

-- Mirrors the real system's "Item Delivery" transaction -- reached from a Sales Order's
-- Item Delivery button once at least one of its Job Order lines has both Built and QI'd
-- qty. One delivery can cover several JO lines at once, one line each, each capped at
-- min(quantity_built, quantity_inspected) - quantity_delivered for that JO.
CREATE TABLE item_deliveries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    delivery_no VARCHAR(30) UNIQUE NOT NULL,
    sales_order_id BIGINT NOT NULL REFERENCES sales_orders(id),
    date_created DATE NOT NULL,
    memo VARCHAR(500),
    status VARCHAR(30) DEFAULT 'saved',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL
);

CREATE TABLE item_delivery_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    item_delivery_id BIGINT NOT NULL REFERENCES item_deliveries(id),
    job_order_id BIGINT NOT NULL REFERENCES job_orders(id),
    qty_delivered DECIMAL(14,4) NOT NULL,
    memo VARCHAR(255)
);

-- Running total of how much of this JO's own quantity has been billed -- caps which SO
-- lines are still eligible for a Sales Invoice (quantity_delivered > quantity_invoiced).
ALTER TABLE job_orders ADD COLUMN quantity_invoiced DECIMAL(14,4) DEFAULT 0;

-- Mirrors the real system's "Create SI" (Sales Invoice) form -- reached from a Sales
-- Order's Bill dropdown once at least one line has been delivered but not yet invoiced.
-- Each line is a straight copy of that sales_order_line's own already-computed billing
-- figures (subtotal/discount/tax/gross) -- the real screen doesn't recompute anything
-- per line, it just bills what the SO line already says it's worth.
CREATE TABLE sales_invoices (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    invoice_no VARCHAR(30) UNIQUE NOT NULL,
    sales_order_id BIGINT NOT NULL REFERENCES sales_orders(id),
    date_created DATE NOT NULL,
    date_due DATE NULL,
    term VARCHAR(60),
    bs_si_no VARCHAR(60),
    po_no VARCHAR(60),
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    office_location_id BIGINT NULL REFERENCES locations(id),
    department_id BIGINT NULL REFERENCES departments(id),
    bill_to_address VARCHAR(500),
    memo VARCHAR(500),
    withholding_tax_pct DECIMAL(5,2) DEFAULT 0,
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    ewt_amount DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    gross_amount DECIMAL(14,2) DEFAULT 0,
    amount_due DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'saved',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL
);

CREATE TABLE sales_invoice_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id),
    sales_order_line_id BIGINT NOT NULL REFERENCES sales_order_lines(id),
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    description VARCHAR(500),
    job_location_id BIGINT NULL REFERENCES locations(id),
    quantity DECIMAL(14,4),
    units VARCHAR(30),
    price_per_unit DECIMAL(14,4),
    subtotal DECIMAL(14,2),
    disc_percent DECIMAL(5,2),
    disc_amount DECIMAL(14,2),
    disc_price_per_unit DECIMAL(14,4),
    net_of_tax DECIMAL(14,2),
    tax_code VARCHAR(30),
    tax_amount DECIMAL(14,2),
    gross_amount DECIMAL(14,2)
);

-- Mirrors the real system's "Purchase Requisition" module (Purchasing > Purchase
-- Requisitions) -- an internal request to buy materials, raised by a department,
-- independent of any Job Order (though a line can optionally reference one it's for).
-- Doesn't move stock or money by itself; it only becomes real once converted to a
-- Purchase Order (not modeled in this build yet) -- po_qty/received_qty running totals
-- on each line are pre-wired for that so it won't need another migration once POs land.
-- qty_on_hand is deliberately NOT stored here (unlike Transfer Order's line snapshot
-- that turned out to go stale) -- it's computed live from inventory_locations on read.
CREATE TABLE purchase_requisitions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    pr_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    date_needed DATE NULL,
    department_id BIGINT NULL REFERENCES departments(id),
    requestor_id BIGINT NULL REFERENCES employees(id),
    prepared_by_user_id BIGINT NULL REFERENCES users(id),
    memo VARCHAR(500),
    status VARCHAR(30) DEFAULT 'pending_request',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL
);

CREATE TABLE purchase_requisition_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    purchase_requisition_id BIGINT NOT NULL REFERENCES purchase_requisitions(id),
    line_no INT NOT NULL,
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    purchase_description VARCHAR(500),
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    qty DECIMAL(14,4) NOT NULL,
    purchase_unit VARCHAR(30),
    unit_title VARCHAR(30),
    po_qty DECIMAL(14,4) DEFAULT 0,
    received_qty DECIMAL(14,4) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mirrors the real system's "Placing Order Form" > Purchase Orders -- one PO per
-- Supplier (a canvass grid covering several suppliers splits into one PO per supplier
-- on save). Deliberately skips the real screen's full Canvass step for now (historical
-- Supplier Price comparison + "not the lowest price, pick a reason" justification) --
-- that needs real purchase history to be meaningful, which doesn't exist yet since this
-- is the first Purchase Order ever raised in this build. Each line traces back to the
-- Purchase Requisition line it came from so PR Qty vs PO Qty stays in sync.
--
-- Approval workflow mirrors the real system: every PO starts 'pending_approval' and
-- needs a user with users.is_supervisor=1 to approve it. If total_amount exceeds
-- APPROVAL_THRESHOLD (see purchaseOrders.js, currently 10,000) that supervisor approval
-- only advances it to 'pending_approval_gm', requiring a second approval from a user
-- with users.account_type = 'System Admin' (stands in for "General Manager" -- the real
-- system's threshold check is against the same account type). Below the threshold,
-- supervisor approval goes straight to 'approved'.
-- `type` mirrors the real system's 4 PO categories: PO1 (raised from a Purchase
-- Requisition via the Canvass step), PO2 (Landed Cost -- a sub-PO for freight/customs/
-- etc. tied to an already-Approved PO1 via parent_purchase_order_id), PO3 (Services with
-- JO, raised directly without a PR) and PO4 (Services/Non-Inventory without JO, also
-- direct). PO3/PO4 are created from a standalone form; PO2 only from an approved
-- non-PO2 PO's "Landed Cost" tab.
CREATE TABLE purchase_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    po_no VARCHAR(30) UNIQUE NOT NULL,
    type VARCHAR(10) NOT NULL DEFAULT 'PO1',
    parent_purchase_order_id BIGINT NULL REFERENCES purchase_orders(id),
    date_created DATE NOT NULL,
    need_by_date DATE NULL,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    term_id BIGINT NULL REFERENCES payment_terms(id),
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    ref_no VARCHAR(100),
    memo VARCHAR(500),
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    total_amount DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'pending_approval',
    -- Independent of `status` (the approval workflow) -- mirrors the real system's
    -- separate Status/SubStatus split ("Approved by General Manager" / "Fully
    -- Received"). Recomputed off purchase_order_lines.received_qty vs qty whenever a
    -- Receiving Report is saved: 'not_received' | 'partially_received' | 'fully_received'.
    receipt_status VARCHAR(30) NOT NULL DEFAULT 'not_received',
    -- Mirrors receipt_status -- recomputed off purchase_order_lines.billed_qty vs
    -- received_qty whenever a Vendor Bill is saved/cancelled: 'not_billed' |
    -- 'partially_billed' | 'fully_billed'.
    bill_status VARCHAR(30) NOT NULL DEFAULT 'not_billed',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL,
    approved_by_supervisor_user_id BIGINT NULL REFERENCES users(id),
    approved_by_supervisor_at DATETIME NULL,
    approved_by_gm_user_id BIGINT NULL REFERENCES users(id),
    approved_by_gm_at DATETIME NULL
);

-- location_id/department_id mirror the real Materials grid's per-line Location/
-- Department columns, present on every PO type except PO2 (Landed Cost) -- Location is
-- what the real system uses to know which warehouse to receive the qty into once the PO
-- is received (Receiving isn't built yet, so this just captures the field for now).
-- job_order_id/memo are only populated on PO3 (job_order_id) and PO3/PO4 (memo) direct
-- lines, matching the real Materials grid's JO#/Memo columns.
CREATE TABLE purchase_order_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),
    purchase_requisition_line_id BIGINT NULL REFERENCES purchase_requisition_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    purchase_description VARCHAR(500),
    location_id BIGINT NULL REFERENCES locations(id),
    department_id BIGINT NULL REFERENCES departments(id),
    job_order_id BIGINT NULL REFERENCES job_orders(id),
    memo VARCHAR(500),
    qty DECIMAL(14,4) NOT NULL,
    purchase_unit VARCHAR(30),
    unit_title VARCHAR(30),
    rate DECIMAL(14,4) DEFAULT 0,
    disc_percent DECIMAL(5,2) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2) DEFAULT 0,
    ext_price DECIMAL(14,2) DEFAULT 0,
    received_qty DECIMAL(14,4) DEFAULT 0,
    -- Mirrors received_qty -- a running total updated whenever a Vendor Bill is saved
    -- (or cancelled, which subtracts back out), so Create Vendor Bill can compute this
    -- line's still-billable qty as received_qty - billed_qty ("RR Qty" - "Billed Qty" on
    -- the real Create Vendor Bill modal).
    billed_qty DECIMAL(14,4) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Receiving Report" (RR-#) -- the document that actually lands the received qty as
-- stock, confirmed against the real system's "Receive" flow off an Approved PO. Rate/
-- Discount%/Tax Code are re-entered per receipt line (invoice price can differ from the
-- PO's) rather than just copied, matching the real Receiving Report form.
CREATE TABLE purchase_order_receipts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    receipt_no VARCHAR(30) UNIQUE NOT NULL,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),
    date_created DATE NOT NULL,
    ref_no VARCHAR(100) NULL,
    memo VARCHAR(500),
    is_on_hold BOOLEAN NOT NULL DEFAULT FALSE,
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    total_amount DECIMAL(14,2) DEFAULT 0,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_order_receipt_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    purchase_order_receipt_id BIGINT NOT NULL REFERENCES purchase_order_receipts(id),
    purchase_order_line_id BIGINT NOT NULL REFERENCES purchase_order_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    qty_received DECIMAL(14,4) NOT NULL,
    rate DECIMAL(14,4) DEFAULT 0,
    disc_percent DECIMAL(5,2) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2) DEFAULT 0,
    ext_price DECIMAL(14,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Vendor Return" (VR-#) -- confirmed against the real system: saving one *decrements*
-- purchase_order_lines.received_qty by qty_returned (never below what a Receiving Report
-- actually logged) and decrements inventory_locations.qty_on_hand at the same Location a
-- Receiving Report line landed it in. Deliberately reuses purchase_orders.receipt_status
-- rather than a separate status field -- the real system's own behavior confirmed a
-- return can flip a PO's SubStatus back from "Fully Received" to "Partially Received",
-- which is exactly what recomputing receipt_status off the now-lower received_qty does
-- for free. Location is NOT editable per return line (unlike Receiving Report) -- the
-- real form shows it read-only, since you return from wherever it was actually received.
CREATE TABLE purchase_returns (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    return_no VARCHAR(30) UNIQUE NOT NULL,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),
    date_created DATE NOT NULL,
    ref_no VARCHAR(100) NULL,
    memo VARCHAR(500),
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    total_amount DECIMAL(14,2) DEFAULT 0,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_return_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    purchase_return_id BIGINT NOT NULL REFERENCES purchase_returns(id),
    purchase_order_line_id BIGINT NOT NULL REFERENCES purchase_order_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    qty_returned DECIMAL(14,4) NOT NULL,
    rate DECIMAL(14,4) DEFAULT 0,
    disc_percent DECIMAL(5,2) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2) DEFAULT 0,
    ext_price DECIMAL(14,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Vendor Bill" (VB-#) -- the AP-side counterpart to Sales Invoice, confirmed against the
-- real system's Create Vendor Bill modal (reached from a Received PO's "Bill" button).
-- Rate on each line is a read-only snapshot of the PO line's own rate; Unit Price is the
-- actual billed price (defaults to Rate but is independently editable -- e.g. a vendor
-- price change discovered at billing time) -- every money figure below is computed off
-- Unit Price, never Rate. Withholding Tax is a single header-level code (picked from
-- withholding_taxes) applied only to the lines whose is_withhold flag is checked, unlike
-- Sales Invoice's simpler flat withholding_tax_pct.
CREATE TABLE vendor_bills (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_no VARCHAR(30) UNIQUE NOT NULL,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),
    date_created DATE NOT NULL,
    date_due DATE NULL,
    term VARCHAR(150),
    reference_no VARCHAR(100),
    account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    office_location_id BIGINT NULL REFERENCES locations(id),
    memo VARCHAR(500),
    subtotal DECIMAL(14,2) DEFAULT 0,
    discount_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    gross_amount DECIMAL(14,2) DEFAULT 0,
    wtax_id BIGINT NULL REFERENCES withholding_taxes(id),
    wtax_description VARCHAR(150),
    wtax_amount DECIMAL(14,2) DEFAULT 0,
    amount_due DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by_user_id BIGINT NULL REFERENCES users(id),
    cancelled_at DATETIME NULL
);

CREATE TABLE vendor_bill_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    vendor_bill_id BIGINT NOT NULL REFERENCES vendor_bills(id),
    purchase_order_line_id BIGINT NOT NULL REFERENCES purchase_order_lines(id),
    item_id BIGINT NOT NULL REFERENCES inventories(id),
    location_id BIGINT NULL REFERENCES locations(id),
    department_id BIGINT NULL REFERENCES departments(id),
    qty DECIMAL(14,4) NOT NULL,
    rate DECIMAL(14,4) DEFAULT 0,
    unit_price DECIMAL(14,4) DEFAULT 0,
    disc_percent DECIMAL(5,2) DEFAULT 0,
    disc_amount DECIMAL(14,2) DEFAULT 0,
    net_of_tax DECIMAL(14,2) DEFAULT 0,
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2) DEFAULT 0,
    ext_price DECIMAL(14,2) DEFAULT 0,
    is_withhold BOOLEAN NOT NULL DEFAULT FALSE,
    wtax_amount DECIMAL(14,2) DEFAULT 0,
    amount_due DECIMAL(14,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Bill Payment" (BPAY-#) -- confirmed against the real system's Bill Payment modal
-- (reached from an Open Vendor Bill). A single payment can settle several of the same
-- vendor's open bills at once (bill_payment_lines.vendor_bill_id rows, the "Apply" tab),
-- and can additionally offset the payment with the vendor's own existing open Bill
-- Credits (bill_payment_lines.bill_credit_id rows, the "Debits" tab) -- each line is one
-- or the other, never both. Selecting Payment Method = CHECK reveals Check Date/Check No
-- in place of the generic Reference #, matching the real modal's conditional sub-fields.
CREATE TABLE bill_payments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_payment_no VARCHAR(30) UNIQUE NOT NULL,
    date_created DATE NOT NULL,
    payment_type VARCHAR(20) NOT NULL DEFAULT 'full',
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    payee_name VARCHAR(255),
    office_location_id BIGINT NULL REFERENCES locations(id),
    ap_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    bank_account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
    payment_method_id BIGINT NOT NULL REFERENCES payment_methods(id),
    reference_no VARCHAR(100),
    check_date DATE NULL,
    check_no VARCHAR(100),
    memo VARCHAR(500),
    total_amount DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL REFERENCES users(id),
    voided_at DATETIME NULL
);

CREATE TABLE bill_payment_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_payment_id BIGINT NOT NULL REFERENCES bill_payments(id),
    vendor_bill_id BIGINT NULL REFERENCES vendor_bills(id),
    bill_credit_id BIGINT NULL REFERENCES bill_credits(id),
    applied_amount DECIMAL(14,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "Bill Credit" (BC-#) -- confirmed against the real system's Bill Credit modal. Unlike
-- Vendor Bill, its lines aren't tied to the source bill's own inventory items -- they're
-- general-ledger expense lines against arbitrary Chart of Accounts entries (e.g. crediting
-- a return, an overcharge correction, a vendor rebate), added one at a time via the
-- EXPENSES tab's "Add" button. The APPLY tab then offsets one or more of the vendor's open
-- bills by this credit's total.
--
-- Deliberate deviation from the real system: the real Apply tab defaults "Applied Amount"
-- to the *source bill's full total* regardless of what the Expenses tab actually adds up
-- to, and doesn't stop you saving with a negative Unapplied Amount (confirmed live -- it
-- saved a credit that claimed to apply ₱2,712 worth of offset from only ₱100 of actual
-- expense lines). That's an accounting error, not a feature, so this build instead caps
-- total applied_amount at the credit's own total_amount and rejects (not clamps) an
-- over-application, consistent with how every other qty/amount cap in this codebase works.
CREATE TABLE bill_credits (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_credit_no VARCHAR(30) UNIQUE NOT NULL,
    vendor_bill_id BIGINT NOT NULL REFERENCES vendor_bills(id),
    date_created DATE NOT NULL,
    office_location_id BIGINT NULL REFERENCES locations(id),
    ap_account_id BIGINT NULL REFERENCES chart_of_accounts(id),
    memo VARCHAR(500),
    wtax_id BIGINT NULL REFERENCES withholding_taxes(id),
    wtax_description VARCHAR(150),
    wtax_amount DECIMAL(14,2) DEFAULT 0,
    subtotal DECIMAL(14,2) DEFAULT 0,
    tax_amount DECIMAL(14,2) DEFAULT 0,
    total_amount DECIMAL(14,2) DEFAULT 0,
    applied_amount DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by_user_id BIGINT NULL REFERENCES users(id),
    voided_at DATETIME NULL
);

CREATE TABLE bill_credit_lines (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_credit_id BIGINT NOT NULL REFERENCES bill_credits(id),
    account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
    department_id BIGINT NULL REFERENCES departments(id),
    amount DECIMAL(14,2) NOT NULL,
    tax_code_id BIGINT NULL REFERENCES taxes(id),
    tax_amount DECIMAL(14,2) DEFAULT 0,
    gross_amount DECIMAL(14,2) DEFAULT 0,
    is_withhold BOOLEAN NOT NULL DEFAULT FALSE,
    wtax_amount DECIMAL(14,2) DEFAULT 0,
    amount_due DECIMAL(14,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bill_credit_applications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    bill_credit_id BIGINT NOT NULL REFERENCES bill_credits(id),
    vendor_bill_id BIGINT NOT NULL REFERENCES vendor_bills(id),
    applied_amount DECIMAL(14,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- SECTION 20: CRM (LEADS, OPPORTUNITIES, ACTIVITIES)
-- =====================================================================
-- Not present in the real GraphicStar system at all (confirmed against the sandbox --
-- it's a pure transaction-and-fulfillment ERP with a static Customer master record, no
-- lead/pipeline/activity-log concept anywhere) -- this section is a net-new addition to
-- this build, not a replication of real-system fields.

CREATE TABLE leads (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    lead_no VARCHAR(30) UNIQUE NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    contact_name VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(50),
    source VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'new',
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    memo VARCHAR(1000),
    converted_customer_id BIGINT NULL REFERENCES customers(id),
    converted_at DATETIME NULL,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

CREATE TABLE opportunities (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    opportunity_no VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    customer_id BIGINT NULL REFERENCES customers(id),
    lead_id BIGINT NULL REFERENCES leads(id),
    -- prospecting, qualified, proposal, negotiation, won, lost
    stage VARCHAR(30) NOT NULL DEFAULT 'prospecting',
    estimated_value DECIMAL(14,2) DEFAULT 0,
    expected_close_date DATE NULL,
    sales_rep_id BIGINT NULL REFERENCES employees(id),
    -- Optional link to an already-created formal quote once one exists -- reuses the
    -- existing Estimates module rather than duplicating its own wizard/approval flow.
    estimate_id BIGINT NULL REFERENCES estimates(id),
    lost_reason VARCHAR(255),
    closed_at DATETIME NULL,
    memo VARCHAR(1000),
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- Polymorphic activity/interaction log -- same auditable_type/auditable_id shape
-- audit_logs already uses (see SECTION 2), just a second, purpose-built table since
-- audit_logs itself is a system-generated field-change trail, not a user-authored note/
-- call/task log.
CREATE TABLE crm_activities (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    related_type VARCHAR(30) NOT NULL,
    related_id BIGINT NOT NULL,
    activity_type VARCHAR(20) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    description VARCHAR(2000),
    due_date DATE NULL,
    is_done BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at DATETIME NULL,
    assigned_to_user_id BIGINT NULL REFERENCES users(id),
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    INDEX idx_crm_activities_related (related_type, related_id)
);

-- =====================================================================
-- SECTION 21: TICKETS (CHAT SUPPORT -> DEPARTMENT-ROUTED TICKETING)
-- =====================================================================
-- Not present in the real GraphicStar system -- an app-support feature (helping users
-- of THIS build, not a business-domain concept), so nothing to replicate here.
-- head_user_id: each department's single designated head, who receives tickets routed
-- to that department and delegates them to staff within it. Deliberately NOT reusing
-- the existing is_supervisor flag -- checked the real data first: the two current
-- Sales supervisors (arjie, michelle) both have employee.department_id = NULL, so
-- there's no reliable existing link from "supervisor" to "department" to build on.
ALTER TABLE departments ADD COLUMN head_user_id BIGINT NULL REFERENCES users(id);

CREATE TABLE tickets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_no VARCHAR(30) UNIQUE NOT NULL,
    department_id BIGINT NOT NULL REFERENCES departments(id),
    subject VARCHAR(255) NOT NULL,
    description VARCHAR(2000) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    priority VARCHAR(10) NOT NULL DEFAULT 'normal',
    created_by_user_id BIGINT NOT NULL REFERENCES users(id),
    assigned_to_user_id BIGINT NULL REFERENCES users(id),
    assigned_by_user_id BIGINT NULL REFERENCES users(id),
    resolved_by_user_id BIGINT NULL REFERENCES users(id),
    resolved_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
);

-- The ongoing chat thread once a ticket exists -- the requester and whoever's working
-- the ticket (department head / assignee) both post here.
CREATE TABLE ticket_messages (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id),
    sender_user_id BIGINT NOT NULL REFERENCES users(id),
    message VARCHAR(2000) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ticket_messages_ticket (ticket_id)
);

-- Per-department, admin-configurable gate: if the ticket's CREATOR belongs to a
-- department with one or more rows here (e.g. Sales), ANY ONE of those tagged users
-- signing off unblocks the ticket for the destination department to assign/work --
-- it stays visible to the creator, the destination department, and every tagged
-- approver the whole time (see ticketVisibility.js), just not actionable until then.
-- A department with no rows here has no gate at all, same as today.
CREATE TABLE department_ticket_approvers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    department_id BIGINT NOT NULL REFERENCES departments(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dept_ticket_approver (department_id, user_id)
);

-- Snapshotted from department_ticket_approvers at ticket creation time (who was
-- eligible then), rather than re-derived live -- so changing a department's approver
-- list later doesn't retroactively change who's responsible for a ticket already in
-- flight. Empty for a ticket = no approval gate. approved_by_user_id/approved_at on
-- tickets itself record whichever one of these actually clicked Approve.
CREATE TABLE ticket_approvers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    UNIQUE KEY uq_ticket_approver (ticket_id, user_id)
);

ALTER TABLE tickets
    ADD COLUMN approved_by_user_id BIGINT NULL REFERENCES users(id),
    ADD COLUMN approved_at DATETIME NULL;

-- General-purpose, polymorphic (related_type/related_id, same shape as crm_activities)
-- so future events beyond "ticket resolved" can reuse this table rather than each
-- needing their own. Only the ticket-resolved trigger is wired up for now (see
-- PUT /:id/status in tickets.js) -- the table/API are intentionally general so adding
-- e.g. "ticket assigned to you" or "new reply" later is just a new INSERT, no schema
-- change. Polled by the client (NotificationBell.jsx) rather than pushed, same
-- approach as the chat widget's ticket-thread polling.
CREATE TABLE notifications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL REFERENCES users(id),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message VARCHAR(500) NULL,
    related_type VARCHAR(50) NULL,
    related_id BIGINT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notifications_user (user_id, is_read)
);

-- Company-wide, not per-department (unlike department_ticket_approvers) -- a General
-- Manager escalation applies regardless of which department the ticket was routed to.
-- A flat list rather than a single user_id column for the same reason
-- department_ticket_approvers is many-to-many: any one of them clearing it is enough.
CREATE TABLE general_managers (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A second, manually-triggered escalation gate on top of the Sales-approval one --
-- the department head/supervisor forwards a not-yet-assigned ticket to the GM for an
-- extra sign-off; PUT /:id/assign in tickets.js blocks until gm_approved_at is set,
-- same shape as the approved_at gate but independent of it (a ticket can clear its
-- Sales approval and still need GM sign-off, or vice versa in principle).
ALTER TABLE tickets
    ADD COLUMN forwarded_to_gm_at DATETIME NULL,
    ADD COLUMN forwarded_by_user_id BIGINT NULL REFERENCES users(id),
    ADD COLUMN gm_approved_at DATETIME NULL,
    ADD COLUMN gm_approved_by_user_id BIGINT NULL REFERENCES users(id);