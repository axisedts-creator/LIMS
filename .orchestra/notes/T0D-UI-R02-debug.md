# T0D-UI-R02 debug
Cause: only failure = "no font CDN..." test hit the 5000ms default timeout (5.5s). Not an assertion failure and not impl-related: the test is a sync walk+read of ~950 source files (no font files read). Reproduced slow (6.3s) once right after, then 224ms; plain node does same work in ~13ms. Transient FS stall (cold cache / AV scan / parallel load on Windows).
Fix: none in impl code (nothing to change; fonts are .woff2, never read by that test). Re-ran full fonts dir: 27/27 pass. No test edited.
Recommend: tester add an explicit timeout (e.g. 30000) to that `it` if the flake repeats in verify.
