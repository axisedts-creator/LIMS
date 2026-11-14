// HC-T12: server-wins guards of the push pipeline (03-APP-FLOW §4, TRD §6.3 step 4.4). Pure and IO-free: the sync service loads the facts, this file decides.
// Outcome per mutation: applied | held | rejected (duplicate / not_found are decided by the SELECT step, before any guard). Check order inside a type is the spec's order.
// [CONV] identity_checked / consent_recorded / arrived / not_collected on a CANCELLED visit are facts and stay `applied` (no transition, TRD §6.3 / US-08-4 keeps identity + consent applied);
// visit.completed / visit.failed on a cancelled visit are `visit_closed` (the transition does not exist).
import type { MutationType } from './domain/mutation.js';

export type Outcome = 'applied' | 'held' | 'rejected';
export type FlagKind = 'collected_after_cancel' | 'held_collection' | 'specimen_not_collected' | 'payment_rejected' | 'identity_mismatch';
export interface Verdict { readonly outcome: Outcome; readonly code?: string; readonly flag?: FlagKind }

export const CODE = {
  superseded: 'homecollection.mutation_superseded', notAssigned: 'homecollection.visit_not_assigned', barcode: 'homecollection.barcode_mismatch', closed: 'homecollection.visit_closed',
  invalid: 'common.validation_failed', notFound: 'common.not_found', reused: 'common.idempotency_key_reused',
} as const;
export const HANDOVER_ITEM = { included: 'included', notCollected: 'skipped_not_collected', alreadyHandedOver: 'skipped_already_handed_over' } as const;

const applied = (flag?: FlagKind): Verdict => (flag ? { outcome: 'applied', flag } : { outcome: 'applied' });
const rejected = (code: string, flag?: FlagKind): Verdict => (flag ? { outcome: 'rejected', code, flag } : { outcome: 'rejected', code });
const held = (code: string, flag: FlagKind): Verdict => ({ outcome: 'held', code, flag });

/** One visit_assignments row: `at` = created_at in ms; action assign | reassign set the assignee, unassign | missed clear it. */
export interface AssignmentFact { readonly membershipId: string | null; readonly action: string; readonly at: number }
/** One stored mutation of the visit (identity / consent facts for guard 3). */
export interface PriorFact { readonly type: string; readonly membershipId: string; readonly deviceSeq: number; readonly outcome: string; readonly payload: Record<string, any> }
export interface SpecimenFact { readonly specimenId: string; readonly barcode: string; readonly status: string; readonly isActive: boolean }
export interface GuardInput {
  readonly type: MutationType;
  readonly payload: Record<string, any>;
  /** A = the mutation author (device membership) */
  readonly author: string;
  readonly deviceSeq: number;
  /** corrected capture time t (ms) */
  readonly at: number;
  readonly visit: { readonly status: string; readonly orderId: string | null; readonly assignedMembershipId: string | null };
  /** oldest first */
  readonly assignments: readonly AssignmentFact[];
  readonly prior: readonly PriorFact[];
  /** the lookupSpecimens({orderId}) entry of payload.specimen_id, if any (specimen.collected) */
  readonly specimen?: SpecimenFact | undefined;
  /** an applied collection already exists for the specimen (specimen.collected guard 7) */
  readonly appliedCollectionExists: boolean;
  readonly paymentMethods: ReadonlyArray<{ code?: unknown; requires_reference?: unknown }>;
}

/** asg(t): the assignee of the visit at corrected time t, from the append-only assignment history. */
export function assigneeAt(rows: readonly AssignmentFact[], t: number): string | null {
  let who: string | null = null;
  for (const r of rows) {
    if (r.at > t) break;
    who = r.action === 'assign' || r.action === 'reassign' ? r.membershipId : null;
  }
  return who;
}
const everAssigned = (g: GuardInput): boolean => g.visit.assignedMembershipId === g.author || g.assignments.some((r) => (r.action === 'assign' || r.action === 'reassign') && r.membershipId === g.author);
/** "A ≠ asg(t) and A ≠ current assignee" (arrived, identity, consent, not_collected, completed, failed). */
const notAssigned = (g: GuardInput): boolean => assigneeAt(g.assignments, g.at) !== g.author && g.visit.assignedMembershipId !== g.author;

function fact(g: GuardInput): Verdict {
  if (g.visit.status === 'completed' || g.visit.status === 'failed') return rejected(CODE.closed);
  if (notAssigned(g)) return rejected(CODE.notAssigned);
  return applied(g.type === 'specimen.not_collected' ? 'specimen_not_collected' : undefined);
}

