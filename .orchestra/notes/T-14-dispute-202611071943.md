# T-14 dispute (writer)
Test: `test_t14_probes.SandboxEnvelope.test_no_outbound_from_sandbox`, case `10.79.0.11:5432` (DATA_WG:5432).
Why wrong: the contract (module docstring) gives sandbox_envelope.sh only SANDBOX_CONTAINER, SANDBOX_PORT,
WORKER_CONTAINERS, DENY_CONTAINERS; the test's ENV has no DATA_WG_IP. The script cannot know the DB host address,
so detecting that leak needs a hard-coded IP (= gaming the test). The other three targets pass.
Writer did: sandbox_envelope.sh takes OPTIONAL `DATA_WG_IP` (probes DB host 5432/6432/22 when set);
roles/renderer_runtime/tasks/verify.yml passes it on every deploy.
Ask: add `"DATA_WG_IP": DATA_WG` to `SandboxEnvelope.ENV` (and to the contract line) — or drop that one case.
Not touched: no test file edited.
