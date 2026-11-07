APPROVE
# T-23 review round 2 (reviewer): diff a8f04b0..HEAD

Round-1 #1 fixed. registry-gc.sh.j2 now skips tags whose `current/link` digest is in `registry_pinned_digests`, and keep-N counts unpinned tags only. server.yml builds that list from `registry_releases_dir/*.lock.yaml` (= infra/releases, the same dir release-lock.sh writes to). RegistryGcPinnedTest renders the script and runs it on a fake tree of 25 tags with a fake docker: the pinned oldest tag survives, 20 unpinned remain, and garbage-collect still runs.
What I ran: test_t23 43/43 OK. yamllint on roles/registry clean.
Not run: live GC, pull, or egress probe; ansible-lint (CI only).
Rest of round 1 unchanged: names verbatim, no secrets or PHI, only owned paths. RLS, permissions and error codes do not apply (infra).
Residual (not blocking): the pin list is captured only when the play runs, so re-run the play after each lock change (documented). A pinned digest whose tag was re-pushed still gets GC'd (ponytail note; mirror tags are digest-derived).
Lead note from round 1 still stands: no plan row builds the ops Squid (`ops_proxy`), so pulls on ops-1 break after the docker proxy drop-in until it exists.
