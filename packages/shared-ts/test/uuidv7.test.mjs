// T0A-04 / AC-0A-2.1, 2.2, 2.3 (TRD §3.3 uuidv7 + §3.4 algorithm paragraph; REQ-SEC-028).
// ASSUMED (not named in spec; see .orchestra/notes/T0A-04-tests.md):
//   buildUuidv7(unixMs: number, rand: Uint8Array /*10 bytes*/): Uuidv7   -- pure layout fn, no clock, no RNG
//   fixture packages/test-fixtures/uuidv7/vectors.json = { "vectors": [ { name, unixMs, randHex(20 hex), expected } ] }
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/uuidv7/index.ts', import.meta.url);
const VECTORS = new URL('../../test-fixtures/uuidv7/vectors.json', import.meta.url);
const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/; // IC §2.1 Uuidv7
const load = () => import(SRC.href);
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

// Independent layout oracle (RFC 9562 §5.7), so fixture rows are checked without trusting the impl.
function oracle(unixMs, rand) {
  const b = new Uint8Array(16);
  let t = BigInt(unixMs);
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  b[8] = 0x80 | (rand[2] & 0x3f);
  for (let i = 0; i < 7; i++) b[9 + i] = rand[3 + i];
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe('AC-0A-2.1 ordering + shape', () => {
  it('10,000 ids in one (frozen) millisecond sort as strings in generation order, all Uuidv7-shaped', async () => {
    const { uuidv7 } = await load();
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    try {
      const ids = Array.from({ length: 10_000 }, () => uuidv7());
      assert.ok(ids.every((s) => RE.test(s)), 'every id matches IC §2.1 Uuidv7');
      assert.equal(new Set(ids).size, ids.length, 'unique');
      assert.deepEqual([...ids].sort(), ids, 'string sort order == generation order');
    } finally { mock.timers.reset(); }
  });

  it('counter overflow (>4096 in one ms) advances the timestamp instead of wrapping', async () => {
    const { uuidv7, uuidv7Timestamp } = await load();
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    try {
      const ids = Array.from({ length: 5_000 }, () => uuidv7());
      const ts = ids.map(uuidv7Timestamp);
      assert.ok(ts[0] >= 1_700_000_000_000);
      assert.ok(ts[4999] >= ts[0] + 1, 'timestamp advanced after 12-bit counter overflow');
      assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]), 'timestamps non-decreasing');
    } finally { mock.timers.reset(); }
  });

  it('ordering holds across millisecond ticks', async () => {
    const { uuidv7 } = await load();
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    try {
      const ids = [];
      for (let i = 0; i < 50; i++) { ids.push(uuidv7(), uuidv7()); mock.timers.tick(1); }
      assert.deepEqual([...ids].sort(), ids);
    } finally { mock.timers.reset(); }
  });

  it('uuidv7Timestamp returns the embedded unix ms', async () => {
    const { uuidv7, uuidv7Timestamp } = await load();
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_123_456 });
    try { assert.equal(uuidv7Timestamp(uuidv7()), 1_700_000_123_456); } finally { mock.timers.reset(); }
  });

  it('rand_b varies (CSPRNG-fed, not constant)', async () => {
    const { uuidv7 } = await load();
    const tails = new Set(Array.from({ length: 1000 }, () => uuidv7().slice(20)));
    assert.ok(tails.size > 990, `rand_b tails distinct: ${tails.size}`);
  });

  it('isUuidv7 accepts canonical v7 and rejects everything else', async () => {
    const { uuidv7, isUuidv7 } = await load();
    assert.equal(isUuidv7(uuidv7()), true);
    assert.equal(isUuidv7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f'), true);
    for (const bad of [
      '017F22E2-79B0-7CC3-98C4-DC0C0C07398F',          // uppercase
      '017f22e2-79b0-4cc3-98c4-dc0c0c07398f',          // v4
      '017f22e2-79b0-7cc3-18c4-dc0c0c07398f',          // bad variant
      '017f22e2-79b0-7cc3-c8c4-dc0c0c07398f',          // bad variant
      '017f22e279b07cc398c4dc0c0c07398f',              // no hyphens
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398',           // short
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398f0',         // long
      ' 017f22e2-79b0-7cc3-98c4-dc0c0c07398f',         // leading space
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398f\n',        // trailing newline (regex $ trap)
      '', null, undefined, 42, {},
    ]) assert.equal(isUuidv7(bad), false, JSON.stringify(bad));
  });

  it('REQ-SEC-028: implementation does not use Math.random', () => {
    assert.doesNotMatch(readFileSync(fileURLToPath(SRC), 'utf8'), /Math\.random/);
  });
});

