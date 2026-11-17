// Permission codes checked by module micro (02-CV §2.2, 07-SECURITY REQ-SEC-099). Copied verbatim from contracts/permissions.yaml (# micro (C10) block).
export const MICRO_PERMISSIONS = Object.freeze([
  'micro.culture.read',
  'micro.culture.work',
  'micro.config.manage',
  'micro.breakpoint.manage',
] as const);

export type MicroPermission = (typeof MICRO_PERMISSIONS)[number];
