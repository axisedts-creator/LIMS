Title: CR-C4-FD-T04: let LimsError carry problem+json extensions (409 frontdesk.patient_duplicate_suspected `candidates`)
From chunk: C4            To owner: C0-0D
Type: api
Blocking? no (FD-T04 ships; the UI cannot show candidates until this lands)
Problem: 02-TRD §5.1 F2 says the 409 body carries `candidates:[PatientSummary]` (US-FD-02.2). `core/errors.ts` LimsError/Problem/toProblem have no extension field, so the body is only the standard Problem.
Proposed change: `LimsError` gets an optional `extensions?: Readonly<Record<string, unknown>>`; `toProblem` copies it onto the Problem (allow-listed per code; schema-checked at stage 12). FD-T04 already sets `err.candidates` (masked PatientSummary[], max 5) and will switch to `extensions` when it exists.
Backward compatible? yes.
Tenant/security impact: candidates are masked summaries from the caller's own tenant (RLS); no new PHI field beyond PatientSummary already readable with frontdesk.patient.read.
Alternatives considered: second round-trip via searchPatients (rejected: loses the "same normalised name + year ±1" predicate).
Tests that will prove it: core errors test for extension rendering; FD-T04 create.test.ts reads `e.extensions.candidates`.
