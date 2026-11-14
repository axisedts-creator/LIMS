// HC-T14 static guards (no DB). Files of this task: handover.service.ts (module root, like device.service.ts), handlers/{listHandovers,getHandover,confirmHandover}.ts (one per operationId),
// services/worker/src/jobs/homecollection/tasks/flag_handover_discrepancy.ts. Rules: 02-TRD §3.1 (no SQL outside repository/, ports only from service/), §5.4 rule 3 + 08 A19 D-125 (receiver paths touch
// handovers / handover_items only; the visit_flags rows come from the worker task), §10 task row, verbatim names. Fails now: the three handlers are HC-T01 stubs and the two files do not exist.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const WORKER_TASK = join(ROOT, '..', '..', '..', '..', 'worker', 'src', 'jobs', 'homecollection', 'tasks', 'flag_handover_discrepancy.ts');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const OPS = ['listHandovers', 'getHandover', 'confirmHandover'] as const;
const handlerFile = (op: string) => join(ROOT, 'handlers', `${op}.ts`);
const service = join(ROOT, 'handover.service.ts');
const repo = join(ROOT, 'repository', 'handovers.repo.ts');
const own = (): string[] => [service, ...OPS.map(handlerFile)].filter(existsSync);
const all = (): string => own().map(code).join('\n');

describe('HC-T14 files', () => {
  it('handover.service.ts, one handler file per operation (named by operationId) and the worker task exist', () => {
    expect(existsSync(service), 'handover.service.ts missing (HC-T14 not implemented yet)').toBe(true);
    for (const op of OPS) expect(existsSync(handlerFile(op)), `handlers/${op}.ts missing (HC-T14 not implemented yet)`).toBe(true);
    expect(existsSync(WORKER_TASK), 'tasks/flag_handover_discrepancy.ts missing (HC-T14 not implemented yet)').toBe(true);
  });
  it('the manifest wires the three handlers (no stub left for them)', () => {
    const idx = code(join(ROOT, 'index.ts'));
    for (const op of OPS) expect(idx, `index.ts does not import handlers/${op}.js`).toMatch(new RegExp(`handlers/${op}\\.js`));
  });
  it('the worker task exports flagHandoverDiscrepancy (02-TRD §3.2 manifest name) as a TaskHandler', () => {
    expect(existsSync(WORKER_TASK), 'tasks/flag_handover_discrepancy.ts missing').toBe(true);
    const t = code(WORKER_TASK);
    expect(t).toMatch(/export\s+const\s+flagHandoverDiscrepancy\b|export\s+(async\s+)?function\s+flagHandoverDiscrepancy\b/);
    expect(t).toMatch(/TaskHandler/);
  });
});

describe('HC-T14 source rules (API side)', () => {
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
  it('D-125: the receiver paths import no visit-side repository and call no port that reads visits or specimens (handovers.repo only)', () => {
    expect(existsSync(service), 'handover.service.ts missing').toBe(true);
    const t = all();
    expect(t).toMatch(/handovers\.repo/);
    for (const r of ['visits\\.repo', 'visitQueries\\.repo', 'visitSpecimens\\.repo', 'collections\\.repo', 'visitFlags\\.repo', 'routes\\.repo', 'visitAssignments\\.repo', 'visitTransitions\\.repo', 'mutations\\.repo', 'devices\\.repo'])
      expect(t, `receiver path imports ${r}`).not.toMatch(new RegExp(r));
    for (const p of ['LabPort', 'FrontdeskPort', 'BillingPort', 'lookupSpecimens', 'bumpVersion', 'insertVisitFlag', 'visit_flags'])
      expect(t, `receiver path uses ${p}`).not.toContain(p);
  });
  it('H15 enqueues the task by its spec name with job_key flag_handover_discrepancy:<handover_id> and payload {tenant_id, handover_id}, from the repository layer', () => {
    expect(existsSync(service) && existsSync(repo)).toBe(true);
    const t = all() + '\n' + code(repo);
    expect(t).toContain('homecollection.flag_handover_discrepancy');
    expect(t).toMatch(/flag_handover_discrepancy:\$\{/);
    expect(t).toMatch(/app\.enqueue_job/);
    expect(t).toMatch(/tenant_id/);
    expect(t).toMatch(/handover_id/);
  });
  it('names are the spec ones: permission homecollection.handover.receive, assertRole on to_centre_id, error codes, no invented names', () => {
    expect(existsSync(service), 'handover.service.ts missing').toBe(true);
    const t = all();
    expect(t).toMatch(/homecollection\.handover\.receive|HOMECOLLECTION_PERMISSIONS/);
    expect(t).toMatch(/assertRole/);
    expect(t).toMatch(/to_centre_id|toCentreId/);
    for (const c of ['common.not_found', 'common.version_conflict', 'common.validation_failed']) expect(t, `missing ${c}`).toContain(c);
    expect(t).toMatch(/memberships\.list/);
  });
  it('H15 uses the HC-T03 state helper for the transition (pending -> confirmed | discrepancy) and the expected-version update of the repository', () => {
    expect(existsSync(service), 'handover.service.ts missing').toBe(true);
    const t = all();
    expect(t).toMatch(/handover\.state/);
    expect(t).toMatch(/\bupdateHandover\b/);
    expect(t).toMatch(/\bupdateHandoverItem\b/);
  });
  it('REQ-SEC-081 / 07-SECURITY §5: no barcode and no note in log calls; tenant comes from the context, never from the body', () => {
    const t = all();
    for (const m of t.matchAll(/\blog\.(?:info|warn|error|debug)\s*\(([^)]*)\)/g)) expect(m[1], `log call ${m[0]}`).not.toMatch(/barcode|note/i);
    expect(t).not.toMatch(/body\.tenant_id|req\.body\??\.tenant/);
    expect(t).toMatch(/ctx\.tenantId|c\.tenantId/);
  });
});

describe('HC-T14 source rules (worker task)', () => {
  it('system-actor task: ignores a payload of another tenant (payload.tenant_id !== ctx.tenantId), validates the uuid, reads the items of the handover, inserts the flag kind handover_discrepancy with ON CONFLICT DO NOTHING semantics', () => {
    expect(existsSync(WORKER_TASK), 'tasks/flag_handover_discrepancy.ts missing').toBe(true);
    const t = code(WORKER_TASK);
    expect(t).toMatch(/tenant_id\s*!==\s*ctx\.tenantId|ctx\.tenantId\s*!==\s*payload/);
    expect(t).toMatch(/handover_id/);
    expect(t).toContain('handover_discrepancy');
    expect(t).toMatch(/missing/);
    expect(/console\./.test(t)).toBe(false);
    expect(/from\s+['"]pg['"]/.test(t)).toBe(false);
  });
  it('the task does not log barcodes', () => {
    expect(existsSync(WORKER_TASK), 'tasks/flag_handover_discrepancy.ts missing').toBe(true);
    for (const m of code(WORKER_TASK).matchAll(/\blog\.(?:info|warn|error|debug)\s*\(([^)]*)\)/g)) expect(m[1], `log call ${m[0]}`).not.toMatch(/barcode/i);
  });
});
