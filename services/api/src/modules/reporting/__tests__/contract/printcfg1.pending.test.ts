// T0C-PRINTCFG-1 (LD-316, LD-325(b), LD-335) — the five print profile / signer profile operations must not break module boot and must be declared pending until T0B-PRINTCFG-1:
// every operationId of reporting.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1); every pending id is a real operationId.
// The reporting manifest fills every spec operation with a 501 stub, so "has a handler" alone proves nothing: LD-325(b) says a contract task adds its new ids to pendingOperations of its module index.ts
// and "nothing else"; the T0B-PRINTCFG-1 handler task removes the ids it implements. This test stays green on both sides of that move (an id with a real handler need not be pending).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listPrintProfiles', 'upsertPrintProfile', 'previewPrintProfile', 'listSignatoryProfiles', 'upsertSignatoryProfile'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

// the T01 scaffold stub answers { status: 501 } and ignores its input; a real handler does something else (or throws on an empty context)
const isStub = async (id: string): Promise<boolean> => {
  try { return JSON.stringify(await (manifest.handlers[id] as any)({})) === '{"status":501}'; } catch { return false; }
};

describe('T0C-PRINTCFG-1: reporting manifest covers the new operations (handler or pending)', () => {
  it('the five print profile operations are in the spec', () => {
    for (const id of NEW_OPS) expect(specIds, id).toContain(id);
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
  it('each of the five ids is listed pending while it is still a 501 stub (LD-325(b)); an id with a real handler needs no entry', async () => {
    for (const id of NEW_OPS) {
      expect(handlerIds, `${id} has a manifest entry`).toContain(id);
      if (await isStub(id)) expect(pending, `${id} is a stub and must be in pendingOperations of the reporting module`).toContain(id);
    }
  });
  it('nothing else was made pending to hide a missing handler: only the five new ids may be pending in reporting', () => {
    expect(pending.filter((id) => !NEW_OPS.includes(id)), 'only the print profile operations may be pending in reporting').toEqual([]);
  });
  it('the older print and settings operations keep their handlers (no operation was moved to pending)', () => {
    for (const id of ['createReportPrint', 'getReportPrint', 'downloadReportPrintPdf', 'createBulkPrint', 'getReportingSettings', 'updateReportingSettings', 'getReportTemplate', 'previewReportTemplate']) {
      expect(handlerIds, `${id} keeps its handler`).toContain(id);
      expect(pending, `${id} must not be pending`).not.toContain(id);
    }
  });
});
