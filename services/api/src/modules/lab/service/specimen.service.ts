// Specimen service (06 row T-05 covers barcode allocation only; further specimen operations land in later tasks).
// Runs in the caller's transaction (ctx.tx): a rendering failure rolls the counter step back with it. Tenant and actor come from ctx only (REQ-SEC-024).
import { LimsError } from '../../../core/errors.js';
import { DEFAULT_BARCODE_PATTERN, renderBarcode } from '../domain/barcode.js';
import { allocateBarcodeSeq } from '../repository/barcodeCounters.repo.js';
import type { RepoTx } from '../repository/base.repo.js';

export interface LabCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly tx: RepoTx;
  now(): Date;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}

/** Next barcode for the ctx tenant: counter + numbering.barcodePattern/barcodePrefix (08 A13 D-8). Invalid config or overflow -> lab.barcode_pattern_invalid. */
export async function allocateBarcode(ctx: LabCtx): Promise<string> {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  const settings = await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['numbering'] });   // failure propagates: no silent default
  const numbering = settings?.numbering ?? {};
  const seq = await allocateBarcodeSeq({ tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id });
  return renderBarcode(numbering.barcodePattern ?? DEFAULT_BARCODE_PATTERN, { seq, prefix: numbering.barcodePrefix, now: ctx.now() });
}
