# C6-T05 impl (writer)
Files (review round): services/renderer/src/pool.ts (data: @font-face injection removed; bounded acquire → 503 'pool saturated'), Dockerfile.renderer (both FROM pinned @sha256:add5c17c… from Docker Hub registry; /app/fonts copy dropped, fontconfig only), DECISIONS.md (watermark section + per-page result, fonts bullet per 02-TRD §5.1, 503 bullet).
Spike: **Technique: thead-tfoot**; watermark = position:fixed centred rotate(-30deg), present on all 3 pages (per-page Form XObject). "Page N Of M" left to the sandbox.
[CONV] fresh context per job, ≤ N concurrent; queue wait ≤ LIMS_RENDERER_TIMEOUT_MS then 503; recycle drains pool first; crash → relaunch, in-flight → 503; RSS = cgroup memory.current; fonts via fontconfig only; blocked navigation 204; 413 > 20 MB; port 8080.
render(templateId, data, assets, pool): registry empty until T06+; unknown id → 400, template throw → 422.
Tests (round 4, after round-3 ruling; impl unchanged): vitest 49 pass / 1 skip (Devanagari embed, image-only); tsc --noEmit clean.
Open: Docker image not built/run here; RSS cap untested in a real cgroup.
