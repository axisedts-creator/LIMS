# API-T06 impl
- New: `repo/device.repo.ts`, `service/enrolment.service.ts` (E01 + shared `deviceScope`/`activeAgent`), `service/heartbeat.service.ts` (E03/E07), `service/releases.service.ts` (E02/E08), `handlers/device.handlers.ts`; `handlers/index.ts` wires them.
- E01: lockAgent FOR UPDATE + CAS active->used = single use; old device tokens revoked `device_replaced` with replaced_by; one access row `device_credential.issue`; uniform 401 for every unusable code.
- [CONV] queue_depth = queue.pending + queue.uploading; last_ip_changed_at set in SQL when IP differs; command_results applied before claim, invalid entries skipped.
- [CONV] E08 file name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`, resolve inside releasesDir, bytes must match sha256+size; whole file read into memory (ponytail note).
- Checks: 5 T06 suites 126/127 pass; tsc clean for instruments. Open: dispute `API-T06-dispute.md` (fixture `target/window: null` vs contract; boot.test IMPLEMENTED list stale).
- Not done: log-bundle PHI re-scrub (no spec pattern list), heartbeat `instruments[]` per-instrument status (evaluator API-T14), real-DB SQL not run.
