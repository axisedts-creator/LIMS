# Catalog integration guide for consumer modules

For developers of modules that read catalog data (registration, results, billing, reports, instruments). Source: C3 04-UI-UX §7.

## Rules
1. Use `CatalogPort` from server code. Never call the HTTP API from server code; the HTTP API is for the web app and for C7 instrument mapping screens.
2. Snapshot what you used. Store `referenceRangeId + version` with every result and `priceListId + priceListVersion` with every priced order item, so later catalog changes never rewrite history.
3. Pass `birthOn` to `referenceRangeFor` whenever the patient's date of birth is known.
4. Omit `ageDays` only when the patient's age is unknown. Then only age-unrestricted bands match.
5. Validate a stored price-list id with `getPriceListStatus`. Never read `catalog.v_pub_*` views in a request.
6. Treat ranges with `kind = text` as print-only: show the text, do not compute flags from it.
7. `catalog.changed.v1` is cache invalidation only. Drop your cached catalog data when it arrives and read again through `CatalogPort`; never rebuild state from the event payload.

## API conventions
Errors are problem+json with a `code`. Lists use cursor pagination. Every change sends `If-Match`. Every create, publish, import, export, bulk and merge request sends an `Idempotency-Key`.

## Alerts
C1 registers the catalog alerts; the operator steps are in the [runbook](runbook.md).
