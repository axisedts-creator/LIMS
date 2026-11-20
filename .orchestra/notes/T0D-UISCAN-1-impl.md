# T0D-UISCAN-1 impl (writer)
Files: lab ReceiveScreen, CollectDispatch; anatomic tracking/TrackingScreen; homecollection HandoverDrawer; inventory CountEntry, GrnEditor, PoShared; rs-c5.screens snapshot (receive + collect only, LD-362).
[CONV] lab screens and PoShared write the kit ScanPanel markup (.lims-scan-panel/-input/-result/-queue) around the kit <BarcodeInput> instead of importing ScanPanel: lab-t11.static and t22.source pin `<BarcodeInput` in those files. Tracking, handover, count entry use ScanPanel.
[CONV] Receive pills = kit FilterBar multi-select chips driven as single choice (no single-select chip kind in the kit).
Handover: the "not in this handover" text now lives only in the result card (hc-t20 wants one element).
Green: uiscan1 32/32, lab-t11 73/74, rs-c5 22/27 after snapshot regen, anatomic t20 191, hc-t20 148, inventory t21/t22/t23, web-style-3 101, elabmenu 99.
Pre-existing reds, not this task: lab-t11.static innerHTML (LabelPage.tsx), rs-c5.static x2 (server baseline, routes), rs-c5 worklist snapshot (other task's header markup), shell motion timing (r04.source, m2.source).
Open: partners manifest receive and micro scan screens still use bare BarcodeInput (later task).
