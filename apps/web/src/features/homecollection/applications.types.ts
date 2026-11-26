// PHLEBO-UI-FULL-1: phlebotomist applications, as plain JSON for client components.
export interface ApplicationDocument { id: string; kind: string; file_name: string; content_type: string; byte_size: number }
export interface ApplicationRow {
  id: string; version: number; status: string;
  full_name: string; phone_e164: string; email: string; area: string;
  employment_type: string; shift_count: string; day_slots: string[];
  submitted_at: string; decided_at: string; decided_by_display: string; decision_note: string;
  documents: ApplicationDocument[];
}
export const DOCUMENT_KIND: Record<string, string> = {
  licence: 'Licence or council registration', training_certificate: 'Training certificate', identity: 'Citizenship or ID', photo: 'Photo',
};
export const DAY_SLOT: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
export const APPLICATION_STATUS: Record<string, readonly ['info' | 'success' | 'danger' | 'neutral', string]> = {
  submitted: ['info', 'Waiting for review'], approved: ['success', 'Approved'], rejected: ['danger', 'Rejected'],
};
/** "Part time · double shift · Morning, Evening" */
export function workPattern(a: { employment_type: string; shift_count: string; day_slots: readonly string[] }): string {
  if (a.employment_type !== 'part_time') return 'Full time';
  return ['Part time', a.shift_count === 'double' ? 'double shift' : 'single shift', a.day_slots.map((s) => DAY_SLOT[s] ?? s).join(', ')].filter(Boolean).join(' · ');
}
