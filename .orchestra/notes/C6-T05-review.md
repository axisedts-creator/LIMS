APPROVE
Scope: git diff ba4ec31..HEAD — only services/renderer/src/__tests__/pool.test.ts (saturation test) and .orchestra/notes; no implementation, DDL, routes, permissions, logs or secrets touched.
Test change matches round-3 ruling items 3–4 exactly: waiter resolves with WAIT-P1 text or rejects 503/408; <4000 ms bound, `await long`, contextsBusy === 0 and NEXT no-leak render kept; title renamed. Status 503 is verbatim from 02-TRD.md:440.
Checks run: vitest 49 pass / 1 skip (Devanagari embed, image-only per round-2 ruling); tsc --noEmit clean.
Not verified: Docker image build/run (Devanagari embed + cgroup RSS cap), as stated in C6-T05-impl.md.
