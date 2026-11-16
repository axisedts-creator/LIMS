@echo off
cd /d "%~dp0..\.."
call pnpm -s turbo run typecheck --continue > "%~dp0vg-typecheck.log" 2>&1
findstr /C:"TS2835" /C:"TS2883" /C:"TS2430" "%~dp0vg-typecheck.log" >nul && (echo named error classes remain & exit /b 1)
call pnpm --dir packages/shared-ts exec tsc -p . --noEmit || exit /b 1
node --test "packages/shared-ts/test/*.test.mjs" || exit /b 1
call pnpm --dir services/api exec vitest run src/modules/identity/handlers src/modules/identity/service || exit /b 1
exit /b 0
