// The account types a user can be given. The users.account_type column is free text, so this
// list is the only place a type is defined -- the user wizard, the Users page and the permission
// templates all read it. Kept in step with ACCOUNT_TYPES in
// server/src/db/create-account-type-permissions.js.
export const ACCOUNT_TYPE_OPTIONS = [
  'Sales', 'Production', 'Costing', 'Logistics', 'Purchasing', 'Inventory',
  'Accounts Receivable', 'Accounting', 'Treasury', 'HR', 'IT', 'Security',
  'Account Manager', 'Artist', 'General Manager', 'System Admin',
];
