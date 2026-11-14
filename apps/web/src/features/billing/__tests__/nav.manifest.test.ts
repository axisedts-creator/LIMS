// BL-T01 web skeleton test (06-IMPLEMENTATION-PLAN BL-T01; 02-CONVENTIONS §2.4; 04-UI-UX §3 nav manifest rules, AC-0D-7.5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNav } from '../../../core/nav/build-nav.ts';
import { navManifest } from '../nav.manifest.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const FEATURES = join(import.meta.dirname, '..', '..');
const permYaml = readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8');
const definedPerms = new Set([...permYaml.matchAll(/code:\s*([a-z_.]+)/g)].map((m) => m[1]));

describe('BL-T01 nav.manifest.ts', () => {
  it('exports navManifest for module billing', () => {
    expect(navManifest.module).toBe('billing');
    expect(Array.isArray(navManifest.entries)).toBe(true);
  });

  it('every entry id is billing.*, its permission exists in permissions.yaml', () => {
    for (const e of navManifest.entries) {
      expect(e.id).toMatch(/^billing\.[a-z0-9_]+$/);
      expect(definedPerms.has(e.permission)).toBe(true);
    }
  });

  it('build-nav accepts the billing manifest (routeId in routes.yaml, staff_web, permission equals the route\'s)', async () => {
    const { errors, entries } = await buildNav(FEATURES, readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8'));
    expect(errors.filter((e) => e.includes('billing'))).toEqual([]);
    expect(entries.filter((e) => e.module === 'billing').length).toBe(navManifest.entries.length);
  });

  it('does not import from another feature folder (REQ-ARCH-076)', () => {
    const src = readFileSync(join(FEATURES, 'billing', 'nav.manifest.ts'), 'utf8');
    expect(/from\s+['"][^'"]*\/features\/(?!billing\b)[a-z_]+\//.test(src)).toBe(false);
  });
});
