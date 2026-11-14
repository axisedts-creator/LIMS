// C6-T25 self-check of the fake tx in messaging-admin.helpers.ts (so a failing handler test can be trusted to point at the implementation, not the fake).
import { describe, expect, it } from 'vitest';
import { ACC_A_SMS, ACC_A_WA, OLD_TOKEN, TENANT_A, TENANT_B, TXT_A_WA, USER, makeMsgDb, rejection, sha256buf } from './messaging-admin.helpers.js';

const q = (db: ReturnType<typeof makeMsgDb>, text: string, values: unknown[] = []) => db.tx.query(text, values).then((r: any) => r.rows);

describe('fake tx: reads', () => {
  it('filters by tenant_id and channel; a statement without a tenant predicate sees every tenant', async () => {
    const db = makeMsgDb();
    expect(await q(db, 'SELECT * FROM reporting.channel_accounts WHERE tenant_id = $1', [TENANT_A])).toHaveLength(2);
    expect(await q(db, 'SELECT * FROM reporting.channel_accounts WHERE tenant_id = $1 AND channel = $2', [TENANT_A, 'sms'])).toHaveLength(1);
    expect(await q(db, 'SELECT * FROM reporting.channel_accounts')).toHaveLength(3);
  });
  it('g_message_templates is global', async () => { expect((await q(makeMsgDb(), 'SELECT code FROM reporting.g_message_templates WHERE is_active = true')).length).toBeGreaterThan(5); });
});

describe('fake tx: writes', () => {
  it('UPDATE ... WHERE version = $n matches only the right version, bumps version and returns the row', async () => {
    const db = makeMsgDb();
    const hit = await q(db, 'UPDATE reporting.channel_accounts SET callback_token_sha256 = $1, version = version + 1, updated_by = $2 WHERE tenant_id = $3 AND channel = $4 AND version = $5 RETURNING *', [sha256buf('t'), USER, TENANT_A, 'sms', 3]);
    expect(hit).toHaveLength(1); expect(hit[0].version).toBe(4); expect(db.acct(ACC_A_SMS)['callback_token_sha256']).toEqual(sha256buf('t'));
    expect(await q(db, 'UPDATE reporting.channel_accounts SET version = version + 1 WHERE tenant_id = $1 AND channel = $2 AND version = $3 RETURNING *', [TENANT_A, 'sms', 3])).toHaveLength(0);
  });
  it('INSERT ... ON CONFLICT (tenant_id, channel) DO UPDATE ... WHERE inserts, then updates, and rejects a duplicate without ON CONFLICT', async () => {
    const db = makeMsgDb();
    const ins = 'INSERT INTO reporting.channel_accounts (tenant_id, channel, provider_kind, secret_ref, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)';
    expect(await q(db, `${ins} RETURNING *`, [TENANT_A, 'email', 'email_smtp_relay', 'secrets/x', USER])).toHaveLength(1);
    expect((await rejection(q(db, ins, [TENANT_A, 'email', 'email_smtp_relay', 'secrets/x', USER]))).code).toBe('23505');
    const up = await q(db, `${ins} ON CONFLICT (tenant_id, channel) DO UPDATE SET secret_ref = excluded.secret_ref, version = reporting.channel_accounts.version + 1 RETURNING *`, [TENANT_A, 'email', 'email_smtp_relay', 'secrets/y', USER]);
    expect(up[0]).toMatchObject({ secret_ref: 'secrets/y', version: 2 });
    expect(db.accts().filter((a) => a['channel'] === 'email')).toHaveLength(1);
  });
  it('CHECKs: bad secret_ref, 31-byte token hash, unknown channel -> 23514; unknown template FK -> 23503; global hash uniqueness -> 23505', async () => {
    const db = makeMsgDb();
    const bad = (sql: string, v: unknown[]) => rejection(q(db, sql, v)).then((e) => e.code);
    expect(await bad('UPDATE reporting.channel_accounts SET secret_ref = $1 WHERE tenant_id = $2 AND channel = $3', ['Bad Ref', TENANT_A, 'sms'])).toBe('23514');
    expect(await bad('UPDATE reporting.channel_accounts SET callback_token_sha256 = $1 WHERE tenant_id = $2 AND channel = $3', [Buffer.alloc(31), TENANT_A, 'sms'])).toBe('23514');
    expect(await bad('UPDATE reporting.channel_accounts SET callback_token_sha256 = $1 WHERE tenant_id = $2 AND channel = $3', [sha256buf(OLD_TOKEN), TENANT_A, 'sms'])).toBe('23505');   // = ACC_A_WA's hash
    expect(db.acct(ACC_A_WA)['version']).toBe(1);
    expect(await bad('INSERT INTO reporting.message_template_texts (tenant_id, template_code, channel, language, body_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [TENANT_A, 'no.such', 'sms', 'en', 'x', USER])).toBe('23503');
    expect(await bad('INSERT INTO reporting.message_template_texts (tenant_id, template_code, channel, language, body_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [TENANT_A, 'reporting.report_ready', 'print', 'en', 'x', USER])).toBe('23514');
    expect(await bad('INSERT INTO reporting.message_template_texts (tenant_id, template_code, channel, language, body_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [TENANT_A, 'reporting.report_ready', 'whatsapp', 'en', 'dup', USER])).toBe('23505');
    expect(db.text(TXT_A_WA)['version']).toBe(2);
  });
  it('DELETE is refused (no grant) and statements mentioning idempotency_keys are journaled', async () => {
    const db = makeMsgDb();
    expect((await rejection(q(db, 'DELETE FROM reporting.channel_accounts WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
    await q(db, 'INSERT INTO core.idempotency_keys (tenant_id) VALUES ($1)', [TENANT_B]);
    expect(db.idemStmts()).toHaveLength(1);
  });
});
