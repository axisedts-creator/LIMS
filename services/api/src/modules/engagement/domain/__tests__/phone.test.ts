// C16 T-02 phone.ts (02-TRD §4.1/§5 E.164 + allowed_phone_prefixes; 04-UI-UX E.164 ^\+[1-9][0-9]{7,14}$;
// 05-SCHEMA settings__prefixes__ck ^\+[1-9][0-9]{0,3}$; masking "country prefix + ••••• + last 2 digits", 07-SECURITY; 01-PRD US-EN-01.7).
// Assumed API: isE164(s) -> boolean, hasAllowedPrefix(e164, prefixes: string[]) -> boolean, maskPhone(e164) -> string
import { describe, expect, it } from 'vitest';
import { hasAllowedPrefix, isE164, maskPhone } from '../phone.js';

describe('isE164 ^\\+[1-9][0-9]{7,14}$', () => {
  it.each(['+9779812345678', '+12345678', '+123456789012345', '+977981234567'])('accepts %s', (p) => expect(isE164(p)).toBe(true));
  it.each([
    ['7 digits (too short)', '+1234567'],
    ['16 digits (too long)', '+1234567890123456'],
    ['no plus', '9779812345678'],
    ['leading zero country code', '+0779812345678'],
    ['national format', '9812345678'],
    ['00 prefix', '009779812345678'],
    ['spaces', '+977 9812345678'],
    ['dashes', '+977-9812345678'],
    ['letters', '+97798123456ab'],
    ['trailing newline', '+9779812345678\n'],
    ['leading space', ' +9779812345678'],
    ['empty', ''],
    ['double plus', '++9779812345678'],
    ['unicode digits', '+٩٧٧٩٨١٢٣٤٥٦٧٨'],
  ])('rejects %s', (_n, p) => expect(isE164(p)).toBe(false));
  it('rejects non-strings', () => {
    expect(isE164(undefined as never)).toBe(false);
    expect(isE164(9779812345678 as never)).toBe(false);
  });
});

describe('hasAllowedPrefix (tenant setting allowed_phone_prefixes)', () => {
  it('matches only at the start', () => {
    expect(hasAllowedPrefix('+9779812345678', ['+977'])).toBe(true);
    expect(hasAllowedPrefix('+919812345678', ['+977'])).toBe(false);
    expect(hasAllowedPrefix('+9189779812345', ['+977'])).toBe(false);
  });
  it('any of several prefixes; empty list allows nothing', () => {
    expect(hasAllowedPrefix('+919812345678', ['+977', '+91'])).toBe(true);
    expect(hasAllowedPrefix('+9779812345678', [])).toBe(false);
  });
  it('is textual on the whole prefix, not on a shorter digit run', () => {
    expect(hasAllowedPrefix('+9769812345678', ['+977'])).toBe(false);
    expect(hasAllowedPrefix('+97', ['+977'])).toBe(false);
  });
  it('a malformed number is never allowed even if its text starts with the prefix', () => {
    expect(hasAllowedPrefix('+977 981', ['+977'])).toBe(false);
    expect(hasAllowedPrefix('+977', ['+977'])).toBe(false);
  });
});

describe('maskPhone', () => {
  it('country prefix + ••••• + last 2 digits', () => expect(maskPhone('+9779812345642')).toBe('+977•••••42'));
  it('never leaks any middle digit', () => {
    const m = maskPhone('+9779876543210');
    for (const d of '9876543') expect(m.slice(4, -2)).not.toContain(d);
    expect(m.endsWith('10')).toBe(true);
    expect(m).toHaveLength('+977•••••10'.length);
  });
  it('does not contain the full number', () => expect(maskPhone('+9779812345678')).not.toContain('9812345678'));
});
