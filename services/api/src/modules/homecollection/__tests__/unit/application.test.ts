// PHLEBO-UI-FULL-1: phlebotomist applications. The disk store runs for real in a temp folder; the database is a recording
// fake that answers the DEFINER calls (their SQL is proven by db/tests/homecollection/phlebo_applications.scenario.sql).
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPhleboApplication, decidePhleboApplication, downloadPhleboApplicationDocument, submitPhleboApplication, uploadPhleboApplicationDocumentChunk } from '../../application.service.js';
import { sniff } from '../../application.store.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const APP = '01a1a98a-ac40-7000-8000-0000000f0001';
const DOC = '01a1a98a-ac40-7000-8000-0000000d0001';
const TOKEN = 'A'.repeat(43);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500, 1)]);

let dir: string;
let calls: Array<{ sql: string; values: unknown[] }>;
let answers: Record<string, unknown>;
let limited: string[];

function ctx(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    actor: { id: '01a1a98a-ac40-7000-8000-0000000f00aa', type: 'patient' },
    now: () => new Date('2026-11-26T04:00:00.000Z'),
    rateLimit: { consume: async (_t: string, key: string) => { limited.push(key); } },
    ports: { IdentityPort: { assertRole: async (_c: unknown, r: { permission: string }) => { calls.push({ sql: `assertRole ${r.permission}`, values: [] }); } } },
    tx: {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        for (const k of Object.keys(answers)) if (sql.includes(k)) return { rows: answers[k] as any[] };
        return { rows: [] };
      },
    },
    ...over,
  };
}
const valid = { full_name: 'Sita Demo', phone_e164: '+9779800000001', email: 'Sita@Example.Test', area: 'Demo Tole', employment_type: 'full_time' };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code as string);
const chunk = (bytes: Buffer, over: Record<string, unknown> = {}) => ({ kind: 'licence', file_name: 'licence.jpg', content_type: 'image/jpeg', index: 0, last: true, data: bytes.toString('base64'), ...over });
const headers = { 'x-lims-application-token': TOKEN };
const params = { application_id: APP, document_id: DOC };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phlebo-app-'));
  process.env['LIMS_HOMECOLLECTION_APPLICATION_DIR'] = dir;
  calls = []; limited = [];
  answers = {
    homecollection_application_create: [{ r: 'created' }],
    homecollection_application_upload_state: [{ kind: 'licence', n: 0 }, { kind: 'training_certificate', n: 0 }, { kind: 'identity', n: 0 }, { kind: 'photo', n: 0 }],
    homecollection_application_add_document: [{ r: 'added' }],
    homecollection_application_submit: [{ r: 'submitted' }],
  };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['LIMS_HOMECOLLECTION_APPLICATION_DIR']; });

