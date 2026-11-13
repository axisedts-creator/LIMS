// C13 T07 — partner accounts, staff side (06-IMPLEMENTATION-PLAN row T07). Tests: integration (in-memory SQL world) + probes. ACs: US-01.1 – US-01.6.
// done_when: "create/update/suspend/reactivate; duplicate code/credit party; foreign credit party -> 404; syncs enqueued (CatalogPort fake)".
// Spec: 02-TRD §5.3 SA1–SA7, §6 (CatalogPort.getCreditParty, purpose 'display'), §8.1 (sync tasks + job keys), §10.2 (settings defaults);
//       03-APP-FLOW §2.4 (partner status table), §6 SA2 order; 05-SCHEMA §3.1 (partners.partners CHECKs), §3.8 (lazy settings row);
//       07-SECURITY ST5/ST8-style probes (cross-tenant, mass assignment, injection, log leak); contracts/openapi/partners.yaml (PartnerAdmin allowlist).
// LEAD DECISION LD-140 (UI only) does not apply: backend task.
//
// Interface expected from the writer (SEAM = not fixed by the spec; the writer follows it or raises a dispute):
//   ../handlers/{listPartners,createPartner,getPartner,updatePartner,suspendPartner,reactivatePartner,resyncPartnerProjections}.ts
//        one named `Handler` export per operationId, wired in manifest.handlers (boot.test IMPLEMENTED list). req = {params:{partner_id}, query, headers (lower-case keys), body};
//        the core has already validated shape/enums against OpenAPI, so the tests below never rely on handler-side schema validation.
//   ../service/partner.service.ts   (exercised only through the handlers)
//   SEAM staff actor = { type:'user', id }; permission via ctx.ports.IdentityPort.assertRole(ctx, {permission}) as FIRST call (C2 throws auth.forbidden / auth.mfa_required for
//        the privileged partners.partner.manage at aal1). SA1/SA3 -> partners.partner.read; SA2/SA4/SA5/SA6/SA7 -> partners.partner.manage.
//   SEAM credit party: ctx.ports.CatalogPort.getCreditParty(ctx, {creditPartyId, purpose:'display'}) -> {creditPartyId, code, name, isActive, ...}; C3 throws common.not_found for a foreign id.
//        credit_party in DTOs = {id: creditPartyId, party_code: code, name}. Never read from catalog tables.
//   SEAM branch/centre: ctx.core.branch(ctx,{branchId}) / ctx.core.centre(ctx,{centreId}) (core-repo; common.not_found when absent) or ctx.core.centres(ctx,{...}) for SA1 enrichment.
//        isActive=false -> 409 identity.centre_inactive; centre.branchId !== branchId -> a 4xx LimsError (code not fixed by the spec).
//   SEAM jobs: ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3[, $4, $5])', [identifier, JSON.stringify(payload), jobKey, ...]) with payload {tenant_id, partner_id} (snake_case),
//        job keys per TRD §5.3/§8.1: pricelist:<partner_id>, statements:<partner_id>, reconcile:partner:<partner_id>.
//   SEAM SQL (the fake interprets only this subset and throws on anything else):
//        INSERT INTO partners.partners (cols) VALUES (…[ON CONFLICT … DO NOTHING][RETURNING …]); INSERT INTO partners.settings … ON CONFLICT (tenant_id) DO NOTHING;
//        UPDATE partners.partners [alias] SET col = $n | 'lit' | NULL | now() | col + 1 [, …] WHERE <AND-conjunction> [RETURNING …];
//        SELECT … FROM partners.partners … WHERE <AND-conjunction of col = $n | col = 'lit' | col IS [NOT] NULL | col = ANY($n) | (partner_code ILIKE $n OR name ILIKE $n)> [ORDER BY] [LIMIT $n] [FOR UPDATE];
//        SA1 gets active_users and open_manifests as aliased columns of that one SELECT (add ::int to get numbers; a bare count() is a string like node-pg bigint).
//        The fake enforces the 05-SCHEMA §3.1 CHECKs and the two UNIQUEs (tenant_id,partner_code), (tenant_id,credit_party_id): violation = pg error 23505 with constraint
//        partners_tenant_id_partner_code_key / partners_tenant_id_credit_party_id_key; or 0 rows when the INSERT has ON CONFLICT … DO NOTHING.
//        The writer may also pre-check with a SELECT; both paths must end in 409 partners.code_duplicate / partners.credit_party_in_use.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { createPartner } from '../handlers/createPartner.js';
import { getPartner } from '../handlers/getPartner.js';
import { listPartners } from '../handlers/listPartners.js';
import { reactivatePartner } from '../handlers/reactivatePartner.js';
import { resyncPartnerProjections } from '../handlers/resyncPartnerProjections.js';
import { suspendPartner } from '../handlers/suspendPartner.js';
import { updatePartner } from '../handlers/updatePartner.js';
import { manifest } from '../index.js';
import { partnerContext } from '../service/partner-context.service.js';

// ---- synthetic ids (uuid-shaped, synthetic data only) ----
const id = (n: number) => `01940e00-0000-7000-8000-c1307${String(n).padStart(7, '0')}`;
const T_A = id(1), T_B = id(2);
const STAFF = id(3), STAFF_RO = id(4);
const BR = { a1: id(10), a2: id(11), ax: id(12), b1: id(13) };
const CE = { a1: id(20), a2: id(21), ax: id(22), b1: id(23) };
const CP = { one: id(30), two: id(31), three: id(32), inactive: id(33), b: id(34), four: id(35) };
const P = { x: id(40), s: id(41), b: id(42), bdup: id(43) };
const NOW = new Date('2026-11-13T00:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PRICELIST = 'partners.sync_price_list', STATEMENTS = 'partners.sync_statements', RECONCILE = 'partners.reconcile_orders';
const MANAGE = 'partners.partner.manage', READ = 'partners.partner.read';
const PA_KEYS = ['id', 'partner_code', 'name', 'status', 'credit_party', 'receiving_centre', 'active_users', 'open_manifests', 'receiving_branch_id', 'conversion_mode',
  'contact_email', 'contact_phone_e164', 'address_text', 'suspend_reason_code', 'created_at', 'version', 'projection_status'];
const PA_REQUIRED = ['id', 'partner_code', 'name', 'status', 'credit_party', 'receiving_centre', 'active_users', 'open_manifests', 'receiving_branch_id', 'conversion_mode', 'created_at', 'version'];
const PS_KEYS = ['id', 'partner_code', 'name', 'status', 'credit_party', 'receiving_centre', 'active_users', 'open_manifests'];
const LEAK = { email: 'leak-contact@partner.invalid', phone: '+15555550199', addr: 'Synthetic Leak Street 9', text: 'synthetic-suspend-note-leak' };

type Row = Record<string, any>;
const pgErr = (code: string, constraint: string, message: string) => Object.assign(new Error(message), { code, constraint, detail: message });

// ---- tiny SQL subset interpreter (see SEAM SQL above) ----
function balanced(s: string, open: number): { inner: string; end: number } {
  let depth = 0, q = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return { inner: s.slice(open + 1, i), end: i };
  }
  throw new Error(`unbalanced parens in: ${s}`);
}
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const TIME_COLS = /_at$/;
const toStored = (col: string, v: unknown) => (TIME_COLS.test(col) && typeof v === 'string' ? new Date(v) : v);

