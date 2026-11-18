T0D-UICONSOLE-1 impl (writer, partial). Files: lab/components/CriticalValueList.tsx, IngestExceptionList.tsx, LabError.tsx (optional pageTitle), new consoleParts.tsx; app/(staff)/lab/critical-values/{page,error}.tsx, ingest-exceptions/{page,error}.tsx.
[CONV] console item = the table row (tr tabIndex 0, data-console-item, aria-selected + data-selected for kit .lims-row highlight); click / Enter selects, SplitConsole moves j / k; key O opens the selected record (label "(O)").
[CONV] first_confirmed_notification_at typed in the component (features/lab/server pinned by rs-c5.static); no new CSS, no kit change, no route / API change.
Run 11:30 after ruling (maxWorkers=1): uiconsole1.lab green; 2 fail = old pinned adminpage-lab-1 / c5-t23 tests, see dispute.md (tester update pending). tsc: no error in touched files (339 pre-existing elsewhere).
Pre-existing reds, not this task: rs-c5.static (server 11 vs 10 files, routes 18 vs 16), rs-c5 worklist snapshot, emptytbl1 (lab/components/shared.tsx, worklist, pending).
Open: payments review / refunds / inventory unresolved wait for tester tests (dispute item 3); main merge and rerun not done; rs-cN snapshots of these two screens: none exist.
