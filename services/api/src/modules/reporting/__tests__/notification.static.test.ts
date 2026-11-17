// C6-T19 — static guards on the NotificationPort sources + the seed (no DB, no runtime). 02-TRD §2 (only adapters talk to providers), REQ-SEC-024,
// REQ-SEC-136, LD-26 (consumers read C2 data through ports, never C2 tables), 08 A13 D-34 (seed homecollection.visit_assigned).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mod = join(here, '..');
const root = join(here, '..', '..', '..', '..', '..', '..');
const FILES = ['ports/NotificationPort.impl.ts', 'service/delivery.service.ts', 'domain/messages.ts'];
const src = (f: string) => readFileSync(join(mod, f), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('C6-T19 sources', () => {
  it('the three owned files exist', () => { for (const f of FILES) expect(existsSync(join(mod, f)), f).toBe(true); });

  it('no network / provider code and no logging of params: no fetch, http(s), net, adapters, console', () => {
    for (const f of FILES) {
      const s = strip(src(f));
      expect(s, f).not.toMatch(/\bfetch\s*\(|from\s+['"]node:(https?|net|tls|dgram|child_process)['"]|from\s+['"](https?|net)['"]|\bXMLHttpRequest\b|delivery\/adapters|\bconsole\./);
    }
  });

  it('reads C2 data through ports only (LD-26): no SQL on core.* tables from the notification sources', () => {
    for (const f of FILES) expect(strip(src(f)), f).not.toMatch(/\b(from|join|into|update)\s+core\.(?!event_log\b)\w+/i);
  });

  it('SQL on tenant tables is parameterised (no ${} inside a statement) and carries an explicit tenant_id predicate', () => {
    for (const f of FILES) {
      const s = strip(src(f));
      for (const lit of s.match(/`[^`]*`/g) ?? []) if (/\breporting\.\w+/i.test(lit)) expect(lit, `${f}: interpolated SQL`).not.toContain('${');
      for (const m of s.matchAll(/\b(from|join|update)\s+reporting\.(\w+)/gi)) {
        if (m[2]!.startsWith('g_')) continue;                           // global registry: no tenant column
        const tail = s.slice(m.index!, m.index! + 600).split(/`|;/)[0]!;
        expect(tail, `${f}: ${m[0]} without tenant_id`).toMatch(/tenant_id/i);
      }
      expect(s, f).not.toMatch(/\bdelete\s+from\s+reporting\./i);        // lims_app has no DELETE grant on deliveries
    }
  });

  it('uses the core rate limiter and events (no home-made counters, no raw phone in the limiter key)', () => {
    const s = strip(src('ports/NotificationPort.impl.ts') + src('service/delivery.service.ts'));
    expect(s).toMatch(/rateLimit\??\.consume/);
    expect(s).toMatch(/otp_request/);
    expect(s).toMatch(/reporting\.delivery\.status_changed\.v1/);
    expect(s).toMatch(/reporting\.send_delivery/);
    expect(s).toMatch(/app\.enqueue_job/);
  });

  it('exports the port factory the contract harness uses', () => {
    expect(src('ports/NotificationPort.impl.ts')).toMatch(/export\s+(async\s+)?function\s+createNotificationPort|export\s+const\s+createNotificationPort/);
  });
});

describe('C6-T19 seed (D-34): templates live in db/seeds, not only in code', () => {
  const seedDir = join(root, 'db', 'seeds');
  const text = () => readdirSync(seedDir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(seedDir, f), 'utf8')).filter((t) => /reporting\.g_message_templates/.test(t)).join('\n');
  /** The VALUES tuple that starts with the code, up to the next tuple that starts with a code literal. */
  const rowOf = (code: string) => { const t = text(); const i = t.indexOf(`'${code}'`); if (i < 0) return ''; const rest = t.slice(i + 1); const j = rest.search(/\(\s*'[a-z_]+\.[a-z0-9_]+'/); return t.slice(i, j < 0 ? undefined : i + 1 + j); };

  it('a seed file inserts into reporting.g_message_templates', () => { expect(text()).toMatch(/insert\s+into\s+reporting\.g_message_templates/i); });
  it('homecollection.visit_assigned: purpose visit_assignment, channel sms only, params route_date + visit_count (short_text)', () => {
    const r = rowOf('homecollection.visit_assigned');
    expect(r).not.toBe('');
    expect(r).toContain('visit_assignment'); expect(r).toMatch(/\bsms\b/);
    expect(r).not.toMatch(/whatsapp|email/);
    for (const p of ['route_date', 'visit_count']) expect(r).toContain(p);
    expect(r).toContain('short_text'); expect(r).not.toMatch(/\blab_name\b|\burl\b/);
  });
  it('the templates the 03-IC §4.8 contract cases use are seeded (registration_confirmation, analytics.report_ready staff_url + label_text, engagement.login_otp)', () => {
    expect(rowOf('frontdesk.registration_confirmation')).toContain('registration_confirmation');
    const a = rowOf('analytics.report_ready'); expect(a).toContain('scheduled_report_ready'); expect(a).toContain('label_text'); expect(a).toContain('staff_url');
    expect(rowOf('engagement.login_otp')).toMatch(/\botp\b/);
  });
  // LD-59 (CR-C6-024): class-G seed range (lims_owner), prod subset; lims_app cannot insert into a class-G table, so no 010+ file may carry it.
  it('LD-59: the seed is db/seeds/004_reporting__g_message_templates.sql (lims_owner, ON CONFLICT (code) DO NOTHING) and no 011 file exists', () => {
    const files = readdirSync(seedDir).filter((f) => f.endsWith('.sql'));
    expect(files).toContain('004_reporting__g_message_templates.sql');
    expect(files.filter((f) => /^01\d_/.test(f) && /g_message_templates/.test(readFileSync(join(seedDir, f), 'utf8')))).toEqual([]);
    expect(files.filter((f) => /^011_/.test(f))).toEqual([]);
    const sql = readFileSync(join(seedDir, '004_reporting__g_message_templates.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/SET\s+LOCAL\s+ROLE\s+lims_owner/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+reporting\.g_message_templates/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*code\s*\)\s+DO\s+NOTHING/i);
  });
  it('every seeded code matches g_message_templates__code__ck', () => {
    for (const m of text().matchAll(/\(\s*'([a-z_]+\.[^']+)'\s*,/g)) expect(m[1], m[1]).toMatch(/^[a-z_]+\.[a-z0-9_]{1,60}$/);
  });
});
