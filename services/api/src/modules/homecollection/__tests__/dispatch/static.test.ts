// HC-T09 static guards (no DB). Files of this task: visit.service.ts + route.service.ts (module root, like device.service.ts / settings.service.ts) and one handler per operation H3-H8 + H11.
// Guards: HC-T03 repository seam (SQL only in repository/*.repo.ts), verbatim names (operationIds, permission, error codes, port + method names), TRD §4.1 (route.service.bumpVersion used by every route-affecting write),
// 08 A19 P-44 (SMS inside ctx.db.tx), REQ-SEC-081 (no personal data in logs), 07-SECURITY §5 (tenant from claims). Fails now: the files do not exist (H3-H8, H11 are HC-T01 stubs).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const OPS = ['assignHomeVisit', 'unassignHomeVisit', 'scheduleHomeVisit', 'cancelHomeVisit', 'createHomeRevisit', 'resolveHomeVisitFlag', 'resequenceHomeRoute'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
const visitService = join(ROOT, 'visit.service.ts');
const routeService = join(ROOT, 'route.service.ts');
const own = (): string[] => [visitService, routeService, ...OPS.map(handlerFile)].filter(existsSync);
const all = (): string => own().map(code).join('\n');

describe('HC-T09 files', () => {
  it('visit.service.ts, route.service.ts and one handler file per operation (named by operationId)', () => {
    expect(existsSync(visitService), 'visit.service.ts missing (HC-T09 not implemented yet)').toBe(true);
    expect(existsSync(routeService), 'route.service.ts missing (HC-T09 not implemented yet)').toBe(true);
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T09 not implemented yet)`).toBe(true);
  });
  it('the manifest wires all seven handlers (no stub left for them)', () => {
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
  it('route.service exports bumpVersion (TRD §4.1: route.service.bumpVersion(tx, routeId))', () => {
    expect(existsSync(routeService), 'route.service.ts missing').toBe(true);
    expect(code(routeService)).toMatch(/export\s+(async\s+)?function\s+bumpVersion|export\s+const\s+bumpVersion|export\s*\{[^}]*\bbumpVersion\b/);
  });
});

describe('HC-T09 source rules', () => {
  it('SQL stays in the repositories: no tx.query / pool.query, no RLS bypass, no pg import, no console', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('writes go through the HC-T03 repositories with the expected version (visits, routes, visit_assignments, visit_transitions, visit_flags)', () => {
    const t = all();
    for (const r of ['visits\\.repo', 'routes\\.repo', 'visitAssignments\\.repo', 'visitTransitions\\.repo', 'visitFlags\\.repo']) expect(t, `no import of ${r}`).toMatch(new RegExp(r));
    for (const fn of ['updateVisit', 'updateRoute', 'insertVisitAssignment', 'insertVisitTransition', 'updateVisitFlag', 'insertVisit']) expect(t, `${fn} not used`).toMatch(new RegExp(`\\b${fn}\\b`));
  });
  it('TRD §4.1: every route-affecting write goes through bumpVersion (visit.service references it; handlers never write routes themselves)', () => {
    expect(existsSync(visitService)).toBe(true);
    expect(code(visitService)).toMatch(/\bbumpVersion\b/);
    for (const op of OPS) if (existsSync(handlerFile(op))) expect(/updateRoute\s*\(/.test(code(handlerFile(op))), `${op}: writes routes directly`).toBe(false);
  });
  it('names are the spec ones: assertRole(homecollection.visit.assign), FrontdeskPort.createOrderFromBooking with source home_collection + key <visit_id>:order, error codes, memberships.list', () => {
    const t = all();
    expect(t).toMatch(/homecollection\.visit\.assign|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/assertRole/);
    expect(t).toMatch(/createOrderFromBooking/);
    expect(t).toMatch(/home_collection/);
    expect(t).toMatch(/:order['"`]/);
    expect(t).toMatch(/confirmImmediately/);
    for (const c of ['homecollection.visit_closed', 'homecollection.visit_incomplete', 'homecollection.phlebotomist_not_eligible', 'homecollection.mutation_superseded', 'common.version_conflict', 'common.validation_failed'])
      expect(t, `missing ${c}`).toContain(c);
    expect(t).toMatch(/\/phlebotomist_membership_id/);
    expect(t).toMatch(/memberships\.list/);
    expect(/core\.memberships/.test(t.replace(/ctx\.core\.memberships/g, '')), 'reads core.memberships directly').toBe(false);
  });
  it('P-44: the assignment SMS is sent through NotificationPort.sendSms inside ctx.db.tx (savepoint) with the spec template + key', () => {
    const t = all();
    expect(t).toMatch(/sendSms/);
    expect(t).toMatch(/db\.tx\s*\(/);
    expect(t).toContain('homecollection.visit_assigned');
    expect(t).toContain('visit_assignment');
    expect(t).toMatch(/:assigned['"`]/);
    expect(t).toMatch(/notify_phlebotomist_on_assign|notifyPhlebotomistOnAssign/);
  });
  it('D-131: the daily cap reads LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS (or the module config constant) and the per-route cap max_visits_per_route', () => {
    const t = all() + (existsSync(join(ROOT, 'config.ts')) ? code(join(ROOT, 'config.ts')) : '');
    expect(t).toMatch(/LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS|SNAPSHOT_MAX_VISITS|snapshotMaxVisits/);
    expect(all()).toMatch(/max_visits_per_route|maxVisitsPerRoute/);
  });
  it('tenant and actor come from the claims, never the request body; no DELETE of visits/routes', () => {
    const t = all();
    expect(/body\W*(\?\.)?\W*tenant_?id/i.test(t), 'tenant taken from the body').toBe(false);
    expect(/delete\s+from\s+homecollection\./i.test(t)).toBe(false);
    expect(t).toMatch(/membershipId|actor/);
  });
  it('REQ-SEC-081: no address / landmark / note / phone / patient name passed to ctx.log', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) expect(/ctx\.log\.\w+\([^)]*(address|landmark|note_for|phone|full_?name|display_?name|patient)/i.test(code(f)), `${f}: logs personal data`).toBe(false);
  });
});
