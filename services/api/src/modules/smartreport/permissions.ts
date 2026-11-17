// Permission codes checked by module smartreport (02-TRD §3.1, 07-SECURITY). Copied verbatim from contracts/permissions.yaml (smartreport.* block).
export const SMARTREPORT_PERMISSIONS = Object.freeze([
  'smartreport.summary.read',
  'smartreport.summary.approve',
  'smartreport.template.manage',
  'smartreport.template.approve',
] as const);

export type SmartreportPermission = (typeof SMARTREPORT_PERMISSIONS)[number];
