// Fiscal document numbers (03-IC §9.3; 02-TRD §12; US-BL-01.5; 08 A13 D-23). Single pass; values never re-expanded. Pure.
import { LimsError } from '../../../core/errors.js';

export type SeriesKind = 'INV' | 'CN' | 'RC';
export type SeriesScope = 'tenant' | 'branch';
export interface DocumentNumberContext {
  readonly fy: { readonly short: string; readonly long: string };
  readonly seq: number; readonly prefix?: string; readonly branch?: string; readonly scope?: SeriesScope;
}

const TOKEN = /\{([a-z]+)(?::(\d+))?\}/g;
const MAX_WIDTH = 20; // [CONV] guard against absurd padding; spec gives no maximum
const BRANCH_CODE = /^[A-Za-z0-9_-]{1,20}$/; // invoices__series__ck
const bad = (detail: string): LimsError => new LimsError('common.validation_failed', detail);
const hasToken = (pattern: string, name: string): boolean => [...pattern.matchAll(TOKEN)].some((m) => m[1] === name);

export function formatDocumentNumber(pattern: string, ctx: DocumentNumberContext): string {
  if (typeof pattern !== 'string') throw bad('pattern must be a string');
  if (!Number.isSafeInteger(ctx.seq) || ctx.seq < 1) throw bad('seq must be an integer >= 1'); // gapless series start at 1
  if (!hasToken(pattern, 'seq')) throw bad('pattern needs {seq:N}');
  if (ctx.scope === 'branch' && !hasToken(pattern, 'branch')) throw new LimsError('billing.numbering_pattern_invalid');
  return pattern.replace(TOKEN, (_all, name: string, width?: string) => {
    if (name === 'seq') {
      const w = width === undefined ? NaN : Number(width);
      if (!(w >= 1 && w <= MAX_WIDTH)) throw bad(`{seq:N} needs 1 <= N <= ${MAX_WIDTH}`);
      return String(ctx.seq).padStart(w, '0'); // never truncates
    }
    if (width !== undefined) throw bad(`{${name}} takes no width`);
    const v = name === 'fy' ? ctx.fy?.short : name === 'fyl' ? ctx.fy?.long : name === 'prefix' ? ctx.prefix : name === 'branch' ? ctx.branch : undefined;
    if (name !== 'fy' && name !== 'fyl' && name !== 'prefix' && name !== 'branch') throw bad(`unknown token {${name}}`);
    if (typeof v !== 'string') throw bad(`{${name}} has no value`);
    return v;
  });
}

/** TRD §12: `INV` | `INV:<branch_code>` (branch scope) | `CN` | `RC`. */
export function seriesKey(kind: SeriesKind, scope: SeriesScope, branchCode?: string): string {
  if (kind !== 'INV' && kind !== 'CN' && kind !== 'RC') throw bad('unknown series kind');
  if (scope !== 'tenant' && scope !== 'branch') throw bad('unknown series scope');
  if (kind !== 'INV' || scope === 'tenant') return kind;
  if (typeof branchCode !== 'string' || !BRANCH_CODE.test(branchCode)) throw bad('branch code must match [A-Za-z0-9_-]{1,20}');
  return `INV:${branchCode}`;
}
