# T-05 impl (writer) — DONE, 41/41 static tests pass (after tester fix per LD-42)
- Files: infra/compose/supabase/{upstream/** (vendored byte-for-byte @189adda99d1b56da55fc5a6ee3f849354aaea92a via curl, LD-33), upstream/UPSTREAM.lock, override.data.yml, override.app.yml, envoy/{lds.template.yaml,cds.yaml} (trimmed), DECISION.md}; .gitattributes `-text` for upstream/**.
- [CONV] Decision: split (DECISION.md). Storage depends_on uses `!override` (TRD's `!reset {..}` clears the value; spike finding).
- [CONV] UPSTREAM.lock = single digest source (repo, commit, files sha256, images digest); rendered images pinned `<image>@<digest>`.
- Run: `python -B -m unittest discover -s infra/tests/static -p "test_t05_*.py"` -> Ran 41, OK. No impl change this round; vendored files unchanged.
- Open: live checks (GoTrue healthy, egress_probe auth, Storage upload/download from app_net, no gateway port) = infra/tests/integration/test_t05_live.py with LIMS_T05_LIVE=1 on VMs/CI; NOT run here.
