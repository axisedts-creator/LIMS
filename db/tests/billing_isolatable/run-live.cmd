@echo off
rem LD-51 (2026-11-07) T0B-11: live proof of AC-0B-6.4, run by the orchestra harness only.
setlocal
cd /d "%~dp0..\..\.."
set "PATH=%CD%\db\tests\billing_isolatable\live\bin;%PATH%"
set "NODE_OPTIONS=--import=./db/tests/billing_isolatable/live/shim.mjs"
"C:\Program Files\Git\bin\bash.exe" db/tests/billing_isolatable/T0B-11_billing_isolatable.sh
exit /b %ERRORLEVEL%
