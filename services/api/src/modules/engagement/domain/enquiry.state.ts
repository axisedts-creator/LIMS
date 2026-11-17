// Enquiry state machine (03-APP-FLOW §4.5; 05-SCHEMA enquiries__status__ck). Pure.

export const ENQUIRY_STATUSES = ['open', 'answered', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

const NEXT: Readonly<Record<EnquiryStatus, readonly EnquiryStatus[]>> = {
  open: ['answered', 'closed'],
  answered: ['open', 'closed'],
  closed: [],
};

export function canTransition(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: EnquiryStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
