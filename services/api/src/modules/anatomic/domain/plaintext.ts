// C11 plain-text normaliser — 02-TRD §4.6, REQ-SEC-088 (no HTML surface; rendering side escapes). Pure.
// CR/CRLF -> LF; C0 (except TAB/LF) and C1 controls removed; NFC; trailing whitespace trimmed.
// Controls are stripped before NFC so the result is idempotent.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function normalizePlainText(input: string): string {
  return input.replace(/\r\n?/g, '\n').replace(CONTROLS, '').normalize('NFC').trimEnd();
}
