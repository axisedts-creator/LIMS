// Patient stage mapping (02-TRD §4.5; 03-IC §10.1 specimen statuses). Pure.

export const SPECIMEN_STATUSES = [
  'ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted',
  'verified', 'approved', 'reported', 'stored', 'rejected', 'recollection_ordered', 'discarded',
] as const;
export type SpecimenStatus = (typeof SPECIMEN_STATUSES)[number];

export type PatientStage =
  | 'registered' | 'sample_collected' | 'in_lab' | 'partial_report' | 'report_ready' | 'recollection_needed' | 'cancelled';

type SpecimenStage = 'registered' | 'sample_collected' | 'in_lab' | 'recollection_needed';

const SPECIMEN_STAGE: Readonly<Record<SpecimenStatus, SpecimenStage | null>> = {
  ordered: 'registered',
  collected: 'sample_collected',
  in_transit: 'sample_collected',
  received: 'in_lab',
  aliquoted: 'in_lab',
  in_process: 'in_lab',
  resulted: 'in_lab',
  verified: 'in_lab',
  approved: 'in_lab',
  reported: 'in_lab',
  stored: 'in_lab',
  rejected: 'in_lab', // 'recollection_needed' when recollectionRequired
  recollection_ordered: 'recollection_needed',
  discarded: null, // ignored for the order stage
};

/** null = ignored. */
export function specimenStage(status: SpecimenStatus, opts?: { recollectionRequired?: boolean | undefined }): SpecimenStage | null {
  if (status === 'rejected' && opts?.recollectionRequired === true) return 'recollection_needed';
  return Object.hasOwn(SPECIMEN_STAGE, status) ? SPECIMEN_STAGE[status] : null;
}

const RANK: Readonly<Record<SpecimenStage, number>> = { registered: 0, sample_collected: 1, in_lab: 2, recollection_needed: 3 };

export interface OrderStageInput {
  orderStatus: string;
  specimens: ReadonlyArray<{ status: SpecimenStatus; recollectionRequired?: boolean | undefined }>;
  reports: ReadonlyArray<{ kind: string; status: string }>;
}

const FINAL_KINDS = new Set(['final', 'amended', 'addendum']);
const PARTIAL_KINDS = new Set(['partial', 'preliminary']);

/** Priority: cancelled > report_ready > partial_report > recollection_needed > in_lab > sample_collected > registered. */
export function orderStage(i: OrderStageInput): PatientStage {
  if (i.orderStatus === 'cancelled') return 'cancelled';
  const valid = i.reports.filter((r) => r.status === 'valid');
  if (valid.some((r) => FINAL_KINDS.has(r.kind))) return 'report_ready';
  if (valid.some((r) => PARTIAL_KINDS.has(r.kind))) return 'partial_report';
  let best: SpecimenStage = 'registered';
  for (const s of i.specimens) {
    const st = specimenStage(s.status, { recollectionRequired: s.recollectionRequired });
    if (st !== null && RANK[st] > RANK[best]) best = st;
  }
  return best;
}

/** payment_due flag (not a stage): balance_due_paisa > 0 AND release_basis = 'due_outstanding'. */
export const isPaymentDue = (i: { balanceDuePaisa: number; releaseBasis: string | null }): boolean =>
  i.balanceDuePaisa > 0 && i.releaseBasis === 'due_outstanding';
