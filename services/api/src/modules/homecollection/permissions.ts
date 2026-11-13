// Permission codes checked by module homecollection (02-TRD §5). Copied verbatim from contracts/permissions.yaml (homecollection block).
export const HOMECOLLECTION_PERMISSIONS = Object.freeze([
  'homecollection.visit.read',
  'homecollection.visit.assign',
  'homecollection.handover.receive',
  'homecollection.device.manage',
  'homecollection.settings.manage',
  'homecollection.sync.upload',
] as const);

export type HomecollectionPermission = (typeof HOMECOLLECTION_PERMISSIONS)[number];
