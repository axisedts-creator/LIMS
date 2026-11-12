Title: CR-C17-016: root pubspec.yaml needs `hooks: user_defines: sqlite3: source: sqlcipher`
From chunk: C17            To owner: C0-0A
Type: shared-lib
Blocking? yes (HC-T22: cache.db/outbox.db are plaintext SQLite without the hook; 10 of 41 HC-T22 tests fail, incl. the REQ-SEC-103 header forensic test)
Problem: package:sqlite3 build hooks read `hooks.user_defines` only from the pub WORKSPACE ROOT pubspec. The copy in apps/phlebo_app/pubspec.yaml is inert, so `PRAGMA key` is silently ignored and files are plaintext (REQ-SEC-103, US-13-3).
Proposed change (exact): append to /pubspec.yaml:
  hooks:
    user_defines:
      sqlite3:
        source: sqlcipher
Backward compatible? yes — packages/shared-dart and packages/ui-flutter do not use package:sqlite3.
Tenant/security impact: none beyond enforcing REQ-SEC-103; no new PHI field.
Alternatives considered: sqlite3mc (TRD §2 allows; C0 picks one — sqlcipher chosen [CONV]); app-level hook (inert in a workspace).
Tests that will prove it: apps/phlebo_app/__tests__/db_forensics_test.dart, db_wipe_test.dart, db_ci_guards_test.dart (all 41 pass with this one change; verified by temporarily applying it, then reverted).
