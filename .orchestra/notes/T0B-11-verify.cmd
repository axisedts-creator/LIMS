cd /d "%~dp0..\.." && node --test tests/db/T0B-11.billing-export.test.mjs && call db\tests\billing_isolatable\run-live.cmd
