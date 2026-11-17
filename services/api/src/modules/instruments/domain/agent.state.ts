// Agent status machine (03-APP-FLOW §2.1 A1–A6). Pure: no DB, no clock.
import { LimsError } from '../../../core/errors.js';

export const AGENT_STATUSES = ['pending_enrolment', 'active', 'revoked', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentAction = 'create' | 'enrol' | 'revoke' | 'retire';

const ABSENT = '∅';
/** action -> { from -> to }. Anything absent is forbidden. */
const TABLE: Readonly<Record<AgentAction, Readonly<Partial<Record<AgentStatus | typeof ABSENT, AgentStatus>>>>> = {
  create: { [ABSENT]: 'pending_enrolment' }, // A1
  enrol: { pending_enrolment: 'active', active: 'active', revoked: 'active' }, // A2, A3, A5
  revoke: { pending_enrolment: 'revoked', active: 'revoked' }, // A4
  retire: { pending_enrolment: 'retired', active: 'retired', revoked: 'retired' }, // A6
};

/** Table first (409 instruments.invalid_transition), then the A6 guard (409 instruments.agent_has_active_instruments). */
export function agentNext(
  from: AgentStatus | null,
  action: AgentAction,
  guard: { hasNonRetiredInstruments?: boolean } = {},
): AgentStatus {
  const to = TABLE[action]?.[from ?? ABSENT];
  if (!to) throw new LimsError('instruments.invalid_transition');
  if (action === 'retire' && guard.hasNonRetiredInstruments) throw new LimsError('instruments.agent_has_active_instruments');
  return to;
}
