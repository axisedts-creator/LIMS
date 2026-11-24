@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\LIMS\.orchestra\start-lanes.ps1"
timeout /t 10 >nul
