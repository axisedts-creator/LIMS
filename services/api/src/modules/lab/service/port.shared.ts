// T-24 shared pieces of the LabPort implementation (03-IC §4.5 + 08 §4.14; 02-TRD §6.1).
// The port gets a STRICT RequestContext { tenantId, actor, requestId, tx, now(): ISO string, ports }: no ctx.events / ctx.store / ctx.audit. Everything runs in ctx.tx under RLS with an
// explicit tenant filter (REQ-SEC-024); events go through core createEvents over ctx.tx. Messages are fixed text: no barcode, value or name is ever echoed (07-SECURITY P-09, S-19).
import { LimsError } from '../../../core/errors.js';
import { createEvents, type PublishInput } from '../../../core/events/publish.js';
import type { RepoCtx, RepoTx } from '../repository/base.repo.js';
import { bad, isObj, UUID } from './specimen.service.js';

export type Obj = Record<string, any>;
export interface PortCtx {
  readonly tenantId: string; readonly requestId: string; readonly tx: RepoTx; now(): string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly ports: { readonly IdentityPort: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } } & Record<string, any>;
}

export const events: { publish(ctx: never, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> } = createEvents({ producer: 'lab' }) as never;
export const forbidden = (): LimsError => new LimsError('auth.forbidden');
export { bad, isObj };

/** Actor guard FIRST (before validation, ports or any tx use): shape, then actor kind. A patient / portal / partner actor never reaches a query (REQ-SEC-072, 08 R3). */
export function portCtx(c: unknown, kinds: readonly string[]): PortCtx {
  const x = c as Partial<PortCtx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.actor.type !== 'string' || typeof x.now !== 'function' || !x.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
  if (!kinds.includes(x.actor.type)) throw forbidden();
  return x as PortCtx;
}
export const rcOf = (c: PortCtx): RepoCtx => ({ tx: c.tx, tenantId: c.tenantId, actorId: c.actor.id });
/** The ctx the handler-style services expect: Date clock + event publisher; delegates everything else to the original ctx (tx, actor, tenantId, requestId, ports). */
export const labCtx = (c: PortCtx): any => Object.assign(Object.create(c), { events, now: () => new Date(c.now()) });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
export const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v.toLowerCase(); };
export const instant = (v: unknown, path: string): string => { if (typeof v !== 'string' || !ISO.test(v) || !Number.isFinite(Date.parse(v))) throw bad(path); return v; };
export const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string).toISOString());
/** assigns only present values: an absent column is omitted from the output, never null */
export const put = (o: Obj, k: string, v: unknown): void => { if (v !== null && v !== undefined) o[k] = v; };
