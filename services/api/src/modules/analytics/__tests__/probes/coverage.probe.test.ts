// AN-T21 — 07-SECURITY §5 completeness map. Every required test ID (P1..P13, E1..E9, S1..S4, X1..X3) must be owned by a test file that exists and names the ID.
// P-tests live in this directory; E-/S-/P8 tests were written with the task that owns the code (AN-T10, T15, T16, T22) and are referenced, not duplicated.
// Also: every operation of analytics.yaml that takes an id is named in a probe file (P1 "all 30 operations" cannot silently lose one).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { OPS } from './spec.js';

const API = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'analytics');
const WORKER = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'analytics');
const P = join(API, '__tests__', 'probes');
const src = (f: string) => readFileSync(f, 'utf8');

const OWNERS: Record<string, string[]> = {
  P1: [join(P, 'tenant.rollups.probe.test.ts'), join(P, 'tenant.lab.probe.test.ts'), join(P, 'tenant.tat.probe.test.ts'), join(P, 'tenant.referral.probe.test.ts'), join(P, 'tenant.pending.probe.test.ts'), join(P, 'exports.probe.test.ts'), join(P, 'schedules.probe.test.ts')],
  P2: [join(P, 'tenant.pending.probe.test.ts'), join(P, 'exports.probe.test.ts'), join(P, 'schedules.probe.test.ts')],
  P3: [join(P, 'tenant.rollups.probe.test.ts'), join(P, 'exports.probe.test.ts'), join(P, 'schedules.probe.test.ts')],
  P4: [join(P, 'tenant.rollups.probe.test.ts')], P5: [join(P, 'tenant.rollups.probe.test.ts')],
  P6: [join(P, 'policies.probe.test.ts')], P7: [join(P, 'policies.probe.test.ts')], P12: [join(P, 'policies.probe.test.ts'), join(P, 'actors.probe.test.ts')],
  P8: [join(WORKER, '__tests__', 'build_export.test.ts')],
  P9: [join(P, 'exports.probe.test.ts')], P10: [join(P, 'schedules.probe.test.ts')], P11: [join(P, 'schedules.probe.test.ts')],
  P13: [join(P, 'contract.probe.test.ts'), join(P, 'tenant.referral.probe.test.ts')],
  E1: [join(API, 'handlers', '__tests__', 'exports.handler.test.ts')], E2: [join(API, 'handlers', '__tests__', 'exports.handler.test.ts')],
  E3: [join(API, 'handlers', '__tests__', 'exports.handler.test.ts')], E4: [join(API, 'handlers', '__tests__', 'exports.handler.test.ts')],
  E5: [join(WORKER, '__tests__', 'build_export.test.ts'), join(API, 'export', '__tests__', 'writers.test.ts')],
  E6: [join(WORKER, '__tests__', 'build_export.test.ts')],
  E7: [join(API, 'handlers', '__tests__', 'referral.handler.test.ts'), join(API, 'handlers', '__tests__', 'exports.handler.test.ts')],
  E8: [join(API, 'handlers', '__tests__', 'referral.handler.test.ts')],
  E9: [join(API, '__tests__', 'ci', 'no-commission.test.ts')],
  S1: [join(API, 'handlers', '__tests__', 'schedules.handler.test.ts')], S2: [join(WORKER, '__tests__', 'dispatch_schedules.test.ts')],
  S3: [join(API, 'handlers', '__tests__', 'schedules.handler.test.ts'), join(API, 'repository', '__tests__', 'schedules.name_ck.test.ts')],
  S4: [join(WORKER, '__tests__', 'dispatch_schedules.test.ts')],
  X1: [join(P, 'actors.probe.test.ts'), join(P, 'contract.probe.test.ts')], X2: [join(P, 'contract.probe.test.ts')], X3: [join(P, 'battery.ts'), join(P, 'contract.probe.test.ts')],
};

/** IDs whose owning tests do not carry the ID in their text: matched by what the test asserts instead. */
const BY_CONTENT: Record<string, RegExp> = {
  E8: /referral_report\.view/, E9: /commission/i, S4: /idempoten|duplicate|twice|same slot/i,
};

describe('every 07-SECURITY §5 test ID has an owning test file that exists and names the ID', () => {
  it.each(Object.entries(OWNERS))('%s', (id, files) => {
    for (const f of files) {
      const text = src(f);
      expect(text.length, f).toBeGreaterThan(0);
    }
    const re = BY_CONTENT[id] ?? new RegExp(`(^|[^A-Za-z0-9_])${id}([^0-9]|$)`);
    const named = files.some((f) => re.test(src(f)));
    expect(named, `no owner file mentions ${id} (${String(re)}): ${files.join(', ')}`).toBe(true);
  });
  it('the table lists all 13 P, 9 E, 4 S and 3 X tests of §5', () => {
    expect(Object.keys(OWNERS).length).toBe(13 + 9 + 4 + 3);
  });
});

describe('P1 "all 30 operations": each id-taking operation is named in a probe file', () => {
  const probeText = Object.values(OWNERS).flat().filter((f) => f.includes('probes')).map(src).join('\n');
  const idTaking = OPS.filter((o) => o.pathParams.length || o.query.some((q) => /_ids?$/.test(String(q))) || /_ids?"/.test(JSON.stringify(o.raw.requestBody ?? {})) || o.hasBody);
  it.each(idTaking.map((o) => [o.id] as const))('%s', (id) => {
    expect(probeText, id).toContain(id);
  });
  it('the generated suites (actors, contract) iterate OPS, so all 30 operations are visited by P12 / X1 / X2 / X3 / P13', () => {
    expect(OPS.length).toBe(30);
    expect(src(join(P, 'actors.probe.test.ts'))).toContain('OPS.map');
  });
});
