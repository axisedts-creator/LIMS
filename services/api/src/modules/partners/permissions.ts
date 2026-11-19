// Permission codes checked by module partners (02-TRD §9.2). Copied verbatim from contracts/permissions.yaml (# partners (C13) block).
export const PARTNERS_PERMISSIONS: readonly string[] = Object.freeze([
  'partners.manifest.receive',
  'partners.manifest.submit',
  'partners.onboarding.decide', // T0C-PARTYSET-1 (LD-321)
  'partners.order.read',
  'partners.partner.manage',
  'partners.partner.read',
  'partners.partner_user.manage',
  'partners.party_id_number.read', // T0C-PARTYSET-1 (LD-321), privileged
  'partners.party_setting.manage', // T0C-PARTYSET-1 (LD-321)
  'partners.party_setting.read', // T0C-PARTYSET-1 (LD-321)
  'partners.penalty.manage', // T0C-PARTYSET-1 (LD-321)
  'partners.pickup.manage',
  'partners.pickup.request',
  'partners.price_list.read',
  'partners.referrer.manage',
  'partners.referrer.map',
  'partners.referrer.read',
  'partners.report.read',
  'partners.sales.manage', // T0C-SALES-1 (LD-321)
  'partners.sales.read', // T0C-SALES-1 (LD-321)
  'partners.statement.read',
  'partners.ticket.manage', // T0C-MSGDESK-1 (LD-321)
  'partners.ticket.read',
]);

/** System actor permissions (02-TRD §9.3); never `platform.*` (03 §11). Extended by CR only. */
export const PARTNERS_SYSTEM_PERMISSIONS: readonly string[] = Object.freeze(['partners.manifest.receive', 'partners.partner.read']);
