import 'server-only';
// Server-only client of the reporting API (02-TRD §3.5, §6.6). Portal credentials travel in the
// X-Lims-Portal-Credential header, never in an API URL or query (REQ-SEC-098). The BFF key proves the
// caller is the portal so the core trusts the forwarded client IP (08 A13 D-32).
import { readFileSync } from 'node:fs';
import { headers } from 'next/headers';

export type Stage = 'link' | 'session';
export interface ApiResult<T = unknown> {
  status: number; // 0 = API unreachable
  code?: string | undefined; // problem+json `code`
  body?: T;
  res?: Response;
}

let bffKey: string | undefined;
function key(): string {
  bffKey ??= readFileSync(process.env.LIMS_PORTAL_BFF_KEY_FILE ?? '', 'utf8').trim();
  return bffKey;
}

export async function callApi<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  opts: { stage?: Stage; credential?: string; json?: unknown; raw?: boolean; headers?: Record<string, string> }, // no credential = public endpoint (Q1)
): Promise<ApiResult<T>> {
  const h: Record<string, string> = {
    ...opts.headers,
    'X-Lims-Bff-Key': key(),
    accept: opts.raw ? 'application/pdf' : 'application/json',
  };
  if (opts.stage && opts.credential) h['X-Lims-Portal-Credential'] = `${opts.stage}.${opts.credential}`;
  const xff = (await headers()).get('x-forwarded-for');
  if (xff) h['X-Forwarded-For'] = xff; // exactly as received from the public nginx
  if (opts.json !== undefined) h['content-type'] = 'application/json';
  try {
    const res = await fetch(`${process.env.LIMS_ORIGIN_API}/v1/reporting${path}`, {
      method,
      headers: h,
      body: opts.json === undefined ? null : JSON.stringify(opts.json),
      cache: 'no-store',
    });
    if (res.ok && opts.raw) return { status: res.status, res };
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, code: (body as { code?: string } | undefined)?.code, body: body as T, res };
  } catch {
    return { status: 0 };
  }
}

/** Minutes from a 429 Retry-After header (seconds), at least 1. */
export function retryMinutes(r: ApiResult): number {
  const s = Number(r.res?.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.max(1, Math.ceil(s / 60)) : 60;
}

export interface SmartSummary {
  status?: string;
  language?: string;
  healthScore?: { value: number; band: string };
  panels?: { panelCode: string; status: string; displayName: string }[];
  deranged?: { text: string; analyteName: string; direction: string; severity: string }[];
  advice?: { text: string }[];
  followUps?: { text: string; suggestedTestName: string; intervalDays: number }[];
  disclaimerText?: string;
}
export interface PortalReport {
  lab_name: string;
  patient_display: string;
  report: {
    report_kind: string;
    status_label: string;
    issued_at: string;
    version_no: number;
    panel_names: string[];
    updated_notice?: { previous_version_no: number; updated_at: string };
  };
  download: { report_version_id: string };
  smart_summary?: SmartSummary | null;
  dues?: { balance_due_paisa: number; online_gateways: ('esewa' | 'khalti')[]; open_request?: { id: string; status: string } };
}
/** P7 (08 A21.1): the dues-only view; no report content. */
export interface PortalDues {
  lab_name: string;
  dues?: NonNullable<PortalReport['dues']>;
  report_follows: boolean;
}
/** PP1 / PP2 (08 A11.1). `action_url` only while ready and not under review. */
export interface PortalPayment {
  id: string;
  status: 'queued' | 'ready' | 'completed' | 'failed' | 'expired';
  gateway: 'esewa' | 'khalti';
  review: boolean;
  action_url?: string;
  failure_code?: string;
}
export const GATEWAY_LABEL = { esewa: 'eSewa', khalti: 'Khalti' } as const;
export const PAYMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
export interface QrResult {
  lab_name: string;
  patient_display: string;
  panel_names: string[];
  issued_at: string;
  version_no: number;
  status: 'valid' | 'superseded';
}

export const token22 = (t: string): boolean => /^[A-Za-z0-9_-]{22}$/.test(t);
