# T0-03 dispute — licence tests vs pinned deps
Spec: spec/program/02-CONVENTIONS.md:1182 (CV §15.2) allow-list has neither `PostgreSQL` nor `BlueOak-1.0.0`.
Tests: tests/monorepo/T0-03.pins.test.mjs "every row … allowed licence" (pgTAP, pinned by SP-3) and "licence check: every installed package" (lru-cache via jsdom, pinned by T0D-12 / LD-05).
Both pins are binding; both licences are permissive OSI. Implementation cannot satisfy test without changing pin or allow-list.
Resolution needs founder ruling on CR .orchestra/cr/T0-03-licences.md (add both ids to §15.2 Allowed or Review-required, then tester updates ALLOWED).
Stopping on these two per debugger rules.
