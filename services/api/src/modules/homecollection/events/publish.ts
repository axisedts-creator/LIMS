// HC-T12 typed publisher for homecollection.collection.synced.v1 (02-TRD §8.1; 03-IC §3.23; 08 A19 D-120). Same seam as payments/events/publish.ts.
// Core publish validates the payload against contracts/events (additionalProperties:false) and fails closed with common.internal; the row is written in the caller's tx.
// The schema allows two empty arrays, the event is meaningless then: the publisher refuses it itself (fail closed). The aggregate seq is the visit version (positive integer).
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';

export const COLLECTION_SYNCED_EVENT = 'homecollection.collection.synced.v1';

export interface EventsPort {
  publish(ctx: any, type: string, input: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }):
    Promise<{ eventId: string; duplicate: boolean }>;
}

const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {}));

/** `<visit_id>:sync:<sha256 hex of the SORTED client_mutation_ids of the collections + payments in THIS event>` (03-IC §3.23): order-independent, set-sensitive. */
export function collectionSyncedKey(payload: Record<string, unknown>): string {
  const ids = [...list(payload['collections']), ...list(payload['payments'])].map((x) => String(x['client_mutation_id'])).sort();
  return `${String(payload['visit_id'])}:sync:${createHash('sha256').update(ids.join(','), 'utf8').digest('hex')}`;
}

export function createHomecollectionEvents(events: EventsPort) {
  return {
    async collectionSynced(ctx: any, payload: Record<string, any>, o: { visitVersion: number }): Promise<{ eventId: string; duplicate: boolean }> {
      if (!Number.isInteger(o.visitVersion) || o.visitVersion < 1) throw new LimsError('common.internal');
      if (list(payload['collections']).length + list(payload['payments']).length === 0) throw new LimsError('common.internal');
      return events.publish(ctx, COLLECTION_SYNCED_EVENT, {
        aggregate: { type: 'home_visit', id: payload['visit_id'], seq: o.visitVersion },
        idempotencyKey: collectionSyncedKey(payload),
        payload,
      });
    },
  };
}
