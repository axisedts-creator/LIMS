// SCR-09/10 text for message kinds, run outcomes and C5 port outcomes (04-UI-UX §3). Status is always text, never colour only. Labels marked [CONV] are not given verbatim.
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { MessageRecord } from '../server/messages';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const KIND_LABEL: Record<string, string> = { data: 'Data', host_query: 'Host query', attachment: 'Attachment', incomplete: 'Incomplete' };
export const KIND_OPTIONS = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));

const OUTCOME: Record<string, readonly [Tone, string]> = {
  parsed: ['success', 'Parsed'],
  shadow: ['info', 'Shadow'],
  quarantined: ['danger', 'Quarantined'],
  rejected_capability: ['danger', 'Rejected'],
};
export const OUTCOME_OPTIONS = Object.entries(OUTCOME).map(([value, [, label]]) => ({ value, label }));
export const outcomeLabel = (o: string | undefined) => (o && Object.hasOwn(OUTCOME, o) ? OUTCOME[o]![1] : (o ?? '—'));
export const OutcomeChip = ({ outcome }: { outcome: string | undefined }) => {
  if (!outcome) return <>—</>;
  const [tone, label] = Object.hasOwn(OUTCOME, outcome) ? OUTCOME[outcome]! : (['neutral', outcome] as const);
  return <StatusChip kind="generic" status={outcome} tone={tone} label={label} />;
};

const MAPPING: Record<string, readonly [Tone, string]> = { mapped: ['success', 'Mapped'], unmapped: ['warning', 'Unmapped'] };
export const MappingChip = ({ status }: { status: string }) => {
  const [tone, label] = Object.hasOwn(MAPPING, status) ? MAPPING[status]! : (['neutral', status] as const);
  return <StatusChip kind="generic" status={status} tone={tone} label={label} />;
};

const EMIT: Record<string, string> = { emitted: 'Sent', skipped: 'Skipped', not_applicable: 'Not applicable' }; // [CONV]
export const emitLabel = (s: string) => (Object.hasOwn(EMIT, s) ? EMIT[s]! : s);

const SCAN: Record<string, readonly [Tone, string]> = { clean: ['success', 'Clean'], pending: ['info', 'Scan pending'], quarantined: ['danger', 'Quarantined'], failed: ['danger', 'Scan failed'] }; // [CONV]
export const ScanChip = ({ state }: { state: string }) => {
  const [tone, label] = Object.hasOwn(SCAN, state) ? SCAN[state]! : (['neutral', state] as const);
  return <StatusChip kind="generic" status={state} tone={tone} label={label} />;
};

/** C5 port outcome text (04-UI-UX SCR-10 reprocess result). Unknown codes show as the code so nothing is hidden. */
export function portOutcomeText(r: Pick<MessageRecord, 'port_outcome' | 'port_reason_code'>): string {
  switch (r.port_outcome) {
    case undefined: return '—';
    case 'applied': return 'Applied';
    case 'duplicate': return 'Already received';
    case 'unmatched': return 'Not matched (see lab exceptions)';
    case 'held': return 'On QC hold';
    case 'rejected_state': return r.port_reason_code === 'result_locked' ? 'Locked (approved — amend in Lab)' : `Rejected (${r.port_reason_code ?? 'state'})`;
    default: return r.port_outcome;
  }
}

/** CR-C7-014: until the C5 exception-list route id is registered the hint is text only — no hand-built URL. */
export const exceptionHint = (r: Pick<MessageRecord, 'port_outcome'>) => r.port_outcome === 'unmatched' || r.port_outcome === 'held';
export const EXCEPTION_HINT = "Check the lab's instrument exceptions";

export const sizeText = (n: number) => `${n} B`;
