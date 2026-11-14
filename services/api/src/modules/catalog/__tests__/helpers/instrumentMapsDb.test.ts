// Self-test of the T-27 additions to helpers/testsDb.ts (catalog.instrument_code_maps): the fake must enforce the schema's constraints, otherwise the service tests prove nothing.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { CBC, GROWTH, HB, HB_B, ID, INST, INST2, MICRO, TEST_B, icm, world27Db, type Setup27Db } from './t27db.js';

const setup27 = (s: Setup27Db = {}) => ({ db: world27Db(s) });

const INS = 'INSERT INTO catalog.instrument_code_maps (id, tenant_id, instrument_id, direction, instrument_code, analyte_id, test_id, unit_from_raw, unit_to_code, unit_factor, flag_map, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)';
let n = 0;
const ins = (e: ReturnType<typeof setup27>, o: Partial<Record<string, unknown>> = {}, tenantId = TENANT_A) => {
  const r = { id: ID(0xb800 + ++n), tenant_id: tenantId, instrument_id: INST, direction: 'inbound', instrument_code: 'X', analyte_id: HB.id, test_id: CBC.test.id, unit_from_raw: null, unit_to_code: null, unit_factor: null,
    flag_map: null, is_active: true, created_by: USER, updated_by: USER, ...o };
  return e.db.run((ctx) => ctx.tx.query(INS, Object.values(r)), { tenantId }).then((x: any) => x, (x: any) => ({ err: x }));
};
const code = async (p: Promise<any>) => (await p).err?.code;
const constraint = async (p: Promise<any>) => (await p).err?.constraint;

describe('fake: catalog.instrument_code_maps', () => {
  it('composite FK (tenant, analyte, test) -> analytes: a mismatched pair and a foreign-tenant pair raise 23503', async () => {
    const e = setup27();
    expect(await constraint(ins(e, { test_id: MICRO.test.id }))).toBe('instrument_code_maps__analyte_test__fk');
    expect(await constraint(ins(e, { analyte_id: GROWTH.id }))).toBe('instrument_code_maps__analyte_test__fk');
    expect(await code(ins(e, { analyte_id: HB_B.id, test_id: TEST_B.test.id }))).toBe('23503');                    // tenant A cannot see tenant B's analyte
    expect((await ins(e, { analyte_id: HB_B.id, test_id: TEST_B.test.id }, TENANT_B)).err).toBeUndefined();         // ... which tenant B itself can map
    expect(await code(ins(e, { analyte_id: HB.id, test_id: CBC.test.id }, TENANT_B))).toBe('23503');                // and B cannot map A's pair
  });

  it('inbound partial unique: active inbound/both with the same (instrument, code) -> 23505; inactive, other instrument, other code, outbound-only do not clash', async () => {
    const e = setup27({ maps: [icm(1, TENANT_A, INST, { instrument_code: 'HGB', direction: 'both', analyte_id: HB.id, test_id: CBC.test.id })] });
    expect(await constraint(ins(e, { instrument_code: 'HGB', direction: 'inbound', analyte_id: ID(0x3000 + 2) }))).toBe('instrument_code_maps__inbound__p_uq');
    expect((await ins(e, { instrument_code: 'HGB', direction: 'inbound', analyte_id: ID(0x3000 + 2), is_active: false })).err).toBeUndefined();
    expect((await ins(e, { instrument_code: 'HGB', instrument_id: INST2, direction: 'both' })).err).toBeUndefined();
    expect((await ins(e, { instrument_code: 'hgb', direction: 'inbound', analyte_id: ID(0x3000 + 2) })).err).toBeUndefined();
    expect((await ins(e, { instrument_code: 'HGB', direction: 'outbound', analyte_id: ID(0x3000 + 2) })).err).toBeUndefined();
  });

  it('outbound partial unique: active outbound/both with the same (instrument, analyte) -> 23505', async () => {
    const e = setup27({ maps: [icm(1, TENANT_A, INST, { instrument_code: 'HGB', direction: 'outbound', analyte_id: HB.id, test_id: CBC.test.id })] });
    expect(await constraint(ins(e, { instrument_code: 'OTHER', direction: 'both' }))).toBe('instrument_code_maps__outbound__p_uq');
    expect((await ins(e, { instrument_code: 'OTHER', direction: 'inbound' })).err).toBeUndefined();
  });

  it('CHECKs -> 23514: direction, code length, unit triple, factor > 0, unit_to_code pattern, flag_map object', async () => {
    const e = setup27();
    for (const o of [{ direction: 'x' }, { instrument_code: '' }, { instrument_code: 'c'.repeat(65) }, { unit_from_raw: 'g/L' }, { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0' },
      { unit_from_raw: 'g/L', unit_to_code: 'g/dl', unit_factor: '1' }, { flag_map: '[1]' }]) expect(await code(ins(e, o)), JSON.stringify(o)).toBe('23514');
    expect((await ins(e, { unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: 0.1 })).err).toBeUndefined();
  });

  it('jsonb / numeric: a JSON string flag_map is parsed (22P02 when invalid) and reads back as an object; unit_factor reads back as a string; updates convert the same way', async () => {
    const e = setup27();
    expect(await code(ins(e, { flag_map: '{"H":' }))).toBe('22P02');
    const ok = await ins(e, { id: ID(0xb7ff), flag_map: '{"H":"HIGH"}', unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: 0.1 });
    expect(ok.err).toBeUndefined();
    const row = e.db.row('instrument_code_maps', ID(0xb7ff))!;
    expect([row['flag_map'], row['unit_factor']]).toEqual([{ H: 'HIGH' }, '0.1']);
    await e.db.run((ctx) => ctx.tx.query('UPDATE catalog.instrument_code_maps SET flag_map = $3, unit_factor = $4 WHERE tenant_id = $1 AND id = $2', [TENANT_A, ID(0xb7ff), '{"L":"LOW"}', 0.5]));
    expect(e.db.row('instrument_code_maps', ID(0xb7ff))).toMatchObject({ flag_map: { L: 'LOW' }, unit_factor: '0.5' });
  });

  it('RLS: another tenant\'s rows are invisible, a foreign tenant_id insert raises 42501; DELETE has no grant (42501); duplicate id -> 23505', async () => {
    const e = setup27({ maps: [icm(1, TENANT_A, INST, { instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id })] });
    expect(await code(e.db.run((ctx) => ctx.tx.query(INS, [ID(0xb801), TENANT_B, INST, 'inbound', 'Q', HB.id, CBC.test.id, null, null, null, null, true, USER, USER])).then((x: any) => x, (x: any) => ({ err: x })))).toBe('42501');
    const seen = await e.db.run((ctx) => ctx.tx.query('SELECT id FROM catalog.instrument_code_maps WHERE instrument_id = $1', [INST]), { tenantId: TENANT_B });
    expect(seen.rows).toEqual([]);
    expect(await code(e.db.run((ctx) => ctx.tx.query('DELETE FROM catalog.instrument_code_maps WHERE id = $1', [ID(0xb001)])).then((x: any) => x, (x: any) => ({ err: x })))).toBe('42501');
    expect(await code(ins(e, { id: ID(0xb001), instrument_code: 'ZZ' }))).toBe('23505');
  });
});
