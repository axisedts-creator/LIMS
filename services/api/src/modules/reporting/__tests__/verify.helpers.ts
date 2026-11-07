// C6-T22 test helpers (not a test file). Synthetic data only. Builds on portal.helpers.ts (same in-memory fake of Postgres, real core rate limiter).
// Adds, by wrapping db.newTx():
//   - `SELECT * FROM app.reporting_verify_qr($1)` = the DEFINER of 05-SCHEMA §6.2, same rules: arg must be a 32-byte bytea, row only when
//     qr_tokens.token_sha256 = arg AND revoked_at IS NULL AND the version is released|superseded; status 'released' -> 'valid' else 'superseded';
//     issued_at is returned as a JS Date (what node-pg gives for timestamptz).
//   - any statement on reporting.cs_reasons / reporting.g_cs_reasons (listCodes) answers the seeded token_revoke_reasons (04-UI-UX: issued_in_error,
//     wrong_recipient, security_concern, other).
// Statements are journalled in db.stmts like every other statement, so tests can assert on what the handler sent to the DB.
import { issueToken } from '../domain/tokens.js';
import { REPORT_A, TENANT_A, idN, makePortalWorld, type Row } from './portal.helpers.js';

export const USER = idN(0x7001);
export const USER2 = idN(0x7002);
export const IP_A = '203.0.113.7';
export const IP_B = '198.51.100.9';
export const REASONS = ['issued_in_error', 'wrong_recipient', 'security_concern', 'other'];
const toBuf = (v: any): Buffer | undefined => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : undefined);

export function makeVerifyWorld() {
  const w = makePortalWorld();
  const baseNewTx = w.db.newTx;
  const journal = (text: string, values: unknown[]) => { (w.db.stmts as any[]).push({ text, values: [...values], verb: 'select' }); };

  /** The DEFINER, as in the migration. */
  function definer(values: unknown[]): Row[] {
    const h = toBuf(values[0]);
    if (!h || h.length !== 32) return [];
    const out: Row[] = [];
    for (const q of w.db.store['qr_tokens']!) {
      const qh = toBuf(q['token_sha256']);
      if (!qh || !qh.equals(h) || q['revoked_at'] != null) continue;
      const v = w.db.store['report_versions']!.find((x) => x['tenant_id'] === q['tenant_id'] && x['id'] === q['report_version_id'] && ['released', 'superseded'].includes(x['status']));
      if (!v) continue;
      out.push({ lab_name: q['lab_name_snapshot'], patient_display: q['patient_display_snapshot'], panel_names: q['panel_names_snapshot'], issued_at: new Date(v['released_at']),
        version_no: v['version_no'], status: v['status'] === 'released' ? 'valid' : 'superseded' });
    }
    return out;
  }
  w.db.newTx = () => {
    const tx = baseNewTx(); const q = tx.query.bind(tx);
    tx.query = async (text: string, values: unknown[] = []) => {
      if (/\bapp\.reporting_verify_qr\s*\(/i.test(text)) { journal(text, values); return { rows: definer(values) }; }
      if (/\breporting\.(g_)?cs_reasons\b/i.test(text)) { journal(text, values); return { rows: REASONS.map((code, i) => ({ code, display: code, sort_order: i + 1 })) }; }
      return q(text, values);
    };
    return tx;
  };

  /** Give an existing version's qr_tokens row a real, known token (the seed stores sha256(versionId), which nobody can present). */
  function qrTokenFor(versionId: string): string {
    const row = w.db.store['qr_tokens']!.find((q) => q['report_version_id'] === versionId)!;
    const { token, tokenSha256 } = issueToken('qr'); row['token_sha256'] = Buffer.from(tokenSha256); return token;
  }
  /** A further version of REPORT_A in `status` with its own qr token (unreleased / discarded probes). */
  function addVersion(status: string, versionNo = 9, report = REPORT_A): { versionId: string; token: string; qr: Row } {
    const v = w.db.insert('report_versions', { tenant_id: TENANT_A, centre_id: idN(0x102), report_id: report, order_id: idN(0x104), patient_id: idN(0x101), version_no: versionNo, status,
      released_at: status === 'released' || status === 'superseded' ? w.now() : null, pdf_object_path: null, pdf_sha256: null, pdf_bytes: null });
    const { token, tokenSha256 } = issueToken('qr');
    const qr = w.db.insert('qr_tokens', { tenant_id: TENANT_A, centre_id: idN(0x102), report_id: report, report_version_id: v['id'], lab_name_snapshot: 'Test Lab 0001',
      patient_display_snapshot: 'T*** P*** 0001', issued_at: w.now(), token_sha256: Buffer.from(tokenSha256) });
    return { versionId: v['id'], token, qr };
  }
  /** Public (anonymous) ctx for Q1: no tenant, no actor; `tx` plays the anonymousTx. */
  const anonCtx = (clientIp = IP_A, over: Row = {}) => w.baseCtx({ tenantId: undefined, actor: undefined, claims: undefined, clientIp, ...over });
  /** Staff ctx (R14-R16). */
  const staffCtx = (over: Row = {}) => w.baseCtx({ tenantId: TENANT_A, actor: { type: 'user', id: USER }, ...over });
  const q1 = (token: unknown, ctx: any = anonCtx()) => w.run('verifyReportQr', ctx, { body: { qr_token: token } });
  const verifyStmts = () => w.db.stmts.filter((s) => /reporting_verify_qr/i.test(s.text));
  const qrRow = (versionId: string) => w.db.store['qr_tokens']!.find((q) => q['report_version_id'] === versionId)!;
  const linkRow = (id: string) => w.db.store['portal_links']!.find((l) => l['id'] === id)!;
  return { ...w, qrTokenFor, addVersion, anonCtx, staffCtx, q1, verifyStmts, qrRow, linkRow };
}
export type VerifyWorld = ReturnType<typeof makeVerifyWorld>;

/** Everything observable about a failure, minus the stack: used for byte-identical comparisons. */
export function failureBytes(e: any): string {
  if (!e || typeof e !== 'object') return String(e);
  const o: Record<string, unknown> = { ctor: e.constructor?.name };
  for (const k of Object.getOwnPropertyNames(e).sort()) if (k !== 'stack') o[k] = e[k];
  return JSON.stringify(o);
}
