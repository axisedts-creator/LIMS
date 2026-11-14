'use server';
// Server actions for the T-21 AST grid (TRD §5 M11 assignAstPanel, M12 recordAstResults, M13 previewAstInterpretation) and the tenant standard read (M39).
// A thrown ApiError loses its code across the action boundary in production, so errors become { ok:false, status, code } (shared `run`). The bearer JWT never
// reaches client code (REQ-SEC-068). Every id is validated as a UUID and every body is rebuilt from the declared fields only (S-05 strict body; REQ-SEC-026/027);
// the entry list is capped at 60 here, not only in the UI (M12/M13). Idempotency-Key on bulk-record and ast-panel; If-Match "<version>" on ast-panel only.
// Nothing here logs a body or a value (REQ-SEC-098).
import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { arrayOf, bad, flag, idemKey, microCode, oneOf, pick, run, text, uuid, version } from './shared';
import { STANDARDS, type ActionResult, type AssignPanelInput, type AstPreviewEntry, type AstPreviewResult, type AstRecordEntry, type AstRecordResult, type IsolateDto } from './types';

const JSON_HEADERS = { 'content-type': 'application/json' };
const METHODS = ['mic', 'zone_diameter', 'other'] as const;
const CATEGORY_RE = /^[A-Za-z^]{1,8}$/;
const method = (v: unknown) => oneOf(METHODS, v);
const rawValue = text(1, 32);
const category = (v: unknown) => {
  if (typeof v !== 'string' || !CATEGORY_RE.test(v)) throw bad();
  return v;
};

const PREVIEW_ENTRY = { antibiotic_code: microCode, method, raw_value: rawValue, qualifier_code: microCode };
const RECORD_ENTRY = {
  antibiotic_code: microCode, method, raw_value: rawValue, category_code: category, standard: (v: unknown) => oneOf(STANDARDS, v), standard_version: text(1, 32),
  accept_suggestion: flag, breakpoint_band_id: uuid, qualifier_code: microCode, is_reportable: flag, add_to_isolate: flag, version,
};

/** M13: suggestions for changed rows; no state change, no Idempotency-Key. */
export async function previewAstAction(isolateId: string, entries: AstPreviewEntry[]): Promise<ActionResult<AstPreviewResult[]>> {
  return run(async () => {
    const body = { entries: arrayOf(60, (e) => pick(e, PREVIEW_ENTRY, ['antibiotic_code', 'method', 'raw_value']), 1)(entries) };
    const r = await serverFetch<{ results: AstPreviewResult[] }>(`/v1/micro/isolates/${uuid(isolateId)}/ast-results/interpret`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    return r.results;
  });
}

/** M12: per-entry outcomes (partial success is committed). A new Idempotency-Key per click; no If-Match (each entry carries its own `version`). */
export async function recordAstAction(isolateId: string, entries: AstRecordEntry[], idempotencyKey: string): Promise<ActionResult<AstRecordResult[]>> {
  return run(async () => {
    const body = { entries: arrayOf(60, (e) => pick(e, RECORD_ENTRY, ['antibiotic_code', 'method']), 1)(entries) };
    const r = await serverFetch<{ results: AstRecordResult[] }>(`/v1/micro/isolates/${uuid(isolateId)}/ast-results/bulk-record`, {
      method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey) }, body: JSON.stringify(body),
    });
    return r.results;
  });
}

/** M11: no `ast_panel_id` = the server picks by precedence (TRD §4.2). If-Match = the isolate's version. */
export async function assignAstPanelAction(isolateId: string, v: number, input: AssignPanelInput, idempotencyKey: string): Promise<ActionResult<IsolateDto>> {
  return run(() => {
    const body = pick(input, { ast_panel_id: uuid });
    return serverFetch<IsolateDto>(`/v1/micro/isolates/${uuid(isolateId)}/ast-panel`, {
      method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey), 'if-match': `"${version(v)}"` }, body: JSON.stringify(body),
    });
  });
}

/** Tenant default standard (`settings.manual_ast_standard`); a refused or failed read is just "no standard" for the caller (the technologist may lack settings access). */
export async function getTenantStandardAction(): Promise<ActionResult<{ standard?: 'CLSI' | 'EUCAST' }>> {
  return run(async () => {
    const s = await serverFetch<{ manual_ast_standard?: 'CLSI' | 'EUCAST' }>('/v1/micro/settings');
    return s.manual_ast_standard === 'CLSI' || s.manual_ast_standard === 'EUCAST' ? { standard: s.manual_ast_standard } : {};
  });
}