function makeWorld() {
  const w = {
    partners: [
      { id: P.x, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', credit_party_id: CP.two, receiving_branch_id: BR.a1, receiving_centre_id: CE.a1,
        conversion_mode: 'on_receipt', contact_email: 'x@partner.invalid', contact_phone_e164: '+15555550101', address_text: 'Synthetic Address X', suspended_at: null, suspended_by: null,
        suspend_reason_code: null, suspend_reason_text: null, version: 3, is_active: true, created_at: new Date('2026-10-01T00:00:00.000Z'), created_by: STAFF, updated_at: new Date('2026-10-02T00:00:00.000Z'), updated_by: STAFF },
      { id: P.s, tenant_id: T_A, partner_code: 'SYN-S', name: 'Synthetic Partner S', status: 'suspended', credit_party_id: CP.three, receiving_branch_id: BR.a1, receiving_centre_id: CE.a1,
        conversion_mode: 'on_submit', contact_email: null, contact_phone_e164: null, address_text: null, suspended_at: new Date('2026-10-05T00:00:00.000Z'), suspended_by: STAFF,
        suspend_reason_code: 'credit_hold', suspend_reason_text: LEAK.text, version: 2, is_active: true, created_at: new Date('2026-10-03T00:00:00.000Z'), created_by: STAFF, updated_at: new Date('2026-10-05T00:00:00.000Z'), updated_by: STAFF },
      { id: P.b, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', credit_party_id: CP.b, receiving_branch_id: BR.b1, receiving_centre_id: CE.b1,
        conversion_mode: 'on_receipt', contact_email: null, contact_phone_e164: null, address_text: null, suspended_at: null, suspended_by: null, suspend_reason_code: null, suspend_reason_text: null,
        version: 1, is_active: true, created_at: new Date('2026-10-04T00:00:00.000Z'), created_by: id(99), updated_at: new Date('2026-10-04T00:00:00.000Z'), updated_by: id(99) },
      { id: P.bdup, tenant_id: T_B, partner_code: 'SYN-DUP', name: 'Synthetic Partner Dup (tenant B)', status: 'active', credit_party_id: id(36), receiving_branch_id: BR.b1, receiving_centre_id: CE.b1,
        conversion_mode: 'on_receipt', contact_email: null, contact_phone_e164: null, address_text: null, suspended_at: null, suspended_by: null, suspend_reason_code: null, suspend_reason_text: null,
        version: 1, is_active: true, created_at: new Date('2026-10-04T00:00:00.000Z'), created_by: id(99), updated_at: new Date('2026-10-04T00:00:00.000Z'), updated_by: id(99) },
    ] as Row[],
    settings: new Map<string, Row>(),
    /** partner_users of P.x, for active_users and for the partnerContext cross-check (US-01.5). */
    users: [
      { id: id(50), tenant_id: T_A, partner_id: P.x, membership_id: id(60), partner_role: 'partner_admin', status: 'active', display_name: 'Synthetic User One' },
      { id: id(51), tenant_id: T_A, partner_id: P.x, membership_id: id(61), partner_role: 'partner_member', status: 'active', display_name: 'Synthetic User Two' },
      { id: id(52), tenant_id: T_A, partner_id: P.x, membership_id: id(62), partner_role: 'partner_member', status: 'invited', display_name: 'Synthetic User Three' },
      { id: id(53), tenant_id: T_A, partner_id: P.x, membership_id: id(63), partner_role: 'partner_member', status: 'deactivated', display_name: 'Synthetic User Four' },
    ] as Row[],
    openManifests: new Map<string, number>([[P.x, 4]]),
    /** partners.g_cs_reasons (05-SCHEMA §7): x-coded-set is annotation-only in core and the DDL has no CHECK/FK, so the service must validate (review item 1). */
    reasons: [
      { set_name: 'partner_suspend_reasons', code: 'credit_hold', requires_text: false, is_active: true, sort_order: 1 },
      { set_name: 'partner_suspend_reasons', code: 'agreement_ended', requires_text: false, is_active: true, sort_order: 2 },
      { set_name: 'partner_suspend_reasons', code: 'security_concern', requires_text: false, is_active: true, sort_order: 3 },
      { set_name: 'partner_suspend_reasons', code: 'other', requires_text: true, is_active: true, sort_order: 4 },
      { set_name: 'partner_suspend_reasons', code: 'retired_reason', requires_text: false, is_active: false, sort_order: 5 },
      { set_name: 'other_set', code: 'foreign_set_code', requires_text: false, is_active: true, sort_order: 1 },
    ] as Row[],
    branches: [
      { id: BR.a1, tenant: T_A, code: 'BR-A1', name: 'Synthetic Branch A1', active: true }, { id: BR.a2, tenant: T_A, code: 'BR-A2', name: 'Synthetic Branch A2', active: true },
      { id: BR.ax, tenant: T_A, code: 'BR-AX', name: 'Synthetic Branch AX (inactive)', active: false }, { id: BR.b1, tenant: T_B, code: 'BR-B1', name: 'Synthetic Branch B1', active: true },
    ],
    centres: [
      { id: CE.a1, tenant: T_A, branchId: BR.a1, code: 'CE-A1', name: 'Synthetic Centre A1', active: true }, { id: CE.a2, tenant: T_A, branchId: BR.a2, code: 'CE-A2', name: 'Synthetic Centre A2', active: true },
      { id: CE.ax, tenant: T_A, branchId: BR.a1, code: 'CE-AX', name: 'Synthetic Centre AX (inactive)', active: false }, { id: CE.b1, tenant: T_B, branchId: BR.b1, code: 'CE-B1', name: 'Synthetic Centre B1', active: true },
    ],
    creditParties: [
      { id: CP.one, tenant: T_A, code: 'SYN-CP-01', name: 'Synthetic Credit Party One', active: true }, { id: CP.two, tenant: T_A, code: 'SYN-CP-02', name: 'Synthetic Credit Party Two', active: true },
      { id: CP.three, tenant: T_A, code: 'SYN-CP-03', name: 'Synthetic Credit Party Three', active: true }, { id: CP.four, tenant: T_A, code: 'SYN-CP-04', name: 'Synthetic Credit Party Four', active: true },
      { id: CP.inactive, tenant: T_A, code: 'SYN-CP-IN', name: 'Synthetic Credit Party Inactive', active: false }, { id: CP.b, tenant: T_B, code: 'SYN-CP-B', name: 'Synthetic Credit Party B', active: true },
      { id: id(36), tenant: T_B, code: 'SYN-CP-B2', name: 'Synthetic Credit Party B2', active: true },
    ],
    jobs: [] as Array<{ identifier: string; payload: any; jobKey: string }>,
    log: [] as Array<{ text: string; values: unknown[] }>,
    failEnqueue: false,
    get writes() { return w.log.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text)); },
    get partnerWrites() { return w.log.filter((q) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+partners\.partners\b/i.test(q.text)); },
    snapshot: () => JSON.stringify([w.partners, [...w.settings.entries()], w.jobs]),
    countActive: (pid: string) => w.users.filter((u) => u.partner_id === pid && u.status === 'active').length,

    check(r: Row, op: string) {
      const bad = (m: string) => pgErr('23514', 'partners_check', `${op}: check violated: ${m}`);
      if (!['active', 'suspended'].includes(r['status'])) throw bad('status');
      if (typeof r['partner_code'] !== 'string' || !/^[A-Z0-9_-]{1,20}$/.test(r['partner_code'])) throw bad('partner_code');
      if (typeof r['name'] !== 'string' || r['name'].length < 1 || r['name'].length > 160) throw bad('name');
      if (!['on_receipt', 'on_submit'].includes(r['conversion_mode'])) throw bad('conversion_mode');
      if ((r['status'] === 'suspended') !== (r['suspended_at'] != null && r['suspended_by'] != null)) throw bad('suspended_at/by set iff suspended');
      if ((r['status'] === 'suspended') !== (r['suspend_reason_code'] != null)) throw bad('suspend_reason_code set iff suspended');
      if (r['suspend_reason_code'] != null && !['credit_hold', 'agreement_ended', 'security_concern', 'other'].includes(r['suspend_reason_code'])) throw bad('suspend_reason_code');
      for (const c of ['id', 'tenant_id', 'credit_party_id', 'receiving_branch_id', 'receiving_centre_id', 'created_by', 'updated_by']) if (!UUID.test(String(r[c]))) throw pgErr('23502', c, `${op}: ${c} not a uuid`);
    },
    evalExpr(e: string, values: unknown[], row?: Row): unknown {
      const x = e.trim().replace(/::\w+(\[\])?/g, '').replace(/^\((.*)\)$/s, '$1').trim();
      let m: RegExpExecArray | null;
      if ((m = /^\$(\d+)$/.exec(x))) return values[Number(m[1]) - 1];
      if ((m = /^'((?:[^']|'')*)'$/.exec(x))) return m[1]!.replace(/''/g, "'");
      if (/^NULL$/i.test(x)) return null;
      if (/^now\(\)$/i.test(x)) return NOW;
      if (/^true$/i.test(x)) return true;
      if (/^false$/i.test(x)) return false;
      if ((m = /^(?:\w+\.)?(\w+)\s*\+\s*1$/.exec(x)) && row) return Number(row[m[1]!]) + 1;
      throw new Error(`fake SQL cannot evaluate expression: ${e}`);
    },
    where(rows: Row[], clause: string, values: unknown[]): Row[] {
      let c = clause.replace(/\s+(ORDER\s+BY|LIMIT|FOR\s+UPDATE|RETURNING)\b[\s\S]*$/i, '');
      let likeVal: string | undefined;
      c = c.replace(/\([^()]*\bI?LIKE\b[^()]*\)/gi, (g) => { const n = /\$(\d+)/.exec(g)![1]; likeVal = String(values[Number(n) - 1]); return ` partner_code ILIKE $${n} `; });
      const terms = c.split(/\s+AND\s+/i).map((t) => t.trim()).filter(Boolean);
      return rows.filter((r) => terms.every((t) => {
        let m: RegExpExecArray | null;
        if (/^1\s*=\s*1$/.test(t)) return true;
        if ((m = /^\(?\s*(?:\w+\.)?(\w+)\s+I?LIKE\s+\$(\d+)\s*\)?$/i.exec(t))) likeVal = String(values[Number(m[2]) - 1]);
        if (likeVal !== undefined && /LIKE/i.test(t)) { const needle = likeVal.replace(/[%]/g, '').toLowerCase(); return String(r['partner_code']).toLowerCase().includes(needle) || String(r['name']).toLowerCase().includes(needle); }
        if ((m = /^\(?\s*(?:\w+\.)?(\w+)\s+IS\s+(NOT\s+)?NULL\s*\)?$/i.exec(t))) return m[2] ? r[m[1]!] != null : r[m[1]!] == null;
        if ((m = /^\(?\s*(?:\w+\.)?(\w+)\s*=\s*ANY\s*\(\s*\$(\d+)(?:::\w+\[\])?\s*\)\s*\)?$/i.exec(t))) return (values[Number(m[2]) - 1] as unknown[]).includes(r[m[1]!]);
        if ((m = /^\(?\s*(?:\w+\.)?(\w+)\s*(=|<>|!=|>|<)\s*(.+?)\s*\)?$/.exec(t))) {
          const l = r[m[1]!], v = w.evalExpr(m[3]!, values, r);
          const [a, b] = [l instanceof Date ? l.getTime() : l, v instanceof Date ? v.getTime() : v];
          return m[2] === '=' ? a === b : m[2] === '>' ? (a as any) > (b as any) : m[2] === '<' ? (a as any) < (b as any) : a !== b;
        }
        throw new Error(`fake SQL cannot evaluate WHERE term: ${t}`);
      }));
    },
    newTx() {
      return {
        startedAt: NOW, operation: {}, savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(w.newTx()),
        async query(text: string, values: unknown[] = []) {
          await Promise.resolve(); // yield: lets two concurrent handlers interleave between pre-check and insert
          w.log.push({ text, values: [...values] });
          if (/app\.enqueue_job/i.test(text)) {
            if (w.failEnqueue) throw new Error('queue unavailable');
            w.jobs.push({ identifier: String(values[0]), payload: JSON.parse(String(values[1])), jobKey: String(values[2]) });
            return { rows: [{ enqueue_job: null }], rowCount: 1 };
          }
          if (/\bmembership_id\b/i.test(text) && /\bFROM\s+partners\.partner_users\b/i.test(text)) { // T03 partnerContext lookup, no RLS
            const u = w.users.find((z) => values.includes(z.tenant_id) && values.includes(z.membership_id));
            const p = u && w.partners.find((z) => z.tenant_id === u.tenant_id && z.id === u.partner_id);
            return { rows: u && p ? [{ partner_user_id: u.id, partner_id: u.partner_id, partner_role: u.partner_role, user_status: u.status, partner_status: p['status'], display_name: u.display_name,
              partner_code: p['partner_code'], partner_name: p['name'], conversion_mode: p['conversion_mode'], access_slip_enabled: null, include_default_price_list: null }] : [] };
          }
          if (/^\s*INSERT\s+INTO\s+partners\.settings\b/i.test(text)) {
            const t = values.find((v) => v === T_A || v === T_B) as string;
            if (!w.settings.has(t)) w.settings.set(t, { default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false });
            return { rows: [], rowCount: 1 };
          }
          if (/\bFROM\s+partners\.settings\b/i.test(text) && !/partners\.partners/i.test(text)) {
            const s = [...w.settings.entries()].find(([t]) => values.includes(t));
            return { rows: s ? [{ tenant_id: s[0], ...s[1] }] : [] };
          }
          if (/^\s*INSERT\s+INTO\s+partners\.partners\b/i.test(text)) {
            const cols = splitTop(/\(([^)]*)\)\s*VALUES/is.exec(text)![1]!);
            const v0 = text.search(/VALUES\s*\(/i); const { inner } = balanced(text, text.indexOf('(', v0));
            const exprs = splitTop(inner);
            const row: Row = { status: 'active', version: 1, is_active: true, contact_email: null, contact_phone_e164: null, address_text: null, suspended_at: null, suspended_by: null,
              suspend_reason_code: null, suspend_reason_text: null, created_at: NOW, updated_at: NOW };
            cols.forEach((c, i) => { row[c.trim()] = toStored(c.trim(), w.evalExpr(exprs[i]!, values)); });
            w.check(row, 'INSERT');
            const dupCode = w.partners.some((p) => p['tenant_id'] === row['tenant_id'] && p['partner_code'] === row['partner_code']);
            const dupCp = w.partners.some((p) => p['tenant_id'] === row['tenant_id'] && p['credit_party_id'] === row['credit_party_id']);
            if (dupCode || dupCp) {
              if (/ON\s+CONFLICT/i.test(text)) return { rows: [], rowCount: 0 };
              throw pgErr('23505', dupCode ? 'partners_tenant_id_partner_code_key' : 'partners_tenant_id_credit_party_id_key', `duplicate key (${dupCode ? 'partner_code' : 'credit_party_id'})`);
            }
            w.partners.push(row);
            return { rows: /RETURNING/i.test(text) ? [{ ...row }] : [], rowCount: 1 };
          }
          if (/^\s*UPDATE\s+partners\.partners\b/i.test(text)) {
            const m = /UPDATE\s+partners\.partners\s+(?:AS\s+)?(?:(?!SET\b)\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(text);
            if (!m) throw new Error(`fake SQL cannot parse UPDATE: ${text}`);
            const hit = w.where(w.partners, m[2]!, values);
            const sets = splitTop(m[1]!).map((s) => { const mm = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(s); if (!mm) throw new Error(`fake SQL cannot parse SET: ${s}`); return [mm[1]!, mm[2]!] as const; });
            const out: Row[] = [];
            for (const r of hit) {
              const next = { ...r };
              for (const [c, e] of sets) next[c] = toStored(c, w.evalExpr(e, values, r));
              w.check(next, 'UPDATE'); Object.assign(r, next); out.push({ ...r });
            }
            return { rows: /RETURNING/i.test(text) ? out : [], rowCount: out.length };
          }
          if (/^\s*SELECT\b/i.test(text) && /\bFROM\s+partners\.g_cs_reasons\b/i.test(text)) { // set_name / code may be literal or bound
            const rows = w.reasons.filter((r) => (text.includes(`'${r['set_name']}'`) || values.includes(r['set_name'])) && (!/\bcode\s*=\s*\$\d+/i.test(text) || values.includes(r['code'])));
            return { rows: rows.map((r) => ({ ...r })) };
          }
          if (/^\s*SELECT\b/i.test(text) && /\bpartners\.partners\b/i.test(text)) {
            const wm = /\bWHERE\b([\s\S]*)$/i.exec(text);
            let rows = wm ? w.where(w.partners, wm[1]!, values) : [...w.partners];
            rows = [...rows].sort((a, b) => (/ORDER\s+BY[\s\S]*created_at\s+DESC/i.test(text) ? b['created_at'].getTime() - a['created_at'].getTime() : String(a['partner_code']).localeCompare(String(b['partner_code']))));
            const lim = /LIMIT\s+\$(\d+)/i.exec(text); if (lim) rows = rows.slice(0, Number(values[Number(lim[1]) - 1]));
            const num = /::\s*(int|integer)\b/i.test(text);
            const cnt = (n: number) => (num ? n : String(n));
            return { rows: rows.map((r) => ({ ...r, active_users: cnt(w.countActive(r['id'])), open_manifests: cnt(w.openManifests.get(r['id']) ?? 0) })) };
          }
          throw new Error(`unexpected SQL in partner accounts: ${text}`);
        },
      };
    },
  };
  return w;
}
type World = ReturnType<typeof makeWorld>;