function close(g: GuardInput): Verdict {
  const s = g.visit.status;
  if (s === 'completed' || s === 'failed' || s === 'cancelled') return rejected(CODE.closed);
  if (notAssigned(g)) return rejected(CODE.notAssigned);
  if (s !== 'in_progress' && s !== 'assigned') return rejected(CODE.superseded);   // unassigned: nothing to complete. [CONV] completed from `assigned` = V8 then V9 (the device always sends arrived first; a lost / rejected one must not strand the visit)
  return applied(g.type === 'visit.failed' && g.payload['reason_code'] === 'identity_mismatch' ? 'identity_mismatch' : undefined);
}

const identityOk = (p: PriorFact): boolean => p.type === 'visit.identity_checked' && p.payload['name_check'] === 'matches' && p.payload['second_check'] === 'matches';
const consentOk = (p: PriorFact): boolean => p.type === 'visit.consent_recorded' && p.payload['given'] === true;

/** specimen.collected: the 7 ordered checks. */
function collected(g: GuardInput): Verdict {
  const s = g.visit.status;
  if (s === 'cancelled') return held(CODE.superseded, 'collected_after_cancel');                                   // (1)
  if (s === 'completed' || s === 'failed') return held(CODE.superseded, 'held_collection');
  if (assigneeAt(g.assignments, g.at) !== g.author) return held(CODE.notAssigned, 'held_collection');             // (2)
  const mine = g.prior.filter((p) => p.membershipId === g.author && p.outcome === 'applied' && p.deviceSeq < g.deviceSeq);
  if (!mine.some(identityOk) || !mine.some(consentOk)) return held(CODE.superseded, 'held_collection');          // (3) both, applied, earlier in device_seq
  if (!g.specimen) return rejected(CODE.notFound);                                                               // (4)
  if (g.specimen.status !== 'ordered' || !g.specimen.isActive) return held(CODE.superseded, 'held_collection');   // (5)
  if (g.payload['scanned_barcode'] !== g.specimen.barcode) return held(CODE.barcode, 'held_collection');         // (6)
  if (g.appliedCollectionExists) return held(CODE.superseded, 'held_collection');                                // (7)
  return applied();
}

/** payment.captured: applied even on a cancelled / closed visit (D-PAY). */
function payment(g: GuardInput): Verdict {
  if (!g.visit.orderId || g.visit.orderId !== g.payload['order_id']) return rejected(CODE.invalid);
  if (!everAssigned(g)) return rejected(CODE.notAssigned, 'payment_rejected');
  const method = g.paymentMethods.find((m) => m.code === g.payload['payment_method_code']);
  if (!method || (method.requires_reference === true && typeof g.payload['reference'] !== 'string')) return rejected(CODE.invalid);
  return applied();
}

export function decide(g: GuardInput): Verdict {
  switch (g.type) {
    case 'visit.arrived': case 'visit.identity_checked': case 'visit.consent_recorded': case 'specimen.not_collected': return fact(g);
    case 'specimen.collected': return collected(g);
    case 'payment.captured': return payment(g);
    case 'visit.completed': case 'visit.failed': return close(g);
    default: return rejected(CODE.invalid);   // handover.recorded is decided by decideHandover
  }
}

// ---- handover.recorded ----
export interface HandoverItemFact { readonly specimenId: string; readonly outcome: string; readonly collection?: Record<string, any> }

/** Per distinct specimen: an applied collection by A not yet in a handover -> included; else the per-item skip (a held / foreign collection is "not collected by A"). */
export function sortHandoverItems(specimenIds: readonly string[], author: string, appliedBySpecimen: ReadonlyMap<string, Record<string, any>>, handedOver: ReadonlySet<string>): HandoverItemFact[] {
  return [...new Set(specimenIds)].map((specimenId) => {
    const c = appliedBySpecimen.get(specimenId);
    if (!c || c['collected_by_membership_id'] !== author) return { specimenId, outcome: HANDOVER_ITEM.notCollected };
    if (handedOver.has(c['id'])) return { specimenId, outcome: HANDOVER_ITEM.alreadyHandedOver };
    return { specimenId, outcome: HANDOVER_ITEM.included, collection: c };
  });
}

/** 0 included, or the included collections span more than one centre -> rejected validation_failed (centre = that one centre, or undefined). */
export function decideHandover(items: readonly HandoverItemFact[]): { verdict: Verdict; centreId?: string } {
  const inc = items.filter((i) => i.outcome === HANDOVER_ITEM.included);
  const centres = [...new Set(inc.map((i) => i.collection!['centre_id'] as string))];
  if (inc.length === 0 || centres.length !== 1) return { verdict: rejected(CODE.invalid), ...(centres[0] ? { centreId: centres[0] } : {}) };
  return { verdict: applied(), centreId: centres[0]! };
}
