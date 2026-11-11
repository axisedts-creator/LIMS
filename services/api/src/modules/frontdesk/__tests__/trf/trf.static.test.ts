// FD-T10 static/contract checks (no database). Plan row FD-T10: service/trf.service.ts; handlers uploadTrf (F20), getTrfAttachment (F21), getTrfAttachmentContent (F21a);
// worker tasks trf_scan.ts + trf_draft_purge.ts; contract frontdesk.yaml. US-FD-09.1-5, 07-SECURITY REQ-SEC-034/035/083-085, 08 A13 P-2 (no Storage URL anywhere).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const W = 'services/worker/src/jobs/frontdesk/tasks';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const code = (rel: string) => text(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');   // comments never count
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const NAMES = ['uploadTrf', 'getTrfAttachment', 'getTrfAttachmentContent'] as const;
const FILES = [`${F}/service/trf.service.ts`, ...NAMES.map((n) => `${F}/handlers/${n}.ts`), `${W}/trf_scan.ts`, `${W}/trf_draft_purge.ts`];

describe('FD-T10 files and wiring', () => {
  it('service, the three handlers and the two worker tasks exist', () => {
    for (const f of FILES) expect(existsSync(join(REPO_ROOT, f)), f).toBe(true);
  });
  it.each([
    ['uploadTrf', () => import('../../handlers/uploadTrf.js')],
    ['getTrfAttachment', () => import('../../handlers/getTrfAttachment.js')],
    ['getTrfAttachmentContent', () => import('../../handlers/getTrfAttachmentContent.js')],
  ])('handlers/%s.ts exports `handler` and index.ts wires it as the real operation (LD-70: the writer removes the stub from pending.json)', async (name, load) => {
    const m = await load();
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any)[name]).toBe(m.handler);
  }, 60_000);
  it('handlers are thin: delegate to trf.service, no repository import', () => {
    for (const n of NAMES) {
      const src = text(`${F}/handlers/${n}.ts`);
      expect(src, n).toMatch(/trf\.service/);
      expect(src, n).not.toMatch(/repository\//);
    }
  });
});

describe('FD-T10 implementation rules (P-2: no Storage URL; R12b: only ctx.uploads.accept writes; trf.view per call)', () => {
  it('no Storage URL is ever produced: `signedUrl` appears in no service, handler or worker task (code, not comments)', () => {
    for (const f of FILES) expect(code(f), f).not.toMatch(/signedUrl|createSignedUrl|getPublicUrl/);
  });
  it('trf.service accepts bytes ONLY through ctx.uploads.accept with the TRD §2 options (bucket frontdesk-trf, re-encode + strip, scan required, 15 MiB)', () => {
    const s = code(`${F}/service/trf.service.ts`);
    expect(s).toMatch(/uploads\.accept\(/);
    expect(s).not.toMatch(/storage\.put\(/);
    expect(s).toMatch(/frontdesk-trf/);
    expect(s).toMatch(/reencode:\s*true/);
    expect(s).toMatch(/stripMetadata:\s*true/);
    expect(s).toMatch(/scan:\s*'required'/);
    expect(s).toMatch(/image\/jpeg/); expect(s).toMatch(/image\/png/); expect(s).toMatch(/application\/pdf/);
  });
  it('content goes through ctx.download.stream and writes the access-log action trf.view on entity type trf_attachment', () => {
    const s = code(`${F}/service/trf.service.ts`);
    expect(s).toMatch(/download\.stream\(/);
    expect(s).toMatch(/['"]trf\.view['"]/);
    expect(s).toMatch(/['"]trf_attachment['"]/);
    expect(s).toMatch(/frontdesk\.trf\.upload|frontdesk\.order\.read/);
  });
  it('upload enqueues frontdesk.trf_scan', () => {
    expect(code(`${F}/service/trf.service.ts`)).toMatch(/frontdesk\.trf_scan/);
  });
  it('time comes from ctx.now(), never Date.now()/new Date() in the service (02-CONVENTIONS clock rule)', () => {
    expect(code(`${F}/service/trf.service.ts`)).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
  it('worker tasks: trf_scan reads through ctx.storage + scans through ctx.files; purge deletes objects then calls the DEFINER purge_trf_drafts (no direct DELETE)', () => {
    const scan = code(`${W}/trf_scan.ts`), purge = code(`${W}/trf_draft_purge.ts`);
    expect(scan).toMatch(/files\.scan\(/); expect(scan).toMatch(/storage\.read\(/);
    expect(purge).toMatch(/storage\.delete\(/);
    expect(purge).toMatch(/frontdesk\.purge_trf_drafts/);
    expect(purge).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('FD-T10 contract', () => {
  it('uploadTrf: frontdesk.trf.upload, Idempotency-Key required, image/jpeg + image/png + application/pdf, declares 413 + 415 codes', () => {
    const o = op('uploadTrf');
    expect(o['x-permission']).toBe('frontdesk.trf.upload');
    expect(o['x-idempotency']).toBe('required');
    expect([...o['x-upload']].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(o['x-error-codes']).toEqual(expect.arrayContaining(['common.payload_too_large', 'common.unsupported_media_type']));
    expect(Object.keys(o.requestBody.content)).toEqual(['multipart/form-data']);
  });
  it.each(['getTrfAttachment', 'getTrfAttachmentContent'])('%s needs frontdesk.order.read and no idempotency', (id) => {
    expect(op(id)['x-permission']).toBe('frontdesk.order.read');
    expect(op(id)['x-idempotency']).toBe('none');
  });
  it('getTrfAttachmentContent declares common.upload_quarantined and requires the three P-2 response headers', () => {
    const o = op('getTrfAttachmentContent');
    expect(o['x-error-codes']).toContain('common.upload_quarantined');
    const h = o.responses['200'].headers;
    for (const n of ['Content-Disposition', 'X-Content-Type-Options', 'Cache-Control']) expect(h[n].required, n).toBe(true);
    expect(h['X-Content-Type-Options'].schema.enum).toEqual(['nosniff']);
    expect(h['Cache-Control'].schema.enum).toEqual(['no-store']);
  });
  it('TrfAttachment is metadata only: no bucket, object path, hash or URL property; scan_state enum pending|clean|quarantined|failed', () => {
    const s = spec.components.schemas.TrfAttachment;
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['id', 'mime_type', 'order_id', 'original_filename', 'scan_state', 'size_bytes', 'uploaded_at', 'uploaded_by']);
    expect(s.properties.scan_state.enum).toEqual(['pending', 'clean', 'quarantined', 'failed']);
    expect(s.properties.size_bytes.maximum).toBe(15728640);
  });
});
