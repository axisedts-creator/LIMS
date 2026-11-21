APPROVE
Range 8e6767ebc..HEAD: test fixture + notes only.
- verlevel1.settings.test.tsx:65-66 adds unrecorded GET /v1/lab/settings mock; route and operation match contracts/openapi/lab.yaml getLabSettings; body valid against LabSettingsDto (all 11 required fields, label 20x10, copies 1, renderer html_svg, history_days 30, all at schema minimums). No assertion changed; calls/ops counts unaffected. Matches the ruling.
- Owned path (features/lab test); nothing under admin/platform/(auth)/(platform); synthetic data, no PHI, no secrets; no names invented.
- Reran 2026-11-20: verlevel1 config 67/67, offline1 config 82/82, rs-c2 74/74.
