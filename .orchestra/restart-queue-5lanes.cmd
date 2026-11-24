@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\LIMS\.orchestra\restart-queue-after-memory-fix.ps1" -Lanes 5
pause
