# HC-T02 impl
Files (services/api/src/modules/homecollection/domain/): visit.state, collection.state, handover.state, mutation, clock, cursor `.ts` — pure, only import core/errors.
Run: 6 files / 204 tests pass; `tsc --noEmit` shows no errors in domain/. eslint not installed in services/api (not run).
[CONV] forbidden pairs the spec gives no code for: visit -> homecollection.mutation_superseded, collection -> homecollection.collection_not_held, handover -> common.version_conflict.
[CONV] mutation.ts validates payloads only (envelope fields client_mutation_id/device_seq/captured are the route schema's job); codes (reason_code, specimen_type_code) are format-checked, set membership is a DB lookup (other task).
[CONV] clock: bad timestamps throw common.validation_failed; skewSeconds uses the clamped correctedAt; anchor path needs named anchor's bootId == now.bootId and elapsed >= 0.
Open: device state machine §1.4 and conflict.ts guards not in this task; tester's assumptions (itemCount/confirmationRequired opts, clock shape) implemented as stated.
