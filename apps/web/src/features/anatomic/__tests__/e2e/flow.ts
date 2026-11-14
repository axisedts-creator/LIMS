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
    o: { body?: unknown; ifMatch?: string | number; op?: Op; expect?: number } = {},
  ): Promise<{ res: APIResponse; json: Json }> {
    const headers: Record<string, string> = {};
    if (o.ifMatch !== undefined) headers['If-Match'] = `"${o.ifMatch}"`;
    if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
    const t0 = performance.now();
    const res = await this.req.fetch(API + path, { method, headers, data: o.body as never });
    if (o.op) this.t.add(o.op, performance.now() - t0);
    const text = await res.text();
    const json: Json = text ? JSON.parse(text) : {};
    if (o.expect !== undefined && res.status() !== o.expect) {
      throw new Error(`${method} ${path} -> ${res.status()} (want ${o.expect}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return { res, json };
  }

  /** CaseDetail; `timed` false for bookkeeping reads that must not skew getAnatomicCase p95. */
  detail = async (id: string, timed = true) => (await this.call('GET', `/cases/${id}`, { op: timed ? 'getAnatomicCase' : undefined, expect: 200 })).json;
}

/** Compose-stack hooks (publish the `received` event; make the C5 fake verify+approve). Unset → explicit NEEDS error, never a silent skip. */
export async function hook(req: APIRequestContext, name: 'receive_specimen' | 'c5_verify_approve' | 'view_row' | 'captured_logs', payload: Json): Promise<Json> {
  const base = process.env.LIMS_E2E_HOOKS_URL;
  if (!base) throw new Error(`NEEDS: LIMS_E2E_HOOKS_URL (compose-stack test hook "${name}")`);
  const r = await req.post(`${base}/${name}`, { data: payload });
  if (!r.ok()) throw new Error(`hook ${name} -> ${r.status()}`);
  return r.json();
}

/** Lifecycle up to and including sign-out on a fresh received specimen. Timings accumulate in api.t. */
export async function runToSignOut(api: Api, opts: { planted?: boolean } = {}) {
  const { req } = api;
  const rec = await hook(req, 'receive_specimen', { case_kind: 'histology', ...(opts.planted ? { accession_hint: PLANTED.accession } : {}) });
  const caseId: string = rec.case_id;

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
