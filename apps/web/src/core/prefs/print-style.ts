// T0D-PRINTCFG-1 done_when (4) (LD-316): the last invoice print style, remembered per browser. A UI preference only (same pattern as density.ts):
// no patient, invoice or user data; the value is "full" or "plain_bw". Kept out of billing UI code, which never touches web storage (BL-T20 privacy).
// Storage is untrusted: anything but an exact known value, or storage that throws, reads "full".
export type PrintStyle = 'full' | 'plain_bw';

const KEY = 'lims.billing.invoice_print_style';

export function readPrintStyle(): PrintStyle {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'plain_bw' ? 'plain_bw' : 'full';
  } catch {
    return 'full';
  }
}

export function writePrintStyle(s: PrintStyle): void {
  try {
    window.localStorage.setItem(KEY, s);
  } catch {
    // quota or blocked storage: the choice still applies to this print
  }
}
