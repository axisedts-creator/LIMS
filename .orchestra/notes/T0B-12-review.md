APPROVE

Reviewed `git diff 6ee2417..HEAD` (T0B-12, LD-54 + LD-55) against 08 §4.8, db/meta/decisions/SP-4.md, REQ-SEC-034/035.

- LD-54: no SQL migration/bootstrap references schema `storage` (only hit: a comment in 20261105001600_frontdesk, "ctx.storage.delete", not the schema). Bucket migration stays deleted. Live pgTAP stays a first-deploy smoke test (README), not executed — per LD-54.
- Names: 11 buckets of 08 §4.8 verbatim; `reporting-legacy` never created; every body `public:false`.
- LD-55 contract: `LIMS_CORE_STORAGE_URL` with no default (unset => throws, exit 1); paged `GET /bucket?limit=100&offset=N` until page < 100; `POST /bucket` {id,name,public:false} only for absent; `PUT /bucket/{id}` {public:false} only for public; private untouched; POST non-2xx re-lists and accepts only present+private; any non-2xx list/PUT => exit 1. Bearer + apikey headers; credential from LIMS_CORE_STORAGE_KEY_FILE, trimmed.
- No secrets/PHI: output only `<bucket> created|ok|flipped`; errors carry op + HTTP status only; fetch errors swallowed to "request failed".
- SP-4.md: "Provisioning contract (LD-55)" appended, existing text unchanged, literal strings present, cites storage-api v1.89.13 + smoke test.
- Owned paths only (db/provisioning, db/meta/decisions, tests/db, own notes). Nothing invented beyond LD-55.
- Tests: `node --test tests/db/T0B-12.storage-buckets.test.mjs tests/db/T0B-12.storage-provisioning.test.mjs` => 105/105 pass (GATE tests included, not weakened); stub server covers idempotent re-run, create, flip, >100 pagination, both headers, 4xx/5xx, no leak, unset URL.
- Not verified: routes against a real Storage stack (first-deploy smoke test, by ruling).
