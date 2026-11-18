// T0B-SYNC-5 static probes (no database, imports no helper that needs LIMS_TEST_APP_URL): done_when (3) source rules of the retention job, (4) the three new gauges in observability/metrics.ts and
// the worker wiring, (5) the runbook docs/ops/OFFLINE-SYNC.md. PINNED SURFACE: ./kit.ts header. Fails today: retention.ts, metrics.ts (sync), the gauges, the worker tasks and the runbook do not exist.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../module.js';

const read = (rel: string): string => { const p = join(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`${rel} does not exist (T0B-SYNC-5 deliverable)`); return readFileSync(p, 'utf8'); };
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' || f === 'node_modules' ? [] : walk(rel)) : [rel];
});
const GAUGES = ['lims_core_sync_device_backlog_age_seconds', 'lims_core_sync_conflicts_open', 'lims_core_sync_print_recalls'];

describe('metrics registry (done_when 4)', () => {
  const m = (): string => read('services/api/src/core/observability/metrics.ts');
  it('the three gauges are declared with bounded labels (tenant_id, plus device_id on the per device one only)', () => {
    expect(m()).toMatch(/lims_core_sync_device_backlog_age_seconds:\s*\['gauge',\s*\['tenant_id',\s*'device_id'\]/);
    expect(m()).toMatch(/lims_core_sync_conflicts_open:\s*\['gauge',\s*\['tenant_id'\]/);
    expect(m()).toMatch(/lims_core_sync_print_recalls:\s*\['gauge',\s*\['tenant_id'\]/);
  });
  it('the existing counters that carry accepted / duplicate / rejected / conflict are unchanged', () => {
    expect(m()).toMatch(/lims_core_sync_operations_total:\s*\['counter',\s*\['status'\]/);
    expect(m()).toMatch(/lims_core_retention_purged_total:\s*\['counter',\s*\['table'\]/);
    expect(m()).toMatch(/lims_core_retention_purge_capped_total:\s*\['counter',\s*\['table'\]/);
  });
});

describe('retention job source (done_when 3)', () => {
  const src = (): string => read('services/api/src/core/sync/retention.ts');
  it('exports the pinned names, default 180 days, and never locks a table, truncates or touches audit.*', () => {
    const s = src();
    expect(s).toMatch(/export const DEFAULT_SYNC_RETENTION_DAYS\s*=\s*180\b/);
    expect(s).toMatch(/export (async )?function purgeSyncLedger\b/);
    expect(s).not.toMatch(/\bLOCK\s+TABLE\b/i);
    expect(s).not.toMatch(/\bTRUNCATE\b/i);
    expect(s).not.toMatch(/\baudit\./i);
    expect(s).not.toMatch(/\bDROP\b|\bALTER\b/i);
  });
  it('every statement that deletes names tenant_id (RLS is a second wall, not the only one) and never deletes a whole table', () => {
    const s = src();
    const deletes = [...s.matchAll(/DELETE\s+FROM[\s\S]*?(?=`|'|")/gi)].map((x) => x[0]);
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) { expect(d, d).toMatch(/tenant_id/); expect(d, d).toMatch(/\bWHERE\b/i); }
  });
  it('removes in small batches (a LIMIT in the candidate query) and skips rows another transaction holds (SKIP LOCKED) so it never waits on a push', () => {
    expect(src()).toMatch(/\bLIMIT\b/i);
    expect(src()).toMatch(/SKIP\s+LOCKED/i);
  });
});

describe('worker wiring (done_when 3, 4)', () => {
  const files = (): string[] => walk('services/worker/src').filter((f) => f.endsWith('.ts'));
  it('a task core.sync_retention calls purgeSyncLedger and a task core.sync_metrics calls refreshSyncGauges; both are per tenant crontab entries', () => {
    const all = files().map((f) => ({ f, s: read(f) }));
    const ret = all.filter((x) => x.s.includes('core.sync_retention')); const met = all.filter((x) => x.s.includes('core.sync_metrics'));
    expect(ret.length, 'no worker file names core.sync_retention').toBeGreaterThan(0);
    expect(met.length, 'no worker file names core.sync_metrics').toBeGreaterThan(0);
    expect(all.some((x) => x.s.includes('purgeSyncLedger'))).toBe(true);
    expect(all.some((x) => x.s.includes('refreshSyncGauges'))).toBe(true);
    const cron = all.map((x) => x.s).join('\n');
    expect(cron).toMatch(/identifier:\s*'core\.sync_retention'[^}]*tenantScope:\s*'per_tenant'/);
    expect(cron).toMatch(/identifier:\s*'core\.sync_metrics'[^}]*tenantScope:\s*'per_tenant'/);
  });
});

describe('runbook docs/ops/OFFLINE-SYNC.md (done_when 5)', () => {
  const doc = (): string => read('docs/ops/OFFLINE-SYNC.md');
  const closed = (): Set<string> => new Set((loadSpec(join(REPO_ROOT, 'contracts/openapi/core.yaml')) as any).components.schemas.SyncErrorCode.enum as string[]);
  const heading = (re: RegExp) => expect(doc().split('\n').filter((l) => /^#{1,4}\s/.test(l)).some((l) => re.test(l)), String(re)).toBe(true);

  it('has a section for each thing the brief names', () => {
    heading(/conflict inbox/i);
    heading(/(wipe|revoke).*device|device.*(wipe|revoke)/i);
    heading(/recall/i);
    heading(/outage drill/i);
    heading(/after a long outage/i);
    heading(/alert/i);
    heading(/retention/i);
  });
  it('conflict inbox: names the operations and the permission, the three resolutions and that a reason is required', () => {
    const d = doc();
    for (const t of ['listSyncConflicts', 'getSyncConflict', 'resolveSyncConflict', 'sync.conflict.resolve', 'keep_server', 'apply_local', 'merge', 'sync.entity_changed']) expect(d, t).toContain(t);
    expect(d).toMatch(/reason/i);
  });
  it('device wipe and revoke: names the operations, the permission and the wipe acknowledgement', () => {
    const d = doc();
    for (const t of ['listSyncDevices', 'revokeSyncDevice', 'requestSyncDeviceWipe', 'ackDeviceWipe', 'sync.device.manage']) expect(d, t).toContain(t);
  });
  it('recall: says what a recall is (a report printed offline on a sign off that failed at sync), who is alerted and where to see it', () => {
    const d = doc();
    expect(d).toMatch(/recall_required/); expect(d).toMatch(/sync\.verification_policy_failed/); expect(d).toMatch(/lab manager/i); expect(d).toMatch(/lims_core_sync_print_recalls/);
  });
  it('outage drill: follows design section 11 (register, bill, collect, accession, enter, verify, print, reconnect) and states what must be true afterwards', () => {
    const d = doc();
    expect(d).toMatch(/offline-design-20261117\.md/); expect(d).toMatch(/section 11/i);
    for (const w of ['register', 'bill', 'collect', 'accession', 'enter results', 'verify', 'print', 'reconnect']) expect(d.toLowerCase(), w).toContain(w);
    for (const w of ['no duplicates', 'no lost operations', 'numbers are finalised', 'conflicts are listed', 'device and server times']) expect(d.toLowerCase(), w).toContain(w);
  });
  it('after a long outage: a check list that covers the conflict inbox, provisional numbers mapped to final ones, recalls, rate limited devices and the backlog gauge', () => {
    const d = doc();
    expect(d).toMatch(/provisional/i); expect(d).toMatch(/OFF-/); expect(d).toMatch(/retry_after/); expect(d).toMatch(/\[ \]|^\s*\d+\.\s/m);
  });
  it('alert thresholds: every exposed metric is named together with a number and a unit or count (the alert thresholds the brief asks for)', () => {
    const lines = doc().split('\n');
    for (const name of [...GAUGES, 'lims_core_sync_operations_total', 'lims_core_sync_batches_total', 'lims_core_retention_purged_total']) {
      const hit = lines.find((l) => l.includes(name) && /\d/.test(l.replace(name, '')));
      expect(hit, `${name} needs a line with its alert threshold`).toBeTruthy();
    }
    expect(doc()).toMatch(/oldest_unsynced|backlog/i);
  });
  it('retention: states the default of 180 days, that open conflicts, pending print markers and audit events are never removed, and the job names', () => {
    const d = doc();
    expect(d).toMatch(/180/); expect(d).toMatch(/open conflict/i); expect(d).toMatch(/pending/i); expect(d).toMatch(/audit/i);
    expect(d).toContain('core.sync_retention'); expect(d).toContain('core.sync_metrics');
  });
  it('every sync.* error code the runbook mentions is a registered code of the closed list (no invented names); no personal data (no names, phone numbers, emails)', () => {
    const d = doc(); const known = closed();
    const codes = [...d.matchAll(/\bsync\.[a-z_]+(?:\.[a-z_]+)*\b/g)].map((m) => m[0]).filter((c) => !['sync.use', 'sync.device.manage', 'sync.conflict.resolve'].includes(c));
    expect(codes.length).toBeGreaterThan(0);
    // request level codes of the device operations are registered on the HTTP response, not in SyncErrorCode
    const requestLevel = new Set(['sync.device_revoked', 'sync.wipe_required', 'sync.device_unknown']);
    for (const c of codes) expect(known.has(c) || requestLevel.has(c), c).toBe(true);
    expect(d).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); expect(d).not.toMatch(/\b9[78]\d{8}\b/);
  });
});
