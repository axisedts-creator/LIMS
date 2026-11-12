// AST raw value grammar (02-TRD §4.3). Pure; raw_value is returned exactly as entered.
import { compareDecimal } from './decimal.js';

export type AstMethod = 'mic' | 'zone_diameter' | 'other';
export type AstQualifier = '<=' | '>=' | '<' | '>' | '=';
export interface AstValue {
  raw_value: string;
  raw_qualifier?: AstQualifier;
  raw_numeric?: string;
  unit_code?: 'ug_ml' | 'mm';
}
export type AstParseResult = { ok: true; value: AstValue } | { ok: false; code: 'micro.ast_value_invalid' };

const MAX_LEN = 32;
const INVALID: AstParseResult = { ok: false, code: 'micro.ast_value_invalid' };
const QUALIFIER = { '<=': '<=', '≤': '<=', '>=': '>=', '≥': '>=', '<': '<', '>': '>', '=': '=' } as const;

// Input is capped at 32 chars before any regex runs, so no backtracking risk.
const MIC = /^(<=|>=|<|>|=|≤|≥)?\s*([0-9]{1,6}(?:\.[0-9]{1,6})?)(?:\s*\/\s*[0-9]{1,6}(?:\.[0-9]{1,6})?)?$/;
const ZONE = /^(<=|>=|<|>|=|≤|≥)?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?)$/;

export function parseAstValue(input: string, method: AstMethod): AstParseResult {
  if (typeof input !== 'string' || input.length > MAX_LEN) return INVALID;
  const s = input.normalize('NFC').trim();
  if (s.length === 0) return INVALID;
  if (method === 'other') return { ok: true, value: { raw_value: input } };

  const m = (method === 'mic' ? MIC : method === 'zone_diameter' ? ZONE : null)?.exec(s);
  const raw_numeric = m?.[2];
  if (!m || raw_numeric === undefined) return INVALID; // group 2 is mandatory in both grammars
  if (method === 'zone_diameter' && compareDecimal(raw_numeric, '100') > 0) return INVALID;
  return {
    ok: true,
    value: {
      raw_value: input,
      raw_qualifier: m[1] ? QUALIFIER[m[1] as keyof typeof QUALIFIER] : '=',
      raw_numeric,
      unit_code: method === 'mic' ? 'ug_ml' : 'mm',
    },
  };
}
