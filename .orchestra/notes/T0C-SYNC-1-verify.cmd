@cd /d "%~dp0" || exit /b 1
cd /d "%~dp0..\..\tools\codegen" || exit /b 1
call npx vitest run __tests__/sync1-openapi.test.ts __tests__/lintfix1-openapi.test.ts || exit /b 1
cd /d "%~dp0..\..\contracts" || exit /b 1
call npx vitest run __tests__/registry-equality.test.ts || exit /b 1
cd /d "%~dp0..\.." || exit /b 1
call pnpm --dir services/api exec vitest run src/core/__tests__/sync1.pending.test.ts src/core/__tests__/health.test.ts src/modules/identity/__tests__/role-packs/admin-all-permissions.test.ts src/modules/identity/__tests__/role-packs/admin-authority.test.ts src/modules/identity/__tests__/role-packs/role-packs.data.test.ts src/modules/identity/__tests__/role-packs/role-packs.loader.test.ts || exit /b 1
"C:\Program Files\Git\bin\bash.exe" -c "bash db/tests/run-suites.sh db/tests/core/T0C-SYNC-1_sync_devices_blocks.test.sql" || exit /b 1
exit /b 0
