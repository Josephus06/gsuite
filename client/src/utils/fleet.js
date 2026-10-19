// Shared by Assets > Fleet's pages (pages/Fleet.jsx, pages/FleetVehicle.jsx).
export const DUE_BADGE = {
  overdue: { cls: 'badge-danger', text: 'Overdue' },
  due_soon: { cls: 'badge-warning', text: 'Due soon' },
  ok: { cls: 'badge-success', text: 'OK' },
  none: { cls: 'badge-muted', text: '—' },
};
export const vehicleName = (v) => [v.make || v.brand, v.model || v.asset_model, v.year_model].filter(Boolean).join(' ') || v.asset_name || '—';

