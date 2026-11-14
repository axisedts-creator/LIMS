'use server';
// Server actions for the T-22 reports UI (TRD §5): M14 submitCultureReport, M16 getCultureReportVersion, M17 reopenCulture, plus the small reads the drawer needs
// (culture_outcomes, alert organisms, the early-final setting, the C5 amendment reasons through listLabCodedSet). Same rules as cultureActions: a thrown ApiError loses its
// code across the action boundary, so errors become { ok:false, status, code } (shared `run`); the bearer JWT never reaches client code (REQ-SEC-068); every id is validated
// as a UUID and every body is rebuilt from the declared fields only (S-05 strict body; REQ-SEC-026/027). Idempotency-Key on M14, If-Match "<version>" on M17. Nothing here logs (REQ-SEC-098).
import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, flag, idemKey, microCode, oneOf, pick, run, text, uuid, version } from './shared';
import { listLabCodedSet } from './listLabCodedSet.server';
import { REPORT_PHASES, type ActionResult, type CultureDetailDto, type LabCodeLite, type MicroCodeDto, type ReopenInput, type ReportSubmitInput, type ReportVersionDto } from './types';

const JSON_HEADERS = { 'content-type': 'application/json' };

// ---- M14 submitCultureReport (Idempotency-Key required; no If-Match; the amendment is decided by the server: AC-09.6, AC-11.2)
export async function submitReportAction(cultureId: string, input: ReportSubmitInput, idempotencyKey: string): Promise<ActionResult<ReportVersionDto>> {
  return run(() => {
    const rebuilt = pick(
      input,
      {
        report_phase: (v) => oneOf(REPORT_PHASES, v),
        outcome_code: microCode,
        is_critical: flag,
        culture_summary_text: text(1, 4000),
        comments_text: text(1, 4000),
        early_final_reason: text(1, 500),
      },
      ['report_phase', 'is_critical', 'culture_summary_text'],
    );
    return serverFetch<ReportVersionDto>(`/v1/micro/cultures/${uuid(cultureId)}/report-versions`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey) },
      body: JSON.stringify(rebuilt),
    });
  });
}

// ---- M16 getCultureReportVersion (read-only snapshot; AC-11.5)
export async function getReportVersionAction(cultureId: string, versionNo: number): Promise<ActionResult<ReportVersionDto>> {
  return run(() => serverFetch<ReportVersionDto>(`/v1/micro/cultures/${uuid(cultureId)}/report-versions/${version(versionNo)}`));
}

// ---- M17 reopenCulture (If-Match = culture.version; reason code from C5 amendment_reasons, never a system code: D-62, enforced by the BFF list and by the API)
export async function reopenCultureAction(cultureId: string, v: number, input: ReopenInput): Promise<ActionResult<CultureDetailDto>> {
  return run(() => {
    const rebuilt = pick(input, { amendment_reason_code: microCode, amendment_reason_text: text(1, 500) }, ['amendment_reason_code']);
    return serverFetch<CultureDetailDto>(`/v1/micro/cultures/${uuid(cultureId)}/reopen`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'if-match': `"${version(v)}"` },
      body: JSON.stringify(rebuilt),
    });
  });
}

/** C5 amendment reasons for the reopen dialog (global + tenant, the three system codes removed by the BFF: D-62). Never fails: [] when C5 refuses. */
export async function listAmendmentReasonsAction(): Promise<LabCodeLite[]> {
  return listLabCodedSet('amendment_reasons');
}

// ---- small reads for the drawer
/** Active outcomes for the Final drawer (GET /v1/micro/coded-sets/culture_outcomes). */
export async function listOutcomesAction(): Promise<ActionResult<MicroCodeDto[]>> {
  return run(async () => (await serverFetch<{ data: MicroCodeDto[] }>('/v1/micro/coded-sets/culture_outcomes')).data);
}

/** Which of the given organisms are alert organisms (is_alert) — the drawer pre-ticks "Notify as critical" (TRD §4.6). At most 20 isolates (snapshot cap); a failed read means "none". */
export async function alertOrganismsAction(organisms: { code: string; display: string }[]): Promise<ActionResult<string[]>> {
  return run(async () => {
    if (!Array.isArray(organisms) || organisms.length > 20) throw bad();
    const wanted = organisms.map((o) => ({ code: microCode(o.code), q: text(1, 200)(o.display).slice(0, 40) }));
    const found = await Promise.all(
      wanted.map(async (o) => {
        try {
          const r = await serverFetch<{ data: MicroCodeDto[] }>(`/v1/micro/coded-sets/organisms?q=${encodeURIComponent(o.q)}`);
          return r.data.some((c) => c.code === o.code && c.is_alert === true) ? o.code : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return found.filter((c): c is string => c !== undefined);
  });
}

/** settings.early_final_requires_reason; defaults to true (the stricter reading) when the setting cannot be read. */
export async function earlyFinalRequiresReasonAction(): Promise<ActionResult<{ required: boolean }>> {
  return run(async () => {
    try {
      const s = await serverFetch<{ early_final_requires_reason?: boolean }>('/v1/micro/settings');
      return { required: s.early_final_requires_reason !== false };
    } catch {
      return { required: true };
    }
  });
}
