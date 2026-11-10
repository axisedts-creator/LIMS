// The 9 catalog.* permission codes (02-TRD §5.0, contracts/permissions.yaml, CR-C3-003). REQ-SEC-099.
export const CATALOG_PERMISSIONS = Object.freeze([
  'catalog.test.read',
  'catalog.test.manage',
  'catalog.price_list.read',
  'catalog.price_list.manage',
  'catalog.referrer.manage',
  'catalog.instrument_code_map.manage',
  'catalog.referrer.read',
  'catalog.reference_range.publish',
  'catalog.referrer.export',
] as const);

export type CatalogPermission = (typeof CATALOG_PERMISSIONS)[number];
