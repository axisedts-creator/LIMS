// HC-T15 static guards (no DB). Files of this task: handlers/listPhleboDevices.ts + handlers/requestDeviceWipe.ts (+ the service they import, device.service.ts or a sibling *.service.ts).
// Guards the HC-T03 repository seam (SQL in repository/*.repo.ts only), verbatim names (operationIds, permission, error codes), REQ-SEC-081 (no personal data in logs), 07-SECURITY §5 (tenant from claims).
// Fails now: both handler files are missing (H16 / H17 are HC-T01 stubs).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');   // comments may name the forbidden things
const OPS = ['listPhleboDevices', 'requestDeviceWipe'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
/** The handler files plus every sibling `*.service.ts` they import. */
const own = (): string[] => {
  const hs = OPS.map(handlerFile).filter(existsSync);
  const svc = hs.flatMap((h) => [...code(h).matchAll(/from\s+['"](\.\.\/[^'"]+\.service)\.js['"]/g)].map((m) => resolve(dirname(h), `${m[1]}.ts`))).filter(existsSync);
  return [...new Set([...hs, ...svc])];
};

describe('HC-T15 files', () => {
  it('one handler file per operation (named by operationId) and the manifest imports both (no stub left)', () => {
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T15 not implemented yet)`).toBe(true);
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
});

describe('HC-T15 source rules', () => {
  const all = (): string => own().map(code).join('\n');
  it('SQL stays in the repositories: no .query(, no RLS bypass, no pg import, no console in the service or handlers', () => {
    expect(own().length).toBeGreaterThan(1);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('reads / writes go through the HC-T03 devices repository (getDeviceById, updateDevice with the expected version; a list query for H16)', () => {
    const t = all();
    expect(t).toMatch(/devices\.repo/); expect(t).toMatch(/getDeviceById/); expect(t).toMatch(/updateDevice/);
    expect(/delete\s+from\s+homecollection\.devices/i.test(t)).toBe(false);
  });
  it('names are the spec ones: device.manage checked through IdentityPort.assertRole, wipe_reasons set, errors precondition_required / version_conflict / not_found, header if-match, display names via memberships.list', () => {
    const t = all();
    expect(t).toMatch(/homecollection\.device\.manage|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/assertRole/);
    expect(t).toMatch(/wipe_reasons/);
    expect(t).toMatch(/common\.precondition_required/);
    expect(t).toMatch(/common\.version_conflict/);
    expect(t).toMatch(/common\.not_found/);
    expect(t).toMatch(/if-match/i);
    expect(t).toMatch(/memberships\.list/);
    expect(/core\.memberships/.test(t.replace(/ctx\.core\.memberships/g, '')), 'reads core.memberships directly').toBe(false);
  });
  it('the actor comes from the claims (ctx.actor), never from the body; the wipe sets status wipe_requested + wipe_requested_at/by + reason through the repo only', () => {
    const t = all();
    expect(t).toMatch(/ctx\.actor/); expect(t).toMatch(/wipe_requested/); expect(t).toMatch(/wipe_reason_code/);
    expect(/body\W*(\?\.)?\W*(membership_?id|tenant_?id|status|wipe_requested_by)/i.test(t), 'identity or state taken from the body').toBe(false);
  });
  it('REQ-SEC-081: no reason text / display name / device values passed to ctx.log', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*(reason_?text|display_?name|model|os_version|app_version)/i.test(code(f)), `${f}: logs device or staff data`).toBe(false);
  });
});
