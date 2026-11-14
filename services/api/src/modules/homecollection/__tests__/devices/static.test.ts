// HC-T10 static guards (no DB). Files of this task: device.service.ts (+ the A1 / A5 handlers wiring it into the manifest, as H18-H20 did with settings.service.ts). Guards the HC-T03 repository seam (SQL lives in
// repository/*.repo.ts only), the verbatim names the spec fixes (operationIds, permission, error codes, header names), REQ-SEC-081 (no personal data in logs), 07-SECURITY §5 (tenant from claims, never the body).
// Fails now: device.service.ts and handlers/{registerPhleboDevice,signOffPhleboDevice}.ts do not exist (A1 / A5 are HC-T01 stubs).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');   // code only: comments may name the forbidden things
const OPS = ['registerPhleboDevice', 'signOffPhleboDevice'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
const service = join(ROOT, 'device.service.ts');
const own = (): string[] => [service, ...OPS.map(handlerFile)].filter(existsSync);

describe('HC-T10 files', () => {
  it('device.service.ts exists and one handler file per operation (named by operationId, like the H18-H20 handlers)', () => {
    expect(existsSync(service), 'device.service.ts missing (HC-T10 not implemented yet)').toBe(true);
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T10 not implemented yet)`).toBe(true);
  });
  it('the module manifest wires both real handlers (no stub left for them)', () => {
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
});

describe('HC-T10 source rules', () => {
  const all = (): string => own().map(code).join('\n');

  it('SQL stays in the repositories: no tx.query / pool.query, no RLS bypass, no pg import, no console in the service or handlers', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('reads and writes go through the HC-T03 devices repository (getDeviceById / insertDevice / updateDevice with the expected version)', () => {
    const t = all();
    expect(t).toMatch(/devices\.repo/);
    expect(t).toMatch(/getDeviceById/);
    expect(t).toMatch(/insertDevice/);
    expect(t).toMatch(/updateDevice/);
  });
  it('names are the spec ones: sync.upload checked through assertRole, errors device_not_registered / unsynced_changes / id_mismatch / app_version_unsupported, headers x-lims-device-id / x-lims-app-version, display names via memberships.list', () => {
    const t = all();
    expect(t).toMatch(/homecollection\.sync\.upload|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/assertRole/);
    expect(t).toMatch(/homecollection\.device_not_registered/);
    expect(t).toMatch(/homecollection\.unsynced_changes/);
    expect(t).toMatch(/common\.id_mismatch/);
    expect(t).toMatch(/homecollection\.app_version_unsupported/);
    expect(t).toMatch(/x-lims-device-id/i);
    expect(t).toMatch(/x-lims-app-version/i);
    expect(t).toMatch(/memberships\.list/);
    expect(/core\.memberships/.test(t.replace(/ctx\.core\.memberships/g, '')), 'reads core.memberships directly').toBe(false);
  });
  it('the caller identity comes from the claims: membership_id = ctx.actor.membershipId, never from the request body; no DELETE of devices', () => {
    const t = all();
    expect(t).toMatch(/membershipId/);
    expect(/body\W*(\?\.)?\W*membership_?id/i.test(t), 'membership taken from the body').toBe(false);
    expect(/delete\s+from\s+homecollection\.devices/i.test(t)).toBe(false);
  });
  it('REQ-SEC-081: no display name / model / device values passed to ctx.log', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*(display_?name|model|os_version|app_version)/i.test(code(f)), `${f}: logs device or staff data`).toBe(false);
  });
});
