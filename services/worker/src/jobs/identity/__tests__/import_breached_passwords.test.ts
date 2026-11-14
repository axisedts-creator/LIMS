// C2-T27 identity.import_breached_passwords (02-TRD §10 jobs table, §11 LIMS_IDENTITY_BREACHED_LIST_PATH; 05-SCHEMA §6 app.identity_load_breached_batch(p_hashes bytea[], p_version text),
// app.identity_finish_breached_import(p_version text); max_attempts 3; idempotent "by file sha256"). Manual platform task: payload {}, ctx.tenantId undefined, not in the crontab.
// ASSUMED seams (spec silent): tasks/import_breached_passwords.ts exports IMPORT_BREACHED_PASSWORDS = 'identity.import_breached_passwords' and `importBreachedPasswords: TaskHandler`;
//   the file path is read from process.env.LIMS_IDENTITY_BREACHED_LIST_PATH AT RUN TIME (never at import); DEFINER calls go through ctx.tx.query as `SELECT app.identity_load_breached_batch($1, $2)`
//   (param 1 = array of 20-byte Buffers/Uint8Arrays, or `\x…`/hex strings; param 2 = version) and `SELECT app.identity_finish_breached_import($1)`; p_version = lowercase hex sha256 of the
//   file bytes (the idempotency key, so re-importing the same file is a no-op upsert + an empty delete); one batch <= 10,000 hashes (a sanity cap, the TRD says "batches").
// Safety rules proven here: a line that is not 40 hex chars rejects the import WITHOUT finishing (the DEFINER would silently drop it, and finish deletes the older list); an empty file
//   never finishes (it would delete the whole list); no batch may hold the same hash twice (ON CONFLICT DO UPDATE raises "cannot affect row a second time").
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IMPORT_BREACHED_PASSWORDS, importBreachedPasswords } from '../tasks/import_breached_passwords.js';
import { LimsError, ctx27, err, makeTx } from './t27.helpers.js';

vi.setConfig({ testTimeout: 60_000 }); // ruling C2.T27: 25k per-element expects exceed vitest's 5 s default (LD-91 pattern)

const ENV = 'LIMS_IDENTITY_BREACHED_LIST_PATH';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const hashes = (n: number, salt = 'pw') => Array.from({ length: n }, (_, i) => sha1(`${salt}-${i}`));
let dir: string; let seq = 0; const saved = process.env[ENV];
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lims-t27-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });
afterEach(() => { delete process.env[ENV]; });

const file = (content: string | Buffer) => { const p = join(dir, `list-${++seq}.txt`); writeFileSync(p, content); process.env[ENV] = p; return typeof content === 'string' ? Buffer.from(content) : content; };
const hex = (v: unknown): string => (typeof v === 'string' ? v.replace(/^\\x/, '').toLowerCase() : Buffer.from(v as Uint8Array).toString('hex'));
const LOAD = /app\.identity_load_breached_batch/, FINISH = /app\.identity_finish_breached_import/;

async function run(o: { failLoadOn?: number } = {}) {
  let loads = 0;
  const t = makeTx([(sql) => (LOAD.test(sql) ? [{ identity_load_breached_batch: 1 }] : FINISH.test(sql) ? [{ identity_finish_breached_import: 0 }] : undefined)]);
  const q = t.tx.query; t.tx.query = (async (text: string, values?: unknown[]) => { if (LOAD.test(text) && ++loads === o.failLoadOn) throw new LimsError('common.dependency_unavailable'); return q(text, values); }) as typeof q;
  const { ctx } = ctx27({ tx: t.tx }); const e = await err(importBreachedPasswords({}, ctx));
  const batches = t.calls.filter((c) => LOAD.test(c.sql)); const finishes = t.calls.filter((c) => FINISH.test(c.sql));
  return { e, t, batches, finishes, loaded: batches.flatMap((b) => (b.values[0] as unknown[]).map(hex)), versions: batches.map((b) => b.values[1]) };
}

