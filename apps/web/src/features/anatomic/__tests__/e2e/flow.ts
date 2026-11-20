// C11.T-26 — API client + one full anatomic case lifecycle (02-TRD §14 "E2E (nightly)"):
// received → accession → gross → blocks → slides → ready → draft → sign-out → (C5 fake verify/approve) → view row → amendment → addendum.
// Names (routes, operationIds, error codes) are copied from 02-TRD §5; ingest / C5-fake hooks come from the compose stack (env, see notes).
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Timings, type Op } from './perf';

export const API = (process.env.LIMS_E2E_API_URL ?? 'http://localhost:3000') + '/v1/anatomic';
/** 07-SECURITY §5.6 planted values: none may appear in logs, metric labels or problem `detail`. */
export const PLANTED = { accession: 'S26-9999', caption: 'Test Patient 0042 left arm', gross: 'PHI-MARKER-GROSS', diagnosis: 'LOC-0001' } as const;

export type Json = Record<string, any>;

export class Api {
  constructor(
    readonly req: APIRequestContext,
    readonly t = new Timings(),
  ) {}

  async call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    o: { body?: unknown; multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>; ifMatch?: string | number; op?: Op; expect?: number } = {},
  ): Promise<{ res: APIResponse; json: Json }> {
    const headers: Record<string, string> = {};
    if (o.ifMatch !== undefined) headers['If-Match'] = `"${o.ifMatch}"`;
    if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
    const t0 = performance.now();
    const res = await this.req.fetch(API + path, { method, headers, ...(o.multipart ? { multipart: o.multipart } : { data: o.body as never }) });
    if (o.op) this.t.add(o.op, performance.now() - t0);
    const text = await res.text();
    const json: Json = text ? JSON.parse(text) : {};
    if (o.expect !== undefined && res.status() !== o.expect) {
      throw new Error(`${method} ${path} -> ${res.status()} (want ${o.expect}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return { res, json };
  }

  /** CaseDetail; `timed` false for bookkeeping reads that must not skew getAnatomicCase p95. */
  detail = async (id: string, timed = true) => (await this.call('GET', `/cases/${id}`, { ...(timed ? { op: 'getAnatomicCase' as const } : {}), expect: 200 })).json;
}

/** Compose-stack hooks (publish the `received` event; make the C5 fake verify+approve). Unset → explicit NEEDS error, never a silent skip. */
export async function hook(req: APIRequestContext, name: 'receive_specimen' | 'c5_verify_approve' | 'view_row' | 'captured_logs', payload: Json): Promise<Json> {
  const base = process.env.LIMS_E2E_HOOKS_URL;
  if (!base) throw new Error(`NEEDS: LIMS_E2E_HOOKS_URL (compose-stack test hook "${name}")`);
  const r = await req.post(`${base}/${name}`, { data: payload });
  if (!r.ok()) throw new Error(`hook ${name} -> ${r.status()}`);
  return r.json();
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** Synthetic valid 1×1 PNG; `padBytes` adds an ancillary tEXt chunk (decoders ignore it) to reach a target size (I1: png/jpeg ≤ 15 MB). */
export function syntheticPng(padBytes = 0): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = Buffer.from('789c6360606000000004000100', 'hex'); // zlib of one black RGB pixel
  const pad = padBytes > 0 ? [chunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(padBytes, 0x78)]))] : [];
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...pad, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const BIG_IMAGE_BYTES = 14 * 1024 * 1024; // just under the 15 MB cap (TRD §11 "image upload accept (15 MB)")

/**
 * Lifecycle up to and including sign-out on a fresh received specimen. Timings accumulate in api.t.
 * `planted` sends the 07-SECURITY §5.6 values; `bigImage` makes the I1 upload ~14 MB and records imageUploadAccept / imageProcessing
 * (small uploads are untimed so they cannot mask the 15 MB p95). Needs `receive_specimen` to honour `accession_hint` and return `handling_ms`.
 */
export async function runToSignOut(api: Api, opts: { planted?: boolean; bigImage?: boolean } = {}) {
  const { req } = api;
  const rec = await hook(req, 'receive_specimen', { case_kind: 'histology', ...(opts.planted ? { accession_hint: PLANTED.accession } : {}) });
  const caseId: string = rec.case_id;
  if (typeof rec.handling_ms !== 'number') throw new Error('NEEDS: receive_specimen hook must return handling_ms (consumer time per event, TRD §11)');
  api.t.add('consumerPerEvent', rec.handling_ms);

  const list = await api.call('GET', '/cases?queue=to_accession&limit=50', { op: 'listAnatomicCases', expect: 200 });
  if (!list.json.data.some((c: Json) => c.id === caseId)) throw new Error('received case missing from to_accession queue');

  let d = await api.detail(caseId);
  d = (
    await api.call('POST', `/cases/${caseId}/accession`, {
      ifMatch: d.version,
      expect: 200,
      body: { parts: (d.parts as Json[]).map((p) => ({ part_id: p.id, site_text: 'Skin, left arm', description_text: 'Ellipse of skin' })) },
    })
  ).json;
  const accession: string = d.accession_no;
  await api.call('POST', '/cases/lookup', { body: { label: accession }, op: 'lookupAnatomicObject', expect: 200 });

  for (const p of d.parts as Json[]) {
    await api.call('PUT', `/cases/${caseId}/parts/${p.id}/gross`, {
      ifMatch: 0,
      op: 'saveAnatomicGross',
      expect: 200,
      body: { gross_text: opts.planted ? PLANTED.gross : 'Ellipse 20 x 10 mm, serially sectioned.', pieces_count: 1, is_complete: true },
    });
  }
  // I1 uploadAnatomicImage (gross image on part 1): planted caption (07-SECURITY §5.6) and/or the 15 MB timing sample.
  const timedImage = !!opts.bigImage;
  const up = await api.call('POST', `/cases/${caseId}/images`, {
    ...(timedImage ? { op: 'imageUploadAccept' as const } : {}),
    expect: 201,
    multipart: {
      file: { name: 'gross.png', mimeType: 'image/png', buffer: syntheticPng(timedImage ? BIG_IMAGE_BYTES : 0) },
      kind: 'gross',
      part_id: d.parts[0].id,
      ...(opts.planted ? { caption: PLANTED.caption } : {}),
    },
  });
  const imageId: string = up.json.id;
  const t1 = performance.now();
  let state: string = up.json.state;
  while (state === 'processing') {
    if (performance.now() - t1 > 60_000) throw new Error(`image ${imageId} still processing after 60 s`);
    await new Promise((r) => setTimeout(r, 250));
    state = ((await api.detail(caseId, false)).images as Json[]).find((i) => i.id === imageId)?.state ?? state;
  }
  if (state !== 'ready') throw new Error(`image ${imageId} ended in state ${state}`);
  if (timedImage) api.t.add('imageProcessing', performance.now() - t1);

  const blocks = (await api.call('POST', `/cases/${caseId}/blocks`, { body: { part_id: d.parts[0].id, count: 2 }, expect: 201 })).json.blocks as Json[];
  await api.call('POST', `/cases/${caseId}/start-processing`, { ifMatch: (await api.detail(caseId, false)).version, expect: 200 });
  const slides = (
    await api.call('POST', `/cases/${caseId}/slides`, { body: { block_id: blocks[0]!.id, stain_code: process.env.LIMS_E2E_ROUTINE_STAIN ?? 'HE', count: 2 }, expect: 201 })
  ).json.slides as Json[];
  const bulk = await api.call('POST', '/slides/bulk-mark-ready', { body: { ids: slides.map((s) => s.id) }, expect: 200 });
  if (!bulk.json.results.every((r: Json) => r.outcome === 'updated')) throw new Error('slides not marked ready');
  await api.call('POST', `/cases/${caseId}/mark-ready`, { ifMatch: (await api.detail(caseId, false)).version, expect: 200 });

  const draftBody = {
    gross_text: 'Ellipse of skin.',
    microscopy_text: 'Sections show skin with benign changes.',
    impression_text: 'Skin, left arm: benign.',
    diagnosis_codes: [{ code: process.env.LIMS_E2E_DIAGNOSIS_CODE ?? PLANTED.diagnosis }],
  };
  const draft = (await api.call('PUT', `/cases/${caseId}/report-draft`, { ifMatch: 0, body: draftBody, op: 'saveAnatomicReportDraft', expect: 200 })).json;
  const signed = (await api.call('POST', `/cases/${caseId}/sign-out`, { ifMatch: draft.version, body: { attest: true }, op: 'signOutAnatomicCase', expect: 200 })).json;
  return { caseId, accession, signed };
}
