// WIRE-DB / LD-189 (AUTH-SENSITIVE): late-bound identityAuthTx for the identity claims resolver. AC-0D-2.6, 02-TRD s6.4, 08 A25 D-212 / R10.
// The resolver gets ONLY this frozen facade (one method). Unbound = common.internal (as before). The identity system actor id is read lazily
// (first call, never at boot) from core.g_system_actors by the source bound at boot, validated as a UUID, memoised on success only.
import { LimsError } from '../../../core/errors.js';
import type { TxFn, TxInput } from '../../../core/db/tx.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // same shape rule as core/db/tx.ts
type AuthDb = { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
export interface IdentityDbSource {
  readActorId(): Promise<unknown>;
  open(actorId: string): AuthDb;
}

export function createIdentityDbBinding(): { readonly db: AuthDb; bind(src: IdentityDbSource): void } {
  let src: IdentityDbSource | undefined;
  let opened: AuthDb | undefined; // set only after a valid id; failures are never cached
  let pending: Promise<AuthDb> | undefined;
  const internal = () => new LimsError('common.internal'); // code only: no id, no driver text

  function resolveDb(): Promise<AuthDb> {
    if (opened) return Promise.resolve(opened);
    const s = src;
    if (!s) return Promise.reject(new LimsError('common.internal', 'identity: ctx.db not wired into module construction')); // same text as before: manifest-ports.test.ts pins it
    pending ??= (async () => {
      let id: unknown;
      try { id = await s.readActorId(); } catch { throw internal(); }
      if (typeof id !== 'string' || !UUID.test(id)) throw internal();
      try { return (opened = s.open(id)); } catch { throw internal(); }
    })().finally(() => { pending = undefined; });
    return pending;
  }

  const db: AuthDb = Object.freeze({
    identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> {
      return resolveDb().then((d) => d.identityAuthTx(input, fn));
    },
  });
  return {
    db,
    bind(s) { src = s; opened = undefined; pending = undefined; },
  };
}
