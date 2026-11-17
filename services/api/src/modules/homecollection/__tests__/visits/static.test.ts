// HC-T08 static guards (no DB). Files of this task: handlers/* and mappers/* (+ the service files they use). Guards the HC-T03 repository seam (SQL lives in repository/*.repo.ts only), the verbatim names the
// spec fixes (operationIds, permissions, error code, access-log action / entity / purposes, port + core calls), REQ-SEC-081 (no patient data in logs), 02-TRD §5 H1 (one batch call per page, never per visit).
// Fails now: handlers/{listHomeVisits,getHomeVisit,listHomeRoutes,listEligiblePhlebotomists,revealHomeVisitPhone}.ts do not exist (H1/H2/H10/H12/H21 are HC-T01 stubs).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const walk = (p: string): string[] => (!existsSync(p) ? [] : statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]);
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');   // code only: comments may name the forbidden things
const ts = (dir: string) => walk(join(ROOT, dir)).filter((f) => f.endsWith('.ts'));
const OPS = ['listHomeVisits', 'getHomeVisit', 'listHomeRoutes', 'listEligiblePhlebotomists', 'revealHomeVisitPhone'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
const SETTINGS_HANDLERS = ['getHomecollectionSettings', 'updateHomecollectionSettings', 'listHomecollectionReasons'];   // HC-T04, not ours

describe('HC-T08 files', () => {
  it('one handler file per operation (named by operationId, like the H18-H20 handlers) and at least one mapper file', () => {
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T08 not implemented yet)`).toBe(true);
    const mappers = ts('mappers').filter((f) => !/settings\.mapper/.test(f));
    expect(mappers.length, 'mappers/* for the visit / route DTOs missing (HC-T08 not implemented yet)').toBeGreaterThan(0);
  });
  it('the module manifest wires the five real handlers (no stub left for them)', () => {
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
});

describe('HC-T08 source rules', () => {
  const own = (): string[] => [...ts('handlers'), ...ts('mappers')].filter((f) => !SETTINGS_HANDLERS.some((s) => f.includes(s)) && !/settings\.mapper/.test(f));
  const all = (): string => [...own(), ...ts('service').filter((f) => !/visit\.service\.ts$/.test(f))].map(code).join('\n');

  it('SQL stays in the repositories: no tx.query / pool.query in the handlers or mappers; no RLS bypass, no pg import', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('reads go through the HC-T03 repositories (visits, routes, visitFlags, collections, visitAssignments, visitTransitions, visitSpecimens)', () => {
    const t = all();
    for (const repo of ['visits.repo', 'routes.repo']) expect(t, repo).toMatch(new RegExp(repo.replace('.', '\\.')));
  });
  it('H1: ONE FrontdeskPort.getPatientDemographicsBatch with purpose home_visit; staff names via ctx.core.memberships.list (P-17), never a direct core.memberships read', () => {
    const list = existsSync(handlerFile('listHomeVisits')) ? code(handlerFile('listHomeVisits')) : '';
    const t = all();
    expect(t).toMatch(/getPatientDemographicsBatch/);
    expect(t).toMatch(/home_visit/);
    expect(t).toMatch(/memberships\.list/);
    expect(/core\.memberships/.test(t.replace(/ctx\.core\.memberships/g, '')), 'reads core.memberships directly').toBe(false);
    expect(/getPatientDemographics\s*\(/.test(list), 'listHomeVisits must not call the per-patient port method').toBe(false);
  });
  it('H2 / H21: access-log writes use the verbatim action home_visit.view, entity home_visit and the purposes visit_detail / phone_reveal, through ctx.audit.access', () => {
    const t = all();
    expect(t).toMatch(/home_visit\.view/);
    expect(t).toMatch(/visit_detail/);
    expect(t).toMatch(/phone_reveal/);
    expect(t).toMatch(/audit\.access/);
    expect(/insert\s+into\s+audit\.access_log/i.test(t), 'writes audit.access_log by hand').toBe(false);
  });
  it('names are the spec ones: permissions visit.read (H1/H2/H10) and visit.assign (H12/H21) + sync.upload for the phlebotomist-only rule, error homecollection.visit_not_assigned, assertRole is used', () => {
    const t = all();
    expect(t).toMatch(/homecollection\.visit\.read|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/homecollection\.visit\.assign|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/homecollection\.sync\.upload|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/homecollection\.visit_not_assigned/);
    expect(t).toMatch(/assertRole/);
  });
  it('REQ-SEC-081 / 07 §6: no patient data (name, phone, address, display names) passed to ctx.log', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*(phone|full_?name|display_?name|address|landmark|patient)/i.test(code(f)), `${f}: logs patient data`).toBe(false);
  });
  it('the phone is read from the port only in H21: neither the list/detail handlers nor the mappers mention phone_e164 / phoneE164', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own().filter((x) => !/revealHomeVisitPhone|phone/i.test(x.slice(ROOT.length)))) expect(/phone_?e164/i.test(code(f)), `${f}: handles the phone`).toBe(false);
  });
});
