// PG-T06 — eSewa adapter: sign, buildAction, verifyCallbackSignature (TRD §7.1, §7.2.2, §7.2.3; REQ-SEC-049; AC-PG-01.1, AC-PG-03.1-03.3).
// Assumed seam (tester contract; the spec fixes the method names/semantics but not the type names — writer may dispute via notes):
//   gateways/esewa.adapter.ts exports
//     createEsewaAdapter(cfg: { formUrl; statusUrl; publicBase /* no trailing slash */; timeouts: GatewayTimeouts; allowFractionalRupees?: boolean })
//        -> { gateway: 'esewa'; buildAction(i, s); verifyCallbackSignature(payloadB64, s, i); check(i, s, ctx); ... }
//     esewaSign(secret: string, fields: Readonly<Record<string,string>>, names: readonly string[]): string   // base64(hmacSha256(secret, "n=v,n=v"))
//   StoredIntent = { id; gatewayTxnRef; amountPaisa: number; productCode; callbackToken }   (eSewa: gatewayTxnRef === id; productCode from the merchant account)
//   s = SecretHandle (service/credentials.ts). Tests `await` every call, so sync (TRD §7.1) or Promise-returning both pass.
// Every value is synthetic. The HMAC oracle below is independent of the implementation (node:crypto only).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEsewaAdapter, esewaSign } from '../../../gateways/esewa.adapter.js';
import { SecretHandle } from '../../../service/credentials.js';

const SECRET = 'synthetic-esewa-secret-for-tests';
const OTHER = 'synthetic-other-secret-for-tests';
const ID = '0192f0a0-7b1e-7c3a-9d2e-4f5a6b7c8d9e';
const CODE = 'SYNTHCODE';
const TOKEN = 'tok_SYNTHETIC-callback-token_0123456789';
const BASE = 'https://lims.example.test';
const FORM = 'https://uat-form.example.test/api/epay/main/v2/form';
const cfg = {
  formUrl: FORM, statusUrl: 'http://127.0.0.1:9/api/epay/transaction/status/', publicBase: BASE,
  timeouts: { initiateMs: 100, inrequestMs: 100, jobMs: 100 },
};
const intent = { id: ID, gatewayTxnRef: ID, amountPaisa: 225000, productCode: CODE, callbackToken: TOKEN };
const h = (s = SECRET) => new SecretHandle(s);
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('base64');
const adapter = () => createEsewaAdapter(cfg);

type Form = { kind: 'form_post'; url: string; fields: Record<string, string>; launchUrl?: string };
const action = async (i: Record<string, unknown> = intent, s = h(), a = adapter()) => (await a.buildAction(i as never, s)) as Form;

describe('esewaSign (TRD §7.2.2)', () => {
  it('known answer: base64 (not hex) of HMAC-SHA256 over "n=v,n=v" in the given order', () => {
    const f = { total_amount: '2250', transaction_uuid: ID, product_code: CODE };
    expect(esewaSign(SECRET, f, ['total_amount', 'transaction_uuid', 'product_code'])).toBe('u2ohHJZ5seo3z1atIM9waINS8tZ4Wpc3Oq4wOurd9gU=');
  });
  it('order matters; secret matters; value matters', () => {
    const f = { total_amount: '2250', transaction_uuid: ID, product_code: CODE };
    const a = esewaSign(SECRET, f, ['total_amount', 'transaction_uuid', 'product_code']);
    expect(esewaSign(SECRET, f, ['transaction_uuid', 'total_amount', 'product_code'])).not.toBe(a);
    expect(esewaSign(OTHER, f, ['total_amount', 'transaction_uuid', 'product_code'])).not.toBe(a);
    expect(esewaSign(SECRET, { ...f, total_amount: '2251' }, ['total_amount', 'transaction_uuid', 'product_code'])).not.toBe(a);
  });
});

