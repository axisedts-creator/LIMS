// C11 T-21 error copy (04-UI-UX §8) and the JSON Pointer -> field mapping of `anatomic.report_incomplete` (03-APP-FLOW §4.2 step 5).
// LD-140 (2026-11-13, binding): copy only; no UI in this file. Codes missing here fall back to the shared copy in ../common.tsx; a raw code or server detail is never shown.
import type { CaseItem, FieldError } from '../../server/types';
import type { Fail } from '../common';

const COPY: Record<string, string> = {
  'anatomic.report_incomplete': "Complete the highlighted fields before signing out.",
  'anatomic.template_not_published': "This template version is not published.",
  'lab.result_locked': "The lab result is approved and locked. Use Amend.",
  'lab.module_result_stale': "A newer version was already sent to the lab. Reload the case.",
  'lab.module_result_invalid': "The lab did not accept this result for this test. Check the test's setup.",
  'lab.result_invalid_transition': "The lab result can't accept a new version now (it may be cancelled).",
  'lab.amendment_reason_required': "An amendment needs a reason.",
};
export const INCOMPLETE = 'anatomic.report_incomplete';
const GENERIC = 'Something went wrong. Try again.';

/**
 * Copy for the report failures; `undefined` = use the shared copy (../common failText).
 * `anatomic.order_item_inactive` names the removed tests from the case items, never from the server detail. Lab errors carry the support reference (flow step 7).
 */
export function reportDescribe(items: readonly CaseItem[], max: number) {
  return (f: Fail): string | undefined => {
    if (f.code === 'anatomic.image_limit_reached') return `Image limit reached (${max}).`; // 04-UI-UX §8
    if (f.code === 'anatomic.order_item_inactive') {
      const names = items.filter((i) => !i.is_active).map((i) => i.test_name);
      return names.length ? `The test ${names.join(', ')} was removed from the order. Ask front desk, or cancel the case.` : undefined;
    }
    const lab = f.code.startsWith('lab.');
    const ref = lab && f.requestId ? ` Support reference: ${f.requestId}` : '';
    const copy = COPY[f.code] ?? (lab ? GENERIC : undefined);
    return copy ? copy + ref : undefined;
  };
}

/** Field labels of the editor, used in the summary entries ("Diagnosis / impression: is required"). */
export const FIELD_LABEL = { gross_text: 'Gross', microscopy_text: 'Microscopy', impression_text: 'Diagnosis / impression', comment_text: 'Comment' } as const;

export interface PointerContext {
  /** Synoptic instances as sent (same order as the PUT body): field key -> label. */
  synoptic: readonly { title: string; labels: Readonly<Record<string, string>> }[];
  /** Ancillary entries as sent: the stain order id and its label. */
  ancillary: readonly { id: string; label: string }[];
}

/**
 * JSON Pointer ("/synoptic/0/values/site") -> { field name on the page, label }. The names are the ones the editor registers with the kit Form, so the
 * summary entry becomes a link that focuses the field. A pointer that maps to no field keeps its own path (plain text entry, never dropped).
 */
export function mapPointer(path: string | undefined, ctx: PointerContext): { name: string; label: string } | undefined {
  const p = (path ?? '').split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const [head, a, b, c] = p;
  if (p.length === 1 && head && head in FIELD_LABEL) return { name: head, label: FIELD_LABEL[head as keyof typeof FIELD_LABEL] };
  if (head === 'synoptic' && b === 'values' && c !== undefined) {
    const i = Number(a);
    const s = ctx.synoptic[i];
    return s ? { name: `synoptic/${i}/values/${c}`, label: s.labels[c] ?? c } : undefined;
  }
  if (head === 'image_ids' && p.length === 2 && /^\d+$/.test(a ?? '')) return { name: `image_ids/${a}`, label: `Image ${Number(a) + 1}` };
  if (head === 'ancillary' && p.length === 3 && /^\d+$/.test(a ?? '')) {
    const x = ctx.ancillary[Number(a)];
    return x ? { name: `ancillary_${x.id}`, label: x.label } : undefined;
  }
  return undefined;
}

/** Server errors -> Form `problem` entries: mapped ones get the page field name and a label prefix; the rest stay plain text. */
export function mapIncomplete(errors: readonly FieldError[] | undefined, ctx: PointerContext): { path?: string; code?: string; message: string }[] {
  return (errors ?? []).map((e) => {
    const m = mapPointer(e.path, ctx);
    return m ? { path: `/${m.name}`, ...(e.code ? { code: e.code } : {}), message: `${m.label}: ${e.message}` } : { ...(e.path ? { path: e.path } : {}), ...(e.code ? { code: e.code } : {}), message: e.message };
  });
}
