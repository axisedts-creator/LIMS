// C6-T23 static checks (06-PLAN row C6-T23 "recording transport only outside prod"; 02-TRD §3.2/§3.3 layout + lint rule "delivery/adapters imported only by worker task code"; 07-SECURITY REQ-SEC-024/101/136).
// Reads sources only. Files: worker tasks/{dispatch_release_deliveries,send_delivery,check_whatsapp_fallback}.ts, api handlers/delivery.handlers.ts, delivery/transport.ts, delivery/adapters/recording.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';

const api = join(REPO_ROOT, 'services/api/src/modules/reporting');
const tasks = join(REPO_ROOT, 'services/worker/src/jobs/reporting/tasks');
const TASKS = ['dispatch_release_deliveries.ts', 'send_delivery.ts', 'check_whatsapp_fallback.ts'].map((f) => join(tasks, f));
const HANDLER = join(api, 'handlers/delivery.handlers.ts');
const TRANSPORT = join(api, 'delivery/transport.ts');
const RECORDING = join(api, 'delivery/adapters/recording.ts');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function sql(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) { const s = m[1] ?? m[2] ?? m[3] ?? ''; if (/\b(select|insert\s+into|update|delete\s+from)\b/i.test(s) && /\breporting\./i.test(s)) out.push(s); }
  return out;
}
const NETWORK = /from\s+['"](?:node:)?(?:net|tls|http|https|http2|dgram|dns|undici|node-fetch|axios|got|nodemailer|ws)['"]|require\(\s*['"](?:node:)?(?:net|tls|http|https|dns)['"]|\bfetch\s*\(|\bXMLHttpRequest\b/;

describe('files exist', () => {
  it.each([...TASKS, HANDLER, TRANSPORT, RECORDING])('%s', (f) => { expect(existsSync(f), f).toBe(true); });
});

describe('transport contract and the recording adapter (REQ-SEC-136)', () => {
  it('delivery/transport.ts exports TransportError(retryable, failureCode) with both readable fields, and the Transport / ProviderKind types (02-TRD §5.4)', () => {
    const t = read(TRANSPORT); expect(t).toMatch(/export\s+class\s+TransportError\s+extends\s+Error/); expect(t).toMatch(/readonly\s+retryable\s*:\s*boolean/); expect(t).toMatch(/readonly\s+failureCode\s*:\s*string/);
    for (const k of ['recording', 'whatsapp_cloud_api', 'sms_sparrow', 'sms_aakash', 'email_smtp_relay']) expect(t).toContain(k);
    expect(t).toMatch(/interface\s+Transport\b/);
  });
  it('the recording adapter has no network, no env and no filesystem access: it only returns an outcome for the caller to record', () => {
    const s = strip(read(RECORDING)); expect(s.length).toBeGreaterThan(50); expect(NETWORK.test(s)).toBe(false); expect(s).not.toMatch(/process\.env/); expect(s).not.toMatch(/from\s+['"](?:node:)?fs/);
    expect(s).toMatch(/providerKind\s*[:=]\s*['"]recording['"]/);
  });
  it('real-provider adapters (if present) are not imported by handlers or services; only worker task code may import delivery/adapters', () => {
    for (const dir of ['handlers', 'service', 'repository', 'ports']) {
      const d = join(api, dir); if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.ts'))) expect(/delivery\/adapters/.test(read(join(d, f))), `${dir}/${f}`).toBe(false);
    }
  });
  it('the three tasks and the D1-D4 handlers contain no direct network client (providers are reached only through Transport) and no console output', () => {
    for (const f of [...TASKS, HANDLER]) { const s = strip(read(f)); expect(NETWORK.test(s), f).toBe(false); expect(/\bconsole\.(log|info|warn|error|debug)\b/.test(s), f).toBe(false); }
  });
  it('production gating is read in the send task (NODE_ENV + LIMS_REPORTING_ALLOW_REAL_PROVIDERS), never decided by tenant data alone', () => {
    const s = strip(read(join(tasks, 'send_delivery.ts'))); expect(s).toMatch(/NODE_ENV/); expect(s).toMatch(/LIMS_REPORTING_ALLOW_REAL_PROVIDERS/); expect(s).toMatch(/recording/);
  });
  it('the handlers do not read process.env (config comes from the module config / ctx)', () => { expect(/process\.env/.test(strip(read(HANDLER)))).toBe(false); });
});

describe('SQL hygiene in the task sources (REQ-SEC-024, REQ-SEC-026) — SQL that lives in repository/ is covered by repository.static.test.ts', () => {
  it.each(TASKS)('%s: parameters only, every tenant-table statement names tenant_id', (f) => {
    const stmts = sql(read(f));
    expect(stmts.filter((s) => /\$\{/.test(s))).toEqual([]);
    const off = stmts.filter((s) => { const t = [...s.matchAll(/\breporting\.(\w+)/gi)].map((m) => m[1]!.toLowerCase()).filter((x) => !x.startsWith('g_') && !x.startsWith('v_pub_')); return t.length > 0 && !/\btenant_id\b/i.test(s); });
    expect(off.map((s) => s.replace(/\s+/g, ' ').slice(0, 110))).toEqual([]);
  });
  it('no task touches another module\'s tables (ports only) and none updates/deletes delivery_attempts (class A, append-only)', () => {
    for (const f of TASKS) {
      const s = read(f); expect(s.match(/\b(?:from|join|into|update)\s+(?:core|frontdesk|billing|lab|catalog|identity|partners|payments)\.\w+/gi) ?? [], f).toEqual([]);
      expect(sql(s).filter((x) => /\b(update|delete\s+from)\s+reporting\.delivery_attempts\b/i.test(x)), f).toEqual([]);
    }
  });
  it('the tasks never call Billing / Payment / SmartReport ports (C6 does not write or read money while delivering)', () => {
    for (const f of TASKS) expect(/BillingPort|PaymentProviderPort|SmartReportPort|ports\.billing/.test(strip(read(f))), f).toBe(false);
  });
});
