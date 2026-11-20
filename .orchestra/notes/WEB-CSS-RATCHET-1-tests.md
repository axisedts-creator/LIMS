# WEB-CSS-RATCHET-1 tests (LD-241)
Files: tests/web/css-class-ratchet.test.mjs (13 tests), tests/web/css-class-scan.mjs (scanner helper), tests/web/css-class-baseline.json (known violations). Fixtures are built in os.tmpdir at run time.
Run: `node --test tests/web/css-class-ratchet.test.mjs` (or .orchestra/notes/WEB-CSS-RATCHET-1-verify.cmd). No component, stylesheet or other file touched.
Proves: fails on a new undefined class, on a stale baseline entry, per-app baselines, scope (same app + packages/ui css, .module.css, inline <style>; __tests__ ignored), seven lims-platform-* in apps/web baseline.
Baseline count per app (undefined / used): apps/web 79/218, apps/portal 1/5, apps/partner 5/15, packages/ui 71/245. Total 156.
Test-only task: the real-repo test passes now because the baseline records today's violations; it goes red when a class is added or fixed without updating the baseline.
Limits (ponytail): regex scan, dynamic `lims-x-${v}` and className={variable} not seen; a `.lims-x` in any file with an inline <style> counts as defined.