interface Over { actor?: Record<string, unknown>; perms?: string[]; aal?: 'aal1' | 'aal2'; centreFail?: boolean }
function makeCtx(w: World, over: Over = {}) {
  const calls: string[] = [];
  const cpCalls: Array<{ creditPartyId: string; purpose: unknown; tenantId?: string }> = [];
  const logs: string[] = [];
  const audits: unknown[] = [];
  const actor: any = over.actor ?? { type: 'user', id: STAFF, membershipId: id(70) };
  const perms = over.perms ?? [READ, MANAGE];
  const permsOfType = (t: string) => (t === 'user' ? perms : t === 'partner' ? ['partners.order.read', 'partners.report.read', 'partners.manifest.submit', 'partners.partner_user.manage'] : []);
  const scoped = <T extends { id: string; tenant: string }>(list: T[], key: string) => list.find((x) => x.id === key && x.tenant === T_A);
  const ctx: any = {
    tenantId: T_A, actor, requestId: id(98), tx: w.newTx(), now: () => '2026-11-13T00:00:00.000Z',
    db: { async tx(fn: (c: unknown) => Promise<unknown>) { return fn(ctx); } },
    core: {
      async branch(_c: unknown, i: { branchId: string }) {
        calls.push('core.branch'); const b = scoped(w.branches, i.branchId); if (!b) throw new LimsError('common.not_found');
        return { id: b.id, branchCode: b.code, name: b.name, isProcessingLab: false, isActive: b.active };
      },
      async centre(_c: unknown, i: { centreId: string }) {
        calls.push('core.centre'); const c = scoped(w.centres, i.centreId); if (!c) throw new LimsError('common.not_found');
        return { id: c.id, branchId: c.branchId, centreCode: c.code, name: c.name, centreKind: 'own', isActive: c.active };
      },
      async centres() { calls.push('core.centres'); return w.centres.filter((c) => c.tenant === T_A).map((c) => ({ id: c.id, branchId: c.branchId, centreCode: c.code, name: c.name, centreKind: 'own', isActive: c.active })); },
      async tenant() { calls.push('core.tenant'); return { id: T_A, tenantCode: 'syn_lab', displayName: 'Synthetic Lab', legalName: 'x', status: 'active', timezone: 'Asia/Kathmandu' }; },
    },
    audit: { access: async (e: unknown) => { audits.push(e); } }, events: {}, uploads: {}, files: {}, storage: {}, services: {},
    log: { info: (o: object) => logs.push(JSON.stringify(o)), warn: (o: object) => logs.push(JSON.stringify(o)), error: (o: object) => logs.push(JSON.stringify(o)) },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, r: { permission: string }) {
          calls.push(`assertRole:${r.permission}`);
          if (!permsOfType(actor.type).includes(r.permission)) throw new LimsError('auth.forbidden');
          if (r.permission === MANAGE && (over.aal ?? 'aal2') !== 'aal2') throw new LimsError('auth.mfa_required'); // privileged -> aal2 (US-01.4)
        },
      },
      CatalogPort: {
        async getCreditParty(_c: unknown, i: { creditPartyId: string; purpose: unknown }) {
          calls.push('CatalogPort.getCreditParty'); cpCalls.push({ creditPartyId: i.creditPartyId, purpose: i.purpose, tenantId: T_A });
          const cp = scoped(w.creditParties, i.creditPartyId); if (!cp) throw new LimsError('common.not_found'); // C3 never returns another tenant's party
          return { creditPartyId: cp.id, code: cp.code, name: cp.name, kind: 'hospital', allowsCredit: true, isActive: cp.active };
        },
      },
    },
  };
  return { ctx, calls, cpCalls, logs, audits };
}

