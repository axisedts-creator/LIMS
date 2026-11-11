// FD-T12 static/wiring checks (no DB): the five consumer files + flags.service exist, export the TRD §3.3 handler names, are registered in the frontdesk worker manifest under their event types
// (02-TRD §3.3, §8.2), open no transaction of their own (the C0 consumer wrapper's job tx is ctx.tx), and the earlier frontdesk tasks are untouched.
// Synthetic data only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPORT_OF, FILE_OF, TYPES, handlerOf, type Kind } from './names.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', '..');
const CONSUMERS = join(ROOT, 'services', 'worker', 'src', 'jobs', 'frontdesk', 'consumers');
const kinds = Object.keys(FILE_OF) as Kind[];
const src = (k: Kind) => readFileSync(join(CONSUMERS, `${FILE_OF[k]}.ts`), 'utf8');

describe('FD-T12 files', () => {
  it.each(kinds)('%s consumer file exists and exports its handler', async (k) => {
    expect(existsSync(join(CONSUMERS, `${FILE_OF[k]}.ts`))).toBe(true);
    expect(src(k)).toMatch(new RegExp(`export\\s+(async\\s+function|const)\\s+${EXPORT_OF[k]}\\b`));
  });
  it('service/flags.service.ts exists (order flags: recollection, booking review — 02-TRD §3.1)', () => {
    expect(existsSync(join(ROOT, 'services', 'api', 'src', 'modules', 'frontdesk', 'service', 'flags.service.ts'))).toBe(true);
  });
  it.each(kinds)('%s consumer opens no transaction and no connection of its own (ctx.tx is the job tx; 02-TRD §7.3)', (k) => {
    const s = src(k);
    expect(s).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\.connect\(|new\s+(pg\.)?Pool\b|from\s+['"]pg['"]|db\.tx\(/);
  });
  it.each(kinds)('%s consumer reads the tenant from ctx only, never from a payload tenant_id', (k) => {
    expect(src(k)).not.toMatch(/payload\??\.\s*tenant_id|payload\[['"]tenant_id['"]\]/);
  });
});

describe('FD-T12 worker manifest wiring', () => {
  it('frontdesk manifest subscribes the five handlers under their event types and still validates', async () => {
    const m: any = (await import('../../../../../../worker/src/jobs/frontdesk/index.js')).manifest;
    const { validateManifests } = await import('../../../../../../worker/src/core/manifest.js');
    expect(Object.keys(m.subscriptions ?? {}).sort()).toEqual(Object.values(TYPES).sort());
    for (const k of kinds) expect(m.subscriptions[TYPES[k]]).toBe(await handlerOf(k));
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('earlier frontdesk tasks and maxAttempts are untouched (FD-T07 / FD-T10)', async () => {
    const m: any = (await import('../../../../../../worker/src/jobs/frontdesk/index.js')).manifest;
    expect(Object.keys(m.tasks).sort()).toEqual(['frontdesk.discount_approval_expire', 'frontdesk.trf_draft_purge', 'frontdesk.trf_scan']);
    expect(m.maxAttempts).toMatchObject({ 'frontdesk.discount_approval_expire': 3, 'frontdesk.trf_scan': 5, 'frontdesk.trf_draft_purge': 3 });
  });
});
