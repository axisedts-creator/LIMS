# 2026-11-13: commit the 02-CONVENTIONS section 4.6 amendment (approved CR-C9-T15a), then restart the queue so it uses the lane cap 8 (running lanes are adopted).
git -C C:\LIMS add spec/program/02-CONVENTIONS.md
git -C C:\LIMS commit -m 'spec: 02-CONVENTIONS 4.6 errors[] also for registry codes whose meaning says so (CR-C9-T15a, founder approved)'
powershell -ExecutionPolicy Bypass -File C:\LIMS\.orchestra\relaunch.ps1