describe('identity.import_breached_passwords', () => {
  it('has the TRD task id', () => { expect(IMPORT_BREACHED_PASSWORDS).toBe('identity.import_breached_passwords'); });

  it('loads every hash exactly once as 20-byte values, then finishes once with the same version = sha256 of the file', async () => {
    const hs = hashes(25_000); const bytes = file(hs.join('\n') + '\n'); const r = await run();
    expect(r.e).toBeUndefined(); expect(r.batches.length).toBeGreaterThan(1);
    for (const b of r.batches) { const arr = b.values[0] as unknown[]; expect(arr.length).toBeGreaterThan(0); expect(arr.length).toBeLessThanOrEqual(10_000); for (const v of arr) expect(hex(v)).toMatch(/^[0-9a-f]{40}$/); }
    expect([...r.loaded].sort()).toEqual([...hs].sort());
    const version = createHash('sha256').update(bytes).digest('hex');
    expect(new Set(r.versions)).toEqual(new Set([version])); expect(r.finishes).toHaveLength(1); expect(r.finishes[0]!.values).toEqual([version]);
  });
  it('finish runs strictly after the last batch', async () => {
    file(hashes(12_000).join('\n')); const r = await run(); const order = r.t.calls.map((c) => (LOAD.test(c.sql) ? 'L' : FINISH.test(c.sql) ? 'F' : '-')).join('');
    expect(order).toMatch(/^L+F$/);
  });
  it('tolerates CRLF line endings, a missing trailing newline and blank lines', async () => {
    const hs = hashes(5); file(`${hs[0]}\r\n${hs[1]}\r\n\r\n${hs.slice(2).join('\r\n')}`); const r = await run();
    expect(r.e).toBeUndefined(); expect([...r.loaded].sort()).toEqual([...hs].sort());
  });
  it('de-duplicates inside a batch (ON CONFLICT DO UPDATE cannot touch a row twice) and still finishes', async () => {
    const hs = hashes(10); file([...hs, ...hs, hs[0]].join('\n')); const r = await run();
    expect(r.e).toBeUndefined(); for (const b of r.batches) { const l = (b.values[0] as unknown[]).map(hex); expect(new Set(l).size).toBe(l.length); }
    expect(new Set(r.loaded)).toEqual(new Set(hs)); expect(r.finishes).toHaveLength(1);
  });
  it('re-importing the same file uses the same version (idempotent by file sha256)', async () => {
    const content = hashes(50).join('\n'); file(content); const a = await run(); file(content); const b = await run(); expect(a.versions[0]).toBe(b.versions[0]); expect(a.versions[0]).toBeDefined();
  });
  it('a different file gets a different version', async () => {
    file(hashes(5, 'a').join('\n')); const a = await run(); file(hashes(5, 'b').join('\n')); const b = await run(); expect(a.versions[0]).not.toBe(b.versions[0]);
  });

  it.each([['too short', 'abcdef0123'], ['non-hex', 'z'.repeat(40)], ['41 chars', 'a'.repeat(41)], ['hash:count (HIBP shape)', `${'a'.repeat(40)}:12`]])('a %s line rejects the import and never finishes (older list kept)', async (_n, bad) => {
    file([...hashes(3), bad, ...hashes(3, 'x')].join('\n')); const r = await run(); expect(r.e).toBeDefined(); expect(r.finishes).toHaveLength(0);
  });
  it('an empty file (or only blank lines) rejects and never finishes — it would delete the whole list', async () => {
    for (const c of ['', '\n\n  \n']) { file(c); const r = await run(); expect(r.e, JSON.stringify(c)).toBeDefined(); expect(r.finishes).toHaveLength(0); }
  });
  it('a failing batch rejects and never finishes (the retry re-runs the same version)', async () => {
    file(hashes(25_000).join('\n')); const r = await run({ failLoadOn: 2 }); expect(r.e).toBeDefined(); expect(r.finishes).toHaveLength(0);
  });
  it('a failing finish call rejects (the job retries)', async () => {
    file(hashes(3).join('\n')); const t = makeTx([], { match: FINISH, error: () => new LimsError('common.dependency_unavailable') }); expect(await err(importBreachedPasswords({}, ctx27({ tx: t.tx }).ctx))).toBeDefined();
  });

  it('env path unset / empty / missing file -> rejects before any DB call', async () => {
    delete process.env[ENV]; const a = await run(); process.env[ENV] = ''; const b = await run(); process.env[ENV] = join(dir, 'does-not-exist.txt'); const c = await run();
    for (const r of [a, b, c]) { expect(r.e).toBeDefined(); expect(r.t.calls).toHaveLength(0); }
  });
  it('the path is read at run time: setting the env var after the module was imported works', async () => {
    delete process.env[ENV]; file(hashes(2).join('\n')); expect((await run()).e).toBeUndefined();
  });
  it('issues only the two DEFINER calls: no DML, no app.maintenance/set_config (A15.3, D-T19)', async () => {
    file(hashes(20).join('\n')); const r = await run();
    for (const c of r.t.calls) { expect(c.sql).toMatch(/app\.identity_(load_breached_batch|finish_breached_import)/); expect(c.sql).not.toMatch(/insert\s+into|update\s|delete\s+from|set_config|app\.maintenance/i); }
  });
  it('logs nothing that contains a hash', async () => {
    const hs = hashes(3); file(hs.join('\n')); const t = makeTx(); const c = ctx27({ tx: t.tx }); await importBreachedPasswords({}, c.ctx);
    for (const h of hs) expect(c.logged()).not.toContain(h);
  });
});
