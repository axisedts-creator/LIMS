// Read / final schedule maths (02-TRD §4.1). Pure: `now` is always an argument.
const HOUR_MS = 3_600_000;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR_MS);

// Smallest scheduled slot strictly later than the latest read (or than planting when none); null when exhausted.
export function nextReadDueAt(i: { plantedAt: Date; readScheduleHours: readonly number[]; latestReadObservedAt?: Date | null }): Date | null {
  const floor = (i.latestReadObservedAt ?? i.plantedAt).getTime();
  let best: number | null = null;
  for (const h of i.readScheduleHours) {
    const t = i.plantedAt.getTime() + h * HOUR_MS;
    if (t > floor && (best === null || t < best)) best = t;
  }
  return best === null ? null : new Date(best);
}

export function finalDueAt(i: { plantedAt: Date; finalNoGrowthHours?: number | null; defaultFinalNoGrowthHours: number }): Date {
  return addHours(i.plantedAt, i.finalNoGrowthHours ?? i.defaultFinalNoGrowthHours);
}

export function hoursSincePlanting(plantedAt: Date, observedAt: Date): number {
  return Math.round(((observedAt.getTime() - plantedAt.getTime()) / HOUR_MS) * 100) / 100;
}

export function isReadOverdue(i: { status: string; nextReadDueAt: Date | null; now: Date }): boolean {
  return (i.status === 'incubating' || i.status === 'growth_detected') && i.nextReadDueAt !== null && i.nextReadDueAt.getTime() < i.now.getTime();
}
