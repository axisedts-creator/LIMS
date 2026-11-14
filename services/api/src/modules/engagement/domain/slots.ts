// Slot generation (02-TRD §4.8; 05-SCHEMA slot_templates/blackouts/occupancy; US-EN-12.1, 12.7). Pure; timezone injected.
// localDate 'YYYY-MM-DD'; weekdays ISO 1=Mon..7=Sun; all instants are Date (UTC).

export interface SlotTemplate {
  weekdays: readonly number[];
  startLocal: string; // 'HH:MM'
  endLocal: string; // 'HH:MM'
  slotMinutes: number;
  capacity: number;
  effectiveFrom: string; // inclusive local date
  effectiveTo: string | null; // inclusive local date
}
export interface Blackout { bookingKind: string | null; startsAt: Date; endsAt: Date }
export interface Occupancy { slotStart: Date; capacity: number; booked: number }
export interface Slot { slotStart: Date; slotEnd: Date }
export interface AvailableSlot extends Slot { capacity: number; remaining: number }

const MIN = 60_000;

/** Offset (ms) of `timeZone` from UTC at `instant`. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(instant).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC instant of local wall-clock `minutes` after 00:00 on `localDate` in `timeZone`. */
function localToUtc(localDate: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let t = wall - tzOffsetMs(new Date(wall), timeZone);
  t = wall - tzOffsetMs(new Date(t), timeZone); // second pass settles instants near an offset change
  return new Date(t);
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

const localDateOf = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);

function addDays(localDate: string, n: number): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isoWeekday(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** UTC instant of local midnight (00:00) of the local day that contains `instant` (T-BK1: per-account day cap). */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  return localToUtc(localDateOf(instant, timeZone), 0, timeZone);
}

/** Slots of one template on one local date: t + slot_minutes <= end_local (a partial last slot is dropped). Ascending. */
export function generateSlots(i: { template: SlotTemplate; localDate: string; timeZone: string }): Slot[] {
  const { template: t, localDate, timeZone } = i;
  if (!t.weekdays.includes(isoWeekday(localDate))) return [];
  if (localDate < t.effectiveFrom || (t.effectiveTo !== null && localDate > t.effectiveTo)) return [];
  const end = toMinutes(t.endLocal);
  const out: Slot[] = [];
  for (let s = toMinutes(t.startLocal); s + t.slotMinutes <= end; s += t.slotMinutes) {
    out.push({ slotStart: localToUtc(localDate, s, timeZone), slotEnd: localToUtc(localDate, s + t.slotMinutes, timeZone) });
  }
  return out;
}

export interface AvailableSlotsInput {
  templates: readonly SlotTemplate[];
  blackouts: readonly Blackout[];
  occupancy: readonly Occupancy[];
  bookingKind: string;
  now: Date;
  minLeadMinutes: number;
  horizonDays: number;
  timeZone: string;
  dateFrom: string;
  dateTo: string;
}

/**
 * Bookable slots, ascending. Rules: slot_start >= now + lead (inclusive); slot_start < local midnight of
 * (today + horizonDays); no overlapping blackout (kind NULL or = bookingKind; edges exclusive); remaining > 0.
 */
export function availableSlots(i: AvailableSlotsInput): AvailableSlot[] {
  const earliest = i.now.getTime() + i.minLeadMinutes * MIN;
  const horizon = localToUtc(addDays(localDateOf(i.now, i.timeZone), i.horizonDays), 0, i.timeZone).getTime();
  const blackouts = i.blackouts.filter((b) => b.bookingKind === null || b.bookingKind === i.bookingKind);
  const occ = new Map(i.occupancy.map((o) => [o.slotStart.getTime(), o]));
  const out: AvailableSlot[] = [];
  for (let d = i.dateFrom; d <= i.dateTo; d = addDays(d, 1)) {
    for (const template of i.templates) {
      for (const s of generateSlots({ template, localDate: d, timeZone: i.timeZone })) {
        const start = s.slotStart.getTime();
        if (start < earliest || start >= horizon) continue;
        if (blackouts.some((b) => start < b.endsAt.getTime() && s.slotEnd.getTime() > b.startsAt.getTime())) continue;
        const o = occ.get(start);
        const capacity = o?.capacity ?? template.capacity;
        const remaining = capacity - (o?.booked ?? 0);
        if (remaining > 0) out.push({ ...s, capacity, remaining });
      }
    }
  }
  return out.sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime());
}
