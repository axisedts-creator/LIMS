# T0B-GREEN-3 dispute (debugger, 2026-11-18)
Tests older than approved migration 20261117130000_engagement__add_portal_content.sql (T0C-CONTENT-1; tables portal_content, profile_image; 2 audit triggers, 1 extra index, composite FKs to identity.branding_assets). Code is right; tests are STALE. Debugger may not edit tests.
- db/tests/engagement/T0B-13.C16_schema.test.sql: assertions 1, 2 (43 -> 45 tables, add portal_content, profile_image), 520 (51 -> 52 indexes), 642 (24 -> 26 audit triggers), 698 (FK target schemas now include identity).
- db/tests/engagement/T-SEC1_table_probes: assertions 1, 3 (43 -> 45 tables; probe fixture db/tests/fixtures/probe-rows/engagement.sql is harness-owned: needs rows for the 2 tables via CR).
Tester must update the expectations, citing 20261117130000, and keep each proving its property.
