TESTS_WRONG — the 3 cases never deliver null/undefined to the task; the harness swaps them for the valid payload.
Reasons:
1. Spec requirement (spec/research/02-security.md:73 REQ-SEC-024: tenant filter explicit, payload cannot widen tenant) is met: guard in services/worker/src/jobs/billing/tasks/export_render.ts:147 and export_purge.ts:14 (`payload?.tenant_id !== tenantId`) skips real null/undefined with zero statements.
2. Test defect, not spec: export.render.test.ts:75 `o.payload ?? {valid}` maps `[null]` and `[undefined]` (line 184) to the valid payload, so `stmts` is non-empty for any correct implementation.
3. Test defect: export.render.test.ts:206 default parameter `payload: unknown = { tenant_id: TENANT_A }` maps `[undefined]` (line 233) to the valid payload. (`[null]` is unaffected and already passes.)
Required test changes (tester), keep all 6 + 4 cases and their assertions unchanged:
- line 75: `task('payload' in o ? o.payload : { tenant_id: TENANT_A, export_id: JOB }, w.ctx)`.
- line 206: `const go = async (w, ...a: unknown[]) => { const m = await purge(); return m.exportPurge(a.length ? a[0] : { tenant_id: TENANT_A }, w.ctx); };` (call sites unchanged).
Implementation: no change.
