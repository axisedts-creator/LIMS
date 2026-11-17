// C11 block/slide labels — 02-TRD §4.3. Pure. Any bad input or label > 32 chars / outside [A-Z0-9-] -> RangeError.
const MAX_LABEL = 32;
const ACC = /^[A-Z0-9-]+$/;
const LETTER = /^[A-Z]+$/;

function seq(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be an integer >= 1`);
  return n;
}
function check(label: string): string {
  if (label.length > MAX_LABEL || !ACC.test(label)) throw new RangeError('label invalid');
  return label;
}
function acc(a: string, l: string): void {
  if (!ACC.test(a)) throw new RangeError('accession_no invalid');
  if (!LETTER.test(l)) throw new RangeError('part letter invalid');
}

/** 1-based bijective base-26: 1→A … 26→Z, 27→AA, 52→AZ, 53→BA. */
export function partLetter(n: number): string {
  seq(n, 'part');
  let s = '';
  for (; n > 0; n = Math.floor(n / 26)) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

export function blockLabel(accessionNo: string, letter: string, blockSeq: number): string {
  acc(accessionNo, letter);
  return check(`${accessionNo}-${letter}${seq(blockSeq, 'block seq')}`);
}

export function slideLabelFromBlock(block: string, slideSeq: number): string {
  check(block);
  return check(`${block}-${seq(slideSeq, 'slide seq')}`);
}

export function slideLabelFromPart(accessionNo: string, letter: string, slideSeq: number): string {
  acc(accessionNo, letter);
  return check(`${accessionNo}-${letter}-${seq(slideSeq, 'slide seq')}`);
}
