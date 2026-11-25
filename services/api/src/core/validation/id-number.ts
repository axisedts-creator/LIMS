// T0B-PARTYSET-1 (LD-321; 07-SECURITY personal / government ids): the ONE place that masks and checks a government ID number
// (PAN = partners.tax_number / catalog.credit_parties.pan, national_id_number on partners and doctors). Every read, list, export and log line
// uses maskIdNumber; the full value leaves only through revealPartyIdNumber (partners.party_id_number.read, audited).
// Format: length and characters only, 1..32 of letters, digits and '-' (the lab accountant confirms the exact PAN / national id formats; notes).

export const ID_NUMBER_FIELDS = ['tax_number', 'national_id_number'] as const;
export type IdNumberField = (typeof ID_NUMBER_FIELDS)[number];

const ID_NUMBER = /^[A-Za-z0-9-]{1,32}$/;
export const isIdNumber = (v: unknown): v is string => typeof v === 'string' && ID_NUMBER.test(v);

/** '*' x (length - 4) + the last four characters; four characters or fewer are fully starred (contract examples ********0001). */
export function maskIdNumber(v: string): string {
  return v.length <= 4 ? '*'.repeat(v.length) : '*'.repeat(v.length - 4) + v.slice(-4);
}
/** null / undefined / '' stay absent: a party without the number never shows an empty mask */
export const maskedOrAbsent = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? maskIdNumber(v) : undefined);
