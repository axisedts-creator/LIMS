@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\LIMS\.orchestra\relaunch.ps1"
timeout /t 5 >nul
