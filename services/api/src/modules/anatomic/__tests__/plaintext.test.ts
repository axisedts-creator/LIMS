// C11 T-02 — plain-text normaliser (02-TRD §4.6; REQ-SEC-088: no HTML surface). Pure.
// Rule: NFC; CR/LF and lone CR → LF; control characters other than LF/TAB removed; trailing whitespace trimmed.
// SEAM: ../domain/plaintext.ts  export function normalizePlainText(input: string): string
//   (TRD does not say per-line vs whole-text trim: only whole-text trailing trim is asserted here; leading whitespace is preserved.)
// Fails now: ../domain/plaintext.js does not exist.
import { describe, expect, it } from 'vitest';
import { normalizePlainText as n } from '../domain/plaintext.js';

describe('C11 plaintext — NFC', () => {
  it('composes e + U+0301 into é (U+00E9)', () => expect(n('é')).toBe('é'));
  it('already-NFC text is unchanged (Devanagari, Latin)', () => {
    expect(n('क्षत्रिय')).toBe('क्षत्रिय'.normalize('NFC'));
    expect(n('Müller')).toBe('Müller');
  });
  it('NFC, not NFKC: compatibility chars are kept (ﬁ ligature, ² superscript)', () => {
    expect(n('ﬁ')).toBe('ﬁ');
    expect(n('x²')).toBe('x²');
  });
});

describe('C11 plaintext — line endings', () => {
  it('CRLF → LF', () => expect(n('a\r\nb\r\nc')).toBe('a\nb\nc'));
  it('lone CR → LF', () => expect(n('a\rb')).toBe('a\nb'));
  it('LF is kept; mixed endings all become LF; no \\r survives', () => {
    const out = n('a\nb\r\nc\rd\r\n\r\ne');
    expect(out).toBe('a\nb\nc\nd\n\ne');
    expect(out).not.toContain('\r');
  });
  it('blank lines inside the text are preserved', () => expect(n('a\n\n\nb')).toBe('a\n\n\nb'));
});

describe('C11 plaintext — control characters', () => {
  it('TAB is kept', () => expect(n('a\tb')).toBe('a\tb'));
  it.each([0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f, 0x80, 0x9f])('U+%s is removed', (cp) => {
    expect(n(`a${String.fromCharCode(cp)}b`)).toBe('ab');
  });
  it('every C0 control except LF/TAB (CR becomes LF) is stripped from a mixed string', () => {
    let s = 'x';
    for (let c = 0; c < 0x20; c++) if (c !== 0x0a && c !== 0x09 && c !== 0x0d) s += String.fromCharCode(c);
    expect(n(s + 'y')).toBe('xy');
  });
  it('an ANSI escape sequence loses its ESC byte', () => expect(n('\u001b[31mred')).toBe('[31mred'));
  it('NUL cannot smuggle a tag past: "<scr\\u0000ipt>" stays plain text (no HTML interpretation)', () => {
    expect(n('<scr\u0000ipt>')).toBe('<script>');
  });
});

describe('C11 plaintext — trailing whitespace', () => {
  it('trailing spaces, tabs and newlines are trimmed', () => expect(n('abc  \n\t \n')).toBe('abc'));
  it('leading whitespace is preserved', () => expect(n('  abc')).toBe('  abc'));
  it('interior whitespace is preserved', () => expect(n('a  b\n  c')).toBe('a  b\n  c'));
  it('control chars next to trailing space are removed first, then trimmed', () => expect(n('abc \u0000')).toBe('abc'));
  it('whitespace-only → empty string', () => {
    expect(n('   \r\n\t ')).toBe('');
    expect(n('')).toBe('');
  });
});

describe('C11 plaintext — not HTML (REQ-SEC-088)', () => {
  it('markup is kept literally, not sanitised or escaped (rendering side escapes)', () => {
    expect(n('<b>x</b> & <script>alert(1)</script>')).toBe('<b>x</b> & <script>alert(1)</script>');
  });
});

describe('C11 plaintext — properties', () => {
  it('idempotent', () => {
    for (const s of ['é\r\nx \u0000\t', 'a\rb\n\n', '\u001b[0m', 'क्षत्रिय  ']) expect(n(n(s))).toBe(n(s));
  });
  it('large input (1 MB) normalises quickly', () => {
    const t0 = Date.now();
    const out = n(('line with é and \u0000 ctl\r\n').repeat(50_000));
    expect(out.length).toBe(50_000 * 21 - 1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
