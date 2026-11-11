// AN-T16 shared table (not a test file): schedule names and whether `label_text` (08 A4.3/A5.4) + the module's own rules accept them.
// Used by schedule.test.ts (service validator) and repository/__tests__/schedules.name_ck.test.ts (DB CHECK schedules__name__ck, 05-SCHEMA §4): both must agree on every row.
// Rules (02-TRD §9.6 step 6): 1–80 characters; `://` and `www.` rejected case-insensitively; `@` rejected; a run of 7+ digits rejected [CONV].
export const VALID_NAMES: readonly string[] = [
  'Daily MIS',
  'a'.repeat(80),                         // 80 ok
  'द'.repeat(80),                    // 80 Devanagari characters (length counts characters, not bytes)
  'Weekly P&L (Q3 2082)',
  'Ref 123456',                           // 6 digits ok
  'www',                                  // no dot
  'Wwwx',
  'http:/x',                              // one slash
  'a.b',
  'x',                                    // 1 ok
];
export const INVALID_NAMES: readonly string[] = [
  '',
  'a'.repeat(81),                         // 81 rejected
  'द'.repeat(81),
  'https://x',
  'HTTPS://X',
  'ftp://a',
  'WWW.x',
  'www.example.com',
  'Visit Www.Foo',
  'awww.b',
  'see me@lab',
  '@',
  '9800000000',                           // phone-like
  '1234567',                              // exactly 7 digits
  'Ref 98765432 now',
  `${'x'.repeat(40)}www.${'y'.repeat(10)}`,
];
