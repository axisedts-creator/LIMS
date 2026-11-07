APPROVE

Re-review after fixes (1ae7fca..01731d6). The earlier CHANGES item 1 (E14 race) is fixed:
- `repo/agents.repo.ts` `lockAgent` runs `SELECT id, centre_id, status FROM instruments.agents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`. It is tenant-scoped and uses the same `s.tx`.
- `service/agents.service.ts:209` takes the lock before `revokeCredentials`/`insertCredential`. It re-checks `retired` on the locked row and returns `common.not_found` if the row is gone. Under READ COMMITTED, the revoke UPDATE that runs after the lock sees the code committed by the other transaction, so only one code stays active.
- Two new service tests: lock ordering + tenant, and retired on the locked row gives 409 with nothing written. The FakeRepo has `lockAgent`.

Checks run: `vitest run src/modules/instruments`: 547/549 pass. The 2 failures are the same boot.test.ts failures as before (`module reporting: index.ts exports no manifest`, `LIMS_CORE_ENV`), which were ruled outside this task. tsc reports no instruments errors.

The FYI items from the previous review still stand (C0 openapi form-array splitting; agent_created/agent_changed config versions belong to API-T05/T06).
