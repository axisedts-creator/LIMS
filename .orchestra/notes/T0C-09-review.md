APPROVE

T0C-09 review (diff bbf4579..HEAD). Checked against 02-TRD §5.3 `gen-probe-manifest` row, 06 plan row T0C-09, 08 A19.1, CR-C3-008, 07-SECURITY AB-25.
- Names verbatim: `tools/codegen/out/probe-manifest.json` (gitignored), `// @probe <operationId>`, `__tests__/probes/pending.json`, `/v1/instruments/agent/`, `queueDisplayToken`/`getQueueBoard` exemption from the deviceToken part only, 401/403. Nothing invented beyond the [CONV] field names noted in impl notes.
- Manifest: operationId + path params + body id fields + bulk-id arrays (ref-resolved). Gate 10 exits 1 on any uncovered op; pending skip works; malformed pending.json fails closed (exit 2).
- Owned paths only (tools/codegen, .gitignore, notes). No secrets, no PHI, no DB/RLS surface in this task.
- Tests: probe-manifest 20/20 pass (ran `npx vitest run __tests__/probe-manifest.test.ts`). Cover done_when: uncovered op fails, A19.1 boundary incl. lookalike prefix + getQueueBoard, pending skip.

Non-blocking notes (not defects against the spec text):
1. pending.json and @probe tags are pooled across all owners; TRD says "the owner's" pending.json. Low risk; tighten if cross-chunk masking appears.
2. A19.1 is emitted as a `deviceBoundary` descriptor in the manifest; the runner that actually calls each op with device/staff_mobile creds is not in this task (needs the API + fixture actors). Track for the probe-runner owner.
3. Public ops (`security: []`, e.g. getLiveness/getReadiness) get `deviceBoundary.applies=true` expecting 401/403; spec is literal ("every non-agent route") but this will be wrong for public endpoints — CR candidate.
4. Real repo `--check` currently fails (getLiveness, getReadiness unprobed) — must be resolved before wiring gate 10 into CI.
5. `--root` with no value throws instead of a usage error (cosmetic).
