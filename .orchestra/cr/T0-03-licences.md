```
Title: CR-C0-<nnn>: T0-03 — CV §15.2 allow-list lacks PostgreSQL License and BlueOak-1.0.0
From chunk: C0 (T0-03, lane C0-0A)      To owner: doc owner (founder) / C0-0A
Type: shared-lib
Blocking? yes — T0-03: 2 of 25 tests in tests/monorepo/T0-03.pins.test.mjs fail on licence ids absent from CV §15.2.
Problem:
  1. pgTAP 1.3.3 (pinned by SP-3; test/CI databases only) is under the PostgreSQL License. CV §15.2 (02-CONVENTIONS.md:1182)
     lists neither it nor a "test-only tooling" scope, so the table row fails the allowed/review check.
  2. lru-cache 11.5.3 (transitive via jsdom 31.0.0, a T0D-12 devDependency) is BlueOak-1.0.0. Not in §15.2;
     installed-tree licence check fails.
  Both are OSI-approved permissive licences; neither is copyleft or banned by §15.2.
Proposed change (exact): add to CV §15.2 "Allowed": `PostgreSQL` (SPDX, permissive), `BlueOak-1.0.0` (SPDX, permissive).
  Tester then adds both ids to ALLOWED in tests/monorepo/T0-03.pins.test.mjs (line 22).
  Alternative minimal: put both in "Review required (C0 + founder)" and record the review in db/meta/decisions/T0-03-dependencies.md.
Backward compatible? yes (widens allow-list by two permissive ids).
Tenant/security impact: none (no RLS, PHI or public surface; pgTAP never ships, lru-cache dev/test only).
IRD/regulatory impact: n/a
Alternatives considered: replace pgTAP (rejected: SP-3 decision); replace jsdom (rejected: T0D-12 pin, happy-dom has
  its own transitive tree); test-side exemption without spec change (rejected: writer may not edit tests or spec).
Tests that will prove it: tests/monorepo/T0-03.pins.test.mjs "every row ... allowed licence" and "licence check: every installed package".
```