describe('buildAction (AC-PG-01.1; TRD §7.2.3)', () => {
  it('returns form_post to the configured form URL with exactly the documented string fields', async () => {
    const a = await action();
    expect(a.kind).toBe('form_post');
    expect(a.url).toBe(FORM);
    expect(Object.keys(a.fields).sort()).toEqual([
      'amount', 'failure_url', 'product_code', 'product_delivery_charge', 'product_service_charge', 'signature',
      'signed_field_names', 'success_url', 'tax_amount', 'total_amount', 'transaction_uuid',
    ]);
    for (const v of Object.values(a.fields)) expect(typeof v).toBe('string');
    expect(a.fields).toMatchObject({
      amount: '2250', total_amount: '2250', tax_amount: '0', product_service_charge: '0', product_delivery_charge: '0',
      transaction_uuid: ID, product_code: CODE, signed_field_names: 'total_amount,transaction_uuid,product_code',
      success_url: `${BASE}/v1/payments/callbacks/esewa/${TOKEN}/success`,
      failure_url: `${BASE}/v1/payments/callbacks/esewa/${TOKEN}/failure`,
    });
  });

  it('signature = Base64(HMAC-SHA256(secret, "total_amount=2250,transaction_uuid=<id>,product_code=<code>"))', async () => {
    const a = await action();
    expect(a.fields['signature']).toBe(hmac(SECRET, `total_amount=2250,transaction_uuid=${ID},product_code=${CODE}`));
    expect(a.fields['signature']).toBe('u2ohHJZ5seo3z1atIM9waINS8tZ4Wpc3Oq4wOurd9gU=');
  });

  it('launchUrl = <PUBLIC_BASE>/v1/payments/launch/<token> (CR-C15-001)', async () => {
    expect((await action()).launchUrl).toBe(`${BASE}/v1/payments/launch/${TOKEN}`);
  });

  it('is deterministic without network (replay returns an identical action, AC-PG-01.2)', async () => {
    expect(await action()).toEqual(await action());
  });

  it('signs the amount actually sent: 100 paisa = "1", 1000000 paisa = "10000" (integer rupees, no separators)', async () => {
    const one = await action({ ...intent, amountPaisa: 100 });
    expect(one.fields).toMatchObject({ amount: '1', total_amount: '1' });
    expect(one.fields['signature']).toBe(hmac(SECRET, `total_amount=1,transaction_uuid=${ID},product_code=${CODE}`));
    const big = await action({ ...intent, amountPaisa: 1_000_000 });
    expect(big.fields).toMatchObject({ amount: '10000', total_amount: '10000' });
  });

  it('fractional rupees: payments.amount_not_supported by default (REQ-SEC-048), "2250.50" only when the flag is on', async () => {
    await expect(Promise.resolve().then(() => action({ ...intent, amountPaisa: 225050 }))).rejects.toMatchObject({ code: 'payments.amount_not_supported' });
    const on = await action({ ...intent, amountPaisa: 225050 }, h(), createEsewaAdapter({ ...cfg, allowFractionalRupees: true }));
    expect(on.fields).toMatchObject({ amount: '2250.50', total_amount: '2250.50' });
    expect(on.fields['signature']).toBe(hmac(SECRET, `total_amount=2250.50,transaction_uuid=${ID},product_code=${CODE}`));
  });

  it.each([0, -100, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('rejects unusable amount %s with payments.amount_not_supported', async (p) => {
    await expect(Promise.resolve().then(() => action({ ...intent, amountPaisa: p }))).rejects.toMatchObject({ code: 'payments.amount_not_supported' });
  });

  it('a different secret gives a different signature; the secret never appears in the action', async () => {
    const a = await action(intent, h(SECRET));
    const b = await action(intent, h(OTHER));
    expect(a.fields['signature']).not.toBe(b.fields['signature']);
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(JSON.stringify(b)).not.toContain(OTHER);
  });

  it('only the order reference, amount and product code go out: no PHI-shaped or extra field (REQ-SEC-141)', async () => {
    const a = await action();
    expect(Object.values(a.fields).join('|')).not.toMatch(/patient|\bname\b|phone|email|mobile/i);
    expect(JSON.stringify(a)).not.toMatch(/patient|phone|email|mobile/i);
  });
});

// Real-shaped callback body: transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names,signature.
const DEFAULT_NAMES = 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
function signed(over: Record<string, string> = {}, names = DEFAULT_NAMES, secret = SECRET): Record<string, string> {
  const f: Record<string, string> = {
    transaction_code: '0001SIM', status: 'COMPLETE', total_amount: '2250', transaction_uuid: ID, product_code: CODE,
    signed_field_names: names, ...over,
  };
  const msg = names.split(',').map((n) => `${n}=${f[n]}`).join(',');
  return { ...f, signature: hmac(secret, msg) };
}
const verify = async (payload: string, s = h(), i: Record<string, unknown> = intent) =>
  (await adapter().verifyCallbackSignature!(payload, s, i as never)) as { valid: boolean; fields?: Record<string, string> };

describe('verifyCallbackSignature (TRD §7.2.2; REQ-SEC-049; AC-PG-03.1-03.3)', () => {
  it('accepts a correctly signed payload and returns the decoded string fields (AC-PG-03.1)', async () => {
    const r = await verify(b64(signed()));
    expect(r.valid).toBe(true);
    expect(r.fields).toMatchObject({ status: 'COMPLETE', total_amount: '2250', transaction_uuid: ID, product_code: CODE });
    for (const v of Object.values(r.fields ?? {})) expect(typeof v).toBe('string');
  });

  it('recomputes over the listed fields in the LISTED order (not a fixed order)', async () => {
    const names = 'total_amount,transaction_uuid,product_code,signed_field_names';
    expect((await verify(b64(signed({}, names)))).valid).toBe(true);
    const reordered = 'product_code,transaction_code,status,total_amount,transaction_uuid,signed_field_names';
    expect((await verify(b64(signed({}, reordered)))).valid).toBe(true);
  });

  it('forged signature (signed with another secret) is invalid (AC-PG-03.2)', async () => {
    const r = await verify(b64(signed({}, DEFAULT_NAMES, OTHER)));
    expect(r.valid).toBe(false);
  });

  it.each([
    ['status', 'COMPLETE', 'PENDING'],
    ['total_amount', '2250', '1'],
    ['transaction_code', '0001SIM', '0002SIM'],
  ])('tampering with signed field %s after signing is invalid', async (k, _from, to) => {
    const p = signed();
    p[k] = to;
    expect((await verify(b64(p))).valid).toBe(false);
  });

  it.each(['total_amount', 'transaction_uuid', 'product_code'])(
    'correctly signed payload whose signed_field_names omits %s is invalid (AC-PG-03.3, REQ-SEC-049)',
    async (omit) => {
      const names = DEFAULT_NAMES.split(',').filter((n) => n !== omit).join(',');
      const p = signed({}, names); // signature is genuine over the shorter list
      expect((await verify(b64(p))).valid).toBe(false);
    },
  );

  it('a name listed in signed_field_names but absent from the body is invalid', async () => {
    const p = signed({}, `${DEFAULT_NAMES.replace('signed_field_names', 'extra_field,signed_field_names')}`);
    delete p['extra_field'];
    expect((await verify(b64(p))).valid).toBe(false);
  });

  it.each(['status', 'signature', 'total_amount', 'transaction_uuid', 'product_code', 'signed_field_names'])(
    'missing required key %s is invalid',
    async (k) => {
      const p = signed();
      delete p[k];
      expect((await verify(b64(p))).valid).toBe(false);
    },
  );

  it('identity: transaction_uuid must equal intent.gatewayTxnRef (replay of another intent\'s payload, AB-2)', async () => {
    const other = '0192f0a0-7b1e-7c3a-9d2e-000000000000';
    expect((await verify(b64(signed()), h(), { ...intent, id: other, gatewayTxnRef: other })).valid).toBe(false);
  });

  it('identity: product_code must equal the merchant account product code', async () => {
    expect((await verify(b64(signed()), h(), { ...intent, productCode: 'OTHERCODE' })).valid).toBe(false);
  });

  it('a payload for another amount cannot validate with the genuine signature of this one', async () => {
    const p = signed();
    const q = { ...signed({ total_amount: '1' }), signature: p['signature']! };
    expect((await verify(b64(q))).valid).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['not base64', '%%%not-base64%%%'],
    ['base64 of non-JSON', Buffer.from('not json {', 'utf8').toString('base64')],
    ['JSON array', b64([1, 2, 3])],
    ['JSON string', b64('hello')],
    ['JSON null', b64(null)],
    ['over 4 KB', b64({ ...signed(), pad: 'x'.repeat(5000) })],
  ])('rejects without throwing: %s', async (_n, payload) => {
    expect((await verify(payload)).valid).toBe(false);
  });

  it.each([
    ['empty signature', ''],
    ['short signature', 'AAAA'],
    ['long signature', 'A'.repeat(200)],
    ['non-base64 signature', '!!!!@@@@####'],
    ['hex of the right digest', createHmac('sha256', SECRET).update('x').digest('hex')],
  ])('signature of wrong length/shape (%s) is invalid and never throws (length check before timingSafeEqual)', async (_n, sig) => {
    expect((await verify(b64({ ...signed(), signature: sig }))).valid).toBe(false);
  });

  it('non-string field values are invalid (all fields are strings)', async () => {
    expect((await verify(b64({ ...signed(), total_amount: 2250 }))).valid).toBe(false);
  });

  it('never leaks the secret in the result', async () => {
    const r = await verify(b64(signed({}, DEFAULT_NAMES, OTHER)));
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('source guards (done_when: constant-time, no floats)', () => {
  const src = readFileSync(new URL('../../../gateways/esewa.adapter.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('compares signatures with timingSafeEqual only', () => {
    expect(code).toContain('timingSafeEqual');
    expect(code).not.toMatch(/signature\s*[!=]==/);
    expect(code).not.toMatch(/\.signature\s*[!=]==|computed\s*[!=]==|expected\s*[!=]==/);
  });
  it('does no floating-point amount handling', () => {
    expect(code).not.toMatch(/parseFloat|toFixed|Math\.round|\*\s*100\b/);
  });
});
