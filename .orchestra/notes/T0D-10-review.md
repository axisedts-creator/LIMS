CHANGES

Scope note: the inbox range c184ba4..HEAD is empty (HEAD = c184ba4), so I reviewed the T0D-10 commits instead: 03419bb (tests), e6f622c (impl), 42d0edd (lead).

1. pnpm-lock.yaml (whole file; e6f622c changed it +39/-6, e.g. :323, :1589, :2929 prom-client entries). This breaks the binding lead decision (AUTO 2026-11-07T10:18:35, CR-C0-0D-004 accepted) and LD-05: the lockfile belongs to C0-0A. Fix: `git checkout e6f622c~1 -- pnpm-lock.yaml` and commit. Keep `services/api/package.json` `"prom-client": "15.1.3"`, and leave the lockfile regeneration to C0-0A. After this revert, `pnpm install --frozen-lockfile` will fail until C0-0A lands it. That failure is expected and the CR covers it.

Checked, no defect:
- Metric names and label sets match 02-TRD §13 and CV §9.4. `tenant_id` appears only on events_published and ratelimit_rejections.
- Routes, operationIds and response shapes match core.yaml.
- 503 is mapped to `common.dependency_unavailable` through x-error-codes (errors.yaml http 503).
- The log line has the CV §9.1 fields, uses the route template rather than the raw URL, and goes through the shared logger's scrubbers.
- No secrets. Every other path is under services/api/src/core/** (owned by C0-0D).
- No tenant tables or RLS are involved. Auth: `security: []` with `x-public` matches the spec.

Verified: T0D-10-verify (vitest) 46/46 pass; `tsc --noEmit` clean.
The tests cover metric presence, the PHI log scan, and health per TRD §8.
Accepted [CONV] gaps (already noted by the writer):
- `degraded` returns 200.
- main.ts does not start the metrics listener yet.
- Liveness does not return 503 during the SIGTERM drain.
