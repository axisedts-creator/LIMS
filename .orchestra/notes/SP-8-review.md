APPROVE

SP-8 review (diff 6754b51..HEAD)
- Paths: db/meta/decisions/SP-8.md (brief), tests/spikes/SP-8.decision.test.mjs (same owned spikes path as SP-1/2/3/5), notes. Nothing else touched.
- done_when met: "Decision: as-designed" recorded; all 12 plan-row SP-8 checks (06 row 24) have a verdict with evidence; T0D-01 hand-off named.
- Names verified verbatim in spec: 7 securitySchemes (02-TRD:332), LIMS_CORE_RESPONSE_VALIDATION on dev/ci/staging, off prod (02-TRD:947), response_contract_violation + 500 common.internal (02-TRD:471), common.validation_failed with common.unknown_field / field_required / field_invalid (02-TRD:462, IC:2436-2438), auth.unauthenticated (02-TRD:1098), multipart 15 MB (02-TRD:461), removeAdditional:false (02-TRD:111), ctx.uploads.accept (IC:3536). No new codes.
- RLS / permissions / idempotency / rate tier: not in scope (spike record, no DB or routes). No PHI, no secrets.
- Tests: `node --test tests/spikes/*.decision.test.mjs` → 88/88 pass (reviewer run). Note: `node --test tests/spikes/` (bare directory) fails on this Node; use the glob.
- Not a defect: the probe is a throwaway that was not committed, so the live behaviour was not re-run here. The open items (Fastify 5.12.8 pin at T0-03, TS types) are recorded in the decision.
