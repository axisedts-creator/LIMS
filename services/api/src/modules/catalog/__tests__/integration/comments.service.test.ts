// T-13 (C3) — comment codes service (operations #57–#59): department-scoped / tenant-wide short codes with text history.
// Spec: 06-PLAN row T-13 (done_when "department/tenant-wide uniqueness via expression index"; integration; AC-09.1–09.3);
//       01-PRD US-09 (AC-09.1 department + tenant-wide `HYPO` coexist, AC-09.2 inactive code, AC-09.3 text edit -> version +1, text history kept);
//       02-TRD §5 rows 57–59 + `CommentCode` DTO (L171), §5.0 (If-Match, codes trimmed + upper-cased, cursor lists, default is_active=true), §9.1 (event
//       `comment_code`: create -> created, update -> updated, is_active -> false -> deactivated), §7 `resolveCommentCodes` (T-29 builds on this data);
//       05-SCHEMA comment_codes (expression unique index comment_codes__tenant_id_code_dept__uq) + comment_code_texts (INSERT + close effective_to only);
//       07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), AB-20 (no value echo), REQ-SEC-088/089 (texts are stored verbatim; React escapes on render).
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/commentsDb.ts (RLS, row locks, UNIQUE incl. the expression index, CHECK, FK,
// the texts immutability trigger). The revision bump is T-03's real service — the writer must call it in the SAME transaction.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-13-tests.md):
//   catalog/service/comments.service.ts  export function createCommentsService(deps: { events: { publish(ctx, type, input) } }) (SEAM, as createMastersService)
//     listCommentCodes(ctx, { department_id?, code_prefix?, cursor?, limit? })   -> { data: CommentCode[], page: { limit, next_cursor? } }   (query as catalog.yaml #57)
//     createCommentCode(ctx, { code, department_id?, text })                      -> CommentCode (the 201 body)
//     updateCommentCode(ctx, { id, expectedVersion, patch: { text?, is_active? } }) -> CommentCode (the 200 body)
//   DTO = snake_case CommentCode of contracts/openapi/catalog.yaml: { id, code, department_id? (absent when tenant-wide), text, is_active, version } and nothing else.
//   Same tx: comment_codes row + comment_code_texts row(s) + bumpRevision(entityType 'comment_code'). Single-table SQL only (see commentsDb.ts dialect).
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createCommentsService } from '../../service/comments.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { cc, ccText, dept, makeCommentsDb, type CommentTable } from '../helpers/commentsDb.js';
import { ID, pgError, type Row } from '../helpers/mastersDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));          // transaction clock of the n-th write
const ms = (v: unknown) => new Date(v as string | Date).getTime();

const HAEM = dept(1, TENANT_A, { code: 'HAEM' });
const BIO = dept(2, TENANT_A, { code: 'BIOCHEM' });
const B_DEPT = dept(9, TENANT_B, { code: 'THEIRS' });

