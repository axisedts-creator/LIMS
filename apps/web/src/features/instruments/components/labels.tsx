// Chip mappings from 04-UI-UX §1. Status/credential labels marked [CONV] are not given verbatim by the spec.
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { AgentStatus, HealthState } from '../server/types';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const HEALTH: Record<HealthState, readonly [Tone, string]> = {
  online: ['success', 'Online'],
  backlog: ['warning', 'Backlog'],
  degraded: ['warning', 'Instrument silent'],
  offline: ['danger', 'Offline'],
};
// [CONV]
const STATUS: Record<AgentStatus, readonly [Tone, string]> = {
  pending_enrolment: ['info', 'Pending enrolment'],
  active: ['success', 'Active'],
  revoked: ['danger', 'Revoked'],
  retired: ['neutral', 'Retired'],
};
const INSTRUMENT: Record<string, readonly [Tone, string]> = {
  draft: ['neutral', 'Draft'],
  commissioning: ['info', 'Commissioning (no results sent)'],
  live: ['success', 'Live'],
  suspended: ['warning', 'Suspended (no results sent)'],
  retired: ['neutral', 'Retired'],
};

const chip = (map: Record<string, readonly [Tone, string]>, code: string) => {
  const [tone, label] = Object.hasOwn(map, code) ? map[code]! : (['neutral', code] as const);
  return <StatusChip kind="generic" status={code} tone={tone} label={label} />;
};

export const healthLabel = (s: string | undefined) => (s && Object.hasOwn(HEALTH, s) ? HEALTH[s as HealthState][1] : (s ?? '—'));
export const HealthChip = ({ state }: { state: string }) => chip(HEALTH, state);
export const AgentStatusChip = ({ status }: { status: string }) => chip(STATUS, status);
export const InstrumentStateChip = ({ state }: { state: string }) => chip(INSTRUMENT, state);

const options = (map: Record<string, readonly [Tone, string]>) => Object.entries(map).map(([value, [, label]]) => ({ value, label }));
export const STATUS_OPTIONS = options(STATUS);
export const HEALTH_OPTIONS = options(HEALTH);

export const DEFAULT_CLOCK_OFFSET_WARN_SECONDS = 300; // 02-TRD settings default for clock_offset_warn_seconds [CONV]

export const hasPerm =(perms: readonly string[], p: string) => perms.includes(p);

// SCR-05/07 (WEB-T03): the chip carries just the state name; "no results sent" is a separate visible hint (04-UI-UX §1) [CONV].
const STATE_CHIP: Record<string, readonly [Tone, string]> = {
  draft: ['neutral', 'Draft'],
  commissioning: ['info', 'Commissioning'],
  live: ['success', 'Live'],
  suspended: ['warning', 'Suspended'],
  retired: ['neutral', 'Retired'],
};
export const InstrumentStatePill = ({ state }: { state: string }) => (
  <>
    {chip(STATE_CHIP, state)}
    {state === 'commissioning' || state === 'suspended' ? <span className="lims-description"> (no results sent)</span> : null}
  </>
);
export const INSTRUMENT_STATE_OPTIONS = options(STATE_CHIP);

const DRIVER: Record<string, readonly [Tone, string]> = {
  generic: ['warning', 'Generic'],
  verified: ['success', 'Verified'],
  sketch_blocked: ['danger', 'Sketch — not for live use'],
};
export const DriverStatusBadge = ({ status }: { status: string }) => chip(DRIVER, status);
export const driverStatusLabel = (s: string) => (Object.hasOwn(DRIVER, s) ? DRIVER[s]![1] : s);

export const PROTOCOL_LABEL: Record<string, string> = { astm: 'ASTM', hl7v2: 'HL7 v2', file_drop: 'Folder only' };
export const PROTOCOL_OPTIONS = Object.entries(PROTOCOL_LABEL).map(([value, label]) => ({ value, label }));
