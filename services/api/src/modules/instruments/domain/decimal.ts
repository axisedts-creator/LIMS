// value_raw -> DecimalString (03-IC §2.1 `^-?[0-9]{1,12}(\.[0-9]{1,6})?$`) or undefined. String-only: no float round-trip.
const DECIMAL_STRING = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;

/** [CONV] Surrounding whitespace (instrument padding, CR/LF) is trimmed; anything else that does not match is undefined. */
export function toDecimalString(valueRaw: string): string | undefined {
  if (typeof valueRaw !== 'string') return undefined;
  const v = valueRaw.trim();
  return DECIMAL_STRING.test(v) ? v : undefined;
}
