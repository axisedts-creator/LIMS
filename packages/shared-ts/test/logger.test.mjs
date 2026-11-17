// T0A-08 / AC-0A-5.1, 5.2, 5.3 (TRD §3.1 logger; CV §9.1, §9.2; 07-SECURITY AB-19, REQ-SEC-098/034/035).
// ASSUMED (see .orchestra/notes/T0A-08-tests.md): createLogger opts also accept
//   destination?: { write(line: string): void }  (test sink; default = stdout); message key is `msg`; mask contains no original chars.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const SRC = new URL('../src/logger/', import.meta.url);
const load = () => import(new URL('index.ts', SRC).href);
const V7 = '01933b6f-0a11-7e2b-8c55-1d2e3f405162';
const V7B = '01933b6e-8f1a-7c3d-9a40-2f5e6b7c8d90';
const R = '[REDACTED]';

async function make(extra = {}) {
  const { createLogger } = await load();
  const lines = [];
  const log = createLogger({ service: 'api', env: 'staging', version: 'abc1234', level: 'debug', destination: { write: (s) => lines.push(String(s)) }, ...extra });
  const out = () => lines.join('');
  const parsed = () => lines.flatMap((l) => l.split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  return { log, lines, out, parsed };
}

// Synthetic corpus (no real people/numbers/tokens). jwt = base64url(header).base64url(payload).sig
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ sub: V7, session_id: V7B })}.c2lnbmF0dXJlLXN5bnRoZXRpYy1vbmx5X0FCQ0RFRkdISUo`;
const PHONES = ['9801234567', '9712345678', '+9779801234567', '+977-9801234567', '+977 9801234567', '977-9712345678', '9612345678', '9621234567', '+977-9611234567'];
const NAMED = /^(patient_name|phone|barcode|otp|authorization)$/i;

describe('AC-0A-5.1 key denylist', () => {
  it('named keys, any case -> "[REDACTED]"', async () => {
    const { log, parsed, out } = await make();
    log.info('x', { patient_name: 'Synthetic Person', phone: '555', barcode: 'BC-PLANT-1', otp: '482913', authorization: 'Bearer PLANT-TOKEN' });
    log.info('y', { PATIENT_NAME: 'SynUpper', Phone: 'PH-MIX', BARCODE: 'BC-PLANT-2', OtP: '119233', Authorization: 'Basic PLANTBASIC' });
    const named = parsed().flatMap((l) => Object.entries(l)).filter(([k]) => NAMED.test(k));
    assert.equal(named.length, 10);
    for (const [k, v] of named) assert.equal(v, R, k);
    for (const s of ['Synthetic Person', 'BC-PLANT-1', '482913', 'PLANT-TOKEN', 'SynUpper', 'PH-MIX', 'BC-PLANT-2', '119233', 'PLANTBASIC']) assert.ok(!out().includes(s), s);
  });
  it('denylist keys are case-insensitive SUBSTRINGS, also nested / in arrays / on child loggers', async () => {
    const { log, out } = await make();
    log.child({ module: 'lab' }).info('x', {
      patient_phone_number: 'SUB-1', x_authorization_header: 'SUB-2', lab_barcode_value: 'SUB-3',
      nested: { deep: { Patient_Name: 'SUB-4', list: [{ otp_code: 'SUB-5' }] } }, arr: [{ phone: 'SUB-6' }],
    });
    for (let i = 1; i <= 6; i++) assert.ok(!out().includes(`SUB-${i}`), `SUB-${i} leaked`);
    assert.ok(out().includes(R));
  });
  it('other §9.2 credential/identifier keys: password, email, url (signed URLs), cookie, refresh_token, jwt', async () => {
    const { log, out } = await make();
    log.info('x', { password: 'PW-PLANT', email: 'syn@example.invalid', url: 'https://x.invalid/s?sig=SIGPLANT', cookie: 'CK-PLANT', refresh_token: 'RT-PLANT', jwt: 'JWT-PLANT' });
    for (const s of ['PW-PLANT', 'syn@example.invalid', 'SIGPLANT', 'CK-PLANT', 'RT-PLANT', 'JWT-PLANT']) assert.ok(!out().includes(s), s);
  });
  it('CV §9.2 health-data keys: comment, critical_value, test_name, panel_name, smart_report', async () => {
    const { log, out } = await make();
    log.info('x', { comment: 'CMT-PLANT', critical_value: 'CRIT-PLANT', test_name: 'TN-PLANT', panel_name: 'PN-PLANT', smart_report: 'SR-PLANT' });
    for (const s of ['CMT-PLANT', 'CRIT-PLANT', 'TN-PLANT', 'PN-PLANT', 'SR-PLANT']) assert.ok(!out().includes(s), s);
  });
  it('child() never throws on a context with a throwing getter (logger never throws)', async () => {
    const { log, out } = await make();
    const ctx = { get boom() { throw new Error('getter'); } };
    let c;
    assert.doesNotThrow(() => { c = log.child(ctx); });
    assert.doesNotThrow(() => c.info('after bad child'));
    assert.ok(out().includes('after bad child'));
  });
  it('allowed fields survive: internal UUIDs, invoice_no, counts, durations, codes', async () => {
    const { log, parsed } = await make();
    log.info('x', { patient_id: V7, order_id: V7B, specimen_id: V7, invoice_no: 'INV-2083-000123', count: 3, duration_ms: 37, error_code: 'common.not_found' });
    const l = parsed()[0];
    assert.deepEqual([l.patient_id, l.order_id, l.specimen_id, l.invoice_no, l.count, l.duration_ms, l.error_code], [V7, V7B, V7, 'INV-2083-000123', 3, 37, 'common.not_found']);
  });
  it('does not mutate the caller object; tolerates circular refs and Error values', async () => {
    const { log, out } = await make();
    const f = { phone: '9801234567', keep: 1 }; f.self = f;
    assert.doesNotThrow(() => log.info('x', f));
    assert.equal(f.phone, '9801234567'); assert.equal(f.keep, 1);
    log.error('boom', { err: new Error('failed for 9801234567') });
    assert.ok(!out().includes('9801234567'));
  });
});

describe('AC-0A-5.2 value scrubbers (free text)', () => {
  for (const p of PHONES) {
    it(`masks Nepali mobile-shaped "${p}" in message and in non-denylisted string fields`, async () => {
      const { log, out } = await make();
      log.info(`call back ${p} tomorrow`, { note: `contact=${p};` });
      const digits = p.replace(/\D/g, '').replace(/^977/, '');
      assert.ok(!out().includes(p) && !out().includes(digits), 'phone leaked');
      assert.ok(out().includes('call back') && out().includes('tomorrow'), 'surrounding text must survive');
    });
  }
  it('masks a 96x-range mobile (e.g. Smart Telecom) held in an integer field', async () => {
    const { log, out } = await make();
    log.info('x', { contact: 9612345678 });
    assert.ok(!out().includes('9612345678'));
  });
  it('masks a JWT-shaped string in message, fields, and bearer text', async () => {
    const { log, out } = await make();
    log.warn(`token was ${JWT} for user`, { detail: JWT, hdr: `Bearer ${JWT}` });
    assert.ok(!out().includes(JWT)); assert.ok(!out().includes(JWT.split('.')[1]));
    assert.ok(out().includes('for user'));
  });
  it('masks every planted value in one free-text corpus line (AB-19)', async () => {
    const { log, out } = await make();
    log.error(`barcode BC-9001-PLANT otp 482913 phone 9801234567 jwt ${JWT}`, { patient_name: 'Synthetic Person', barcode: 'BC-9001-PLANT', otp: '482913', phone: '9801234567' });
    for (const s of ['Synthetic Person', 'BC-9001-PLANT', '482913', '9801234567', JWT]) assert.ok(!out().includes(s), s);
  });
  it('scrubs thrown-error stack/message fields', async () => {
    const { log, out } = await make();
    const e = new Error(`lookup failed for 9801234567 with ${JWT}`);
    log.error('failed', { error: e, stack: e.stack });
    assert.ok(!out().includes('9801234567') && !out().includes(JWT));
  });
  it('does NOT mangle UUIDv7s, timestamps, durations, ordinary numbers', async () => {
    const { log, parsed } = await make();
    log.info(`handled ${V7} in 1234567890 ms at 2026-11-05T04:15:00.123Z`, { request_id: V7, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7', duration_ms: 1730000000000 });
    const l = parsed()[0];
    assert.ok(l.msg.includes(V7) && l.msg.includes('1234567890') && l.msg.includes('2026-11-05T04:15:00.123Z'));
    assert.equal(l.request_id, V7); assert.equal(l.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736'); assert.equal(l.span_id, '00f067aa0ba902b7'); assert.equal(l.duration_ms, 1730000000000);
  });
});

describe('AC-0A-5.3 one JSON object per line with mandatory fields', () => {
  it('each call writes exactly one newline-terminated line that parses to one object', async () => {
    const { log, lines } = await make();
    log.info('a'); log.warn('b', { x: 1 }); log.error('c\nwith\nnewlines', { y: 'line1\nline2' }); log.debug('d');
    const text = lines.join('');
    assert.ok(text.endsWith('\n'));
    const rows = text.split('\n').slice(0, -1);
    assert.equal(rows.length, 4);
    for (const r of rows) { const o = JSON.parse(r); assert.ok(o && typeof o === 'object' && !Array.isArray(o)); }
  });
  it('base fields: ts (ISO UTC ms), level, service, env, version, msg', async () => {
    const { log, parsed } = await make();
    log.info('hello');
    const l = parsed()[0];
    assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(l.level, 'info'); assert.equal(l.service, 'api'); assert.equal(l.env, 'staging'); assert.equal(l.version, 'abc1234'); assert.equal(l.msg, 'hello');
  });
  it('level names for each method', async () => {
    const { log, parsed } = await make();
    log.debug('1'); log.info('2'); log.warn('3'); log.error('4');
    assert.deepEqual(parsed().map((l) => l.level), ['debug', 'info', 'warn', 'error']);
  });
  it('level option filters lower levels; default level suppresses debug', async () => {
    const a = await make({ level: 'warn' }); a.log.info('no'); a.log.warn('yes');
    assert.deepEqual(a.parsed().map((l) => l.msg), ['yes']);
    const { createLogger } = await load(); const lines = [];
    const d = createLogger({ service: 'worker', env: 'dev', version: 'v', destination: { write: (s) => lines.push(s) } });
    d.debug('hidden'); d.info('shown');
    assert.deepEqual(lines.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l).msg), ['shown']);
  });
  it('every provided CV §9.1 context field appears verbatim (via child and via per-call fields)', async () => {
    const { log, parsed } = await make();
    const ctx = { request_id: V7, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7', tenant_id: V7B, actor_id: V7, actor_type: 'staff', module: 'lab', operation_id: 'rejectSpecimen', route: '/v1/lab/specimens/{specimen_id}/reject', status: 409, duration_ms: 37, error_code: 'lab.specimen_invalid_transition' };
    log.child(ctx).info('via child');
    log.child({ request_id: V7 }).info('child+fields', { task: 'send_report', status: 200 });
    const [a, b] = parsed();
    for (const [k, v] of Object.entries(ctx)) assert.equal(a[k], v, k);
    assert.equal(b.request_id, V7); assert.equal(b.task, 'send_report'); assert.equal(b.status, 200);
  });
  it('child() merges and does not leak context into the parent or siblings', async () => {
    const { log, parsed } = await make();
    const c1 = log.child({ request_id: V7 }); const c2 = c1.child({ module: 'lab' });
    c2.info('c2'); c1.info('c1'); log.info('root');
    const [a, b, r] = parsed();
    assert.equal(a.request_id, V7); assert.equal(a.module, 'lab'); assert.equal(b.module, undefined); assert.equal(r.request_id, undefined);
  });
  it('fields not provided are omitted (no null / "undefined" placeholders)', async () => {
    const { log, parsed } = await make();
    log.info('x');
    const l = parsed()[0];
    for (const k of ['request_id', 'tenant_id', 'actor_id', 'route', 'error_code']) assert.ok(!(k in l), k);
  });
  it('a caller cannot overwrite base fields (service/env/version/level/ts) through fields', async () => {
    const { log, parsed } = await make();
    log.info('x', { service: 'evil', env: 'prod', version: 'x', level: 'fatal', ts: '1970-01-01T00:00:00.000Z' });
    const l = parsed()[0];
    assert.equal(l.service, 'api'); assert.equal(l.env, 'staging'); assert.equal(l.version, 'abc1234'); assert.equal(l.level, 'info'); assert.notEqual(l.ts, '1970-01-01T00:00:00.000Z');
  });
  it('src/logger has no console.* (CV §9.1)', () => {
    const files = readdirSync(SRC).filter((f) => /\.(ts|js|mjs)$/.test(f));
    assert.ok(files.length > 0, 'src/logger is empty');
    for (const f of files) assert.ok(!/\bconsole\s*\./.test(readFileSync(new URL(f, SRC), 'utf8')), f);
  });
});
