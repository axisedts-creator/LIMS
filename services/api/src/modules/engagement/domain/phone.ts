// Phone helpers (02-TRD §4.1/§5; 04-UI-UX E.164 ^\+[1-9][0-9]{7,14}$; 07-SECURITY masking). Pure.
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

export const isE164 = (s: unknown): s is string => typeof s === 'string' && E164_RE.test(s);

/** Textual prefix match on a well-formed number against tenant `allowed_phone_prefixes`. */
export const hasAllowedPrefix = (e164: string, prefixes: readonly string[]): boolean =>
  isE164(e164) && prefixes.some((p) => e164.startsWith(p));

/** "country prefix + ••••• + last 2 digits". [CONV] prefix = '+' and first 3 digits (+977); no per-country table. */
export const maskPhone = (e164: string): string => `${e164.slice(0, 4)}•••••${e164.slice(-2)}`;
