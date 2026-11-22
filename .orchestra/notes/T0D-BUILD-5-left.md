# T0D-BUILD-5 left (writer)
- GAP listTatAlerts (contracts/openapi/quality.yaml, GET /v1/quality/tat-alerts): the response is { data, page: { limit, next_cursor? }, generated_at } with NO total or count field. The tiles and the "Alerts by level" table on /quality/tat-alerts therefore count the current page only and read "at least N" (plus a card note) while a next page exists; no total is invented. A real total needs a contract change (a `total`/count field or a per-level count operation): CR for C9 if the founder wants exact numbers.
- Nav badge stays capped at "50+" for the same reason (first page of 50, C9 04-UI-UX §1.1).
- getAutoverifyRuleSet: the contract summary says "404 when none yet", so 404 = empty state is per contract (no gap).
- Names: department/centre names come from the existing filter lookups (listDepartments active only, listCentres). An inactive department or a failed lookup falls back to the short id (by design).
