// API-T14 — instruments.expire_credentials_and_commands (02-TRD §10; 03-APP-FLOW §2.3 / §2.5).
// Enrolment codes past expires_at: active -> expired (device tokens never expire here); commands past expires_at in queued/delivered -> expired
// (completed/failed untouched). The fake cannot evaluate WHERE clauses, so the guards are asserted on the statement content.
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { T_A, makeWorld, rejects, type World } from './helpers.js';

const ID = 'instruments.expire_credentials_and_commands';
async function run(w: World) { await manifest.tasks![ID]!({ tenant_id: T_A }, w.makeCtx()); }
const upd = (w: World, table: string) => w.writes().filter((s) => new RegExp(`UPDATE\\s+instruments\\.${table}\\b`, 'i').test(s.text));

describe('credential expiry', () => {
  it('updates agent_credentials to expired, only enrolment codes that are still active and past expires_at, tenant-bound', async () => {
    const w = makeWorld(); await run(w);
    const u = upd(w, 'agent_credentials');
    expect(u).toHaveLength(1);
    const s = u[0]!;
    expect(w.touches(s, 'expired')).toBe(true);
    expect(s.text).toMatch(/kind\s*=\s*(\$\d+|'enrolment_code')/i);
    if (/kind\s*=\s*\$\d+/i.test(s.text)) expect(s.values).toContain('enrolment_code');
    expect(s.text).toMatch(/status\s*=\s*(\$\d+|'active')/i);
    expect(s.text).toMatch(/expires_at\s*(<=?|\s)/i);
    expect(s.text).toMatch(/tenant_id/);
    expect(JSON.stringify(s.values)).not.toContain('device_token');
    expect(s.text).not.toMatch(/device_token/);
  });
  it('never touches or selects secret_sha256 (lims_app has no SELECT on it, REQ-SEC)', async () => {
    const w = makeWorld(); await run(w);
    for (const s of w.stmts) expect(s.text).not.toMatch(/secret_sha256/i);
  });
});

describe('command expiry', () => {
  it('updates agent_commands to expired only from queued / delivered and only past expires_at, tenant-bound', async () => {
    const w = makeWorld(); await run(w);
    const u = upd(w, 'agent_commands');
    expect(u).toHaveLength(1);
    const s = u[0]!;
    expect(w.touches(s, 'expired', 'queued', 'delivered')).toBe(true);
    expect(w.touches(s, [/state\s+IN/i, /state\s*=\s*ANY/i])).toBe(true);
    expect(JSON.stringify([s.text, s.values])).not.toMatch(/completed|failed/);
    expect(s.text).toMatch(/expires_at/i);
    expect(s.text).toMatch(/tenant_id/);
  });
});

describe('job hygiene', () => {
  it('writes only to the two tables, never DELETEs, uses the ctx clock or SQL now() (no wall-clock drift) and emits no event', async () => {
    const w = makeWorld(); await run(w);
    for (const s of w.writes()) expect(s.text).toMatch(/UPDATE\s+instruments\.(agent_credentials|agent_commands)\b/i);
    expect(w.stmts.some((s) => /DELETE/i.test(s.text))).toBe(false);
    expect(w.events).toHaveLength(0);
    for (const s of w.stmts) for (const v of s.values) if (v instanceof Date) expect(Math.abs(v.getTime() - Date.parse('2026-11-07T12:00:30.000Z'))).toBeLessThan(1000);
  });
  it('a database failure propagates (Graphile retries; attempts = 3)', async () => {
    const w = makeWorld(); const ctx = w.makeCtx();
    ctx.tx.query = async () => { throw new Error('db down'); };
    await rejects(manifest.tasks![ID]!({ tenant_id: T_A }, ctx));
  });
  it('is idempotent: running twice issues the same statements (nothing depends on previous output)', async () => {
    const w = makeWorld(); await run(w); const first = w.stmts.map((s) => s.text); await run(w);
    expect(w.stmts.slice(first.length).map((s) => s.text)).toEqual(first);
  });
});
