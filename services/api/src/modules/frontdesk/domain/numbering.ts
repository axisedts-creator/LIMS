// Number pattern formatting (03-IC §9.3). Single pass over the pattern; values are never re-expanded. Pure.
import { LimsError } from '../../../core/errors.js';

export interface NumberContext {
  readonly prefix?: string; readonly branch?: string; readonly centre?: string;
  readonly year?: number; readonly fy?: string; readonly fyl?: string; readonly seq: number;
}

const TOKEN = /\{([a-z]+)(?::(-?\d+))?\}/g;
const bad = (detail: string): LimsError => new LimsError('common.validation_failed', detail);

export function hasToken(pattern: string, name: string): boolean {
  for (const m of pattern.matchAll(TOKEN)) if (m[1] === name) return true;
  return false;
}

export function formatNumber(pattern: string, ctx: NumberContext): string {
  if (!Number.isSafeInteger(ctx.seq) || ctx.seq < 0) throw bad('seq must be an integer >= 0');
  if (!hasToken(pattern, 'seq')) throw bad('pattern needs {seq:N}');
  return pattern.replace(TOKEN, (_all, name: string, width?: string) => {
    if (name === 'seq') {
      const w = width === undefined ? NaN : Number(width);
      if (!(w >= 1)) throw bad('{seq:N} needs N >= 1');
      return String(ctx.seq).padStart(w, '0'); // never truncates
    }
    if (width !== undefined) throw bad(`{${name}} takes no width`);
    if (name === 'yy') {
      if (!Number.isSafeInteger(ctx.year)) throw bad('{yy} needs year');
      return String(ctx.year! % 100).padStart(2, '0');
    }
    if (name !== 'prefix' && name !== 'branch' && name !== 'centre' && name !== 'fy' && name !== 'fyl') throw bad(`unknown token {${name}}`);
    const v = ctx[name];
    if (typeof v !== 'string') throw bad(`{${name}} has no value`);
    return v;
  });
}
