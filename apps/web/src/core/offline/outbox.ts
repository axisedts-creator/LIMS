// T0D-OFFLINE-1 (LD-322; offline design section 2): the outbox. One operation = op_id (UUIDv7, the idempotency key),
// op_type, base_version, entity_id, payload, device_created_at. It is appended in ONE IndexedDB transaction together with
// the local state change it belongs to. Settled operations move out in one transaction per batch.
// Reused from the Flutter outbox (apps/phlebo_app/lib/features/outbox): op_id idempotency, attempts, outcome code on
// rejected rows, a separate conflict list.
import { OfflineError, req, type DataStoreName, type OfflineStore, type SealedRecord } from './store';

export interface OperationInput { op_type: string; payload: unknown; base_version?: number; entity_id?: string }
export interface Operation extends OperationInput { op_id: string; device_created_at: string; device_id: string; user_id: string }
export interface LocalChange { store: DataStoreName; key: string; value: unknown }
export interface AttentionItem extends Operation { code: string; at: string }
export interface ConflictItem extends Operation { conflict_id: string; code?: string | undefined; at: string }
export interface NumberMapping { document_type: string; provisional_number: string; final_number: string; [k: string]: unknown }
export interface Settlement {
  remove?: string[];
  attention?: Array<{ opId: string; code: string }>;
  conflicts?: Array<{ opId: string; conflictId: string; code?: string | undefined }>;
  mappings?: NumberMapping[];
}

const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');

/** RFC 9562 UUIDv7 with a monotonic 12 bit counter in rand_a, so ids made in one millisecond still sort in creation order. */
export function uuidV7Factory(now: () => number = Date.now) {
  let lastMs = -1; let seq = 0;
  return () => {
    let ms = now();
    if (ms <= lastMs) { ms = lastMs; seq++; if (seq > 0xfff) { ms++; seq = 0; } } else seq = globalThis.crypto.getRandomValues(new Uint16Array(1))[0]! & 0x3ff;
    lastMs = ms;
    const r = globalThis.crypto.getRandomValues(new Uint8Array(8));
    const t = hex(ms, 12);
    const tail = Array.from(r, (b) => hex(b, 2)).join('');
    return `${t.slice(0, 8)}-${t.slice(8)}-7${hex(seq, 3)}-${hex(0x8 | (r[0]! & 0x3), 1)}${tail.slice(1, 4)}-${tail.slice(4, 16)}`;
  };
}

export function createOutbox(store: OfflineStore, ctx: { deviceId: string; userId: string; now?: () => number }) {
  const now = ctx.now ?? Date.now;
  const nextId = uuidV7Factory(now);
  const locked = () => { if (!store.isUnlocked()) throw new OfflineError('offline.locked'); };
  const all = async <T>(name: 'outbox' | 'attention' | 'conflicts' | 'mappings', limit?: number): Promise<T[]> => {
    locked();
    const rows = (await store.transact([name], 'readonly', (s) => req(s(name).getAll(null, limit)))) as SealedRecord[];
    return Promise.all(rows.map((r) => store.decryptRecord<T>(name, r)));
  };

  async function settle(x: Settlement) {
    locked();
    const moving = [...(x.attention ?? []).map((a) => a.opId), ...(x.conflicts ?? []).map((c) => c.opId)];
    const rows = (await store.transact(['outbox'], 'readonly', (s) => Promise.all(moving.map((id) => req(s('outbox').get(id)))))) as Array<SealedRecord | undefined>;
    const ops = new Map<string, Operation>();
    for (const r of rows) if (r) ops.set(r.k, await store.decryptRecord<Operation>('outbox', r));
    const at = new Date(now()).toISOString();
    const sealed: Array<[string, SealedRecord]> = [];
    for (const a of x.attention ?? []) { const op = ops.get(a.opId); if (op) sealed.push(['attention', await store.encryptRecord('attention', a.opId, { ...op, code: a.code, at })]); }
    for (const c of x.conflicts ?? []) { const op = ops.get(c.opId); if (op) sealed.push(['conflicts', await store.encryptRecord('conflicts', c.opId, { ...op, conflict_id: c.conflictId, code: c.code, at })]); }
    for (const m of x.mappings ?? []) sealed.push(['mappings', await store.encryptRecord('mappings', m.provisional_number, m)]);
    await store.transact(['outbox', 'attention', 'conflicts', 'mappings'], 'readwrite', (s) => {
      for (const [n, r] of sealed) s(n).put(r);
      for (const id of [...(x.remove ?? []), ...ops.keys()]) s('outbox').delete(id);
    });
  }

  return {
    /** Appends the operation and its local changes atomically; crypto runs first, then one readwrite transaction. */
    async append(input: OperationInput, localChanges: LocalChange[] = []): Promise<Operation> {
      locked();
      const ms = now();
      const op: Operation = { ...input, op_id: nextId(), device_created_at: new Date(ms).toISOString(), device_id: ctx.deviceId, user_id: ctx.userId };
      const rec = await store.encryptRecord('outbox', op.op_id, op, { attempts: 0 });
      const local = await Promise.all(localChanges.map(async (c) => [c.store, await store.encryptRecord(c.store, c.key, c.value)] as const));
      await store.transact(['outbox', ...new Set(localChanges.map((c) => c.store))], 'readwrite', (s) => {
        s('outbox').add(rec);
        for (const [n, r] of local) s(n).put(r);
      });
      return op;
    },
    /** Pending operations in creation order (op_id is time ordered). */
    pending: (limit?: number) => all<Operation>('outbox', limit),
    async count() { locked(); return store.transact(['outbox'], 'readonly', (s) => req(s('outbox').count())); },
    remove: (opIds: string[]) => settle({ remove: opIds }),
    async recordAttempt(opIds: string[], nextAttemptAt: number) {
      locked();
      await store.transact(['outbox'], 'readwrite', async (s) => {
        for (const id of opIds) {
          const r = (await req(s('outbox').get(id))) as SealedRecord | undefined;
          if (r) s('outbox').put({ ...r, attempts: Number(r.attempts ?? 0) + 1, next_attempt_at: nextAttemptAt });
        }
      });
    },
    moveToAttention: (opId: string, code: string) => settle({ attention: [{ opId, code }] }),
    moveToConflicts: (opId: string, conflictId: string, code?: string | undefined) => settle({ conflicts: [{ opId, conflictId, code }] }),
    saveNumberMappings: (m: NumberMapping[]) => settle({ mappings: m }),
    settle,
    needsAttention: () => all<AttentionItem>('attention'),
    conflicts: () => all<ConflictItem>('conflicts'),
    numberMappings: () => all<NumberMapping>('mappings'),
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