const IFM = (v: number) => ({ 'if-match': `"${v}"` });
const req = (over: { partner_id?: string; body?: unknown; headers?: Record<string, string>; query?: Record<string, unknown> } = {}) =>
  ({ params: over.partner_id ? { partner_id: over.partner_id } : {}, query: over.query ?? {}, headers: over.headers ?? {}, body: over.body });
type Out = { status: number; body: any };
const call = (h: (r: any, c: any) => Promise<unknown>, ctx: unknown, r: unknown) => h(r, ctx) as Promise<Out>;
const fails = async (p: Promise<unknown>, code: string, status: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(code); expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const CREATE = { partner_code: 'SYN-NEW', name: 'Synthetic New Partner', credit_party_id: CP.one, receiving_branch_id: BR.a1, receiving_centre_id: CE.a1 };
const jobsOf = (w: World, pid: string) => w.jobs.filter((j) => j.payload?.partner_id === pid);
const row = (w: World, pid: string) => w.partners.find((p) => p['id'] === pid)!;
const untouched = (w: World, before: string) => { expect(w.writes).toEqual([]); expect(w.jobs).toEqual([]); expect(w.snapshot()).toBe(before); };

describe('T07 manifest wiring', () => {
  it('SA1–SA7 are wired to the handlers (T01 stubs replaced)', () => {
    const wired = { listPartners, createPartner, getPartner, updatePartner, suspendPartner, reactivatePartner, resyncPartnerProjections };
    for (const [op, h] of Object.entries(wired)) { expect(typeof h).toBe('function'); expect(manifest.handlers[op]).toBe(h); }
  });
});

describe('T07 SA2 createPartner — US-01.1', () => {
  it('201: row inserted active for tenant A, DTO = PartnerAdmin allowlist, settings row created, both syncs enqueued (job keys, payload)', async () => {
    const w = makeWorld(); const { ctx, cpCalls } = makeCtx(w);
    const r = await call(createPartner, ctx, req({ body: { ...CREATE, contact_email: 'new@partner.invalid', contact_phone_e164: '+15555550123', address_text: 'Synthetic Address, Ward 1' } }));
    expect(r.status).toBe(201);
    const db = w.partners.find((p) => p['partner_code'] === 'SYN-NEW')!;
    expect(db).toMatchObject({ tenant_id: T_A, status: 'active', credit_party_id: CP.one, receiving_branch_id: BR.a1, receiving_centre_id: CE.a1, conversion_mode: 'on_receipt', version: 1,
      name: 'Synthetic New Partner', contact_email: 'new@partner.invalid', contact_phone_e164: '+15555550123', address_text: 'Synthetic Address, Ward 1', suspended_at: null, created_by: STAFF, updated_by: STAFF });
    expect(db['id']).toMatch(UUID);
    expect(r.body.id).toBe(db['id']);
    for (const k of Object.keys(r.body)) expect(PA_KEYS).toContain(k);
    for (const k of PA_REQUIRED) expect(r.body).toHaveProperty(k);
    expect(r.body).toMatchObject({ partner_code: 'SYN-NEW', name: 'Synthetic New Partner', status: 'active', receiving_branch_id: BR.a1, conversion_mode: 'on_receipt', version: 1, active_users: 0, open_manifests: 0 });
    expect(r.body.credit_party).toEqual({ id: CP.one, party_code: 'SYN-CP-01', name: 'Synthetic Credit Party One' });
    expect(r.body.receiving_centre).toEqual({ id: CE.a1, code: 'CE-A1', name: 'Synthetic Centre A1' });
    expect(r.body.created_at).toMatch(ISO);
    expect(cpCalls).toEqual([{ creditPartyId: CP.one, purpose: 'display', tenantId: T_A }]);
    expect(w.settings.get(T_A)).toMatchObject({ default_conversion_mode: 'on_receipt', include_default_price_list: true }); // 05-SCHEMA §3.8, same tx
    const jobs = jobsOf(w, db['id']);
    expect(jobs.map((j) => [j.identifier, j.jobKey]).sort()).toEqual([[PRICELIST, `pricelist:${db['id']}`], [STATEMENTS, `statements:${db['id']}`]]);
    for (const j of jobs) expect(j.payload).toMatchObject({ tenant_id: T_A, partner_id: db['id'] });
    expect(w.jobs).toHaveLength(2);
  });

  it('conversion_mode: absent -> partners.settings.default_conversion_mode (on_submit); present in body -> body wins', async () => {
    const w = makeWorld(); w.settings.set(T_A, { default_conversion_mode: 'on_submit', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false });
    const r1 = await call(createPartner, makeCtx(w).ctx, req({ body: CREATE }));
    expect(r1.body.conversion_mode).toBe('on_submit');
    const r2 = await call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-NEW2', credit_party_id: CP.four, conversion_mode: 'on_receipt' } }));
    expect(r2.body.conversion_mode).toBe('on_receipt');
    expect(w.settings.get(T_A)!['default_conversion_mode']).toBe('on_submit'); // an existing settings row is never overwritten (ON CONFLICT DO NOTHING)
  });

  it('SA2 order (03-APP-FLOW §6): assertRole(partners.partner.manage) first, then credit party, then branch/centre; the INSERT comes last, after every check', async () => {
    const w = makeWorld(); const { ctx, calls } = makeCtx(w);
    await call(createPartner, ctx, req({ body: CREATE }));
    expect(calls[0]).toBe(`assertRole:${MANAGE}`);
    expect(calls.indexOf('CatalogPort.getCreditParty')).toBeGreaterThan(0);
    expect(calls).toContain('core.centre');
    expect(calls.indexOf('CatalogPort.getCreditParty')).toBeLessThan(calls.indexOf('core.centre'));
    expect(w.log.some((q) => /^\s*INSERT\s+INTO\s+partners\.partners\b/i.test(q.text))).toBe(true);
  });

  it('created_by / updated_by come from the staff actor only; planted body fields (status, tenant_id, id, version, created_by, is_active) never reach the row', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const planted = { ...CREATE, status: 'suspended', tenant_id: T_B, id: id(77), version: 9, created_by: id(78), updated_by: id(78), is_active: false, suspended_at: '2026-01-01T00:00:00Z' };
    const out = await call(createPartner, ctx, req({ body: planted })).then((r) => r, (e) => e);
    if (out instanceof LimsError) { expect(out.code).toBe('common.validation_failed'); expect(w.partnerWrites).toEqual([]); return; }
    expect(out.status).toBe(201);
    const db = w.partners.find((p) => p['partner_code'] === 'SYN-NEW')!;
    expect(db).toMatchObject({ tenant_id: T_A, status: 'active', version: 1, created_by: STAFF, updated_by: STAFF, is_active: true, suspended_at: null });
    expect(db['id']).not.toBe(id(77));
  });

  it('hostile name / address is only ever a bound parameter (no string-built SQL); contact data is not logged', async () => {
    const w = makeWorld(); const { ctx, logs } = makeCtx(w);
    const name = `x'); DROP TABLE partners.partners;--`;
    const r = await call(createPartner, ctx, req({ body: { ...CREATE, name, contact_email: LEAK.email, contact_phone_e164: LEAK.phone, address_text: LEAK.addr } }));
    expect(r.status).toBe(201);
    expect(r.body.name).toBe(name);
    for (const q of w.log) { expect(q.text).not.toMatch(/DROP\s+TABLE/i); expect(q.text).not.toContain(LEAK.email); expect(q.text).not.toContain('SYN-NEW'); }
    expect(w.log.some((q) => q.values.includes(name))).toBe(true);
    for (const l of logs) for (const s of [LEAK.email, LEAK.phone, LEAK.addr]) expect(l).not.toContain(s);
  });

  it('a failing job enqueue fails the whole request (the pipeline then rolls back the row): the error is not swallowed', async () => {
    const w = makeWorld(); w.failEnqueue = true; const { ctx } = makeCtx(w);
    await expect(call(createPartner, ctx, req({ body: CREATE }))).rejects.toThrow();
  });
});

