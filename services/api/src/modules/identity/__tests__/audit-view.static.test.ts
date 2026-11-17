// C2-T18 — static SQL hygiene of the viewer (REQ-SEC-011/017/024/026/031; 05-SCHEMA §3.2 CR-C2-010 centre clause + 08 A16.1 cast; CR-C2-002 allowlist).
// Live RLS probes for these tables already exist as db/tests/isolation/audit.*.test.sql + identity.auth_events.test.sql (C0/T0B-10.C2).
// Assumed layout: identity/repository/audit-read.repo.ts (all SQL, string/template literals), identity/service/audit-view.service.ts and
// identity/handlers/{listAuditEntries,getAuditEntry,listAccessLogEntries,listAuthEvents}.ts without SQL.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const base = join(import.meta.dirname, '..');
const read = (p: string) => (existsSync(join(base, p)) ? readFileSync(join(base, p), 'utf8') : undefined);
const repo = read('repository/audit-read.repo.ts');
const service = read('service/audit-view.service.ts');
const HANDLERS = ['listAuditEntries', 'getAuditEntry', 'listAccessLogEntries', 'listAuthEvents'];
function sqlLiterals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? '';
    if (/\b(select|insert\s+into|update|delete\s+from|with)\b[\s\S]*\b(from|into|set)\b/i.test(s) && /\b(audit|identity|core)\.\w+/i.test(s)) out.push(s);
  }
  return out;
}
const stmts = repo ? sqlLiterals(repo) : [];
const onAudit = (t: string) => /\baudit\.audit_log\b/i.test(t);
const onAccess = (t: string) => /\baudit\.access_log\b/i.test(t);
const onAuth = (t: string) => /\bidentity\.auth_events\b/i.test(t);
const viewer = (t: string) => onAudit(t) || onAccess(t) || onAuth(t);

describe('layout', () => {
  it('repository/audit-read.repo.ts, service/audit-view.service.ts and the four handlers exist', () => {
    expect(repo, 'repository/audit-read.repo.ts').toBeTruthy();
    expect(service, 'service/audit-view.service.ts').toBeTruthy();
    for (const h of HANDLERS) expect(read(`handlers/${h}.ts`), `handlers/${h}.ts`).toBeTruthy();
  });
  it('the repository has statements for all three sources', () => {
    expect(stmts.some(onAudit)).toBe(true); expect(stmts.some(onAccess)).toBe(true); expect(stmts.some(onAuth)).toBe(true);
  });
  it('service and handlers contain no SQL (single access path = the repository)', () => {
    for (const [n, t] of [['service', service], ...HANDLERS.map((h) => [h, read(`handlers/${h}.ts`)] as const)] as Array<[string, string | undefined]>) {
      expect({ file: n, sql: t ? sqlLiterals(t).length : 0 }).toEqual({ file: n, sql: 0 });
    }
  });
});

