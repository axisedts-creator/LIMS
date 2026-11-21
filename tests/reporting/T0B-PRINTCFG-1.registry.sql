-- T0B-PRINTCFG-1: previewPrintProfile enqueues reporting.render_print; app.enqueue_job rejects identifiers absent from core.g_task_registry
-- (the deploy step registry-sync fills it, the FD-T03 boot skips it). Superuser, idempotent, synthetic. max_attempts 5 = PRINT_MAX_ATTEMPTS.
INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts)
VALUES ('reporting.render_print', 'reporting', 'task', 'per_tenant', 5) ON CONFLICT DO NOTHING;
