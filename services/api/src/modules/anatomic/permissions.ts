// Permission codes checked by module anatomic (02-TRD §3.2, 07-SECURITY). Copied verbatim from contracts/permissions.yaml (anatomic.* block).
export const ANATOMIC_PERMISSIONS = Object.freeze([
  'anatomic.case.read',
  'anatomic.case.work',
  'anatomic.case.signout',
  'anatomic.config.manage',
] as const);

export type AnatomicPermission = (typeof ANATOMIC_PERMISSIONS)[number];
