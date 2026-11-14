APPROVE
Re-review (after dcbb500f / 3b1eb4c5). Both earlier items are closed:
1. purge_triggers.dart:72-74: `_staleReason` now returns null when route_date is missing, so an empty cache rebuilt after an offline purge lets the next pull run. Matches the [CONV] comment.
2. purge_engine_test.dart:123-143: the recovery test checks that the second engine's syncNow returns ok, the pending row is applied, and a new route_date is set.

Ran HC-T28-verify.cmd: 43/43 pass.
Earlier checks still hold: names match 02-TRD A4 / PRD US-13-3/4/5; cache is destroyed before outbox, key first, via DbWipe; wipe only after drain; time is injected; no logs/PHI/secrets; only owned paths + notes.
Note (not blocking, spec silent): a failed wipe ack is still swallowed. Raise a CR if the lead wants a retry.
