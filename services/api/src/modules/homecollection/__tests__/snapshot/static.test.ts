// HC-T11 static guards (no DB). Files of this task: snapshot.service.ts (+ handlers/getSyncSnapshot.ts and handlers/ackSync.ts wiring it into the manifest, as H18-H20 / A1 / A5 did).
// Guards the HC-T03 repository seam (SQL only in repository/*.repo.ts), the verbatim names the spec fixes, review #2 (no read-model fallback, barcode never stored/logged), 08 A19 P-44 (savepoints around failing ports),
// REQ-SEC-081/096 (no personal data in logs, access log written), 07-SECURITY §5 (tenant from claims). Fails now: the files do not exist (A2 / A4 are HC-T01 stubs).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const OPS = ['getSyncSnapshot', 'ackSync'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
const service = join(ROOT, 'snapshot.service.ts');
const own = (): string[] => [service, ...OPS.map(handlerFile)].filter(existsSync);
const all = (): string => own().map(code).join('\n');

describe('HC-T11 files', () => {
  it('snapshot.service.ts exists and one handler file per operation (named by operationId)', () => {
    expect(existsSync(service), 'snapshot.service.ts missing (HC-T11 not implemented yet)').toBe(true);
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T11 not implemented yet)`).toBe(true);
  });
  it('the module manifest wires both real handlers (no 501 stub left for A2 / A4)', () => {
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
});

describe('HC-T11 source rules', () => {
  it('SQL stays in the repositories: no .query(, no RLS bypass, no pg import, no console', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('uses the HC-T03 repositories: devices (binding, last_snapshot_at / last_ack_*), routes by membership+date and route update, visits, settings', () => {
    const t = all();
    expect(t).toMatch(/devices\.repo/);
    expect(t).toMatch(/getDeviceById/);
    expect(t).toMatch(/updateDevice/);
    expect(t).toMatch(/routes\.repo/);
    expect(t).toMatch(/listRoutesByMembershipDate/);
    expect(t).toMatch(/updateRoute/);
    expect(t).toMatch(/settings\.repo/);
    expect(t).toMatch(/getSettings/);
  });
  it('TRD §6.2 ports by their catalog names: getPatientDemographicsBatch (purpose home_visit), lookupSpecimens, getOrderBalance, IdentityPort.getTenantSettings for the timezone, assertRole for visit.read', () => {
    const t = all();
    expect(t).toMatch(/getPatientDemographicsBatch/);
    expect(t).toMatch(/purpose:\s*'home_visit'/);
    expect(t).toMatch(/lookupSpecimens/);
    expect(t).toMatch(/statuses:\s*\[\s*'ordered'\s*\]/);
    expect(t).toMatch(/getOrderBalance/);
    expect(t).toMatch(/getTenantSettings/);
    expect(t).toMatch(/timezone/);
    expect(t).toMatch(/assertRole/);
    expect(t).toMatch(/homecollection\.visit\.read|HOMECOLLECTION_PERMISSIONS/);
  });
  it('port calls that may fail run inside ctx.db.tx (savepoint, 08 A19 P-44) so one failure cannot abort the read transaction', () => {
    const t = code(service);
    expect(t).toMatch(/db\.tx\s*\(/);
  });
  it('review #2: no fallback to the visit_specimens read model in the snapshot, barcode never persisted or logged', () => {
    expect(existsSync(service), 'snapshot.service.ts missing').toBe(true);
    const t = code(service);
    expect(/visitSpecimens\.repo|visit_specimens|listVisitSpecimens/i.test(t), 'snapshot reads the visit_specimens read model').toBe(false);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*barcode/i.test(code(f)), `${f}: logs a barcode`).toBe(false);
  });
  it('REQ-SEC-096: access log written with the verbatim codes home_visit.view / home_visit / home_visit_snapshot', () => {
    const t = code(service);
    expect(t).toMatch(/audit\.access/);
    expect(t).toMatch(/'home_visit\.view'/);
    expect(t).toMatch(/entityType:\s*'home_visit'/);
    expect(t).toMatch(/purpose:\s*'home_visit_snapshot'/);
  });
  it('errors / headers by their spec names: device_not_registered, app_version_unsupported, id_mismatch, x-lims-device-id, x-lims-app-version; cursor is base64url', () => {
    const t = all();
    expect(t).toMatch(/homecollection\.device_not_registered/);
    expect(t).toMatch(/homecollection\.app_version_unsupported/);
    expect(t).toMatch(/common\.id_mismatch/);
    expect(t).toMatch(/x-lims-device-id/i);
    expect(t).toMatch(/x-lims-app-version/i);
    expect(t).toMatch(/base64url/);
  });
  it('identity comes from the claims (ctx.actor.membershipId, ctx.tenantId), never from query / body', () => {
    const t = all();
    expect(t).toMatch(/membershipId/);
    expect(/(query|body)\W*(\?\.)?\W*(tenant_?id|membership_?id)/i.test(t), 'tenant / membership taken from the request').toBe(false);
  });
  it('REQ-SEC-081: no patient / address / note / staff fields passed to ctx.log', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*(full_?name|fullName|phone|address|landmark|note|birth|display_?name|barcode)/i.test(code(f)), `${f}: logs personal data`).toBe(false);
  });
  it('the snapshot response never names registration number or test names (field allowlist, REQ-SEC-081)', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/registration_?no|registrationNo|orderable_ids|test_?names/i.test(code(f)), `${f}: handles registration number / test names`).toBe(false);
  });
});