describe('every repository statement', () => {
  it('reads only the CR-C2-002 allowlisted tables: audit.audit_log, audit.access_log, identity.auth_events and core.users / core.memberships (names)', () => {
    const allowed = new Set(['audit.audit_log', 'audit.access_log', 'identity.auth_events', 'core.users', 'core.memberships']);
    for (const s of stmts) for (const m of s.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)) expect(allowed.has(m[1]!.toLowerCase()), `${m[1]} in: ${s.slice(0, 80)}`).toBe(true);
  });
  it('is read-only: the viewer never INSERTs/UPDATEs/DELETEs (the view access log goes through ctx.audit.access, never repo SQL)', () => {
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) expect(s, s.slice(0, 80)).not.toMatch(/^\s*(insert|update|delete|truncate|alter|drop|create|grant)\b/i);
    expect(repo!).not.toMatch(/audit\.access_log[\s\S]{0,40}\binsert\b|insert\s+into\s+audit\./i);
  });
  it('binds values only as parameters (no ${...} interpolation, no string concatenation into SQL, no comments)', () => {
    for (const s of stmts) { expect(s).not.toMatch(/\$\{/); expect(s).not.toMatch(/--|\/\*/); }
    expect(repo!).not.toMatch(/(?:select|from|where)[^`'"\n]*['"`]\s*\+\s*\w/i);
  });
  it('no SELECT *, no OFFSET, no views (REQ-SEC-031), no CREATE VIEW', () => {
    for (const s of stmts) { expect(s).not.toMatch(/select\s+(\w+\.)?\*/i); expect(s).not.toMatch(/\boffset\b/i); }
    expect(repo!).not.toMatch(/create\s+(or\s+replace\s+)?(materialized\s+)?view/i);
  });
  it('every statement on the viewer tables binds tenant_id = $n explicitly (REQ-SEC-024, defence in depth over RLS)', () => {
    for (const s of stmts.filter(viewer)) expect(s, s.slice(0, 100)).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
  it('every name lookup (core.users / core.memberships) binds tenant_id too ("same tenant only", 03-APP-FLOW §7.1.3)', () => {
    for (const s of stmts.filter((x) => !viewer(x))) expect(s, s.slice(0, 100)).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
  it('list statements are bounded and ordered: LIMIT, ORDER BY occurred_at with an id tie-break, occurred_at range predicates', () => {
    const lists = stmts.filter(viewer).filter((s) => /\blimit\b/i.test(s));
    for (const src of [onAudit, onAccess, onAuth]) {
      const l = lists.filter(src);
      expect(l.length, String(src)).toBeGreaterThan(0);
      for (const s of l) {
        expect(s).toMatch(/\blimit\s+(\$\d+|\d+)/i);
        expect(s).toMatch(/order\s+by\s+(\w+\.)?occurred_at\s+(asc|desc)?\s*,\s*(\w+\.)?id\b/i);
        expect(s).toMatch(/occurred_at\s*(>=|>)\s*\$\d+|occurred_at\s+between/i);
        expect(s).toMatch(/occurred_at\s*(<=|<)\s*\$\d+|occurred_at\s+between/i);
      }
    }
  });
});

describe('audit_log / access_log statements carry the CR-C2-010 centre clause in the cast form (05-SCHEMA §3.2; 08 A16.1)', () => {
  it('each audit_log / access_log SELECT has `centre_id IS NULL` and a membership-scope branch', () => {
    const rel = stmts.filter((s) => onAudit(s) || onAccess(s));
    expect(rel.length).toBeGreaterThan(0);
    for (const s of rel) {
      expect(s, s.slice(0, 100)).toMatch(/centre_id\s+IS\s+NULL/i);
      expect(s).toMatch(/has_all_centres\s*\(\s*\)|\$\d+(::boolean)?\s+OR|centre_id\s*=\s*ANY/i);
    }
  });
  it('never the uncast form `ANY ((SELECT app.current_centre_ids()))` — always `::uuid[]` (A16.1)', () => {
    for (const s of stmts) if (/current_centre_ids\s*\(\s*\)/i.test(s)) expect(s).toMatch(/current_centre_ids\s*\(\s*\)\s*\)?\s*::\s*uuid\s*\[\s*\]/i);
    expect(repo!).not.toMatch(/ANY\s*\(\s*\(\s*SELECT\s+app\.current_centre_ids\s*\(\s*\)\s*\)\s*\)(?!\s*::)/i);
  });
  it('identity.auth_events statements have no centre clause (the table has no centre_id)', () => {
    for (const s of stmts.filter(onAuth)) expect(s).not.toMatch(/centre_id/i);
  });
});

describe('sensitive columns', () => {
  it('auth_events SQL never selects email_hmac', () => { for (const s of stmts.filter(onAuth)) expect(s).not.toMatch(/email_hmac/i); });
  it('only one statement family selects old_values / new_values (the detail by id); every statement that does binds the entry id', () => {
    const withValues = stmts.filter((s) => /old_values|new_values/i.test(s));
    expect(withValues.length).toBeGreaterThan(0);
    for (const s of withValues) { expect(s).toMatch(/\bid\s*=\s*\$\d+/i); expect(s).not.toMatch(/order\s+by/i); expect(s).toMatch(/\blimit\s+1\b|\bid\s*=\s*\$\d+/i); }
  });
  it('the service logs the view through audit.access with the C0 action code `audit_entry.view` (two-segment, 08 §4.4) and no bare `view` code', () => {
    expect(service!).toMatch(/['"`]audit_entry\.view['"`]/);
    expect(service!).toMatch(/['"`]audit_entry['"`]/);
    expect(service!).not.toMatch(/action\s*:\s*['"`]view['"`]/);
  });
});
