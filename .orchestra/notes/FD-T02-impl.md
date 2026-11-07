FD-T02 impl — files: services/api/src/modules/frontdesk/domain/{patient,numbering,order.state,discount,discountApproval.state,trf.state}.ts (no change needed after ruling; impl already rejected `{seq:N}`-less patterns).
Review fix: discountApproval.state.ts checkApprove not-pending/expired -> common.immutable_record (02-TRD F18/F19).
Checks: vitest frontdesk/domain 6 files / 232 tests pass; `tsc --noEmit` clean. No eslint configured in repo.
[CONV] numbering: single-pass token replace, `{seq:N}` required, never truncates, unknown/width-misused tokens -> common.validation_failed.
[CONV] discount: integer paisa, bigint intermediates, largest-remainder allocation, ties -> lowest index.
[CONV] discountApproval: approver centre not covered treated as common.not_found (no existence leak).
Open: patient.ts 150-year age cap is a sanity bound, not a spec value (ponytail comment) — tighten if PRD names one.