describe('T07 SA2 createPartner — duplicates (US-01.2, US-01.6) and foreign/inactive references (US-01.3)', () => {
  it('US-01.2 same partner_code in tenant A -> 409 partners.code_duplicate; no new row, no job, no settings write', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot(); const n = w.partners.length;
    const e = await fails(call(createPartner, ctx, req({ body: { ...CREATE, partner_code: 'SYN-X' } })), 'partners.code_duplicate', 409);
    expect(JSON.stringify(e)).not.toContain(P.x);
    expect(w.partners).toHaveLength(n); expect(w.jobs).toEqual([]);
    expect(w.partners.filter((p) => p['partner_code'] === 'SYN-X')).toHaveLength(1);
    expect(row(w, P.x)).toMatchObject({ name: 'Synthetic Partner X', version: 3, credit_party_id: CP.two }); // the existing partner is untouched
    void before; // the fake has no rollback: only rows and jobs are asserted here, the pipeline rolls the rest back
  });

  it('the same partner_code in tenant B does not clash (uniqueness is per tenant) and the error never confirms another tenant\'s code', async () => {
    const w = makeWorld();
    const ok = await call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-DUP' } }));
    expect(ok.status).toBe(201);
    expect(w.partners.filter((p) => p['partner_code'] === 'SYN-DUP').map((p) => p['tenant_id']).sort()).toEqual([T_A, T_B].sort());
  });

  it('US-01.6 credit party already linked to another partner of tenant A -> 409 partners.credit_party_in_use; no row, no job', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const n = w.partners.length;
    await fails(call(createPartner, ctx, req({ body: { ...CREATE, credit_party_id: CP.two } })), 'partners.credit_party_in_use', 409); // CP.two belongs to P.x
    expect(w.partners).toHaveLength(n); expect(w.jobs).toEqual([]);
    expect(w.partners.find((p) => p['partner_code'] === 'SYN-NEW')).toBeUndefined();
  });

  it('US-01.6 also holds for a SUSPENDED partner\'s credit party (statements are per credit party)', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    await fails(call(createPartner, ctx, req({ body: { ...CREATE, credit_party_id: CP.three } })), 'partners.credit_party_in_use', 409); // CP.three belongs to suspended P.s
    expect(w.jobs).toEqual([]);
  });

  it('race: two concurrent creates with the same partner_code -> exactly one 201, the loser is 409 partners.code_duplicate (not a 500)', async () => {
    const w = makeWorld();
    const a = call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-RACE', credit_party_id: CP.one } }));
    const b = call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-RACE', credit_party_id: CP.four } }));
    const res = await Promise.allSettled([a, b]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(LimsError); expect(lost.reason.code).toBe('partners.code_duplicate'); expect(lost.reason.statusCode).toBe(409);
    expect(w.partners.filter((p) => p['partner_code'] === 'SYN-RACE')).toHaveLength(1);
  });

  it('race: two concurrent creates with the same credit party -> one 201, the loser is 409 partners.credit_party_in_use', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([
      call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-R1' } })),
      call(createPartner, makeCtx(w).ctx, req({ body: { ...CREATE, partner_code: 'SYN-R2' } })),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('partners.credit_party_in_use'); expect(lost.reason.statusCode).toBe(409);
    expect(w.partners.filter((p) => p['credit_party_id'] === CP.one)).toHaveLength(1);
  });

  it('US-01.3 credit party of tenant B -> 404 common.not_found, nothing written, no job, and the id is not echoed', async () => {
    const w = makeWorld(); const { ctx, cpCalls } = makeCtx(w); const before = w.snapshot();
    const e = await fails(call(createPartner, ctx, req({ body: { ...CREATE, credit_party_id: CP.b } })), 'common.not_found', 404);
    expect(JSON.stringify(e)).not.toContain(CP.b);
    untouched(w, before);
    expect(cpCalls).toHaveLength(1); expect(cpCalls[0]!.purpose).toBe('display');
  });

  it('unknown credit party id -> 404 (same answer as a foreign one: no existence oracle)', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(createPartner, ctx, req({ body: { ...CREATE, credit_party_id: id(888) } })), 'common.not_found', 404);
    untouched(w, before);
  });

  it('inactive credit party -> 422 partners.credit_party_inactive; nothing written', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(createPartner, ctx, req({ body: { ...CREATE, credit_party_id: CP.inactive } })), 'partners.credit_party_inactive', 422);
    untouched(w, before);
  });

  it('receiving centre of tenant B / unknown -> 404; branch of tenant B -> 404; nothing written', async () => {
    for (const body of [{ ...CREATE, receiving_centre_id: CE.b1 }, { ...CREATE, receiving_branch_id: BR.b1 }, { ...CREATE, receiving_centre_id: id(889) }]) {
      const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
      await fails(call(createPartner, ctx, req({ body })), 'common.not_found', 404);
      untouched(w, before);
    }
  });

  it('inactive centre or inactive branch -> 409 identity.centre_inactive; nothing written', async () => {
    for (const body of [{ ...CREATE, receiving_centre_id: CE.ax }, { ...CREATE, receiving_branch_id: BR.ax }]) {
      const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
      await fails(call(createPartner, ctx, req({ body })), 'identity.centre_inactive', 409);
      untouched(w, before);
    }
  });

  it('centre that does not belong to the given branch -> rejected with a 4xx LimsError; nothing written', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    const e: any = await call(createPartner, ctx, req({ body: { ...CREATE, receiving_branch_id: BR.a1, receiving_centre_id: CE.a2 } })).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(LimsError); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    untouched(w, before);
  });
});

