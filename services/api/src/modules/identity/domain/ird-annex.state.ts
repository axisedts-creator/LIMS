// IRD annex record state table (03-APP-FLOW §2.5 IR1–IR8; identity.ird_annex_records.status; AC-E3.1–E3.3). Pure.
export const STATES = ['not_started', 'in_preparation', 'submitted', 'completed', 'rejected', 'superseded'] as const;
export type AnnexStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<AnnexStatus | '(none)', readonly AnnexStatus[]>> = {
  '(none)': ['not_started'], // IR1
  not_started: ['in_preparation'], // IR2
  in_preparation: ['submitted', 'not_started'], // IR3, IR8
  submitted: ['completed', 'rejected'], // IR4, IR5
  rejected: ['in_preparation'], // IR6
  completed: ['superseded'], // IR7
  superseded: [],
};

export function canTransition(from: AnnexStatus | null, to: AnnexStatus): boolean {
  const k = from ?? '(none)';
  return Object.hasOwn(EDGES, k) && EDGES[k].includes(to);
}

export type AnnexFields = { submittedOn?: string; completedOn?: string; referenceNo?: string; note?: string; today: string };
export type AnnexCheck = { ok: true } | { ok: false; code: 'identity.annex_invalid_transition' | 'common.validation_failed' };

const INVALID = { ok: false, code: 'identity.annex_invalid_transition' } as const;
const VALIDATION = { ok: false, code: 'common.validation_failed' } as const;

// Strict calendar date YYYY-MM-DD (rejects 2026-02-30); ISO dates compare correctly as strings.
const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const filled = (s: unknown): boolean => typeof s === 'string' && s.trim() !== '';

// Edge check first: an invalid edge is 409 even when fields are also missing (AC-E3.3).
export function checkAnnexTransition(from: AnnexStatus, to: AnnexStatus, f: AnnexFields): AnnexCheck {
  if (!canTransition(from, to)) return INVALID;
  if (to === 'submitted') {
    if (!isDate(f.submittedOn) || !isDate(f.today) || f.submittedOn > f.today) return VALIDATION; // IR3
  } else if (to === 'completed') {
    if (!filled(f.referenceNo) || !isDate(f.completedOn) || !isDate(f.submittedOn) || f.completedOn < f.submittedOn) return VALIDATION; // IR4
  } else if (to === 'rejected') {
    if (!filled(f.note)) return VALIDATION; // IR5
  }
  return { ok: true };
}