describe('create', () => {
  it('stores only the hash of the upload token, lower-cases the email and rate-limits by phone', async () => {
    const r = await createPhleboApplication(ctx(), valid) as any;
    expect(r.status).toBe(201);
    expect(r.body.upload_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const create = calls.find((c) => c.sql.includes('homecollection_application_create'))!;
    expect(create.values).toContain('sita@example.test');
    expect(JSON.stringify(create.values)).not.toContain(r.body.upload_token);
    expect((create.values[8] as Buffer).length).toBe(32);
    expect(limited).toEqual(['p:+9779800000001']);
    expect(calls[0]!.sql).toBe('assertRole homecollection.application.submit');
  });

  it('refuses bad input before the limiter or the database is touched', async () => {
    const bads: Array<Record<string, unknown>> = [
      { ...valid, phone_e164: '+919800000001' }, { ...valid, phone_e164: '9800000001' }, { ...valid, email: 'not-an-email' },
      { ...valid, full_name: 'ab' }, { ...valid, full_name: 'Sita\u0000Demo' }, { ...valid, area: '' },
      { ...valid, employment_type: 'sometimes' }, { ...valid, shift_count: 'single' }, { ...valid, extra: 1 },
      { ...valid, employment_type: 'part_time' }, { ...valid, employment_type: 'part_time', shift_count: 'single', day_slots: ['morning', 'evening'] },
      { ...valid, employment_type: 'part_time', shift_count: 'double', day_slots: ['morning', 'morning'] },
      { ...valid, employment_type: 'part_time', shift_count: 'double', day_slots: ['morning', 'night'] },
    ];
    for (const b of bads) expect(await code(createPhleboApplication(ctx(), b)), JSON.stringify(b)).toBe('common.validation_failed');
    expect(limited).toEqual([]);
    expect(calls.filter((c) => c.sql.includes('SELECT'))).toEqual([]);
  });

  it('part time: slots are stored in day order', async () => {
    await createPhleboApplication(ctx(), { ...valid, employment_type: 'part_time', shift_count: 'double', day_slots: ['evening', 'morning'] });
    expect(calls.find((c) => c.sql.includes('homecollection_application_create'))!.values[7]).toEqual(['morning', 'evening']);
  });

  it('an open application for the phone is a 409; no limiter means no service', async () => {
    answers['homecollection_application_create'] = [{ r: 'exists' }];
    expect(await code(createPhleboApplication(ctx(), valid))).toBe('common.immutable_record');
    expect(await code(createPhleboApplication(ctx({ rateLimit: undefined }), valid))).toBe('common.service_unavailable');
  });
});

describe('document pieces', () => {
  it('one piece: checked, stored compressed, recorded with its real size and hash; no piece files are left', async () => {
    const r = await uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(JPEG)) as any;
    expect(r.body).toEqual({ complete: true });
    expect(readdirSync(join(dir, TENANT, APP))).toEqual([`${DOC}.gz`]);
    const add = calls.find((c) => c.sql.includes('homecollection_application_add_document'))!;
    expect(add.values[6]).toBe(JPEG.length);
    expect(add.values[7] as number).toBeLessThan(JPEG.length);          // gzip of a repetitive body
    expect(add.values[9]).toBe(`${TENANT}/${APP}/${DOC}.gz`);
  });

  it('two pieces in order are joined; out-of-order or repeated pieces are refused', async () => {
    const a = JPEG.subarray(0, 1000), b = JPEG.subarray(1000);
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(b, { index: 1 })))).toBe('common.validation_failed');
    expect(((await uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(a, { last: false }))) as any).body).toEqual({ complete: false });
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(a, { last: false })))).toBe('common.validation_failed');
    expect(((await uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(b, { index: 1 }))) as any).body).toEqual({ complete: true });
    expect(calls.find((c) => c.sql.includes('add_document'))!.values[6]).toBe(JPEG.length);
  });

  it('the declared type must be the real type; a refused file leaves nothing on disk', async () => {
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(PDF)))).toBe('common.unsupported_media_type');
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(Buffer.from('MZ this is a program'))))).toBe('common.unsupported_media_type');
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(PDF, { kind: 'photo', content_type: 'application/pdf' })))).toBe('common.unsupported_media_type');
    expect(readdirSync(join(dir, TENANT, APP))).toEqual([]);
    expect(sniff(PDF)).toBe('application/pdf');
  });

  it('a wrong or missing token, or an unknown application, writes nothing', async () => {
    answers['homecollection_application_upload_state'] = [];
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(JPEG)))).toBe('auth.unauthenticated');
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, {}, chunk(JPEG)))).toBe('auth.unauthenticated');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ids that are not UUIDs never reach the disk (no path escape)', async () => {
    for (const bad of ['../../etc', '..', `${APP}/..`, 'C:\\x']) {
      expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), { application_id: bad, document_id: DOC }, headers, chunk(JPEG)))).toBe('common.validation_failed');
      expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), { application_id: APP, document_id: bad }, headers, chunk(JPEG)))).toBe('common.validation_failed');
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('more than 2 MB in total is refused and the pieces are removed', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(512 * 1024 - 3, 1)]);
    for (let i = 0; i < 4; i++) await uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(big, { index: i, last: false }));
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(Buffer.alloc(10, 1), { index: 4 })))).toBe('common.payload_too_large');
    expect(readdirSync(join(dir, TENANT, APP))).toEqual([]);
  });

  it('a document the database refuses (too many of a kind) is deleted from disk', async () => {
    answers['homecollection_application_add_document'] = [{ r: 'too_many' }];
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(JPEG)))).toBe('common.validation_failed');
    expect(readdirSync(join(dir, TENANT, APP))).toEqual([]);
  });

  it('without the storage folder configured the upload fails closed', async () => {
    delete process.env['LIMS_HOMECOLLECTION_APPLICATION_DIR'];
    expect(await code(uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(JPEG)))).toBe('common.service_unavailable');
  });
});

