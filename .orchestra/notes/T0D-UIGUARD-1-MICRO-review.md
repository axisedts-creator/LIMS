APPROVE

Reviewed `git diff d12dbe5c4..HEAD` (23 files, display only).
- Rule 7: no raw h1-h4/ul/ol left under features/micro or app/(staff)/micro. MICRO legacy block removed from uiguard1.exceptions.ts (tester) and notes/T0D-UIGUARD-1-exceptions.md (writer); nothing re-added (LD-439, LD-441).
- MicroForbidden: PageHeader title, helpKey now required; all 6 callers pass one. Settings tabs on Card title rows + DataTable; drawer titles via kit DrawerSection; lists via Stack role=list.
- Kit change: Stack role/aria-label is additive and spreads through ...rest (LD-441). tokens.json, kit.css, shell.css and the pinned paths are untouched.
- No route, permission, API, contract, operation or error-code change. No PHI, logs or secrets. t19 change follows the arbiter TESTS_WRONG ruling (LD-353 in-page ErrorState).
- Re-ran here: uiguard1 36/36, micro t19 134/134, t20 188/188, t26 32/32. I did not re-run t21-t24 (writer reports them green). eslint is still not runnable (writer note).
