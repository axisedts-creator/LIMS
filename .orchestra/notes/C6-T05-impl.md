# C6-T05 impl (writer)
Files: services/renderer/{package.json, tsconfig.json, DECISIONS.md, Dockerfile.renderer, fonts/ (Noto Sans R/B, Noto Sans Devanagari R/B, Noto Sans Mono R + OFL.txt), src/{pool,guard,render,server}.ts}; pnpm-lock.yaml (playwright 1.65.0, prom-client 15.1.3 added for @lims/renderer).
Spike: **Technique: thead-tfoot** (page.pdf templates rejected: separate doc without page CSS/fonts; fixed-position lost hdr/ftr on p1/p3). "Page N Of M" left to the sandbox.
[CONV] fresh context per job, ≤ N concurrent; recycle drains pool first; crash → relaunch on next job, in-flight → 503; RSS = cgroup memory.current (fallback node RSS); fonts injected as data: @font-face + fontconfig in image; blocked navigation answered 204; file: counted from Chromium console refusal; 413 for > 20 MB; port 8080 fixed (spec names no key).
render(templateId, data, assets, pool): registry empty until T06+; unknown id → 400, template throw → 422.
Tests: 33/47 with shipped helper; 14 fail only in PDF text extraction → see C6-T05-dispute.md. With corrected helper 47/47. tsc clean.
Open: Docker image not built/run here (node:26.13.0-bookworm-slim tag unverified); RSS cap untested inside a real cgroup; 503 saturation (queue) not implemented — callers wait.
