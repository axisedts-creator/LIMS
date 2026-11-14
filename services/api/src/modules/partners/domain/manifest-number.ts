// C13 T04 — manifest number MF{yy}{seq:6} (03-APP-FLOW §4.1 M1; DB check ^MF[0-9]{8}$). Counter allocation is T08.

/** Two-digit A.D. year in the tenant timezone. Throws RangeError on an invalid timezone (never falls back to UTC). */
export function manifestYy(now: Date, timeZone: string): string {
  const year = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now);
  return year.slice(-2).padStart(2, '0');
}

export function formatManifestNo(yy: string, seq: number): string {
  if (!/^[0-9]{2}$/.test(yy)) throw new RangeError('manifest yy must be two digits');
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) throw new RangeError('manifest seq must be an integer 1..999999');
  return `MF${yy}${String(seq).padStart(6, '0')}`;
}
