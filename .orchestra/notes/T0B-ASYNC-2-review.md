APPROVE

Re-review of `git diff 32e490d37..HEAD` (T0B-ASYNC-2), after the review fixes (5a4b97870, 413f428fd).

Both earlier items are fixed:
1. homecollection.refresh_visit_specimens is no longer declared in jobs/homecollection/index.ts. It is back on the KNOWN_GAP list with its reason and both CR ids. CR-C0-T0B-ASYNC-2-001 is written (.orchestra/cr/T0B-ASYNC-2.md). It asks for ctx.ports via IC X7, and it is non-blocking for this task. The registry-sync and manifest tests assert that it is absent.
2. worker-sql-functions.test.ts now scans the homecollection api repositories and services that the worker runs. The pgTAP worker_app_fns list adds current_actor_id, so the catalog equals the scan again. No grant is needed, because lims_worker inherits lims_app (has_function_privilege covers inheritance).

Re-checked: flag_handover_discrepancy is typed TaskHandler, so tsc checks its ctx use. Its imports (handovers/visitFlags/visits repos, route.service bumpVersion) take only tx and use no ctx.ports. The catalog index declares exactly the three enqueued ids, with the existing handlers. manifests.ts gets +2 entries. There is no API, contract, migration, auth or RLS change. No PHI or secrets. Only owned paths are touched. Names are verbatim from CR-C0-T0B-ASYNC-1-001 and LD-279.
Deviation from the brief, accepted: 4 of the 5 identifiers are queued, not 5. This follows the brief's own "doesn't fit, write a CR" rule. Still open: refresh_visit_specimens (CR-C0-T0B-ASYNC-2-001), identity.notify_ip_throttle, identity.rescan_upload (LD-279 c).

Ran: the verify.cmd vitest set, 7 files, 59/59 passed. `tsc --noEmit` is clean.
Not run: the pgTAP test and the *.live/integration tests (they need a DB).
