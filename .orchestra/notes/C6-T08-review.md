CHANGES

1. services/worker/src/jobs/reporting/tasks/assemble_report.ts:168 — smart section is not wrapped in a SAVEPOINT. 02-TRD §4.3 (08 A19 P-44) requires `SmartReportPort.buildSummary` to run inside `ctx.db.tx(…)` as a SAVEPOINT so anything the port wrote before throwing `smartreport.*` is rolled back before the version commits. In the worker, `ctx.db.tx` is `(fn) => fn(ctx)` (services/worker/src/core/consumer.ts:58, "reuse it"), i.e. no savepoint: port writes survive the catch, and a SQL error inside the port leaves the PG transaction aborted so every later INSERT fails (version never created, job retries forever). Also `t` passed to the port is the ctx, fine, but the rollback is missing. Exact fix (C6-owned file, worker core untouched):
   ```ts
   await tx.query('SAVEPOINT smart_summary');
   try {
     const s = await ctx.ports.smartreport.buildSummary(ctx, { orderId: report.order_id, version: versionNo });
     await tx.query('RELEASE SAVEPOINT smart_summary');
     if (s?.status === 'approved') smart = s;
   } catch (e) {
     await tx.query('ROLLBACK TO SAVEPOINT smart_summary');
     if (!String((e as Row)?.code ?? '').startsWith('smartreport.')) throw e;
     ctx.log?.warn?.({ event: 'smart_section_omitted', report_id: reportId, code: (e as Row).code });
   }
   ```
   Add a test in assemble_report.test.ts (smart describe): flag on + port that issues a write via `ctx.tx.query` then throws `smartreport.x` -> statement log shows `SAVEPOINT` before the port call and `ROLLBACK TO SAVEPOINT` before the version INSERT; version still created with the three smart columns NULL. (The fake dialect must accept/record SAVEPOINT statements.)

Checked OK: names vs 05-SCHEMA (report_versions, qr_tokens, reports columns + mutable-column triggers), statuses/discard_reason enums, token_sha256 32-byte bytea, fingerprint/readiness per TRD §4.2, job key `assemble:<report_id>`, max_attempts 10/5, cron `*/5 * * * *` per_tenant + 2 min staleness (§9), tenant_id in every statement, `::uuid[]` cast, payload tenant check, no PHI/token in logs, owned paths only, P-13 read-only instrument bucket + sanitise. 70/70 T08 tests pass locally (verify.cmd).
