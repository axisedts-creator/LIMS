// Permission codes checked by module lab (02-CV §2.2, §10.1). Copied verbatim from contracts/permissions.yaml (# lab (C5)
// block + 08 §4.1 additions, CR-C5-004). The T-01 test pins this list to every `lab.*` code of the registry.
export const LAB_PERMISSIONS = Object.freeze([
  'lab.status_board.read',
  'lab.specimen.read',
  'lab.specimen.collect',
  'lab.specimen.receive',
  'lab.specimen.reject',
  'lab.specimen.label_print',
  'lab.worklist.read',
  'lab.result.read',
  'lab.result.enter',
  'lab.result.verify',
  'lab.result.approve',
  'lab.result.amend',
  'lab.critical_value.read',
  'lab.critical_value.log_notification',
  'lab.qc.capture',
  'lab.worksheet.manage',
  'lab.config.manage',
  'lab.qc_hold.release',
] as const);

export type LabPermission = (typeof LAB_PERMISSIONS)[number];
