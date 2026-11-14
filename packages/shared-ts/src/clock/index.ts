// @lims/shared-ts/clock (02-TRD §3.1). IsoUtc = 2026-11-05T04:15:00.000Z (IC §2.1).

/** IC §4.1 IsoUtc. [CONV] local brand (as uuidv7) until `@lims/contracts/ports/common` resolves at runtime. */
export type IsoUtc = string & { readonly __brand: 'IsoUtc' };

export interface Clock { now(): IsoUtc }

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function toIsoUtc(d: Date): IsoUtc {
  if (Number.isNaN(d.getTime())) throw new RangeError('toIsoUtc: invalid Date');
  return d.toISOString() as IsoUtc;
}

export const systemClock: Clock = { now: () => toIsoUtc(new Date()) };

export function fixedClock(iso: string): Clock {
  const d = new Date(iso);
  if (!ISO_UTC.test(iso) || Number.isNaN(d.getTime()) || d.toISOString() !== iso) throw new RangeError('fixedClock: not an IsoUtc instant');
  const v = iso as IsoUtc;
  return { now: () => v };
}
