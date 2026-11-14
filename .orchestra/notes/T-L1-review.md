APPROVE
Range 9469446f..HEAD: test-only change (t-l1.app-access.test.tsx) plus notes; no implementation files touched.
- Matches arbiter ruling (T-L1-ruling.md) points 1-4 exactly: LAB='Demo Lab Kathmandu' (no word shared with patient name); checkbox ticked in all 4 Issue paths (:135, :150, :184, issueOnce :211) + new unticked-checkbox test; print test asserts PrintFrame iframe inserted (it mounts only when isOpen, PrintFrame.tsx:57-67) and main window.print not called; /paused/i matches LINK_STATUS suspended→'Paused' (AppAccess.tsx:58).
- No names invented, no PHI/secrets, synthetic data only, owned paths only (apps/web/src/features/engagement/__tests__).
- Ran T-L1-verify.cmd: API link.handlers 41/41 pass; web vitest.t-l1 2 files 35/35 pass (jsdom "Not implemented: print()" notice comes from the iframe contentWindow, expected).
