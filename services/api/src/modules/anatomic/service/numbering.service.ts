// Accession numbering — 02-TRD §4.2. Allocates ONLY through repository/counters.repo (one atomic UPDATE; the row lock serialises concurrent accessions, AC-02.2).
// Runs inside the caller's transaction: any throw (overflow, bad pattern, later duplicate) rolls the counter back. Errors never carry the number (REQ-SEC-095).
import { LimsError } from '../../../core/errors.js';
import type { Tx } from '../../../core/db/tx.js';
import type { CaseKind } from '../domain/case.js';
import {
  DEFAULT_ACCESSION_PATTERN, DEFAULT_ACCESSION_PREFIXES, accessionYearAd, parseAccessionPattern, renderAccessionNumber,
} from '../domain/accession-pattern.js';
import { bumpAccessionCounter } from '../repository/counters.repo.js';

/** The part of the request context the anatomic services use (02-TRD §6.2 / §6.3). */
export interface AnatomicCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly tx: Pick<Tx, 'query'>;
  now(): Date;
  readonly log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
  readonly core: {
    branch(ctx: unknown, i: { branchId: string }): Promise<{ branchCode: string }>;
    readonly memberships: {
      list(ctx: unknown, i: { permission: string; centreId?: string; activeOnly: boolean; limit: number }): Promise<ReadonlyArray<{ membershipId: string; displayName: string }>>;
    };
  };
  readonly ports: {
    readonly IdentityPort: {
      assertRole(ctx: unknown, i: { permission: string; centreId?: string }): Promise<unknown>;
      getTenantSettings(ctx: unknown, i: { keys: readonly string[] }): Promise<Record<string, any>>;
    };
  };
}

export interface AllocatedNumber { accessionNo: string; seriesKey: string; yearAd: number; seq: number }

const invalid = (): LimsError => new LimsError('anatomic.accession_pattern_invalid');
const isStr = (v: unknown): v is string => typeof v === 'string';

export async function allocateAccessionNumber(ctx: AnatomicCtx, i: { caseKind: CaseKind; branchId?: string | null }): Promise<AllocatedNumber> {
  const settings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone', 'numbering'] });
  const numbering = (settings['numbering'] ?? {}) as Record<string, any>;
  const pattern: string = isStr(numbering['accessionNoPattern']) ? numbering['accessionNoPattern'] : DEFAULT_ACCESSION_PATTERN;
  const configured = numbering['accessionPrefixes']?.[i.caseKind];
  const prefix: string = isStr(configured) ? configured : DEFAULT_ACCESSION_PREFIXES[i.caseKind];

  const parsed = parseAccessionPattern(pattern); // throws accession_pattern_invalid before any counter work
  let branchCode: string | undefined;
  if (parsed.hasBranch) {
    if (!i.branchId) throw invalid(); // event carried no processing branch; core.branch is never called
    branchCode = (await ctx.core.branch(ctx, { branchId: i.branchId })).branchCode;
  }
  let yearAd = 0;
  if (parsed.hasYear) {
    try { yearAd = accessionYearAd(ctx.now(), String(settings['timezone'])); } catch { throw new LimsError('common.internal'); } // bad tz: never fall back to UTC
  }
  const seq = await bumpAccessionCounter(ctx.tx, { tenantId: ctx.tenantId, seriesKey: i.caseKind, yearAd, actorId: ctx.actor.id });
  const accessionNo = renderAccessionNumber({ pattern, seq, year: yearAd, prefix, ...(branchCode !== undefined ? { branchCode } : {}) }); // overflow -> throws
  return { accessionNo, seriesKey: i.caseKind, yearAd, seq };
}
