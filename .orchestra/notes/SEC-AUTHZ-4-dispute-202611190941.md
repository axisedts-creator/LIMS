# SEC-AUTHZ-4 dispute (debugger): stale tester-owned snapshot
Test: tests/security/authz-identity.test.mjs (3 snapshot cases) and tests/security/authz-classification.test.mjs fail on tests/security/authz-classification.json.
Spec: task brief done_when "the unguarded count of module identity is 0 in the regenerated snapshot"; "the TESTER regenerates it with the classifier after the code exists and the lane commits it (the writer and debugger cannot keep a change to it)".
Fact: committed snapshot total 1018 / unguarded 207; fresh run total 1177 / unguarded 176, identity 0. Snapshot was not regenerated after the code.
Needed: tester regenerates the snapshot (node tests/security/classify-authz.mjs), lane commits it. No implementation change possible or needed.
