// C11.T-26 — performance targets + seed plan for the nightly scenario/load script.
// Source of truth: 02-TRD §11 table (p95, ms) and derivation (≤25 cases/day/lab at 1×; 10× = 250). A guard test
// (t26.e2e.test.ts) parses the TRD and fails if TARGETS_MS drift from it.
export const TARGETS_MS = {
  listAnatomicCases: 250,
  getAnatomicCase: 250,
  lookupAnatomicObject: 100,
  saveAnatomicGross: 150, // "draft/gross saves"
  saveAnatomicReportDraft: 150,
  signOutAnatomicCase: 600, // ≤ 5 items
  consumerPerEvent: 300, // "consumer per event"; handling ms returned by the receive_specimen hook
  imageUploadAccept: 2000, // "image upload accept (15 MB)" ≤ 2 s excluding network (I1 uploadAnatomicImage)
  imageProcessing: 30_000, // "processing p95 ≤ 30 s": upload accepted → image no longer `processing`
} as const;
export type Op = keyof typeof TARGETS_MS;

export const SCALES = [1, 10] as const;
/** Reference dataset: 02-TRD §11 — ≤ 25 cases/day/lab at 1×; images ≤ 10/case. */
export const seedPlan = (scale: number) => ({ casesPerDay: 25 * scale, maxImagesPerCase: 10, scale });
/** Sequential full-lifecycle runs per nightly pass (= sign-out samples); enough that p95 is not a single point. */
export const lifecycleRuns = (scale: number) => 20 * scale;

/** Nearest-rank percentile (p in (0,100]). Throws on empty input so a missing measurement can never pass. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error('percentile: no samples');
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export class Timings {
  private m = new Map<Op, number[]>();
  add(op: Op, ms: number) {
    this.m.set(op, [...(this.m.get(op) ?? []), ms]);
  }
  p95(op: Op) {
    return percentile(this.m.get(op) ?? [], 95);
  }
  count(op: Op) {
    return this.m.get(op)?.length ?? 0;
  }
  /** One line per op, for the nightly log. */
  report() {
    return [...this.m.keys()].map((o) => `${o} n=${this.count(o)} p95=${this.p95(o).toFixed(0)}ms (target ${TARGETS_MS[o]})`).join('\n');
  }
}
