APPROVE

HC-T26 review (reviewer), diff 9f6c1a1b..a45a3513.
- Run: `flutter test` on the 6 HC-T26 files: 146/146 pass (reviewer run, 2026-11-14).
- Names: the mutation types and payload keys match TRD §6.3 (lines 366-373) exactly: `visit.arrived{gps}`, `visit.identity_checked{name_check,second_identifier,second_check}`, `visit.consent_recorded{consent_text_version,given}`, `specimen.collected{specimen_id,scanned_barcode,scan_method,specimen_type_code,gps}`, `specimen.not_collected{specimen_id,reason_code,reason_text?}`, `payment.captured{order_id,payment_method_code,amount{amount_paisa,currency},reference?}`, `visit.completed{outcome}`, `visit.failed{reason_code,reason_text?,gps}`. The UI copy matches 04-UI-UX §3.3-3.9.
- ACs: US-07-1 (7 mutations into the real outbox, resume from the log), -2 (mismatch: only Fail visit / Back), -3 (refused: patient_refused), -4 (match / other patient / unknown / repeat), -5 (manual, last4 only, scan_method=manual), -6 (partial), -7 (requires_reference from config, amount 1..50,000,000 paisa). All are covered by tests. The settings 400 part of -7 is backend and out of scope.
- PHI/secrets: no logging, clipboard or network in the feature code. visit_label is the sequence + window only. The barcode and reference fields are `sensitive`. No secrets.
- Paths: everything is under apps/phlebo_app (C17). The one-line `implements MutationSink` in outbox/data/outbox_repository.dart is outside the brief's globs but inside the chunk, and the tests need it. Acceptable.
- RLS/permissions/idempotency/rate tier: not applicable (Flutter UI only; client_mutation_id is set by the existing outbox).
- LD-140: lims_ui widgets + LimsTokens only; no hex colours or radii; one primary button per screen.

Non-blocking (follow-ups, not defects for this task):
1. 04-UI-UX §4: "Duplicate within 1,500 ms ignored [CONV]". collect_screen.dart:114 instead shows "Already collected." with the alert sound for a re-scan inside 1.5 s. Nothing gets recorded twice, so this is only a UX difference. Worth aligning when HID burst detection is added.
2. HID burst timing (≤30 ms, ≥4 chars) and the re-auth gate (US-07-8) are not in this task. The writer recorded both as open items. LimsTextField has no onSubmitted, so the screen uses a focus-loss workaround (collect_screen.dart:291). That needs a lims_ui CR.
