// AST raw value grammar (02-TRD §4.3, AC-06.2) — a copy of the server rule so the row can say "Enter a value like …" before anything is sent. The value is NEVER
// parsed or normalised for sending: the qualifier stays in the text ("≤0.25" is not 0.25 — 06-GLOSSARY "MIC"); the API re-checks everything.
import type { AstMethod } from '../../server/types';

export const RAW_VALUE_MESSAGE = 'Enter a value like 0.25, <=0.25 or 18.';

const MIC = /^(?:<=|>=|≤|≥|<|>|=)?\s*([0-9]{1,6}(?:\.[0-9]{1,6})?)(?:\s*\/\s*[0-9]{1,6}(?:\.[0-9]{1,6})?)?$/;
const ZONE = /^(?:<=|>=|≤|≥|<|>|=)?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?)$/;

/** true = acceptable (an empty value is acceptable: a pending row stays pending). */
export function isValidRawValue(method: AstMethod, raw: string): boolean {
  const t = raw.normalize('NFC').trim();
  if (t === '') return true;
  if (t.length > 32) return false;
  if (method === 'other') return true;
  if (method === 'mic') return MIC.test(t);
  const m = ZONE.exec(t);
  return m !== null && Number(m[1]) <= 100;
}
