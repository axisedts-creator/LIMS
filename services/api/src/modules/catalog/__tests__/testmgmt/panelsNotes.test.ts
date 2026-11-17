// T0B-TESTMGMT-1 (LD-318, done_when 2, 3, 5, 7): panels (ElabAssist Profile / Package) and notes (comment codes) with their new fields. Real PG17, RLS on.
// PINNED PICKS: note text is plain text or the safe Markdown subset, NEVER raw HTML: a '<' directly followed by a letter, '/' or '!' is rejected by the SERVICE with 400 at /text
// (the database CHECK is only the backstop), "<5 mg/dL" stays legal; Markdown notes need text_format 'markdown' to be offered as such but the HTML rule applies to both formats.
// Notes and panels are deactivated (is_active false), never deleted: no delete operation exists (boot.test.ts) and lims_app has no DELETE grant (probes).
import { beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, T, auditRows, call, changedEvents, dbRow, expectCode, expectInvalid, fails, im, mkLegacyTest as mkTest, req, schemaErrors, tag, uid, world, type World } from './helpers.js';

let A: World; let B: World; let member: any;
beforeAll(async () => { A = await world(TENANT_A); B = await world(TENANT_B); member = await mkTest(A); }, T);

const panelBody = (o: Record<string, unknown> = {}) => ({ code: `PN${tag(5)}`, name: 'Synthetic profile', panel_kind: 'clinical', members: [{ kind: 'test', orderable_id: member.id, sort_order: 0 }], ...o });
const mkPanel = (o: Record<string, unknown> = {}, tenant = TENANT_A) => call('createPanel', req({ body: panelBody(o), headers: { 'idempotency-key': uid() } }), { tenant });
const updPanel = (id: string, version: number, body: object, tenant = TENANT_A) => call('updatePanel', req({ params: { panel_id: id }, headers: im(version), body }), { tenant });
const noteBody = (o: Record<string, unknown> = {}) => ({ code: `N${tag(6)}`, text: 'Synthetic note text', ...o });
const mkNote = (o: Record<string, unknown> = {}, tenant = TENANT_A) => call('createCommentCode', req({ body: noteBody(o), headers: { 'idempotency-key': uid() } }), { tenant });
const updNote = (id: string, version: number, body: object, tenant = TENANT_A) => call('updateCommentCode', req({ params: { comment_code_id: id }, headers: im(version), body }), { tenant });
const category = async (w: World) => (await call('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: w.dept.id, name: `Cat ${tag()}` } }), { tenant: w.tenant })).body;
const long = (n: number) => 'x'.repeat(n);

describe('panels: profile / package fields', () => {
  it('createPanel with barcode_text, loyalty_points, display_order, is_popular: 201 Panel (schema valid), echoed by getPanelDetail, columns stored; defaults 0 / false / absent when not sent', { timeout: T }, async () => {
    const r = await mkPanel({ barcode_text: 'PB-9', loyalty_points: 40, display_order: 3, is_popular: true, panel_kind: 'package' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(schemaErrors('Panel', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ barcode_text: 'PB-9', loyalty_points: 40, display_order: 3, is_popular: true, panel_kind: 'package' });
    const g = await call('getPanelDetail', req({ params: { panel_id: r.body.id } }));
    expect(g.body).toMatchObject({ barcode_text: 'PB-9', loyalty_points: 40, display_order: 3, is_popular: true });
    expect(await dbRow('panels', r.body.id)).toMatchObject({ tenant_id: TENANT_A, barcode_text: 'PB-9', loyalty_points: 40, display_order: 3, is_popular: true });
    const d = (await mkPanel()).body;
    expect(d).toMatchObject({ loyalty_points: 0, is_popular: false });
    expect(d.barcode_text).toBeUndefined(); expect(d.display_order).toBeUndefined();
  });
  it.each([
    ['barcode_text empty', { barcode_text: '' }, '/barcode_text'], ['barcode_text over 64', { barcode_text: long(65) }, '/barcode_text'],
    ['loyalty_points negative', { loyalty_points: -1 }, '/loyalty_points'], ['loyalty_points above 1000000', { loyalty_points: 1_000_001 }, '/loyalty_points'], ['loyalty_points fractional', { loyalty_points: 0.5 }, '/loyalty_points'],
    ['display_order negative', { display_order: -1 }, '/display_order'], ['display_order above 9999', { display_order: 10_000 }, '/display_order'],
    ['is_popular not a boolean', { is_popular: 'yes' }, '/is_popular'], ['an unknown field', { is_hot: true }, '/is_hot'],
  ])('createPanel rejects %s (400 + path, no write)', { timeout: T }, async (_n, over, path) => {
    await expectInvalid('createPanel', req({ body: panelBody(over), headers: { 'idempotency-key': uid() } }), path);
  });
  it('updatePanel changes the new fields in place (version +1, audit line with changed columns, one catalog.changed.v1 panel / updated), unset barcode_text clears it, stale If-Match 409, other tenant 404', { timeout: T }, async () => {
    const p = (await mkPanel({ barcode_text: 'OLD', loyalty_points: 1 })).body;
    const r = await updPanel(p.id, p.version, { barcode_text: 'NEW', loyalty_points: 9, display_order: 4, is_popular: true });
    expect(r.body).toMatchObject({ barcode_text: 'NEW', loyalty_points: 9, display_order: 4, is_popular: true, version: p.version + 1 });
    const audit = (await auditRows('panels', p.id)).filter((x: any) => x.action === 'UPDATE');
    expect(audit).toHaveLength(1);
    for (const c of ['barcode_text', 'loyalty_points', 'display_order', 'is_popular']) expect(audit[0].changed_columns, c).toContain(c);
    expect((await changedEvents(TENANT_A, p.id)).map((e: any) => `${e.envelope.payload.entity_type}:${e.envelope.payload.change_kind}`)).toEqual(['panel:created', 'panel:updated']);
    const c = await updPanel(p.id, r.body.version, { unset: ['barcode_text'] });
    expect(c.body.barcode_text).toBeUndefined();
    expect((await dbRow('panels', p.id)).barcode_text).toBeNull();
    expectCode(await fails('updatePanel', req({ params: { panel_id: p.id }, headers: im(1), body: { loyalty_points: 2 } })), 'common.version_conflict', 409);
    expectCode(await fails('updatePanel', req({ params: { panel_id: p.id }, headers: im(3), body: { loyalty_points: 2 } }), { tenant: TENANT_B }), 'common.not_found', 404);
  });
  it('updatePanel rejects bad values with the path and writes nothing; is_active false deactivates (the row stays)', { timeout: T }, async () => {
    const p = (await mkPanel()).body;
    await expectInvalid('updatePanel', req({ params: { panel_id: p.id }, headers: im(p.version), body: { loyalty_points: -5 } }), '/loyalty_points');
    await expectInvalid('updatePanel', req({ params: { panel_id: p.id }, headers: im(p.version), body: { barcode_text: long(65) } }), '/barcode_text');
    const off = await updPanel(p.id, p.version, { is_active: false });
    expect(off.body.is_active).toBe(false);
    expect(await dbRow('panels', p.id)).toBeTruthy();
    expect((await changedEvents(TENANT_A, p.id)).map((e: any) => e.envelope.payload.change_kind)).toContain('deactivated');
  });
});

describe('notes (comment codes): category, result type, default template, text format', () => {
  it('createCommentCode with every new field: 201 CommentCode (schema valid), echoed, stored; defaults text_format plain, is_default_template false', { timeout: T }, async () => {
    const cat = await category(A);
    const r = await mkNote({ category_id: cat.id, result_type: 'narrative', is_default_template: true, text_format: 'markdown', text: 'Interpret with **care**.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(schemaErrors('CommentCode', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ category_id: cat.id, result_type: 'narrative', is_default_template: true, text_format: 'markdown', text: 'Interpret with **care**.' });
    expect(await dbRow('comment_codes', r.body.id)).toMatchObject({ tenant_id: TENANT_A, category_id: cat.id, result_type: 'narrative', is_default_template: true, text_format: 'markdown' });
    const d = (await mkNote()).body;
    expect(d).toMatchObject({ text_format: 'plain', is_default_template: false });
    expect(d.category_id).toBeUndefined(); expect(d.result_type).toBeUndefined();
  });
  it('all 11 result types are accepted for a note', { timeout: T }, async () => {
    for (const result_type of ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative', 'boolean', 'test_footer', 'space', 'graph', 'html_descriptive']) {
      expect((await mkNote({ result_type })).body.result_type, result_type).toBe(result_type);
    }
  });
  const HTML = ['<b>bold</b>', 'see <a href="x">link</a>', '<script>alert(1)</script>', '</p>', '<!-- hidden -->', 'text <IMG src=x onerror=1>', '<p>para'];
  it.each(HTML)('raw HTML is rejected by the service at /text: %s', { timeout: T }, async (text) => {
    await expectInvalid('createCommentCode', req({ body: noteBody({ text }), headers: { 'idempotency-key': uid() } }), '/text');
    await expectInvalid('createCommentCode', req({ body: noteBody({ text, text_format: 'markdown' }), headers: { 'idempotency-key': uid() } }), '/text');
  });
  it.each(['Value < 5 mg/dL is low', '<5 mg/dL', 'a < b and c > d', 'Ratio 1<2', '**bold** and _italic_ and a [link](https://example.org)'])('legal text stays legal: %s', { timeout: T }, async (text) => {
    expect((await mkNote({ text })).status).toBe(201);
  });
  it('update applies the same HTML rule and the new fields; unset clears category_id and result_type; the version moves 1 -> 2; audit names the changed columns', { timeout: T }, async () => {
    const cat = await category(A);
    const n = (await mkNote({ category_id: cat.id, result_type: 'text' })).body;
    await expectInvalid('updateCommentCode', req({ params: { comment_code_id: n.id }, headers: im(n.version), body: { text: '<b>x</b>' } }), '/text');
    const r = await updNote(n.id, n.version, { text_format: 'markdown', is_default_template: true, result_type: 'graph' });
    expect(r.body).toMatchObject({ text_format: 'markdown', is_default_template: true, result_type: 'graph', version: n.version + 1 });
    const audit = (await auditRows('comment_codes', n.id)).filter((x: any) => x.action === 'UPDATE');
    for (const c of ['text_format', 'is_default_template', 'result_type']) expect(audit[0].changed_columns, c).toContain(c);
    const c = await updNote(n.id, r.body.version, { unset: ['category_id', 'result_type'] });
    expect(c.body.category_id).toBeUndefined(); expect(c.body.result_type).toBeUndefined();
    const row = await dbRow('comment_codes', n.id);
    expect(row.category_id).toBeNull(); expect(row.result_type).toBeNull();
  });
  it.each([
    ['result_type outside the list', { result_type: 'float' }, '/result_type'], ['text_format outside the list', { text_format: 'html' }, '/text_format'],
    ['is_default_template not a boolean', { is_default_template: 'yes' }, '/is_default_template'], ['category_id not a uuid', { category_id: 'abc' }, '/category_id'],
    ['text over 2000', { text: long(2001) }, '/text'], ['an unknown field', { template: 'x' }, '/template'],
  ])('createCommentCode rejects %s (400 + path, no write)', { timeout: T }, async (_n, over, path) => {
    await expectInvalid('createCommentCode', req({ body: noteBody(over), headers: { 'idempotency-key': uid() } }), path);
  });
  it('a category of another tenant or an unknown one is 404 common.not_found; unset of anything but category_id / result_type is a validation error', { timeout: T }, async () => {
    const foreign = await category(B);
    for (const category_id of [uid(), foreign.id]) expectCode(await fails('createCommentCode', req({ body: noteBody({ category_id }), headers: { 'idempotency-key': uid() } })), 'common.not_found', 404);
    const n = (await mkNote()).body;
    await expectInvalid('updateCommentCode', req({ params: { comment_code_id: n.id }, headers: im(n.version), body: { unset: ['text'] } }), '/unset');
  });
  it('deactivate instead of delete: is_active false hides the note from the default list, shows it with is_active=all; the row stays; the code stays reserved (duplicate is 409)', { timeout: T }, async () => {
    const n = (await mkNote()).body;
    const off = await updNote(n.id, n.version, { is_active: false });
    expect(off.body.is_active).toBe(false);
    expect((await call('listCommentCodes', req({ query: {} }))).body.data.map((x: any) => x.id)).not.toContain(n.id);
    expect((await call('listCommentCodes', req({ query: { is_active: 'all' } }))).body.data.map((x: any) => x.id)).toContain(n.id);
    expect(await dbRow('comment_codes', n.id)).toBeTruthy();
    expectCode(await fails('createCommentCode', req({ body: noteBody({ code: n.code }), headers: { 'idempotency-key': uid() } })), 'catalog.code_duplicate', 409);
    expect((await changedEvents(TENANT_A, n.id)).map((e: any) => e.envelope.payload.change_kind)).toContain('deactivated');
  });
  it('another tenant: cannot update (404), the row is untouched, and its own notes do not appear in this tenant list', { timeout: T }, async () => {
    const n = (await mkNote({ text: 'tenant A text' })).body;
    expectCode(await fails('updateCommentCode', req({ params: { comment_code_id: n.id }, headers: im(1), body: { text: 'hijacked' } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect((await dbRow('comment_codes', n.id)).text).toBe('tenant A text');
    const b = (await mkNote({}, TENANT_B)).body;
    expect((await call('listCommentCodes', req({ query: { is_active: 'all', limit: 200 } }))).body.data.map((x: any) => x.id)).not.toContain(b.id);
  });
});