describe('submit and staff side', () => {
  it('submit maps the database answers', async () => {
    expect(((await submitPhleboApplication(ctx(), { application_id: APP }, headers)) as any).status).toBe(204);
    answers['homecollection_application_submit'] = [{ r: 'incomplete' }];
    expect(await code(submitPhleboApplication(ctx(), { application_id: APP }, headers))).toBe('common.validation_failed');
    answers['homecollection_application_submit'] = [{ r: 'denied' }];
    expect(await code(submitPhleboApplication(ctx(), { application_id: APP }, headers))).toBe('auth.unauthenticated');
  });

  it('download returns the original bytes as an attachment with a fixed safe name', async () => {
    await uploadPhleboApplicationDocumentChunk(ctx(), params, headers, chunk(JPEG, { file_name: '"><script>.jpg' }));
    const add = calls.find((c) => c.sql.includes('add_document'))!;
    answers['FROM homecollection.phlebo_applications'] = [{ id: APP, status: 'submitted', version: 2 }];
    answers['FROM homecollection.phlebo_application_documents'] = [{ id: DOC, application_id: APP, kind: 'licence', file_name: add.values[4], content_type: 'image/jpeg', byte_size: JPEG.length, sha256: add.values[8] }];
    const staff = ctx({ actor: { id: 'u', type: 'user', membershipId: 'm' } });
    const r = await downloadPhleboApplicationDocument(staff, params) as any;
    expect(Buffer.compare(r.body, JPEG)).toBe(0);
    expect(r.headers['content-disposition']).toBe('attachment; filename="licence-0d0001.jpg"');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(calls.some((c) => c.sql === 'assertRole homecollection.application.manage')).toBe(true);
    // a file changed on disk no longer matches its recorded hash
    answers['FROM homecollection.phlebo_application_documents'] = [{ id: DOC, application_id: APP, kind: 'licence', content_type: 'image/jpeg', sha256: Buffer.alloc(32, 9) }];
    expect(await code(downloadPhleboApplicationDocument(staff, params))).toBe('common.not_found');
  });

  it('decide: needs If-Match, a note to reject, a submitted application and the current version', async () => {
    const staff = ctx({ actor: { id: 'u', type: 'user', membershipId: '01a1a98a-ac40-7000-8000-0000000000m1' } });
    answers['FROM homecollection.phlebo_applications'] = [{ id: APP, status: 'submitted', version: 2 }];
    expect(await code(decidePhleboApplication(staff, { application_id: APP }, {}, { decision: 'approve' }))).toBe('common.precondition_required');
    expect(await code(decidePhleboApplication(staff, { application_id: APP }, { 'if-match': '"2"' }, { decision: 'reject' }))).toBe('common.validation_failed');
    expect(await code(decidePhleboApplication(staff, { application_id: APP }, { 'if-match': '"1"' }, { decision: 'approve' }))).toBe('common.version_conflict');
    answers['FROM homecollection.phlebo_applications'] = [{ id: APP, status: 'rejected', version: 3 }];
    expect(await code(decidePhleboApplication(staff, { application_id: APP }, { 'if-match': '"3"' }, { decision: 'approve' }))).toBe('common.immutable_record');
  });
});
