// BL-T01 worker skeleton test (06-IMPLEMENTATION-PLAN BL-T01; 02-CONVENTIONS §2.3; 02-TRD §7.2 manifest checks).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../../core/manifest.js';
import { manifest } from '../../index.js';

const DIR = join(import.meta.dirname, '..', '..');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(f) ? [p] : [];
  });

describe('BL-T01 worker manifest (jobs/billing/index.ts)', () => {
  it('is the billing WorkerManifest and passes the core validation (namespace, subscriptions, crontab)', () => {
    expect(manifest.module).toBe('billing');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('declares task ids only inside the billing namespace', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) expect(id).toMatch(/^billing\.[a-z0-9_]+$/);
  });

  it('does not import from another module\'s job folder (REQ-ARCH-076)', () => {
    const files = sources(DIR);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const offenders = files.filter((f) => /from\s+['"][^'"]*\/jobs\/(?!billing\b)[a-z_]+\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
