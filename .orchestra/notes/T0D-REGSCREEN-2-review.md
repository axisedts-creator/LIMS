APPROVE
Range cdcfa2511..HEAD: test change only (regscreen2.drafts.test.tsx:219-221), plus notes. It matches arbiter ruling round 2 word for word: patient picked via F2 + "Synthetic Patient One" (synthetic), assertions at :222-226 unchanged, nothing deleted or loosened.
Contract check: contracts/openapi/frontdesk.yaml:5666-5674 RegistrationDraft.required has `patient`, so a quote without a patient is invalid; the screen not sending one is right.
No production code, contract, route, permission, migration, RLS, log or secret change in range. Paths are owned (frontdesk __tests__, own notes).
Ran: vitest.regscreen2.config.ts: 4 files, 87/87 passed (05:21 NPT). Did not re-run regscreen1/fd-t13/fd-t14 (no code change in range).
Note, outside this range (not blocking here): impl notes say the 54-row table is listed by group, not row by row (done_when 5), and referrer/credit party are not restored from a draft. The lead should decide if that closes done_when (5).
