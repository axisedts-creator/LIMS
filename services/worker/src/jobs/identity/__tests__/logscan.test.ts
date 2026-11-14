// C2-T28 worker log PHI scan (02-TRD §13 "Never logged"; 07-SECURITY §5.1). Planted e-mail / password / token through the identity tasks that touch them.
// send_invitation (seams as in send_invitation.test.ts): GoTrue fails with a message carrying the planted e-mail + password + token -> ctx.log lines and the rethrown error must not contain them.
// Static half: no worker identity log call names a forbidden field.
// Run: pnpm --dir services/worker exec vitest run src/jobs/identity/__tests__/logscan.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSendInvitation } from '../tasks/send_invitation.js';
import { TENANT, idN, makeCtx, gt } from './t11.helpers.js';

const EMAIL = 'planted.invitee.0042@example.test';
const PASSWORD = 'Pl4nted-Passw0rd!xyz';
const TOKEN = 'tok_PLANTED_9f3a7c1e5b2d';
const INV = idN(0x1a1);

describe('send_invitation never logs or throws the planted e-mail / password / token', () => {
  it('permanent GoTrue failure whose message carries the planted values: logs only ids + error_code', async () => {
    const c = makeCtx({ tenantId: TENANT });
    const e: any = gt('sendInvite', 422, 'email_address_invalid'); e.message = `422 for ${EMAIL} password ${PASSWORD} token ${TOKEN}`;
    const repo = { loadInvitation: vi.fn(async () => ({ id: INV, status: 'pending', email: EMAIL, expires_at: '2026-11-18T04:00:00.000Z' })), markSent: vi.fn(), markFailed: vi.fn() };
    const task = createSendInvitation({ gotrue: { sendInvite: vi.fn(async () => { throw e; }) }, repo } as any);
    await task({ tenant_id: TENANT, invitation_id: INV } as any, c.ctx);
    expect(c.log.warn).toHaveBeenCalled();                      // the failure path really logged
    for (const p of [EMAIL, PASSWORD, TOKEN]) expect(c.logged(), p).not.toContain(p);
  });

  it('transient failure is rethrown without the planted values in message / detail, and nothing is logged with them', async () => {
    const c = makeCtx({ tenantId: TENANT });
    const e: any = new Error(`503 upstream for ${EMAIL} token ${TOKEN}`); e.status = 503;
    const repo = { loadInvitation: vi.fn(async () => ({ id: INV, status: 'pending', email: EMAIL, expires_at: '2026-11-18T04:00:00.000Z' })), markSent: vi.fn(), markFailed: vi.fn() };
    const task = createSendInvitation({ gotrue: { sendInvite: vi.fn(async () => { throw e; }) }, repo } as any);
    const out = await task({ tenant_id: TENANT, invitation_id: INV } as any, c.ctx).then(() => undefined, (x: any) => x);
    for (const p of [EMAIL, TOKEN]) expect(c.logged(), p).not.toContain(p);
    if (out && out !== e) for (const p of [EMAIL, TOKEN]) expect(String(out.message) + JSON.stringify(out.detail ?? ''), p).not.toContain(p);   // a wrapped error must not carry them
  });

  it('skipped path (row not pending) logs the status only', async () => {
    const c = makeCtx({ tenantId: TENANT });
    const repo = { loadInvitation: vi.fn(async () => ({ id: INV, status: 'sent', email: EMAIL, expires_at: '2026-11-18T04:00:00.000Z' })), markSent: vi.fn(), markFailed: vi.fn() };
    await createSendInvitation({ gotrue: { sendInvite: vi.fn() }, repo } as any)({ tenant_id: TENANT, invitation_id: INV } as any, c.ctx);
    expect(c.logged()).not.toContain(EMAIL);
  });
});

const FORBIDDEN = /\b(email|e_mail|phone|mobile|password|passwd|totp|totp_code|otp|otpauth\w*|secret|jwt|token|token_hash|session_token|refresh_token|qr|qr_svg|access_token)\b/i;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '__tests__' ? [] : walk(join(dir, d.name))) : [join(dir, d.name)]));
const SRC = walk(join(import.meta.dirname, '..')).filter((p) => /\.ts$/.test(p) && !/\.test\./.test(p));

describe('static: no worker identity log call names a forbidden field', () => {
  it('scans the identity tasks (guards the regex: there are log calls)', () => {
    expect(SRC.reduce((a, f) => a + (readFileSync(f, 'utf8').match(/\blog\??\.(?:info|warn|error|debug)\??\.?\(/g) ?? []).length, 0)).toBeGreaterThan(5);
  });
  it('no log call argument list contains a forbidden word', () => {
    const bad: string[] = [];
    for (const f of SRC) for (const m of readFileSync(f, 'utf8').matchAll(/\blog\??\.(?:info|warn|error|debug)\??\.?\(([^;]*?)\)\s*;/g)) {
      const hit = m[1]!.replace(/\berror_code\b/g, '').match(FORBIDDEN);
      if (hit) bad.push(`${f}: ${hit[0]} in ${m[0].slice(0, 120)}`);
    }
    expect(bad).toEqual([]);
  });
});
