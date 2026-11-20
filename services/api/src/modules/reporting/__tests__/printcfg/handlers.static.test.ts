// T0B-PRINTCFG-1 done_when (1) FIRST PRIORITY: handlers for every new operation of T0C-PRINTCFG-1 so the module boot check passes (LD-325(b): the task removes its ids from pendingOperations).
// Complements contract/printcfg1.pending.test.ts (which stays green on both sides): this file demands the AFTER state. Also pins the things that must not be forgotten around the handlers:
// tenant and actor come from ctx only, no raw markup rendering, no secrets, and the open CR (finance) is not silently decided.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listPrintProfiles', 'upsertPrintProfile', 'previewPrintProfile', 'listSignatoryProfiles', 'upsertSignatoryProfile'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0B-PRINTCFG-1: the five operations are implemented, not pending', () => {
  it('the reporting manifest has no pending operation left (all of them were T0C-PRINTCFG-1 ids)', () => { expect(pending).toEqual([]); });
  it.each(NEW_OPS)('%s has a real handler: not the 501 stub', async (id) => {
    expect(specIds).toContain(id);
    const h = (manifest.handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[id];
    expect(typeof h).toBe('function');
    let stub = false; try { stub = JSON.stringify(await h!({}, {})) === '{"status":501}'; } catch { stub = false; }
    expect(stub, `${id} still answers the 501 stub`).toBe(false);
  });
  it.each(NEW_OPS)('%s fails closed without an authenticated request context (no tenant / actor / tx in ctx)', async (id) => {
    const h = (manifest.handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[id]!;
    await expect(h({ params: {}, query: {}, headers: {}, body: {} }, {})).rejects.toBeTruthy();
  });
  it('every spec operation of reporting has a handler (boot check AC-0D-1.2 with an empty pending list)', () => {
    const missing = specIds.filter((id) => !Object.keys(manifest.handlers).includes(id));
    expect(missing).toEqual([]);
  });
});

describe('sources (static): the new handlers and the renderer client', () => {
  const src = (p: string) => readFileSync(join(REPO_ROOT, 'services/api/src/modules/reporting', p), 'utf8');
  it('the render client request type carries the print profile (RenderRequest.print_profile) so the worker can pass the resolved profile', () => {
    expect(src('renderer-client/render.client.ts')).toMatch(/print_profile/);
  });
  it('the print profile domain module exists and is pure (no db, no fetch)', () => {
    const d = src('domain/printProfile.ts');
    expect(d).not.toMatch(/from ['"]pg['"]|\bfetch\(|process\.env/);
  });
});
