// T0D-02 — X-Lims-Bff-Key (08 R10, A13 D-32, A19 P-45). Expected API (core/auth/bff-key.ts):
//   createBffKeyVerifier({ staff_web?: string[], partner?: string[], portal?: string[] }): { verify(header): BffKind | undefined; reload(): void }
//   values = key FILE paths per kind; a file holds one key per line (blank lines ignored, surrounding whitespace trimmed);
//   several files / lines per kind = old + new key during the rotation overlap. verify() never throws.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBffKeyVerifier } from '../bff-key.js';
import { tmpFile } from './helpers.js';

const WEB = 'web-key-0123456789abcdef0123456789abcdef0123456789abcdef';
const PARTNER = 'partner-key-0123456789abcdef0123456789abcdef0123456789';
const PORTAL = 'portal-key-0123456789abcdef0123456789abcdef0123456789';
const three = () => createBffKeyVerifier({
  staff_web: [tmpFile(WEB + '\n')], partner: [tmpFile(PARTNER)], portal: [tmpFile(PORTAL + '\r\n')],
});

describe('X-Lims-Bff-Key kinds (D-32, P-45)', () => {
  it('each of the three key files yields its own kind', () => {
    const v = three();
    expect(v.verify(WEB)).toBe('staff_web');
    expect(v.verify(PARTNER)).toBe('partner');
    expect(v.verify(PORTAL)).toBe('portal');
  });
  it('a key of one kind never yields another kind', () => {
    const v = createBffKeyVerifier({ staff_web: [tmpFile(WEB)], partner: [tmpFile(PARTNER)] });
    expect(v.verify(WEB)).toBe('staff_web');
    expect(v.verify(PARTNER)).toBe('partner');
    expect(v.verify(PORTAL)).toBeUndefined(); // portal not configured: its key (or anything) is not valid
  });
  it('a kind with no file configured accepts nothing for that kind', () => {
    const v = createBffKeyVerifier({ staff_web: [tmpFile(WEB)] });
    expect(v.verify(PORTAL)).toBeUndefined();
    expect(v.verify(PARTNER)).toBeUndefined();
  });
});

describe('invalid keys are rejected without throwing', () => {
  const v = three();
  const bad: ReadonlyArray<[string, unknown]> = [
    ['undefined (header absent)', undefined], ['empty string', ''], ['whitespace', '   '], ['null', null],
    ['wrong key', 'x'.repeat(WEB.length)], ['same length, last char changed', WEB.slice(0, -1) + (WEB.endsWith('f') ? '0' : 'f')],
    ['prefix of a real key', WEB.slice(0, 20)], ['real key + suffix', WEB + 'x'], ['real key upper-cased', WEB.toUpperCase()],
    ['two real keys joined (duplicated header)', `${WEB}, ${PARTNER}`], ['array value', [WEB]], ['number', 5],
    ['very long (1 MB)', 'a'.repeat(1_000_000)], ['NUL byte', WEB + '\u0000'], ['key with leading "Bearer "', `Bearer ${WEB}`],
  ];
  it.each(bad)('%s -> undefined', (_n, h) => {
    expect(() => v.verify(h as any)).not.toThrow();
    expect(v.verify(h as any)).toBeUndefined();
  });
  it('an empty key file never makes the empty header valid', () => {
    const e = createBffKeyVerifier({ staff_web: [tmpFile('')], partner: [tmpFile('\n\n  \n')] });
    expect(e.verify('')).toBeUndefined();
    expect(e.verify(undefined)).toBeUndefined();
    expect(e.verify(' ')).toBeUndefined();
  });
});

describe('rotation overlap: old + new key accepted (D-32, P-45)', () => {
  it('two files for one kind: both keys valid, the same kind', () => {
    const v = createBffKeyVerifier({ staff_web: [tmpFile(WEB), tmpFile('web-NEW-key-9876543210fedcba9876543210fedcba98765432')] });
    expect(v.verify(WEB)).toBe('staff_web');
    expect(v.verify('web-NEW-key-9876543210fedcba9876543210fedcba98765432')).toBe('staff_web');
  });
  it('one file with two lines: both keys valid', () => {
    const v = createBffKeyVerifier({ portal: [tmpFile(`${PORTAL}\n\nportal-NEW-key-9876543210fedcba9876543210fedcba9876\n`)] });
    expect(v.verify(PORTAL)).toBe('portal');
    expect(v.verify('portal-NEW-key-9876543210fedcba9876543210fedcba9876')).toBe('portal');
  });
  it('reload() picks up a rotated file without a restart; the retired key stops working after the overlap', () => {
    const f = tmpFile(PORTAL);
    const v = createBffKeyVerifier({ portal: [f] });
    expect(v.verify('portal-NEW')).toBeUndefined();
    writeFileSync(f, `${PORTAL}\nportal-NEW\n`); // overlap window: old + new
    v.reload();
    expect(v.verify(PORTAL)).toBe('portal');
    expect(v.verify('portal-NEW')).toBe('portal');
    writeFileSync(f, 'portal-NEW\n'); // overlap over: only the new key
    v.reload();
    expect(v.verify(PORTAL)).toBeUndefined();
    expect(v.verify('portal-NEW')).toBe('portal');
  });
});

describe('configuration', () => {
  it('a configured key file that does not exist throws at construction (fail fast)', () => {
    expect(() => createBffKeyVerifier({ staff_web: ['/nonexistent/lims/bff.key'] })).toThrow();
  });
  it('never leaks a key: error messages from construction do not contain key material', () => {
    const f = tmpFile(WEB);
    let msg = '';
    try {
      createBffKeyVerifier({ staff_web: [f, '/nonexistent/lims/bff.key'] });
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).not.toContain(WEB);
  });
});