const setup = (rows: Partial<Record<CommentTable, Row[]>> = {}, catalog: any = seedState, departments: Row[] = [HAEM, BIO, B_DEPT]) => {
  const db = makeCommentsDb({ rows, catalog, departments });
  const svc = createCommentsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
type Db = ReturnType<typeof setup>['db'];
// A TypeError ("svc.x is not a function", a crash) is never an acceptable rejection: no test here expects one.
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
const events = (db: Db, tenant = TENANT_A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
const stmtsOf = (db: Db, tenant = TENANT_A) => db.stmts.filter((s) => s.tenantId === tenant);
const writes = (db: Db) => stmtsOf(db).filter((s) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\./i.test(s.text));
const create = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) => db.run((ctx) => svc['createCommentCode']!(ctx, body), o);
const list = (db: Db, svc: Svc, q: object = {}, tenantId = TENANT_A) => db.run((ctx) => svc['listCommentCodes']!(ctx, q), { tenantId });
const upd = (db: Db, svc: Svc, id: string, version: number | undefined, patch: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) =>
  db.run((ctx) => svc['updateCommentCode']!(ctx, { id, expectedVersion: version, patch }), o);
const codesOf = (r: { data: any[] }) => r.data.map((x) => x.code).sort();
const HYPO_TW = { code: 'HYPO', text: 'Hypochromia (tenant-wide).' };
const HYPO_HAEM = { code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.' };

// ====================================================================================================== CREATE
describe('createCommentCode (#58) — AC-09.1', () => {
  it('201 DTO: tenant-wide code -> exactly {id, code, text, is_active:true, version:1}; no department_id, no internal columns; row owned by the caller\'s tenant', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, HYPO_TW);
    expect(out).toEqual({ id: out.id, code: 'HYPO', text: 'Hypochromia (tenant-wide).', is_active: true, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(db.row('comment_codes', out.id)).toMatchObject({ tenant_id: TENANT_A, code: 'HYPO', version: 1, is_active: true, created_by: USER, updated_by: USER });
    expect(db.row('comment_codes', out.id)!.department_id).toBeNull();
  });

  it('201 DTO: department-scoped code carries department_id', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, HYPO_HAEM);
    expect(out).toEqual({ id: out.id, code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.', is_active: true, version: 1 });
    expect(db.row('comment_codes', out.id)).toMatchObject({ department_id: HAEM.id, tenant_id: TENANT_A });
  });

  it.each([[' hypo '], ['HyPo'], ['\thypo\n']])('code %j is trimmed and upper-cased on write (TRD §5.0)', { timeout: T }, async (raw) => {
    const { db, svc } = setup();
    const out = await create(db, svc, { code: raw, text: 'x' });
    expect(out.code).toBe('HYPO');
    expect(db.row('comment_codes', out.id)!.code).toBe('HYPO');
  });

  it('boundaries: a 16-character code and a 2000-character text are accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { code: 'A_1'.padEnd(16, 'Z'), text: 't'.repeat(2000) });
    expect(out.code).toHaveLength(16);
    expect(db.row('comment_codes', out.id)!.text).toHaveLength(2000);
  });

  it('catalog.changed.v1 {entity_type comment_code, change_kind created, entity_id = new id} in the same transaction; revision +1; insert before event', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, HYPO_TW);
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'comment_code', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(TENANT_A)).toBe(418);
    const mine = stmtsOf(db);
    const insertAt = mine.findIndex((s) => /^\s*INSERT\s+INTO\s+catalog\.comment_codes\b/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text))).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('text history: create writes version 1 into comment_code_texts (open window from the transaction clock, same tenant, actor as author)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, HYPO_HAEM, { at: at(7) });
    const texts = db.texts(out.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ tenant_id: TENANT_A, comment_code_id: out.id, text_version: 1, text: 'Hypochromia present.', effective_to: null, created_by: USER, updated_by: USER });
    expect(ms(texts[0]!.effective_from)).toBe(+at(7));
    expect(new Set(stmtsOf(db).map((s) => s.txId)).size).toBe(1);
  });

  it('AC-09.1: department HYPO (HAEM) and tenant-wide HYPO with different text coexist — either creation order; each has its own id, version 1 and text', { timeout: T }, async () => {
    for (const order of [[HYPO_HAEM, HYPO_TW], [HYPO_TW, HYPO_HAEM]]) {
      const { db, svc } = setup();
      const [a, b] = [await create(db, svc, order[0]!, { at: at(1) }), await create(db, svc, order[1]!, { at: at(2) })];
      expect(a.id).not.toBe(b.id);
      expect([a.version, b.version]).toEqual([1, 1]);
      expect(db.rows('comment_codes', TENANT_A).map((r) => [r.code, r.department_id, r.text]).sort()).toEqual(
        [['HYPO', HAEM.id, 'Hypochromia present.'], ['HYPO', null, 'Hypochromia (tenant-wide).']].sort());
      expect(events(db)).toHaveLength(2);
    }
  });

  it('the same code in two different departments is fine; a third tenant-wide one too', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const department_id of [HAEM.id, BIO.id, undefined]) await create(db, svc, { code: 'NOTE', text: 'n', ...(department_id ? { department_id } : {}) });
    expect(db.rows('comment_codes')).toHaveLength(3);
  });

  it.each([
    ['tenant-wide twice', { code: 'HYPO', text: 'a' }, { code: 'HYPO', text: 'b' }],
    ['same department twice', { code: 'HYPO', department_id: HAEM.id, text: 'a' }, { code: 'HYPO', department_id: HAEM.id, text: 'b' }],
    ['tenant-wide, second in another case', { code: 'HYPO', text: 'a' }, { code: 'hypo', text: 'b' }],
    ['tenant-wide, second padded', { code: 'HYPO', text: 'a' }, { code: ' HYPO ', text: 'b' }],
    ['department, second in lower case', { code: 'HYPO', department_id: HAEM.id, text: 'a' }, { code: 'hypo', department_id: HAEM.id, text: 'b' }],
  ])('done_when (expression index): %s -> 409 catalog.code_duplicate — no second row, no text row, no event, no revision bump', { timeout: T }, async (_n, first, second) => {
    const { db, svc } = setup();
    await create(db, svc, first, { at: at(1) });
    lims(await rejection(create(db, svc, second, { at: at(2) })), 'catalog.code_duplicate', 409);
    expect(db.rows('comment_codes')).toHaveLength(1);
    expect(db.rows('comment_code_texts')).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
    expect(db.rows('comment_codes')[0]).toMatchObject({ text: 'a', version: 1 });
  });

  it('an INACTIVE code still owns its (code, department) slot: tenant-wide and department variants -> 409; the other scope stays free', { timeout: T }, async () => {
    const tw = cc(1, TENANT_A, { code: 'HYPO', is_active: false });
    const hd = cc(2, TENANT_A, { code: 'ANISO', department_id: HAEM.id, is_active: false });
    const { db, svc } = setup({ comment_codes: [tw, hd] });
    lims(await rejection(create(db, svc, { code: 'HYPO', text: 'again' })), 'catalog.code_duplicate', 409);
    lims(await rejection(create(db, svc, { code: 'ANISO', department_id: HAEM.id, text: 'again' })), 'catalog.code_duplicate', 409);
    await create(db, svc, { code: 'HYPO', department_id: HAEM.id, text: 'department variant is a different slot' });
    await create(db, svc, { code: 'ANISO', text: 'tenant-wide variant is a different slot' });
    expect(db.rows('comment_codes')).toHaveLength(4);
  });

  it('AC-01.3 pattern: tenant B owning HYPO (tenant-wide and in its department) does not block tenant A; B rows untouched', { timeout: T }, async () => {
    const theirs = [cc(1, TENANT_B, { code: 'HYPO' }), cc(2, TENANT_B, { code: 'HYPO', department_id: B_DEPT.id })];
    const { db, svc } = setup({ comment_codes: theirs });
    await create(db, svc, HYPO_TW);
    await create(db, svc, HYPO_HAEM);
    expect(db.rows('comment_codes', TENANT_B).map((r) => ({ id: r.id, version: r.version, text: r.text }))).toEqual(theirs.map((r) => ({ id: r.id, version: 1, text: r.text })));
    expect(events(db, TENANT_B)).toHaveLength(0);
  });

  it('race: two concurrent creates of the same TENANT-WIDE code -> exactly one wins, the loser gets catalog.code_duplicate (not a raw 23505), one text row, one event', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([create(db, svc, { code: 'HYPO', text: 'one' }, { at: at(1) }), create(db, svc, { code: 'HYPO', text: 'two' }, { at: at(2) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('comment_codes')).toHaveLength(1);
    expect(db.rows('comment_code_texts')).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('race: five concurrent creates of the same code in one department -> one winner, four code_duplicate', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => create(db, svc, { code: 'HYPO', department_id: HAEM.id, text: `w${n}` }, { at: at(n) })));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const r of res.filter((x) => x.status === 'rejected')) lims((r as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('comment_codes')).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
  });

  it('the expression index is the guard: a 23505 from comment_codes__tenant_id_code_dept__uq (a check that raced past any pre-read) is mapped to 409 catalog.code_duplicate', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT INTO catalog\.comment_codes\b/i, () => pgError('23505', 'duplicate key value violates unique constraint "comment_codes__tenant_id_code_dept__uq"', 'comment_codes__tenant_id_code_dept__uq'));
    const e = await rejection(create(db, svc, HYPO_TW));
    lims(e, 'catalog.code_duplicate', 409);
    expect(e.code).not.toBe('23505');
    expect(db.rows('comment_codes')).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
  });

  it('S-1: a department of another tenant (or an unknown one) -> 404 common.not_found, no row, no text, no event, no revision bump', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const department_id of [B_DEPT.id, ID(0xdead)]) lims(await rejection(create(db, svc, { code: 'HYPO', department_id, text: 'x' })), 'common.not_found', 404);
    expect(db.rows('comment_codes')).toHaveLength(0);
    expect(db.rows('comment_code_texts')).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
  });

  it('rollback after create discards row, text version, revision and event together; a failing event insert or text insert fails the create and leaves no row', { timeout: T }, async () => {
    const a = setup();
    await rejection(create(a.db, a.svc, HYPO_TW, { rollback: true }));
    expect(a.db.rows('comment_codes')).toHaveLength(0); expect(a.db.rows('comment_code_texts')).toHaveLength(0);
    expect(events(a.db)).toHaveLength(0); expect(a.db.revisionOf(TENANT_A)).toBe(417);
    for (const match of [/INSERT INTO core\.event_log/i, /INSERT INTO catalog\.comment_code_texts\b/i]) {
      const b = setup();
      b.db.fail(match);
      await rejection(create(b.db, b.svc, HYPO_TW));
      expect(b.db.rows('comment_codes')).toHaveLength(0); expect(b.db.rows('comment_code_texts')).toHaveLength(0);
      expect(b.db.revisionOf(TENANT_A)).toBe(417);
    }
  });

  it('first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup({}, {});
    await create(db, svc, HYPO_TW);
    expect(db.revisionOf(TENANT_A)).toBe(1);
  });

  it.each([
    ['code missing', { code: undefined }], ['code empty', { code: '' }], ['code blank', { code: '   ' }], ['code 17 chars', { code: 'A'.repeat(17) }],
    ['code with hyphen', { code: 'HY-PO' }], ['code with space', { code: 'HY PO' }], ['code with dot', { code: 'HY.PO' }], ['code with slash', { code: 'HY/PO' }],
    ['code with a Unicode letter that upper-cases to ASCII (ı)', { code: 'hypoı' }], ['code number', { code: 12 }], ['code null', { code: null }],
    ['text missing', { text: undefined }], ['text empty', { text: '' }], ['text 2001 chars', { text: 't'.repeat(2001) }], ['text number', { text: 5 }], ['text null', { text: null }],
    ['department_id not a uuid', { department_id: 'not-a-uuid' }], ['department_id number', { department_id: 7 }], ['department_id null (the DTO has no nulls)', { department_id: null }],
  ])('invalid body: %s -> 400 before any write (the service is also called by import commits, so it validates itself)', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    const body = Object.fromEntries(Object.entries({ code: 'HYPO', text: 'x', ...over }).filter(([, v]) => v !== undefined));
    validation400(await rejection(create(db, svc, body)));
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });

  it.each([['tenant_id', { tenant_id: TENANT_B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }], ['is_active (not in CommentCodeCreate)', { is_active: false }],
    ['created_by', { created_by: USER }], ['status', { status: 'x' }], ['effective_from', { effective_from: '2020-01-01T00:00:00.000Z' }], ['__proto__ key', JSON.parse('{"__proto__": {"is_active": false}}')],
  ])('S-5: mass assignment (%s) -> 400, nothing written', { timeout: T }, async (_n, extra) => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { ...HYPO_TW, ...extra })));
    expect(writes(db)).toEqual([]);
    expect(db.rows('comment_codes')).toHaveLength(0);
  });

  it('a non-object body is a 400, not a crash', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const body of [null, 'HYPO', 7, [HYPO_TW]]) validation400(await rejection(create(db, svc, body as never)));
  });

  it('REQ-SEC-088/089 data side: markup / quotes / SQL fragments / newlines are stored and returned verbatim (escaping is the UI\'s job) and never reach SQL text', { timeout: T }, async () => {
    const nasty = "<img src=x onerror=alert(1)> & \"q\" ' ; DROP TABLE catalog.comment_codes; --\nLine 2\t🧪 é";
    const { db, svc } = setup();
    const out = await create(db, svc, { code: 'XSS', text: nasty });
    expect(out.text).toBe(nasty);
    expect(db.row('comment_codes', out.id)!.text).toBe(nasty);
    expect(db.texts(out.id)[0]!.text).toBe(nasty);
    expect((await list(db, svc)).data[0].text).toBe(nasty);
    for (const s of db.stmts) expect(s.text).not.toContain('DROP TABLE');
  });

  it('AB-20: error detail never echoes submitted values (validation, duplicate, foreign department)', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const { db, svc } = setup();
    await create(db, svc, { code: 'HYPO', text: 'first' });
    const errs = [
      await rejection(create(db, svc, { code: 'HYPO', text: planted })),
      await rejection(create(db, svc, { code: 'BAD CODE', text: planted })),
      await rejection(create(db, svc, { code: planted.toUpperCase(), text: 'x' })),
      await rejection(create(db, svc, { code: 'NEW', text: planted, department_id: B_DEPT.id })),
      await rejection(create(db, svc, { code: 'NEW', text: planted, unknown_field: planted })),
    ];
    for (const e of errs) expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
  });

  it('SQL stays parameterised and append-only: text and code are bind values, no DELETE', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { code: 'HYPO', text: 'bound-text-0xC0FFEE', department_id: HAEM.id });
    const ins = db.stmts.filter((s) => /^\s*INSERT\s+INTO\s+catalog\.comment_code(s|_texts)\b/i.test(s.text));
    expect(ins.length).toBeGreaterThanOrEqual(2);
    for (const s of ins) { expect(s.text).not.toContain('bound-text-0xC0FFEE'); expect(s.text).not.toContain('HYPO'); }
    expect(ins.some((s) => s.values.includes('bound-text-0xC0FFEE') && s.values.includes(TENANT_A))).toBe(true);
    expect(db.stmts.filter((s) => /^\s*DELETE\b/i.test(s.text))).toEqual([]);
    expect(out.id).toMatch(UUIDV7);
  });
});