describe('AC-0A-2.2 seeding', () => {
  it('same {seed,startMs} twice => identical 100-id sequences', async () => {
    const { createSeededUuidv7 } = await load();
    const a = createSeededUuidv7({ seed: 42, startMs: 1_700_000_000_000 });
    const b = createSeededUuidv7({ seed: 42, startMs: 1_700_000_000_000 });
    const sa = Array.from({ length: 100 }, () => a());
    const sb = Array.from({ length: 100 }, () => b());
    assert.deepEqual(sa, sb);
    assert.ok(sa.every((s) => RE.test(s)));
    assert.deepEqual([...sa].sort(), sa, 'seeded ids are time-ordered');
  });

  it('different seed => different sequence', async () => {
    const { createSeededUuidv7 } = await load();
    const a = createSeededUuidv7({ seed: 42, startMs: 1_700_000_000_000 });
    const b = createSeededUuidv7({ seed: 43, startMs: 1_700_000_000_000 });
    assert.notDeepEqual(Array.from({ length: 10 }, () => a()), Array.from({ length: 10 }, () => b()));
  });

  it('does not read the wall clock: i-th id carries startMs + i*stepMs (default step 1)', async () => {
    const { createSeededUuidv7, uuidv7Timestamp } = await load();
    mock.timers.enable({ apis: ['Date'], now: 5 }); // wall clock far from startMs
    try {
      const g = createSeededUuidv7({ seed: 1, startMs: 1_700_000_000_000 });
      for (let i = 0; i < 20; i++) assert.equal(uuidv7Timestamp(g()), 1_700_000_000_000 + i);
      const h = createSeededUuidv7({ seed: 1, startMs: 1_700_000_000_000, stepMs: 5 });
      for (let i = 0; i < 20; i++) assert.equal(uuidv7Timestamp(h()), 1_700_000_000_000 + i * 5);
    } finally { mock.timers.reset(); }
  });

  it('seeded and unseeded generators are independent (seeded run unaffected by interleaved uuidv7())', async () => {
    const { createSeededUuidv7, uuidv7 } = await load();
    const a = createSeededUuidv7({ seed: 7, startMs: 1_700_000_000_000 });
    const b = createSeededUuidv7({ seed: 7, startMs: 1_700_000_000_000 });
    const sa = [];
    for (let i = 0; i < 20; i++) { sa.push(a()); uuidv7(); }
    assert.deepEqual(sa, Array.from({ length: 20 }, () => b()));
  });
});

describe('AC-0A-2.3 shared fixture', () => {
  const vectors = () => JSON.parse(readFileSync(fileURLToPath(VECTORS), 'utf8')).vectors;

  it('fixture exists, is well-formed, and includes the RFC 9562 A.6 vector', () => {
    const v = vectors();
    assert.ok(Array.isArray(v) && v.length >= 5, '>= 5 vectors');
    for (const x of v) {
      assert.equal(typeof x.name, 'string');
      assert.ok(Number.isSafeInteger(x.unixMs) && x.unixMs >= 0 && x.unixMs < 2 ** 48);
      assert.match(x.randHex, /^[0-9a-f]{20}$/);
      assert.match(x.expected, RE);
      assert.equal(x.expected, oracle(x.unixMs, hexToBytes(x.randHex)), `oracle agrees: ${x.name}`);
    }
    assert.ok(v.some((x) => x.expected === '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'));
    assert.ok(v.some((x) => x.unixMs === 0), 'epoch edge');
    assert.ok(v.some((x) => x.unixMs === 2 ** 48 - 1), 'max-48-bit edge');
  });

  it('TS buildUuidv7 reproduces every fixture row (and masks version/variant bits)', async () => {
    const { buildUuidv7 } = await load();
    for (const x of vectors()) assert.equal(buildUuidv7(x.unixMs, hexToBytes(x.randHex)), x.expected, x.name);
    // hard-coded RFC A.6 case; rand[0]/rand[2] carry junk high bits that must be masked
    assert.equal(
      buildUuidv7(0x017f22e279b0, Uint8Array.from([0xfc, 0xc3, 0xd8, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f])),
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
    );
  });
});
