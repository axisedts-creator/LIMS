# T0D-05 impl (writer)
- Files: `services/api/src/core/idempotency.ts` (new). Tests: 89/89 idempotency, full api suite 987/987, `tsc --noEmit` clean; eslint not installed (`eslint` not found).
- Claim/select/takeover in ONE short `db.requestTx` with caller claims; decision thrown outside the tx. Takeover always attempted on in_progress; 0 rows -> 409 (covers 59.999 s boundary + race) — no JS clock for staleness, DB `now()` decides.
- All WHERE use `tenant_id IS NOT DISTINCT FROM $1` (D-213 NULL tenant). All values bound; no body/key in logs.
- [CONV] malformed key -> `common.validation_failed` with errors[] `{path:'header.Idempotency-Key', code:'common.field_invalid'}`.
- [CONV] idempotent op without tenant claim (or platform op without `scope:'platform'`) -> `common.internal` before SQL (§6.6 step 6: public ops never use idempotency).
- [CONV] canonical JSON drops undefined object members; 204/undefined body stored as SQL NULL.
- Open: `now` option accepted but unused (DB clock is authoritative); Fastify wiring of stages 6/10/11 is the pipeline task.
