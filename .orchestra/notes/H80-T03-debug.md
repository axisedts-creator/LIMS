# H80-T03 debug
- Cause: not implementation. Tester commit cd49d38e moved goldens path in test (fixture() reads drivers/truth_h80e/testdata/*.hl7) but never added the 8 .hl7 files there; old dir deleted. 25/34 fail ENOENT.
- Fix: none by debugger (goldens = test assets, off-limits). Existing H80-T03-dispute.md stands: tester must restore from cd49d38e~1 into testdata/ and update SOURCE.md. Stopped.
