// Order readiness for report (02-TRD §4.7; 03-IC §3.12 + §4.5 fake spec; 08 A13 D-5; PRD AC-16.5, AC-16.6, AC-17.1). Pure: no ports, no clock, no DB.
// Approved set = reportable results with status approved of order tests that are not excluded / outsourced / cancelled (D-5), as `result_id:current_version_no`.
// Complete = >= 1 eligible order test and every eligible order test has >= 1 reportable, non-cancelled result and all of them approved.
// Partial (partialReleaseAllowed only, order not complete) = departments whose eligible tests are all complete and whose own set hash differs from the last emitted one.
// An event is due only when (completeness, set hash) differs from what was last emitted.
import { approvedSetHash, type ApprovedEntry } from '../events/publish.js';

export { approvedSetHash };   // one hash definition: events/publish.ts == the fake LabPort's hashOf

export interface ReadinessOrderTest { id: string; orderItemId: string; departmentId: string; status: string }
export interface ReadinessResult { id: string; orderTestId: string; status: string; isReportable: boolean; currentVersionNo: number }
export interface ReadinessInput {
  orderTests: readonly ReadinessOrderTest[]; results: readonly ReadinessResult[]; partialReleaseAllowed: boolean;
  last?: { hash?: string | undefined; completeness?: 'complete' | 'partial' | undefined; departmentHashes?: Readonly<Record<string, string>> | undefined };
}
export interface ReadinessDecision {
  completeness: 'complete' | 'partial'; orderItemIds: string[]; departmentIds?: string[]; approvedSet: ApprovedEntry[]; approvedSetHash: string;
  containsAmendment: boolean; departmentHashes: Record<string, string>;
}

const INELIGIBLE = new Set(['excluded', 'outsourced', 'cancelled']);   // D-5: a cancelled order test never blocks nor contributes
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

export function evaluateReadiness(i: ReadinessInput): ReadinessDecision | null {
  const tests = i.orderTests.filter((t) => !INELIGIBLE.has(t.status));
  const reportable = (testId: string) => i.results.filter((r) => r.orderTestId === testId && r.isReportable && r.status !== 'cancelled');
  const done = (t: ReadinessOrderTest) => { const rs = reportable(t.id); return rs.length > 0 && rs.every((r) => r.status === 'approved'); };
  const setOf = (ts: readonly ReadinessOrderTest[]): ApprovedEntry[] =>
    ts.flatMap((t) => reportable(t.id).filter((r) => r.status === 'approved').map((r) => ({ result_id: r.id, version_no: r.currentVersionNo })));
  const build = (completeness: 'complete' | 'partial', ts: readonly ReadinessOrderTest[], departmentHashes: Record<string, string>): ReadinessDecision => {
    const approvedSet = setOf(ts);
    return {
      completeness, orderItemIds: unique(ts.map((t) => t.orderItemId)), ...(completeness === 'partial' ? { departmentIds: unique(ts.map((t) => t.departmentId)) } : {}),
      approvedSet, approvedSetHash: approvedSetHash(approvedSet), containsAmendment: approvedSet.some((e) => e.version_no >= 2), departmentHashes,
    };
  };

  if (tests.length === 0) return null;
  const departments = unique(tests.map((t) => t.departmentId));
  const ready = departments.filter((d) => tests.filter((t) => t.departmentId === d).every(done));
  const departmentHashes: Record<string, string> = Object.fromEntries(ready.map((d) => [d, approvedSetHash(setOf(tests.filter((t) => t.departmentId === d)))]));
  const last = i.last ?? {};

  if (tests.every(done)) {
    const d = build('complete', tests, departmentHashes);
    return last.completeness === 'complete' && last.hash === d.approvedSetHash ? null : d;
  }
  if (!i.partialReleaseAllowed) return null;
  const fresh = ready.filter((d) => departmentHashes[d] !== last.departmentHashes?.[d]);
  if (fresh.length === 0) return null;
  return build('partial', tests.filter((t) => fresh.includes(t.departmentId)), departmentHashes);
}
