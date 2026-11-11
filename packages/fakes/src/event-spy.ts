// packages/fakes/src/event-spy.ts — in-memory `events.publish` spy (C0 TRD §5.4; CV §7.3 semantics: a duplicate
// (tenant, event type, idempotencyKey) is silently not re-published).
import type { EventType } from "@lims/contracts/ports/generated/events";

export interface PublishedEvent {
  readonly tenantId: string;
  readonly type: EventType | string;
  readonly idempotencyKey: string;
  readonly aggregate?: { readonly type: string; readonly id: string; readonly seq?: number };
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface EventSpy {
  publish(tx: unknown, type: EventType | string, e: { tenantId: string; idempotencyKey: string; aggregate?: PublishedEvent["aggregate"]; payload: Record<string, unknown> }): Promise<void>;
  readonly published: readonly PublishedEvent[];
  ofType(type: EventType | string): readonly PublishedEvent[];
  /** Drops events published inside `tx` (the caller's transaction rolled back). */
  rollback(tx: unknown): void;
  clear(): void;
}

export function createEventSpy(): EventSpy {
  const rows: { tx: unknown; e: PublishedEvent }[] = [];
  return {
    async publish(tx, type, e) {
      if (rows.some((r) => r.e.tenantId === e.tenantId && r.e.type === type && r.e.idempotencyKey === e.idempotencyKey)) return;
      rows.push({ tx, e: JSON.parse(JSON.stringify({ ...e, type })) });
    },
    get published() { return rows.map((r) => r.e); },
    ofType(type) { return rows.filter((r) => r.e.type === type).map((r) => r.e); },
    rollback(tx) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.tx === tx) rows.splice(i, 1); },
    clear() { rows.length = 0; },
  };
}
