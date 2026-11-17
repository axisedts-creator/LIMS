// UUIDv7 (02-TRD §3.3 / §3.4; RFC 9562 §5.7). Self-contained: Node strips types at test time.

/** IC §2.1 Uuidv7. [CONV] local brand until `@lims/contracts/ports/common` exists; re-export it then. */
export type Uuidv7 = string & { readonly __brand: 'Uuidv7' };

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MS = 2 ** 48 - 1;

/** Pure layout: 48-bit ms + 10 random bytes (rand[0] low nibble + rand[1] = rand_a; rand[2..9] = rand_b, high bits masked). */
export function buildUuidv7(unixMs: number, rand: Uint8Array): Uuidv7 {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs > MAX_MS) throw new RangeError('unixMs out of 48-bit range');
  if (rand.length !== 10) throw new RangeError('rand must be 10 bytes');
  const b = new Uint8Array(16);
  let t = unixMs;
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = 0x70 | (rand[0]! & 0x0f);
  b[7] = rand[1]!;
  b[8] = 0x80 | (rand[2]! & 0x3f);
  for (let i = 0; i < 7; i++) b[9 + i] = rand[3 + i]!;
  let h = '';
  for (const x of b) h += x.toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as Uuidv7;
}

/** Monotonic generator: rand_a is a 12-bit counter, randomly seeded per new ms; overflow advances the ms. */
function makeGenerator(clock: () => number, fill: (b: Uint8Array<ArrayBuffer>) => void): () => Uuidv7 {
  let lastMs = -1;
  let counter = 0;
  const rand = new Uint8Array(10);
  return () => {
    fill(rand);
    const now = clock();
    if (now > lastMs) {
      lastMs = now;
      counter = ((rand[0]! & 0x0f) << 8) | rand[1]!;
    } else if (++counter > 0xfff) {
      lastMs++;
      counter = ((rand[0]! & 0x0f) << 8) | rand[1]!;
    }
    rand[0] = counter >> 8;
    rand[1] = counter & 0xff;
    return buildUuidv7(lastMs, rand);
  };
}

// REQ-SEC-028: CSPRNG only (Web Crypto = node:crypto.getRandomValues).
const defaultGen = makeGenerator(() => Date.now(), (b) => { crypto.getRandomValues(b); });

export function uuidv7(): Uuidv7 {
  return defaultGen();
}

/** xoshiro128** [CONV], state expanded from `seed` with splitmix32. Same algorithm in lims_shared (Dart). */
function xoshiro128ss(seed: number): () => number {
  let x = seed >>> 0;
  const sm = (): number => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  let s0 = sm(), s1 = sm(), s2 = sm(), s3 = sm();
  const rotl = (v: number, k: number): number => (v << k) | (v >>> (32 - k));
  return () => {
    const r = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 11);
    return r;
  };
}

/** Deterministic fake (CV §8.3): seeded PRNG + clock `startMs + i * stepMs`; never reads the wall clock. */
export function createSeededUuidv7(opts: { seed: number; startMs: number; stepMs?: number }): () => Uuidv7 {
  const next = xoshiro128ss(opts.seed);
  const step = opts.stepMs ?? 1;
  let i = 0;
  return makeGenerator(
    () => opts.startMs + i++ * step,
    (b) => {
      for (let j = 0; j < b.length; j += 4) {
        const r = next();
        for (let k = 0; k < 4 && j + k < b.length; k++) b[j + k] = (r >>> (8 * k)) & 0xff;
      }
    },
  );
}

export function uuidv7Timestamp(id: Uuidv7): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function isUuidv7(s: unknown): s is Uuidv7 {
  return typeof s === 'string' && RE.test(s);
}
