// Session state table (03-APP-FLOW §2.1 SS1–SS10; identity.sessions.state). Pure.
export const STATES = ['password_setup', 'mfa_pending', 'mfa_enrolment_required', 'active', 'revoked', 'expired'] as const;
export type SessionState = (typeof STATES)[number];

const END = ['revoked', 'expired'] as const; // SS6/SS9 revoke, SS10 expire; both terminal
const EDGES: Readonly<Record<SessionState | '(none)', readonly SessionState[]>> = {
  '(none)': ['password_setup', 'mfa_pending', 'mfa_enrolment_required', 'active'], // SS1–SS4
  password_setup: ['mfa_enrolment_required', 'active', 'mfa_pending', ...END], // SS8
  mfa_pending: ['active', ...END], // SS5
  mfa_enrolment_required: ['active', ...END], // SS7
  active: [...END],
  revoked: [],
  expired: [],
};

export function canTransition(from: SessionState | null, to: SessionState): boolean {
  const k = from ?? '(none)';
  return Object.hasOwn(EDGES, k) && EDGES[k].includes(to);
}
