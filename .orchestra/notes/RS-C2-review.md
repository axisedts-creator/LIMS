APPROVE
Scope af00f00e..HEAD: rs-c2.baseline.json (one hash), __snapshots__/rs-c2.screens.test.tsx.snap (new, 5 snapshots), notes only.
- Baseline: only data_files["features/admin/auth/actions.ts"] changed. The new value a68b6952... matches sha256(LF) of auth/actions.ts at HEAD, and that file is identical to 62f59645 (T0D-DEP-02). Routes, api_paths, permission_codes and field_names were not re-recorded, as the ruling requires.
- Snapshot: kept under LD-170/LD-177. It has 5 key screens (sign-in, users, roles-edit-privileged, centres drawer, settings). The inline style attributes in it are rendered DOM from packages/ui/react-aria (visually-hidden, overlay vars), not source under task paths. Data is synthetic (example.test). No secrets, no PHI.
- No source, API, route, permission or RLS change in this range. Every path is owned or allowed (test/snapshot/notes).
- Verify (CI=true, vitest.rs-c2.config.ts): 2 files, 75/75 pass, no obsolete or missing snapshots.