describe('T07 authorisation of SA1–SA7 — US-01.4 and actor probes', () => {
  const MANAGE_OPS: Array<[string, (w: World, c: any) => Promise<Out>]> = [
    ['createPartner', (_w, c) => call(createPartner, c, req({ body: CREATE }))],
    ['updatePartner', (_w, c) => call(updatePartner, c, req({ partner_id: P.x, headers: IFM(3), body: { name: 'Renamed' } }))],
    ['suspendPartner', (_w, c) => call(suspendPartner, c, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'credit_hold' } }))],
    ['reactivatePartner', (_w, c) => call(reactivatePartner, c, req({ partner_id: P.s, headers: IFM(2) }))],
    ['resyncPartnerProjections', (_w, c) => call(resyncPartnerProjections, c, req({ partner_id: P.x, body: { scopes: ['price_list'] } }))],
  ];
  const READ_OPS: Array<[string, (c: any) => Promise<Out>]> = [
    ['listPartners', (c) => call(listPartners, c, req())],
    ['getPartner', (c) => call(getPartner, c, req({ partner_id: P.x }))],
  ];

  for (const [name, run] of MANAGE_OPS) {
    it(`${name}: staff at aal1 -> 403 auth.mfa_required; no SQL, no port call, no job (US-01.4)`, async () => {
      const w = makeWorld(); const { ctx, calls } = makeCtx(w, { aal: 'aal1' });
      await fails(run(w, ctx), 'auth.mfa_required', 403);
      expect(w.log).toEqual([]); expect(w.jobs).toEqual([]);
      expect(calls).toEqual([`assertRole:${MANAGE}`]);
    });
    it(`${name}: staff with partners.partner.read only -> 403 auth.forbidden; nothing happens`, async () => {
      const w = makeWorld(); const { ctx, calls } = makeCtx(w, { perms: [READ] });
      await fails(run(w, ctx), 'auth.forbidden', 403);
      expect(w.log).toEqual([]); expect(w.jobs).toEqual([]); expect(calls).toEqual([`assertRole:${MANAGE}`]);
    });
    for (const type of ['partner', 'portal', 'patient', 'device']) {
      it(`${name}: ${type} actor -> 403 auth.forbidden before any SQL / port call`, async () => {
        const w = makeWorld(); const { ctx, calls } = makeCtx(w, { actor: { type, id: id(71), membershipId: id(72) } });
        await fails(run(w, ctx), 'auth.forbidden', 403);
        expect(w.log).toEqual([]); expect(w.jobs).toEqual([]);
        expect(calls.filter((c) => !c.startsWith('assertRole'))).toEqual([]);
      });
    }
  }
  for (const [name, run] of READ_OPS) {
    it(`${name}: needs partners.partner.read (staff without it 403), works at aal1 (not privileged), partner actor 403, no writes`, async () => {
      const w = makeWorld();
      await fails(run(makeCtx(w, { perms: [] }).ctx), 'auth.forbidden', 403);
      await fails(run(makeCtx(w, { actor: { type: 'partner', id: id(71), membershipId: id(72) } }).ctx), 'auth.forbidden', 403);
      expect(w.log).toEqual([]);
      const c = makeCtx(w, { aal: 'aal1', perms: [READ] });
      expect((await run(c.ctx)).status).toBe(200);
      expect(c.calls[0]).toBe(`assertRole:${READ}`); expect(w.writes).toEqual([]); expect(w.jobs).toEqual([]);
    });
  }
});

describe('T07 SA1 listPartners / SA3 getPartner', () => {
  it('SA1: only tenant A rows, PartnerAdminSummary allowlist, credit party + centre enrichment, integer counts, page.limit', async () => {
    const w = makeWorld(); const { ctx, cpCalls } = makeCtx(w);
    const r = await call(listPartners, ctx, req());
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.partner_code).sort()).toEqual(['SYN-S', 'SYN-X']);
    expect(JSON.stringify(r.body)).not.toMatch(/SYN-B|SYN-DUP|Synthetic Partner B|Synthetic Branch B1/);
    for (const d of r.body.data) { for (const k of Object.keys(d)) expect(PS_KEYS).toContain(k); for (const k of PS_KEYS) expect(d).toHaveProperty(k); }
    const x = r.body.data.find((d: any) => d.id === P.x);
    expect(x).toMatchObject({ partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', active_users: 2, open_manifests: 4 });
    expect(x.credit_party).toEqual({ id: CP.two, party_code: 'SYN-CP-02', name: 'Synthetic Credit Party Two' });
    expect(x.receiving_centre).toEqual({ id: CE.a1, code: 'CE-A1', name: 'Synthetic Centre A1' });
    expect(typeof x.active_users).toBe('number'); expect(typeof x.open_manifests).toBe('number');
    expect(r.body.page).toMatchObject({ limit: expect.any(Number) });
    expect(JSON.stringify(r.body)).not.toMatch(/x@partner\.invalid|Synthetic Address X|synthetic-suspend-note-leak/); // contact / reason text are not summary fields
    expect(cpCalls.every((c) => c.purpose === 'display')).toBe(true);
    expect(w.writes).toEqual([]);
  });

  it('SA1: status filter and q (code or name, case-insensitive) are applied; the tenant is bound in every statement', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const s = await call(listPartners, ctx, req({ query: { status: 'suspended' } }));
    expect(s.body.data.map((d: any) => d.partner_code)).toEqual(['SYN-S']);
    const q = await call(listPartners, ctx, req({ query: { q: 'partner x' } }));
    expect(q.body.data.map((d: any) => d.partner_code)).toEqual(['SYN-X']);
    const c = await call(listPartners, ctx, req({ query: { q: 'syn-s' } }));
    expect(c.body.data.map((d: any) => d.partner_code)).toEqual(['SYN-S']);
    for (const stmt of w.log.filter((l) => /partners\.partners/i.test(l.text))) expect(stmt.values).toContain(T_A);
  });

  it('SA1: q with SQL metacharacters is a bound parameter, never part of the statement text', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const q = `'; DROP TABLE partners.partners; --`;
    const r = await call(listPartners, ctx, req({ query: { q } }));
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
    for (const l of w.log) expect(l.text).not.toContain('DROP TABLE');
  });

  it('SA3: 200 with PartnerAdmin (+ version); a SUSPENDED partner is still readable by staff (US-01.5); no suspend_reason_text / tenant_id / audit columns on the wire', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const r = await call(getPartner, ctx, req({ partner_id: P.s }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: P.s, partner_code: 'SYN-S', status: 'suspended', version: 2, conversion_mode: 'on_submit', suspend_reason_code: 'credit_hold', receiving_branch_id: BR.a1 });
    for (const k of Object.keys(r.body)) expect(PA_KEYS).toContain(k);
    for (const k of PA_REQUIRED) expect(r.body).toHaveProperty(k);
    expect(JSON.stringify(r.body)).not.toContain(LEAK.text); expect(JSON.stringify(r.body)).not.toContain(T_A);
    expect(r.body.credit_party).toEqual({ id: CP.three, party_code: 'SYN-CP-03', name: 'Synthetic Credit Party Three' });
  });

  it('SA3: partner of tenant B and unknown id -> the same 404 common.not_found (no existence oracle)', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const a = await fails(call(getPartner, ctx, req({ partner_id: P.b })), 'common.not_found', 404);
    const b = await fails(call(getPartner, ctx, req({ partner_id: id(890) })), 'common.not_found', 404);
    expect(a.message).toBe(b.message);
    expect(JSON.stringify(a)).not.toContain('SYN-B');
  });
});

