// ADMINPAGE-FD-1: how rs-c4.baseline.json may move (brief: "changes only where the signature of a touched manifest moved").
// The reference is the baseline committed before this task (git BASE). Allowed movement, nothing else:
//   - logic hash: ONLY src/features/frontdesk/nav.manifest.ts (the new entry). The existing frontdesk server/forms/hooks files and every billing file stay byte-identical.
//   - signatures: billing areas identical; frontdesk areas may only ADD (permission frontdesk.settings.manage; routes /frontdesk/settings or /v1/frontdesk/settings; field names; server imports/symbols).
//   - route files: the same list plus the settings page.tsx / loading.tsx / error.tsx.
// The existing rs-c4.static.test.ts then proves the (updated) baseline equals the tree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const BASE = '93bfe99f5';
const REL = 'apps/web/src/features/frontdesk/__tests__/rs-c4.baseline.json';
type Sig = { permissions: string[]; routes: string[]; field_names: string[]; server_imports: string[]; server_symbols: string[] };
type Baseline = { logic: Record<string, string>; signatures: Record<string, Sig>; route_files: string[] };
const was = JSON.parse(execFileSync('git', ['show', `${BASE}:${REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Baseline;
const now = JSON.parse(readFileSync(join(HERE, 'rs-c4.baseline.json'), 'utf8')) as Baseline;
const SETTINGS_ROUTE = /^\/(v1\/)?frontdesk\/settings$/;

describe('rs-c4.baseline.json moves only where the settings page touches it', () => {
  it('logic hashes: same files; only the frontdesk nav manifest changed (it has the new entry)', () => {
    expect(Object.keys(now.logic).sort()).toEqual(Object.keys(was.logic).sort());
    const changed = Object.keys(was.logic).filter((k) => now.logic[k] !== was.logic[k]);
    expect(changed).toEqual(['src/features/frontdesk/nav.manifest.ts']);
  });

  it('billing areas: identical signatures', () => {
    for (const a of ['billing_feature', 'billing_app']) expect(now.signatures[a]).toEqual(was.signatures[a]);
  });

  it.each(['frontdesk_feature', 'frontdesk_app'])('%s: nothing removed; added permissions are only frontdesk.settings.manage; added routes are only the settings page and its operation', (a) => {
    const w = was.signatures[a]!;
    const n = now.signatures[a]!;
    for (const k of ['permissions', 'routes', 'field_names', 'server_imports', 'server_symbols'] as const) expect(w[k].filter((x) => !n[k].includes(x)), `${a}.${k} removed`).toEqual([]);
    expect(n.permissions.filter((x) => !w.permissions.includes(x) && x !== 'frontdesk.settings.manage')).toEqual([]);
    expect(n.routes.filter((x) => !w.routes.includes(x) && !SETTINGS_ROUTE.test(x))).toEqual([]);
  });

  it('the settings permission and the operation route are recorded for the feature (the baseline knows the page exists)', () => {
    const feat = now.signatures['frontdesk_feature']!;
    const app = now.signatures['frontdesk_app']!;
    expect([...feat.permissions, ...app.permissions]).toContain('frontdesk.settings.manage');
    expect([...feat.routes, ...app.routes].some((r) => SETTINGS_ROUTE.test(r))).toBe(true);
  });

  it('route files: exactly the old list plus the settings page.tsx (and loading.tsx / error.tsx)', () => {
    const added = now.route_files.filter((f) => !was.route_files.includes(f));
    expect(was.route_files.filter((f) => !now.route_files.includes(f))).toEqual([]);
    expect(added).toContain('src/app/(staff)/frontdesk/settings/page.tsx');
    expect(added.filter((f) => !/^src\/app\/\(staff\)\/frontdesk\/settings\/(page|loading|error)\.tsx$/.test(f))).toEqual([]);
    expect([...now.route_files]).toEqual([...now.route_files].sort());
  });
});
