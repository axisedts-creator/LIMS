// T0A-05 / TRD §3.5 `generators/*`, AC-0C-3.2 (consumed), REQ-SEC-136. ASSUMED API (see notes file):
//   src/generators/index.ts exports
//     SAFE_PHONE_PREFIX: string                      e.g. '+999' (candidate; must be verified, source recorded)
//     SAFE_PHONE_PREFIX_SOURCE: { url: string, checkedOn: 'YYYY-MM-DD', note: string }
//     generateDataset({ seed: number, tenantId: string, scale: '1x'|'10x', days?: number /*default 1*/ })
//       -> { patients, orders, specimens, results, invoices }   (arrays of plain objects, all with id + tenantId)
//          patients: { id, tenantId, name, email, phone }  orders: { id, tenantId, patientId }
//          specimens: { id, tenantId, orderId }  results: { id, tenantId, specimenId }  invoices: { id, tenantId, orderId }
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const load = (p) => import(new URL(p, import.meta.url).href);
const g = await load('../src/generators/index.ts');
const { isUuidv7 } = await load('../../shared-ts/src/uuidv7/index.ts');
const TA = '01a1a98a-ac40-7000-8000-00000000a001';
const TB = '01a1a98a-ac40-7000-8000-00000000b001';
const KINDS = ['patients', 'orders', 'specimens', 'results', 'invoices'];
const gen = (o) => g.generateDataset({ tenantId: TA, scale: '1x', seed: 1, ...o });

describe('determinism (AC-0C-3.2)', () => {
  it('same seed twice -> deep-equal data and identical ids', () => {
    const a = gen({ seed: 42 });
    const b = gen({ seed: 42 });
    assert.deepEqual(a, b);
    assert.deepEqual(a.patients.map((x) => x.id), b.patients.map((x) => x.id));
  });
  it('different seed -> different ids', () => {
    const a = gen({ seed: 1 });
    const b = gen({ seed: 2 });
    assert.notDeepEqual(a.patients.map((x) => x.id), b.patients.map((x) => x.id));
  });
  it('different tenant, same seed -> disjoint ids, all rows carry that tenantId', () => {
    const a = gen({ seed: 7, tenantId: TA });
    const b = gen({ seed: 7, tenantId: TB });
    const ids = new Set(KINDS.flatMap((k) => a[k].map((x) => x.id)));
    for (const k of KINDS) {
      for (const x of b[k]) assert.ok(!ids.has(x.id));
      for (const x of a[k]) assert.equal(x.tenantId, TA);
      for (const x of b[k]) assert.equal(x.tenantId, TB);
    }
  });
  it('never reads Math.random or the wall clock', () => {
    const r = mock.method(Math, 'random', () => { throw new Error('Math.random used'); });
    const d = mock.method(Date, 'now', () => { throw new Error('Date.now used'); });
    try {
      const a = gen({ seed: 5 });
      const b = gen({ seed: 5 });
      assert.deepEqual(a, b);
    } finally {
      r.mock.restore();
      d.mock.restore();
    }
  });
  it('generator sources contain no Math.random / Date.now / new Date()', () => {
    const dir = new URL('../src/generators/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 1);
    for (const f of files) {
      assert.ok(!/Math\.random|Date\.now|new Date\(\)/.test(readFileSync(new URL(f, dir), 'utf8')), f);
    }
  });
});

describe('volume (1x = 500 patients/day, 10x = 5000/day; TRD §3.5, 04 §14)', () => {
  it('1x one day -> 500 patients; 10x -> 5000', () => {
    assert.equal(gen({ scale: '1x' }).patients.length, 500);
    assert.equal(gen({ scale: '10x' }).patients.length, 5000);
  });
  it('days scales linearly', () => {
    assert.equal(gen({ days: 2 }).patients.length, 1000);
  });
  it('10x is a strict superset in volume for every entity kind', () => {
    const a = gen({ scale: '1x' });
    const b = gen({ scale: '10x' });
    for (const k of KINDS) assert.ok(b[k].length >= 9 * a[k].length, k);
  });
  it('invalid scale or non-uuid tenant is rejected', () => {
    assert.throws(() => gen({ scale: '2x' }));
    assert.throws(() => gen({ tenantId: 'not-a-uuid' }));
  });
});

describe('shape + referential integrity', () => {
  const d = gen({ seed: 3 });
  it('every id is a unique UUIDv7', () => {
    const all = KINDS.flatMap((k) => d[k].map((x) => x.id));
    assert.equal(new Set(all).size, all.length);
    for (const id of all) assert.ok(isUuidv7(id), id);
  });
  it('patient names follow "Test Patient NNNN"', () => {
    assert.equal(d.patients[0].name, 'Test Patient 0001');
    assert.equal(d.patients[41].name, 'Test Patient 0042');
    for (const p of d.patients) assert.match(p.name, /^Test Patient \d{4,}$/);
  });
  it('orders -> patients, specimens -> orders, results -> specimens, invoices -> orders', () => {
    const ids = (k) => new Set(d[k].map((x) => x.id));
    const [P, O, S] = [ids('patients'), ids('orders'), ids('specimens')];
    assert.ok(d.orders.length >= d.patients.length && d.specimens.length >= d.orders.length);
    assert.ok(d.results.length >= d.specimens.length && d.invoices.length >= 1);
    for (const o of d.orders) assert.ok(P.has(o.patientId));
    for (const s of d.specimens) assert.ok(O.has(s.orderId));
    for (const r of d.results) assert.ok(S.has(r.specimenId));
    for (const i of d.invoices) assert.ok(O.has(i.orderId));
  });
});

describe('safe phone/email (REQ-SEC-136, TRD §3.5)', () => {
  const d = gen({ seed: 9 });
  it('prefix is "+" + 3 digits, not Nepal (+977) or other well-known assigned codes', () => {
    assert.match(g.SAFE_PHONE_PREFIX, /^\+\d{3}$/);
    for (const bad of ['+977', '+91', '+86', '+44', '+880', '+92', '+94', '+975', '+971', '+966']) {
      assert.notEqual(g.SAFE_PHONE_PREFIX, bad);
    }
  });
  it('prefix verification source is recorded (url, date, note) and no longer UNVERIFIED', () => {
    const s = g.SAFE_PHONE_PREFIX_SOURCE;
    assert.match(s.url, /^https:\/\//);
    assert.match(s.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(s.note.length >= 20);
    assert.ok(!/UNVERIFIED/i.test(s.note));
    assert.match(s.note, /ITU/);
  });
  it('every generated phone starts with the prefix, is E.164-length, and digits only after +', () => {
    for (const p of d.patients) {
      assert.ok(p.phone.startsWith(g.SAFE_PHONE_PREFIX), p.phone);
      assert.match(p.phone, /^\+\d{8,15}$/);
    }
  });
  it('every generated email is under the reserved .invalid TLD, e.g. test.patient.0042@example.invalid', () => {
    for (const p of d.patients) assert.match(p.email, /^[a-z0-9.]+@[a-z0-9.-]+\.invalid$/, p.email);
    assert.equal(d.patients[41].email, 'test.patient.0042@example.invalid');
  });
  it('no string anywhere in the dataset looks like a Nepali mobile or a deliverable address', () => {
    const s = JSON.stringify(d);
    assert.ok(!/\+977|\b9[78]\d{8}\b/.test(s));
    for (const m of s.matchAll(/[\w.+-]+@[\w.-]+/g)) assert.match(m[0], /\.invalid$/, m[0]);
  });
});
