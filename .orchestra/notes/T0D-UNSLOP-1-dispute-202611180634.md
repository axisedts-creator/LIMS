# T0D-UNSLOP-1 dispute (writer, LD-360 ruling 2)
rs-c8.screens.admin.test.tsx.snap "New schedule form": the -u diff shows the removed Scheduled reports > New crumb AND `<form ... class="lims-form" data-label-placement="above">`. That attribute is not on the LD-360 allow-list (crumb, lims-align-end, title, dashboard row). Origin: packages/ui Form.tsx from T0D-DENSITY-1 (a2a2474f7), not this task; the committed snap was simply stale against it.
Per LD-360 ("if any diff shows anything else, stop") this .snap is NOT committed; working copy equals HEAD. rs-c8 is 35/36 with it (36/36 with the regen).
Ask: lead allows the data-label-placement line in this snap; then the writer runs `vitest run -c src/features/analytics/__tests__/vitest.rs-c8.config.ts -u rs-c8.screens.admin` and commits it.
Committed (diffs clean): rs-c4.screens (credit party crumb), rs-c6.screens (3 outline crumbs), rs-c7.screens (3 crumbs), rs-c8.screens (dashboard row, money line, pipeline counts).
Not snapshot, seen in the same runs, not touched: rs-c4.static x5 + rs-c4.register x1, rs-c7.static x1 (permission/byte baselines; REGSCREEN-2 / earlier tasks).