describe('T07 SA4 updatePartner', () => {
  it('200: mutable fields change, version +1, updated_by = staff, credit party / code / status untouched, price-list sync enqueued (TRD §8.1 sync_price_list trigger)', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const r = await call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { name: 'Renamed Partner X', receiving_branch_id: BR.a2, receiving_centre_id: CE.a2, conversion_mode: 'on_submit', contact_phone_e164: '+15555550177', address_text: 'Synthetic New Address' } }));
    expect(r.status).toBe(200);
    expect(row(w, P.x)).toMatchObject({ name: 'Renamed Partner X', receiving_branch_id: BR.a2, receiving_centre_id: CE.a2, conversion_mode: 'on_submit', contact_phone_e164: '+15555550177',
      address_text: 'Synthetic New Address', contact_email: 'x@partner.invalid', version: 4, updated_by: STAFF, partner_code: 'SYN-X', credit_party_id: CP.two, status: 'active', tenant_id: T_A });
    expect(r.body).toMatchObject({ id: P.x, name: 'Renamed Partner X', version: 4, conversion_mode: 'on_submit', receiving_branch_id: BR.a2 });
    expect(r.body.receiving_centre).toEqual({ id: CE.a2, code: 'CE-A2', name: 'Synthetic Centre A2' });
    expect(jobsOf(w, P.x).map((j) => [j.identifier, j.jobKey])).toContainEqual([PRICELIST, `pricelist:${P.x}`]);
  });

  it('unset[] clears exactly the named optional columns (NULL), others stay', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const r = await call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { unset: ['contact_email', 'address_text'] } }));
    expect(r.status).toBe(200);
    expect(row(w, P.x)).toMatchObject({ contact_email: null, address_text: null, contact_phone_e164: '+15555550101', version: 4 });
    expect(r.body.contact_email).toBeUndefined(); expect(r.body.address_text).toBeUndefined(); expect(r.body.contact_phone_e164).toBe('+15555550101');
  });

  it('If-Match missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; row and jobs untouched', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(updatePartner, ctx, req({ partner_id: P.x, body: { name: 'Nope' } })), 'common.precondition_required', 428);
    await fails(call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(2), body: { name: 'Nope' } })), 'common.version_conflict', 409);
    expect(w.snapshot()).toBe(before); expect(w.jobs).toEqual([]);
  });

  it('two updates with the same If-Match: one wins, the other is 409 common.version_conflict (lost update impossible)', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([
      call(updatePartner, makeCtx(w).ctx, req({ partner_id: P.x, headers: IFM(3), body: { name: 'Winner A' } })),
      call(updatePartner, makeCtx(w).ctx, req({ partner_id: P.x, headers: IFM(3), body: { name: 'Winner B' } })),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('common.version_conflict');
    expect(row(w, P.x)['version']).toBe(4);
  });

  it('mass-assignment probe: credit_party_id, partner_code, status, tenant_id, version in the body never change those columns (400 validation_failed or ignored)', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const out = await call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { name: 'Probe', credit_party_id: CP.one, partner_code: 'HACK', status: 'suspended', tenant_id: T_B, version: 99, created_by: id(79) } })).then((r) => r, (e) => e);
    if (out instanceof LimsError) expect(out.code).toBe('common.validation_failed');
    expect(row(w, P.x)).toMatchObject({ credit_party_id: CP.two, partner_code: 'SYN-X', status: 'active', tenant_id: T_A, created_by: STAFF });
    expect(row(w, P.x)['version']).toBeLessThanOrEqual(4);
  });

  it('partner of tenant B / unknown id -> 404; tenant B row is unchanged', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const b0 = JSON.stringify(row(w, P.b));
    await fails(call(updatePartner, ctx, req({ partner_id: P.b, headers: IFM(1), body: { name: 'Takeover' } })), 'common.not_found', 404);
    await fails(call(updatePartner, ctx, req({ partner_id: id(891), headers: IFM(1), body: { name: 'Nope' } })), 'common.not_found', 404);
    expect(JSON.stringify(row(w, P.b))).toBe(b0); expect(w.jobs).toEqual([]);
  });

  it('centre / branch checks as SA2: inactive centre -> 409 identity.centre_inactive, foreign centre -> 404, centre outside the (unchanged) branch -> 4xx; nothing written', async () => {
    for (const [body, code, status] of [[{ receiving_centre_id: CE.ax }, 'identity.centre_inactive', 409], [{ receiving_centre_id: CE.b1 }, 'common.not_found', 404], [{ receiving_branch_id: BR.ax, receiving_centre_id: CE.ax }, 'identity.centre_inactive', 409]] as const) {
      const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
      await fails(call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(3), body })), code, status);
      expect(w.snapshot()).toBe(before);
    }
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    const e: any = await call(updatePartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { receiving_centre_id: CE.a2 } })).then(() => null, (x) => x); // CE.a2 is in BR.a2, the partner stays in BR.a1
    expect(e).toBeInstanceOf(LimsError); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(w.snapshot()).toBe(before);
  });
});

describe('T07 SA5 suspendPartner — US-01.5', () => {
  it('200: status suspended, reason code/text, suspended_at/by set, version +1; response status + suspend_reason_code only; nothing deleted, no job', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w);
    const r = await call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'credit_hold', reason_text: LEAK.text } }));
    expect(r.status).toBe(200);
    expect(row(w, P.x)).toMatchObject({ status: 'suspended', suspend_reason_code: 'credit_hold', suspend_reason_text: LEAK.text, suspended_by: STAFF, version: 4, updated_by: STAFF });
    expect(row(w, P.x)['suspended_at']).toBeInstanceOf(Date);
    expect(r.body).toMatchObject({ id: P.x, status: 'suspended', suspend_reason_code: 'credit_hold', version: 4 });
    expect(JSON.stringify(r.body)).not.toContain(LEAK.text);
    expect(w.log.some((q) => /^\s*DELETE\b/i.test(q.text))).toBe(false);
    expect(w.writes.every((q) => /^\s*UPDATE\s+partners\.partners\b/i.test(q.text))).toBe(true); // open pickups / manifests / users stay as they are (03-APP-FLOW §2.4)
    expect(w.jobs).toEqual([]);
    expect(w.users.every((u) => u.status !== 'deactivated' || u.id === id(53))).toBe(true);
  });

  it('every partner user of the suspended partner gets 403 partners.partner_inactive on the next request (T03 partnerContext), staff can still read it', async () => {
    const w = makeWorld();
    await call(suspendPartner, makeCtx(w).ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'agreement_ended' } }));
    for (const u of w.users.filter((z) => z.status !== 'deactivated')) {
      const pctx: any = { tenantId: T_A, actor: { type: 'partner', id: u.id, membershipId: u.membership_id }, tx: w.newTx(), now: () => '2026-11-13T00:00:00.000Z' };
      await fails(partnerContext.require(pctx), 'partners.partner_inactive', 403);
    }
    const r = await call(getPartner, makeCtx(w).ctx, req({ partner_id: P.x }));
    expect(r.status).toBe(200); expect(r.body.status).toBe('suspended'); expect(r.body.partner_code).toBe('SYN-X');
  });

  it('already suspended -> 409 partners.partner_invalid_transition; row unchanged', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(suspendPartner, ctx, req({ partner_id: P.s, headers: IFM(2), body: { reason_code: 'other', reason_text: 'again' } })), 'partners.partner_invalid_transition', 409);
    expect(w.snapshot()).toBe(before);
  });

  it('If-Match missing -> 428, stale -> 409 common.version_conflict; unknown / tenant-B partner -> 404', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(suspendPartner, ctx, req({ partner_id: P.x, body: { reason_code: 'credit_hold' } })), 'common.precondition_required', 428);
    await fails(call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(1), body: { reason_code: 'credit_hold' } })), 'common.version_conflict', 409);
    await fails(call(suspendPartner, ctx, req({ partner_id: P.b, headers: IFM(1), body: { reason_code: 'credit_hold' } })), 'common.not_found', 404);
    expect(w.snapshot()).toBe(before);
  });

  it('unknown / inactive / other-set reason_code -> 400 common.validation_failed; nothing written', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    for (const reason_code of ['bogus', 'retired_reason', 'foreign_set_code', '', 'CREDIT_HOLD', "x'; DROP TABLE partners.partners;--"]) {
      await fails(call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code, reason_text: 'note' } })), 'common.validation_failed', 400);
    }
    await fails(call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_text: 'no code' } })), 'common.validation_failed', 400);
    expect(w.partnerWrites).toEqual([]); expect(row(w, P.x)).toMatchObject({ status: 'active', suspend_reason_code: null, version: 3 });
    expect(w.snapshot()).toBe(before);
  });

  it("'other' (requires_text) without reason_text, or blank after trim -> 400 common.validation_failed; with text -> 200; a code that needs no text stays 200 without it", async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    for (const body of [{ reason_code: 'other' }, { reason_code: 'other', reason_text: '' }, { reason_code: 'other', reason_text: '   \t ' }]) {
      await fails(call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body })), 'common.validation_failed', 400);
    }
    expect(w.partnerWrites).toEqual([]); expect(w.snapshot()).toBe(before);
    const ok = await call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'other', reason_text: 'Synthetic reason' } }));
    expect(ok.status).toBe(200); expect(row(w, P.x)).toMatchObject({ status: 'suspended', suspend_reason_code: 'other', suspend_reason_text: 'Synthetic reason' });
    const w2 = makeWorld();
    expect((await call(suspendPartner, makeCtx(w2).ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'security_concern' } }))).status).toBe(200);
  });

  it('suspend reason text is not logged', async () => {
    const w = makeWorld(); const { ctx, logs } = makeCtx(w);
    await call(suspendPartner, ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'other', reason_text: LEAK.text } }));
    for (const l of logs) expect(l).not.toContain(LEAK.text);
  });
});

