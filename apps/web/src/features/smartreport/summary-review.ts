// SR-02 view model (04-UI-UX SR-02): a SmartSummaryView (#28) cut down to plain text for the client component.
// Pure and server/client neutral. 07-SECURITY REQ 081: `review_inputs` and any `llm_text` are copied ONLY when the session holds smartreport.summary.approve;
// the reviews[] `comment` is never copied. REQ 088: every value is coerced to a string or number here and rendered as a text node later.
import { UUID_RE } from './library';

export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'critical';
export interface Reason { code: string; display: string }
export interface InputRow { id: string; analyte: string; result: string; unit: string; flag?: string; range: string; band: string; bandTone: Tone; group: string }
export interface TrendVM { id: string; title: string; unit?: string; points: { at: string; value: string }[]; band?: { low?: string; high?: string } }
export interface HistoryItem { at: string; label: string; tone: Tone }
export interface SummaryVM {
  id: string; version: number; status: string; orderId?: string; supersededBy?: string; canApprove: boolean; canResults: boolean;
  registrationNo: string; patient: string; centre: string; builtAt: string; library: string; formula: string; rejectReason?: string;
  score?: { value: number; band: string; explanation?: string };
  panels: { name: string; status: string }[]; deranged: string[]; advice: string[]; followUps: string[]; disclaimer?: string; trends: TrendVM[];
  inputs?: InputRow[]; unmapped?: number; duplicates?: number; history: HistoryItem[]; reasons: Reason[];
}

export const STATUS: Record<string, [string, Tone]> = {
  draft: ['Awaiting review', 'info'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'], superseded: ['Superseded', 'neutral'],
};
const BAND: Record<string, [string, Tone]> = {
  in_range: ['In range', 'success'], borderline: ['Borderline', 'warning'], out_of_range: ['Out of range', 'danger'], critical: ['Critical', 'critical'],
};
const FLAGS = ['N', 'L', 'H', 'LL', 'HH', 'A'];
const CAP = 200;

type O = Record<string, unknown>;
const obj = (x: unknown): O => (x && typeof x === 'object' && !Array.isArray(x) ? (x as O) : {});
const arr = (x: unknown): O[] => (Array.isArray(x) ? x.slice(0, CAP).map(obj) : []);
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const words = (x: unknown) => str(x).replace(/_/g, ' ');
const uuid = (x: unknown) => (UUID_RE.test(str(x)) ? str(x) : undefined);
const text = (list: O[], key: string) => list.map((i) => str(i[key])).filter(Boolean);
/** "7 - 40" -> { low: '7', high: '40' }; anything else gives no band. */
const rangeOf = (s: string) => { const m = /^\s*(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s); return m ? { low: m[1]!, high: m[2]! } : undefined; };

/** History: "Built" first, then reviews[] by time (oldest first). Wording [CONV] from 04-UI-UX SR-02. */
function historyOf(s: O, reasons: Reason[]): HistoryItem[] {
  const shown = (code: string) => reasons.find((r) => r.code === code)?.display ?? words(code);
  const items = arr(s['reviews']).flatMap((r): HistoryItem[] => {
    const by = str(r['actor_display_name']);
    const who = by ? ` by ${by}` : '';
    const when = str(r['at']);
    switch (str(r['action'])) {
      case 'approved': return [{ at: when, label: `Approved${who}`, tone: 'success' }];
      case 'rejected': return [{ at: when, label: `Rejected${who}${str(r['reason_code']) ? ` — ${shown(str(r['reason_code']))}` : ''}`, tone: 'danger' }];
      case 'superseded': return [{ at: when, label: 'Superseded — results changed', tone: 'warning' }];
      case 'llm_rephrase_requested': return [{ at: when, label: `AI rephrasing requested${who}`, tone: 'neutral' }];
      default: return [];
    }
  }).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return [...(str(s['built_at']) ? [{ at: str(s['built_at']), label: 'Built', tone: 'neutral' as const }] : []), ...items];
}

/** `id` is the validated route id, never a value echoed by the API. */
export function buildView(s: O, ctx: { id: string; perms: readonly string[]; reasons: Reason[]; centre?: string }): SummaryVM {
  const canApprove = ctx.perms.includes('smartreport.summary.approve');
  const hs = obj(s['health_score']);
  const inputs = canApprove ? arr(s['review_inputs']) : [];
  const rangeFor = (analyte: unknown) => rangeOf(str(inputs.find((i) => i['analyte_id'] === analyte)?.['ref_range_text']));
  const status = str(s['status']);
  const lib = typeof s['template_library_version'] === 'number' ? `Library v${s['template_library_version']}` : '';
  const code = str(s['reject_reason_code']);

  return {
    id: ctx.id, version: typeof s['version'] === 'number' ? s['version'] : 0, status, canApprove, canResults: ctx.perms.includes('lab.result.read'),
    ...(uuid(s['order_id']) ? { orderId: uuid(s['order_id'])! } : {}), ...(uuid(s['superseded_by_summary_id']) ? { supersededBy: uuid(s['superseded_by_summary_id'])! } : {}),
    registrationNo: str(s['registration_no']) || '—', patient: str(s['patient_display_name']) || '—', centre: ctx.centre || '—', builtAt: str(s['built_at']),
    library: lib || '—', formula: str(s['formula_version']) || '—',
    ...(status === 'rejected' && code ? { rejectReason: ctx.reasons.find((r) => r.code === code)?.display ?? words(code) } : {}),
    ...(typeof hs['value'] === 'number' ? { score: { value: hs['value'], band: words(hs['band']), ...(str(hs['explanation_text']) ? { explanation: str(hs['explanation_text']) } : {}) } } : {}),
    panels: arr(s['panels']).map((p) => ({ name: str(p['display_name']), status: words(p['status']) })),
    deranged: text(arr(s['deranged']), 'text'), advice: text(arr(s['advice']), 'text'), followUps: text(arr(s['follow_ups']), 'text'),
    ...(str(s['disclaimer_text']) ? { disclaimer: str(s['disclaimer_text']) } : {}),
    trends: arr(s['trends']).map((t) => {
      const band = rangeFor(t['analyte_id']);
      const unit = str(t['unit_code']);
      return {
        id: str(t['analyte_id']), title: `${str(t['analyte_name'])} — ${words(t['direction'])}`, ...(unit ? { unit } : {}), ...(band ? { band } : {}),
        points: arr(t['points']).map((p) => ({ at: str(p['approved_at']), value: str(p['value_numeric']) })).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)),
      };
    }),
    ...(canApprove ? {
      inputs: inputs.map((i) => {
        const [band, bandTone] = BAND[str(i['band_status'])] ?? [words(i['band_status']), 'neutral' as const];
        return {
          id: str(i['result_id']), analyte: str(i['analyte_name']), result: str(i['value_text']), unit: str(i['unit_code']), range: str(i['ref_range_text']),
          band, bandTone, group: words(i['group_code']), ...(FLAGS.includes(str(i['flag'])) ? { flag: str(i['flag']) } : {}),
        };
      }),
      unmapped: Number(obj(s['counts'])['unmapped_results']) || 0, duplicates: Number(obj(s['counts'])['ignored_duplicates']) || 0,
    } : {}),
    history: historyOf(s, ctx.reasons), reasons: ctx.reasons,
  };
}
