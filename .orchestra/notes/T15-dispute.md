# T15 dispute (writer)
Test: org.service.test.ts:164-166 `it.each(['own','franchise','home_collection'])('kind %s accepted')` uses code `` `K-${kind}`.slice(0, 16) ``.
For `home_collection` that is `K-home_collectio` — contains `_`. Contract `CentreCreateRequest.code` pattern `^[A-Za-z0-9-]{1,16}$` (contracts/openapi/identity.yaml)
and DB `collection_centres__centre_code__ck` both forbid `_`; the same file requires `a_b` / `under_score` -> 400 (lines 108, 179). The test contradicts itself.
Fix (tester): build the code without the kind's underscore, e.g. `` `K-${kind.replace('_', '-')}`.slice(0, 16) ``.
State: 174/175 T15 tests pass; only this case fails, with 400 common.validation_failed from code validation (correct per contract).