describe('T07 SA6 reactivatePartner', () => {
  it('200: status active, every suspension column cleared, version +1; price-list and statement syncs enqueued (03-APP-FLOW §2.4)', async () => {
    const w = makeWorld(); const { ctx, cpCalls } = makeCtx(w);
    const r = await call(reactivatePartner, ctx, req({ partner_id: P.s, headers: IFM(2) }));
    expect(r.status).toBe(200);
    expect(row(w, P.s)).toMatchObject({ status: 'active', suspended_at: null, suspended_by: null, suspend_reason_code: null, suspend_reason_text: null, version: 3, updated_by: STAFF });
    expect(r.body).toMatchObject({ id: P.s, status: 'active', version: 3 }); expect(r.body.suspend_reason_code).toBeUndefined();
    expect(cpCalls).toEqual([{ creditPartyId: CP.three, purpose: 'display', tenantId: T_A }]); // the guard reads the partner's own credit party, not a request value
    expect(jobsOf(w, P.s).map((j) => [j.identifier, j.jobKey]).sort()).toEqual([[PRICELIST, `pricelist:${P.s}`], [STATEMENTS, `statements:${P.s}`]]);
    expect(w.jobs).toHaveLength(2);
  });

  it('credit party deactivated in C3 meanwhile -> 422 partners.credit_party_inactive; partner stays suspended, no job', async () => {
    const w = makeWorld(); w.creditParties.find((c) => c.id === CP.three)!.active = false;
    const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.s, headers: IFM(2) })), 'partners.credit_party_inactive', 422);
    expect(w.snapshot()).toBe(before); expect(w.writes).toEqual([]);
  });

  it('credit party no longer resolvable (C3 404) -> the 404 propagates, partner stays suspended', async () => {
    const w = makeWorld(); w.creditParties = w.creditParties.filter((c) => c.id !== CP.three);
    const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.s, headers: IFM(2) })), 'common.not_found', 404);
    expect(w.snapshot()).toBe(before);
  });

  it('already active -> 409 partners.partner_invalid_transition; no job; If-Match missing -> 428; stale -> 409 version_conflict; tenant-B partner -> 404', async () => {
    const w = makeWorld(); const { ctx } = makeCtx(w); const before = w.snapshot();
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.x, headers: IFM(3) })), 'partners.partner_invalid_transition', 409);
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.s })), 'common.precondition_required', 428);
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.s, headers: IFM(1) })), 'common.version_conflict', 409);
    await fails(call(reactivatePartner, ctx, req({ partner_id: P.b, headers: IFM(1) })), 'common.not_found', 404);
    expect(w.snapshot()).toBe(before);
  });

  it('suspend -> reactivate round trip restores a partner whose users pass partnerContext again', async () => {
    const w = makeWorld();
    await call(suspendPartner, makeCtx(w).ctx, req({ partner_id: P.x, headers: IFM(3), body: { reason_code: 'credit_hold' } }));
    await call(reactivatePartner, makeCtx(w).ctx, req({ partner_id: P.x, headers: IFM(4) }));
    const u = w.users[0]!;
    const pctx: any = { tenantId: T_A, actor: { type: 'partner', id: u.id, membershipId: u.membership_id }, tx: w.newTx(), now: () => '2026-11-13T00:00:00.000Z' };
    expect(await partnerContext.require(pctx)).toMatchObject({ partnerId: P.x, partnerUserId: u.id });
    expect(row(w, P.x)['version']).toBe(5);
  });
});

describe('T07 SA7 resyncPartnerProjections', () => {
  const run = (w: World, pid: string, scopes: string[], over: Over = {}) => call(resyncPartnerProjections, makeCtx(w, over).ctx, req({ partner_id: pid, body: { scopes } }));

  it('202 {} ; price_list -> partners.sync_price_list job_key pricelist:<id>', async () => {
    const w = makeWorld(); const r = await run(w, P.x, ['price_list']);
    expect(r.status).toBe(202); expect(r.body ?? {}).toEqual({});
    expect(w.jobs).toEqual([{ identifier: PRICELIST, jobKey: `pricelist:${P.x}`, payload: expect.objectContaining({ tenant_id: T_A, partner_id: P.x }) }]);
  });
  it('statements -> partners.sync_statements job_key statements:<id>', async () => {
    const w = makeWorld(); await run(w, P.x, ['statements']);
    expect(w.jobs).toEqual([{ identifier: STATEMENTS, jobKey: `statements:${P.x}`, payload: expect.objectContaining({ tenant_id: T_A, partner_id: P.x }) }]);
  });
  it('tracking -> partners.reconcile_orders job_key reconcile:partner:<id> (scoped to this partner)', async () => {
    const w = makeWorld(); await run(w, P.x, ['tracking']);
    expect(w.jobs).toEqual([{ identifier: RECONCILE, jobKey: `reconcile:partner:${P.x}`, payload: expect.objectContaining({ tenant_id: T_A, partner_id: P.x }) }]);
  });
  it('all three scopes -> three jobs with distinct keys; nothing but jobs is written', async () => {
    const w = makeWorld(); await run(w, P.x, ['price_list', 'statements', 'tracking']);
    expect(w.jobs.map((j) => j.jobKey).sort()).toEqual([`pricelist:${P.x}`, `reconcile:partner:${P.x}`, `statements:${P.x}`]);
    expect(w.writes.every((q) => /app\.enqueue_job/i.test(q.text))).toBe(true);
  });
  it('a suspended partner can be resynced (statements stay available to staff)', async () => {
    const w = makeWorld(); expect((await run(w, P.s, ['statements'])).status).toBe(202);
    expect(w.jobs.map((j) => j.jobKey)).toEqual([`statements:${P.s}`]);
  });
  it('partner of tenant B / unknown id -> 404 and no job (a foreign id never enqueues work)', async () => {
    const w = makeWorld();
    await fails(run(w, P.b, ['price_list', 'statements', 'tracking']), 'common.not_found', 404);
    await fails(run(w, id(892), ['price_list']), 'common.not_found', 404);
    expect(w.jobs).toEqual([]);
  });
  it('a failing enqueue is not swallowed', async () => {
    const w = makeWorld(); w.failEnqueue = true;
    await expect(run(w, P.x, ['price_list'])).rejects.toThrow();
  });
});
