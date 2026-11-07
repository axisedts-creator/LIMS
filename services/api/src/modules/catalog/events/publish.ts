// catalog.changed.v1 publisher (02-TRD §9.1, 03-IC §3.19). Runs inside the writing transaction via core events.publish.
interface Events { publish(ctx: unknown, type: string, input: object): Promise<unknown> }

export interface CatalogChangedPayload {
  readonly catalog_revision: number;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly change_kind: string;
  readonly effective_from: string;
}

export function createCatalogEvents(events: Events) {
  return {
    catalogChanged(ctx: { readonly tenantId: string }, payload: CatalogChangedPayload, o: { catalogRootId: string }) {
      return events.publish(ctx, 'catalog.changed.v1', {
        aggregate: { type: 'catalog', id: o.catalogRootId, seq: payload.catalog_revision },
        idempotencyKey: `${ctx.tenantId}:catalog:${payload.catalog_revision}`,
        payload,
      });
    },
  };
}
