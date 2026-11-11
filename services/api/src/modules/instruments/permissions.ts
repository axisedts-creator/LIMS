// Permission codes checked by module instruments (02-CV §2.2, §10.1). Copied verbatim from contracts/permissions.yaml
// (# instruments (C7) block + 08 §4.1 additions, CR-C7-001). instruments.ingest.* are held only by device actors (REQ-SEC-072).
export const INSTRUMENTS_PERMISSIONS = Object.freeze([
  'instruments.agent.read',
  'instruments.agent.manage',
  'instruments.message.read',
  'instruments.message.rematch',
  'instruments.ingest.submit',
  'instruments.ingest.heartbeat',
  'instruments.ingest.host_query',
  'instruments.ingest.config_read',
  'instruments.instrument.read',
  'instruments.instrument.manage',
  'instruments.ingest.enrol',
] as const);

export type InstrumentsPermission = (typeof INSTRUMENTS_PERMISSIONS)[number];
