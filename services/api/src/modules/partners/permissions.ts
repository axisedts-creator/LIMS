// Permission codes checked by module partners (02-TRD §9.2). Copied verbatim from contracts/permissions.yaml (# partners (C13) block).
export const PARTNERS_PERMISSIONS: readonly string[] = Object.freeze([
  'partners.manifest.receive',
  'partners.manifest.submit',
  'partners.order.read',
  'partners.partner.manage',
  'partners.partner.read',
  'partners.partner_user.manage',
  'partners.pickup.manage',
  'partners.pickup.request',
  'partners.price_list.read',
  'partners.referrer.manage',
  'partners.referrer.map',
  'partners.referrer.read',
  'partners.report.read',
  'partners.statement.read',
]);

/** System actor permissions (02-TRD §9.3); never `platform.*` (03 §11). Extended by CR only. */
export const PARTNERS_SYSTEM_PERMISSIONS: readonly string[] = Object.freeze(['partners.manifest.receive', 'partners.partner.read']);
