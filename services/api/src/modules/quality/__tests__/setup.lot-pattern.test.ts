// C9 T-06 — the lot number rule is ONE rule in three places (DB CHECK control_lots__lot__ck, quality.yaml ControlLotDto.lot_no, the service): 1-64 printable ASCII, no leading/trailing
// space, never trimmed (02-TRD §5.1 #8). A value the DB CHECK refuses must be answered 400 common.validation_failed by the service, not 500 (and a valid one must not be refused).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { createSetupService } from '../service/setup.service.js';
import { LVL, code, makeCtx, makeRepo, rejection } from './setup.helpers.js';

const CHECK = String.raw`^[\x21-\x7E]([\x20-\x7E]{0,62}[\x21-\x7E])?$`;
const spec05 = readFileSync(join(REPO_ROOT, 'spec', 'chunks', 'C9-quality-engine', '05-SCHEMA.md'), 'utf8');
const openapi: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
const re = new RegExp(CHECK);

describe('the three statements of the rule are identical', () => {
  it('05-SCHEMA control_lots__lot__ck is the reference pattern', () => { expect(spec05).toContain(`CHECK (lot_no ~ '${CHECK}')`); });
  it('quality.yaml ControlLotDto.lot_no pattern (and the createControlLot request body) equal the DB CHECK', () => {
    expect(openapi.components.schemas.ControlLotDto.properties.lot_no.pattern).toBe(CHECK);
    const post = openapi.paths['/v1/quality/control-levels/{level_id}/lots'].post.requestBody.content['application/json'].schema;
    const body = post.$ref ? post.$ref.split('/').reduce((a: any, k: string) => (k === '#' ? openapi : a[k]), openapi) : post;
    expect(body.properties.lot_no.pattern).toBe(CHECK);
  });
  it('the quality migration (when C0 has merged the DDL) carries the same CHECK', () => {
    const dir = join(REPO_ROOT, 'db', 'migrations');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /quality/i.test(f)) : [];
    for (const f of files) { const sql = readFileSync(join(dir, f), 'utf8'); if (/control_lots__lot__ck/.test(sql)) expect(sql).toContain(CHECK); }
  });
});

describe('the service accepts exactly what the CHECK accepts', () => {
  const body = (lot_no: unknown) => ({ lot_no, expires_on: '2027-01-01' });
  const run = async (lot_no: unknown) => {
    const svc: any = createSetupService({ repo: makeRepo().repo });
    try { const r = await svc.createControlLot(makeCtx().ctx, { levelId: LVL(1), body: body(lot_no) }); return { ok: true as const, stored: r.body.lot_no }; }
    catch (e: any) { return { ok: false as const, code: code(e), paths: (e.errors ?? []).map((x: any) => x.path) }; }
  };
  const VALID = ['A', '~', '!', 'LOT-SYN-01', 'a b', 'A  B', 'L O T 1', 'x'.repeat(64), `a${' '.repeat(62)}b`, '0', 'lot/01#2', '"q"', 'A.B_C'];
  const INVALID: unknown[] = ['', ' ', ' A', 'A ', ' A ', '\tA', 'A\t', 'A\nB', 'A\n', 'A\r', 'A\x00', 'A\x7f', 'LÖT', '日本', 'x'.repeat(65), `a${' '.repeat(63)}b`, 'a'.repeat(63) + ' ', 12, null, undefined, ['A'], {}];
  it.each(VALID)('valid %j is accepted and stored exactly as sent (no trim)', async (v) => { expect(re.test(v)).toBe(true); expect(await run(v)).toEqual({ ok: true, stored: v }); });
  it.each(INVALID)('invalid %j -> 400 common.validation_failed at /lot_no', async (v) => {
    if (typeof v === 'string') expect(re.test(v)).toBe(false);
    expect(await run(v)).toEqual({ ok: false, code: 'common.validation_failed', paths: ['/lot_no'] });
  });
  it('agrees with the DB CHECK on 600 generated strings (deterministic LCG; alphabet of letters, space, dash, control chars, DEL, non-ASCII)', async () => {
    const alphabet = ['A', 'b', '7', '-', '/', ' ', ' ', '\t', '\n', '\x7f', '\x00', 'é', '~', '!'];
    let seed = 20261113; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const mismatches: string[] = [];
    for (let i = 0; i < 600; i++) {
      const len = i % 40 === 0 ? 62 + (next() % 5) : next() % 12;      // some strings sit on the 63/64/65 boundary
      let s = ''; for (let k = 0; k < len; k++) s += alphabet[next() % alphabet.length];
      const r = await run(s);
      if (re.test(s) !== r.ok || (!r.ok && r.code !== 'common.validation_failed')) mismatches.push(JSON.stringify(s));
    }
    expect(mismatches).toEqual([]);
  });
});