// ====================================================================================================== LIST
describe('listCommentCodes (#57)', () => {
  const rows = () => [
    cc(1, TENANT_A, { code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.' }),
    cc(2, TENANT_A, { code: 'HYPO', text: 'Hypochromia (tenant-wide).' }),
    cc(3, TENANT_A, { code: 'HYPER', department_id: HAEM.id }),
    cc(4, TENANT_A, { code: 'GLU', department_id: BIO.id }),
    cc(5, TENANT_A, { code: 'NOTE' }),
    cc(6, TENANT_A, { code: 'OLD', department_id: HAEM.id, is_active: false }),
    cc(7, TENANT_A, { code: 'OLDTW', is_active: false }),
  ];
  const withB = () => [...rows(), cc(20, TENANT_B, { code: 'BONLY' }), cc(21, TENANT_B, { code: 'HYPO', department_id: B_DEPT.id, text: 'B secret' })];

  it('default: every ACTIVE code of the tenant (department-scoped and tenant-wide), DTO exactly the CommentCode schema keys', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: withB() });
    const out = await list(db, svc);
    expect(out.data).toHaveLength(5);
    expect(out.data.every((x: Row) => x.is_active === true)).toBe(true);
    expect(codesOf(out)).toEqual(['GLU', 'HYPER', 'HYPO', 'HYPO', 'NOTE']);
    expect(out.page.limit).toBe(50);
    const hypoDept = out.data.find((x: Row) => x.id === cc(1, TENANT_A).id);
    expect(hypoDept).toEqual({ id: cc(1, TENANT_A).id, code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.', is_active: true, version: 1 });
    const hypoTw = out.data.find((x: Row) => x.id === cc(2, TENANT_A).id);
    expect(hypoTw).toEqual({ id: cc(2, TENANT_A).id, code: 'HYPO', text: 'Hypochromia (tenant-wide).', is_active: true, version: 1 });
    for (const x of out.data) for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at']) expect(x).not.toHaveProperty(k);
  });

  it('AC-09.2: deactivated codes are not listed by default', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    expect(codesOf(await list(db, svc))).not.toContain('OLD');
    expect(codesOf(await list(db, svc))).not.toContain('OLDTW');
  });

  it('AC-09.1: department_id filter returns that department\'s codes AND the tenant-wide ones (never another department\'s); both HYPO entries are present with their own text and version', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: withB() });
    const out = await list(db, svc, { department_id: HAEM.id });
    expect(codesOf(out)).toEqual(['HYPER', 'HYPO', 'HYPO', 'NOTE']);
    expect(out.data.filter((x: Row) => x.code === 'HYPO').map((x: Row) => [x.department_id ?? null, x.text, x.version]).sort())
      .toEqual([[HAEM.id, 'Hypochromia present.', 1], [null, 'Hypochromia (tenant-wide).', 1]].sort());
    const bio = await list(db, svc, { department_id: BIO.id });
    expect(codesOf(bio)).toEqual(['GLU', 'HYPO', 'NOTE']);                                    // only the tenant-wide HYPO
    expect(bio.data.find((x: Row) => x.code === 'HYPO')).not.toHaveProperty('department_id');
  });

  it('a department without codes of its own yields just the tenant-wide ones', { timeout: T }, async () => {
    const other = dept(3, TENANT_A, { code: 'MICRO' });
    const { db, svc } = setup({ comment_codes: rows() }, seedState, [HAEM, BIO, other]);
    expect(codesOf(await list(db, svc, { department_id: other.id }))).toEqual(['HYPO', 'NOTE']);
  });

  it('S-1: never returns tenant B rows (no code, no text); a B department id yields no B data', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: withB() });
    const all = await list(db, svc);
    expect(JSON.stringify(all)).not.toMatch(/BONLY|B secret/);
    expect(all.data.map((x: Row) => x.id)).not.toContain(cc(20, TENANT_B).id);
    const viaB = await db.run((ctx) => svc['listCommentCodes']!(ctx, { department_id: B_DEPT.id })).then((r) => r, (e) => e);
    expect(JSON.stringify(viaB instanceof Error ? '' : viaB)).not.toMatch(/BONLY|B secret/);
    if (viaB instanceof Error) { expect(viaB).not.toBeInstanceOf(TypeError); expect([200, 404]).toContain((viaB as any).statusCode); }
    const asB = await list(db, svc, {}, TENANT_B);
    expect(codesOf(asB)).toEqual(['BONLY', 'HYPO']);
    expect(JSON.stringify(asB)).not.toContain('Hypochromia');
  });

  it('code_prefix: only codes starting with it; case of the stored code is upper, an unmatched prefix gives an empty page', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: [...rows(), cc(8, TENANT_A, { code: 'AHY' }), cc(9, TENANT_A, { code: 'H' })] });
    expect(codesOf(await list(db, svc, { code_prefix: 'HYP' }))).toEqual(['HYPER', 'HYPO', 'HYPO']);
    expect(codesOf(await list(db, svc, { code_prefix: 'H' }))).toEqual(['H', 'HYPER', 'HYPO', 'HYPO']);        // a prefix equal to a whole code matches it
    expect(codesOf(await list(db, svc, { code_prefix: 'ZZ' }))).toEqual([]);
    expect(codesOf(await list(db, svc, { code_prefix: 'HYPO', department_id: HAEM.id }))).toEqual(['HYPO', 'HYPO']);   // combines with the department filter
  });

  it('code_prefix is a literal prefix, not a LIKE pattern: `_` and `%` are not wildcards', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: [cc(1, TENANT_A, { code: 'H_X' }), cc(2, TENANT_A, { code: 'HBX' }), cc(3, TENANT_A, { code: 'HYX' })] });
    expect(codesOf(await list(db, svc, { code_prefix: 'H_' }))).toEqual(['H_X']);
    const pct = await db.run((ctx) => svc['listCommentCodes']!(ctx, { code_prefix: '%' })).then((r) => r, (e) => e);
    if (pct instanceof Error) validation400(pct); else expect(pct.data).toEqual([]);            // never "everything"
  });

  it('order is deterministic: by code, then id', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    const out = await list(db, svc);
    const keys = out.data.map((x: Row) => `${x.code}|${x.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('cursor pagination: limit 2 over 5 active rows -> 2,2,1, no duplicates or gaps, next_cursor absent on the last page', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0; const sizes: number[] = [];
    do {
      const p = await list(db, svc, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(p.page.limit).toBe(2);
      sizes.push(p.data.length);
      seen.push(...p.data.map((x: Row) => x.id));
      cursor = p.page.next_cursor;
      if (cursor !== undefined) expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(sizes).toEqual([2, 2, 1]);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual((await list(db, svc)).data.map((x: Row) => x.id));                    // same order as the unpaged list
  });

  it('pagination keeps the department filter and does not leak across it', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    const a = await list(db, svc, { department_id: BIO.id, limit: 1 });
    expect(a.data).toHaveLength(1);
    const b = await list(db, svc, { department_id: BIO.id, limit: 1, cursor: a.page.next_cursor });
    const c = await list(db, svc, { department_id: BIO.id, limit: 1, cursor: b.page.next_cursor });
    expect([...a.data, ...b.data, ...c.data].map((x: Row) => x.code).sort()).toEqual(['GLU', 'HYPO', 'NOTE']);
    expect(c.page.next_cursor).toBeUndefined();
  });

  it.each([['garbage', '!!!not-a-cursor!!!'], ['well-formed base64url but not ours', 'AAAA'], ['empty', '']])('malformed cursor (%s) -> 400 common.invalid_cursor', { timeout: T }, async (_n, cursor) => {
    const { db, svc } = setup({ comment_codes: rows() });
    const e = await rejection(list(db, svc, { cursor }));
    expect(e.statusCode).toBe(400);
    expect(['common.invalid_cursor', 'common.validation_failed']).toContain(e.code);
  });

  it('S-1: a cursor minted for tenant A never returns A rows to tenant B', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: withB() });
    const a = await list(db, svc, { limit: 1 });
    const res = await db.run((ctx) => svc['listCommentCodes']!(ctx, { limit: 50, cursor: a.page.next_cursor }), { tenantId: TENANT_B }).then((r) => r, (e) => e);
    if (res instanceof Error) { expect(res).not.toBeInstanceOf(TypeError); expect(res.statusCode).toBe(400); }
    else for (const x of res.data) expect(['BONLY', 'HYPO']).toContain(x.code);
    expect(JSON.stringify(res instanceof Error ? '' : res)).not.toContain('Hypochromia');
  });

  it.each([['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit 1.5', { limit: 1.5 }], ['limit -1', { limit: -1 }], ['department_id not a uuid', { department_id: 'x' }],
    ['department_id number', { department_id: 5 }], ['code_prefix 17 chars', { code_prefix: 'A'.repeat(17) }], ['code_prefix number', { code_prefix: 5 }],
    ['unknown filter', { tenant_id: TENANT_B }], ['unknown sort', { sort: 'text' }]])('invalid query: %s -> 400', { timeout: T }, async (_n, q) => {
    const { db, svc } = setup({ comment_codes: rows() });
    validation400(await rejection(list(db, svc, q)));
  });

  it('limit 200 is accepted and echoed', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    expect((await list(db, svc, { limit: 200 })).page.limit).toBe(200);
  });

  it('a list is a pure read: no INSERT/UPDATE, no revision bump, no event', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    await list(db, svc, { department_id: HAEM.id, code_prefix: 'H' });
    expect(writes(db)).toEqual([]);
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(events(db)).toHaveLength(0);
  });

  it('every statement is tenant-scoped explicitly and bound (RLS is the second line, not the first)', { timeout: T }, async () => {
    const { db, svc } = setup({ comment_codes: rows() });
    await list(db, svc, { department_id: HAEM.id, code_prefix: 'HY' });
    const sel = stmtsOf(db).filter((s) => /^\s*SELECT\b[\s\S]*\bFROM\s+catalog\.comment_codes\b/i.test(s.text));
    expect(sel.length).toBeGreaterThanOrEqual(1);
    for (const s of sel) { expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(TENANT_A); expect(s.text).not.toContain(HAEM.id); }
  });
});

// ====================================================================================================== UPDATE
describe('updateCommentCode (#59) — AC-09.3, AC-09.2', () => {
  const fresh = () => {
    const s = setup({ comment_codes: [cc(1, TENANT_B, { code: 'HYPO' })] });
    return s;
  };
  /** A code created through the service at AT(1), so its text history is exactly what the writer produces. */
  const made = async (body: object = HYPO_HAEM) => {
    const s = fresh();
    const row = await create(s.db, s.svc, body, { at: at(1) });
    return { ...s, row };
  };

  it('AC-09.3: editing the text -> DTO with version+1 and the new text; code, department, is_active untouched; one `updated` event, revision +1', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    const out = await upd(db, svc, row.id, 1, { text: 'Hypochromia marked.' }, { at: at(2) });
    expect(out).toEqual({ id: row.id, code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia marked.', is_active: true, version: 2 });
    expect(db.row('comment_codes', row.id)).toMatchObject({ text: 'Hypochromia marked.', version: 2, tenant_id: TENANT_A, code: 'HYPO', department_id: HAEM.id, created_by: USER });
    const ev = events(db);
    expect(ev).toHaveLength(2);                                                              // create + update
    expect(ev[1]!.envelope.payload).toMatchObject({ catalog_revision: 419, entity_type: 'comment_code', entity_id: row.id, change_kind: 'updated' });
    expect(db.revisionOf(TENANT_A)).toBe(419);
  });

  it('AC-09.3: the previous text is KEPT as a closed history row, the new one is open — text_version = the new version, windows are contiguous, old rows never rewritten', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { text: 'Second text.' }, { at: at(2) });
    await upd(db, svc, row.id, 2, { text: 'Third text.' }, { at: at(3) });
    const t = db.texts(row.id);
    expect(t.map((x) => [x.text_version, x.text])).toEqual([[1, 'Hypochromia present.'], [2, 'Second text.'], [3, 'Third text.']]);
    expect(t.map((x) => ms(x.effective_from))).toEqual([+at(1), +at(2), +at(3)]);
    expect(ms(t[0]!.effective_to)).toBe(+at(2));
    expect(ms(t[1]!.effective_to)).toBe(+at(3));
    expect(t[2]!.effective_to).toBeNull();
    expect(t.filter((x) => x.effective_to === null)).toHaveLength(1);
    expect(t.every((x) => x.tenant_id === TENANT_A && x.comment_code_id === row.id)).toBe(true);
    expect(db.row('comment_codes', row.id)!.text).toBe('Third text.');
  });

  it('no statement ever UPDATEs a history row except to close its window (effective_to / audit columns): the trigger is not what protects it', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { text: 'Second text.' }, { at: at(2) });
    const histUpdates = db.stmts.filter((s) => /^\s*UPDATE\s+catalog\.comment_code_texts\b/i.test(s.text));
    for (const s of histUpdates) {
      const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(s.text)![1]!;
      expect(set.replace(/\b(effective_to|updated_at|updated_by|version)\b/gi, '')).not.toMatch(/\b(text|text_version|effective_from|comment_code_id|tenant_id|id)\b\s*=/i);
      expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
    }
  });

  it('AC-09.3: an is_active-only change bumps `version` but writes no text row; a later text edit records text_version = the DTO version (versions of the code may skip numbers)', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    const off = await upd(db, svc, row.id, 1, { is_active: false }, { at: at(2) });
    expect(off).toMatchObject({ is_active: false, version: 2, text: 'Hypochromia present.' });
    expect(db.texts(row.id)).toHaveLength(1);
    expect(db.texts(row.id)[0]!.effective_to).toBeNull();
    const on = await upd(db, svc, row.id, 2, { is_active: true, text: 'Back again.' }, { at: at(3) });
    expect(on).toMatchObject({ is_active: true, version: 3, text: 'Back again.' });
    const t = db.texts(row.id);
    expect(t.map((x) => x.text_version)).toEqual([1, 3]);
    expect(ms(t[0]!.effective_to)).toBe(+at(3));
    expect(t[1]!.effective_to).toBeNull();
  });

  it('events: is_active true -> false is `deactivated`; false -> true is `updated`; a text change together with deactivation is ONE `deactivated` event', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { is_active: false }, { at: at(2) });
    await upd(db, svc, row.id, 2, { is_active: true }, { at: at(3) });
    await upd(db, svc, row.id, 3, { is_active: false, text: 'Retired wording.' }, { at: at(4) });
    expect(events(db).map((e) => e.envelope.payload.change_kind)).toEqual(['created', 'deactivated', 'updated', 'deactivated']);
    expect(events(db).map((e) => e.envelope.payload.catalog_revision)).toEqual([418, 419, 420, 421]);
    expect(new Set(events(db).map((e) => e.envelope.payload.entity_id))).toEqual(new Set([row.id]));
  });

  it('AC-09.2: a deactivated code leaves the default list but keeps its slot (re-creating it is a 409); reactivating lists it again without a new text row', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { is_active: false }, { at: at(2) });
    expect(codesOf(await list(db, svc))).toEqual([]);
    lims(await rejection(create(db, svc, { ...HYPO_HAEM, text: 'again' }, { at: at(3) })), 'catalog.code_duplicate', 409);
    await upd(db, svc, row.id, 2, { is_active: true }, { at: at(4) });
    expect((await list(db, svc)).data.map((x: Row) => x.id)).toEqual([row.id]);
    expect(db.texts(row.id)).toHaveLength(1);
  });

  it('a partial patch leaves every other field as it was', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    const before = db.row('comment_codes', row.id)!;
    await upd(db, svc, row.id, 1, { text: 'Only the text.' }, { at: at(2) });
    const after = db.row('comment_codes', row.id)!;
    for (const c of Object.keys(before)) if (!['text', 'version', 'updated_at', 'updated_by'].includes(c)) expect(after[c], c).toEqual(before[c]);
  });

  it('AC-01.6 pattern: no If-Match -> 428 common.precondition_required; nothing changes (row, text history, revision, events)', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    lims(await rejection(upd(db, svc, row.id, undefined, { text: 'x' }, { at: at(2) })), 'common.precondition_required', 428);
    expect(db.row('comment_codes', row.id)).toMatchObject({ version: 1, text: 'Hypochromia present.' });
    expect(db.texts(row.id)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
    expect(events(db)).toHaveLength(1);
  });

  it('AC-01.6 pattern: stale If-Match -> 409 common.version_conflict; nothing changes', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { text: 'Second.' }, { at: at(2) });
    lims(await rejection(upd(db, svc, row.id, 1, { text: 'stale write' }, { at: at(3) })), 'common.version_conflict', 409);
    lims(await rejection(upd(db, svc, row.id, 99, { text: 'future' }, { at: at(4) })), 'common.version_conflict', 409);
    expect(db.row('comment_codes', row.id)).toMatchObject({ version: 2, text: 'Second.' });
    expect(db.texts(row.id)).toHaveLength(2);
    expect(events(db)).toHaveLength(2);
    expect(db.revisionOf(TENANT_A)).toBe(419);
  });

  it('race: two concurrent text edits with the same If-Match -> one wins, the other is version_conflict; exactly 2 history rows, one open', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    const res = await Promise.allSettled([upd(db, svc, row.id, 1, { text: 'writer one' }, { at: at(2) }), upd(db, svc, row.id, 1, { text: 'writer two' }, { at: at(3) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row('comment_codes', row.id)!.version).toBe(2);
    const t = db.texts(row.id);
    expect(t).toHaveLength(2);
    expect(t.filter((x) => x.effective_to === null)).toHaveLength(1);
    expect(t[1]!.text).toBe(db.row('comment_codes', row.id)!.text);
    expect(events(db)).toHaveLength(2);
    expect(db.revisionOf(TENANT_A)).toBe(419);
  });

  it('the UPDATE is optimistic in SQL (version predicate) and tenant-scoped explicitly, all values bound', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    await upd(db, svc, row.id, 1, { text: 'Bound-update-text.' }, { at: at(2) });
    const u = db.stmts.filter((s) => /^\s*UPDATE\s+catalog\.comment_codes\b/i.test(s.text));
    expect(u).toHaveLength(1);
    const where = u[0]!.text.split(/\bWHERE\b/i)[1] ?? '';
    expect(where).toMatch(/\bversion\s*=\s*\$\d+/i);
    expect(where).toMatch(/\btenant_id\s*=\s*\$\d+/i);
    expect(u[0]!.values).toEqual(expect.arrayContaining([TENANT_A, row.id, 1]));
    expect(u[0]!.text).not.toContain('Bound-update-text.');
  });

  it('unknown id -> 404 common.not_found (no event, no text row)', { timeout: T }, async () => {
    const { db, svc } = await made();
    lims(await rejection(upd(db, svc, ID(0xdead), 1, { text: 'x' }, { at: at(2) })), 'common.not_found', 404);
    expect(events(db)).toHaveLength(1);
    expect(db.rows('comment_code_texts')).toHaveLength(1);
  });

  it('S-1: tenant A cannot update tenant B\'s code (text or is_active) -> 404; B row, B history, B events and A revision unchanged', { timeout: T }, async () => {
    const theirs = cc(30, TENANT_B, { code: 'THEIRS', text: 'B text' });
    const { db, svc } = setup({ comment_codes: [theirs], comment_code_texts: [ccText(30, theirs.id, TENANT_B, { text: 'B text' })] });
    for (const patch of [{ text: 'hacked' }, { is_active: false }]) lims(await rejection(upd(db, svc, theirs.id, 1, patch)), 'common.not_found', 404);
    expect(db.row('comment_codes', theirs.id)).toMatchObject({ version: 1, text: 'B text', is_active: true });
    expect(db.texts(theirs.id)).toHaveLength(1);
    expect(db.texts(theirs.id)[0]).toMatchObject({ text: 'B text', effective_to: null });
    expect(events(db)).toHaveLength(0); expect(events(db, TENANT_B)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
  });

  it.each([['code (immutable)', { code: 'RENAMED' }], ['department_id (immutable; not in CommentCodeUpdate)', { department_id: BIO.id }], ['tenant_id', { tenant_id: TENANT_B }],
    ['id', { id: ID(0xbad) }], ['version', { version: 9 }], ['created_by', { created_by: USER }], ['status', { status: 'x' }], ['effective_to', { effective_to: '2020-01-01T00:00:00.000Z' }],
    ['is_active as string', { is_active: 'false' }], ['is_active null', { is_active: null }], ['text null', { text: null }], ['text number', { text: 5 }]])('S-5: patch field %s -> 400, row and history unchanged', { timeout: T }, async (_n, patch) => {
    const { db, svc, row } = await made();
    validation400(await rejection(upd(db, svc, row.id, 1, patch, { at: at(2) })));
    expect(db.row('comment_codes', row.id)).toMatchObject({ version: 1, code: 'HYPO', department_id: HAEM.id, tenant_id: TENANT_A, text: 'Hypochromia present.', is_active: true });
    expect(db.texts(row.id)).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
  });

  it.each([['text empty', { text: '' }], ['text 2001 chars', { text: 't'.repeat(2001) }]])('invalid patch: %s -> 400, row unchanged', { timeout: T }, async (_n, patch) => {
    const { db, svc, row } = await made();
    validation400(await rejection(upd(db, svc, row.id, 1, patch, { at: at(2) })));
    expect(db.row('comment_codes', row.id)!.version).toBe(1);
    expect(db.texts(row.id)).toHaveLength(1);
  });

  it('a 2000-character text is accepted', { timeout: T }, async () => {
    const { db, svc, row } = await made();
    expect((await upd(db, svc, row.id, 1, { text: 't'.repeat(2000) }, { at: at(2) })).version).toBe(2);
  });

  it('REQ-SEC-088/089 data side: an edited text is stored verbatim in the code AND in its history row', { timeout: T }, async () => {
    const nasty = '<script>alert(1)</script> \' OR 1=1 --';
    const { db, svc, row } = await made();
    const out = await upd(db, svc, row.id, 1, { text: nasty }, { at: at(2) });
    expect(out.text).toBe(nasty);
    expect(db.texts(row.id)[1]!.text).toBe(nasty);
    for (const s of db.stmts) expect(s.text).not.toContain('alert(1)');
  });

  it('rollback after update — or a failing event/text insert — discards the change, the history row, the window closing, the revision bump and the event together', { timeout: T }, async () => {
    const a = await made();
    await rejection(upd(a.db, a.svc, a.row.id, 1, { text: 'gone' }, { at: at(2), rollback: true }));
    expect(a.db.row('comment_codes', a.row.id)).toMatchObject({ version: 1, text: 'Hypochromia present.' });
    expect(a.db.texts(a.row.id)).toHaveLength(1);
    expect(a.db.texts(a.row.id)[0]!.effective_to).toBeNull();
    expect(a.db.revisionOf(TENANT_A)).toBe(418);
    for (const match of [/INSERT INTO core\.event_log/i, /INSERT INTO catalog\.comment_code_texts\b/i]) {
      const b = await made();
      b.db.fail(match);
      await rejection(upd(b.db, b.svc, b.row.id, 1, { text: 'gone' }, { at: at(2) }));
      expect(b.db.row('comment_codes', b.row.id)).toMatchObject({ version: 1, text: 'Hypochromia present.' });
      expect(b.db.texts(b.row.id)).toHaveLength(1);
      expect(b.db.texts(b.row.id)[0]!.effective_to).toBeNull();
      expect(b.db.revisionOf(TENANT_A)).toBe(418);
    }
  });

  it('AB-20: error detail never echoes the submitted text', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const { db, svc, row } = await made();
    const errs = [
      await rejection(upd(db, svc, row.id, 7, { text: planted }, { at: at(2) })),
      await rejection(upd(db, svc, ID(0xdead), 1, { text: planted }, { at: at(3) })),
      await rejection(upd(db, svc, row.id, 1, { text: planted, code: planted }, { at: at(4) })),
    ];
    for (const e of errs) expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
  });

  it('seeded legacy-free case: a code seeded together with its version-1 history edits cleanly', { timeout: T }, async () => {
    const row = cc(40, TENANT_A, { code: 'SEED', text: 'Seed text.' });
    const { db, svc } = setup({ comment_codes: [row], comment_code_texts: [ccText(40, row.id, TENANT_A, { text: 'Seed text.', effective_from: at(0) })] });
    const out = await upd(db, svc, row.id, 1, { text: 'Seed text, edited.' }, { at: at(5) });
    expect(out.version).toBe(2);
    expect(db.texts(row.id).map((x) => [x.text_version, x.text, x.effective_to === null ? null : ms(x.effective_to)])).toEqual([[1, 'Seed text.', +at(5)], [2, 'Seed text, edited.', null]]);
  });
});
