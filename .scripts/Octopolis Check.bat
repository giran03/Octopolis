@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Octopolis - Check

rem Usage: ".scripts\Octopolis Check.bat" [quiet]
rem Type-checks the UI, runs UI and Rust tests, and lints the Rust code.
set "QUIET=0"
if /i "%~1"=="quiet" set "QUIET=1"

if not exist "node_modules\" (
  echo Installing front-end packages...
  where bun >nul 2>&1 && (call bun install || goto :fail) || (call npm install || goto :fail)
)

set "RUN=npm run"
where bun >nul 2>&1 && set "RUN=bun run"

echo.
echo ==== UI type check ====
call %RUN% check || goto :fail

echo.
echo ==== UI tests ====
call %RUN% test || goto :fail

echo.
echo ==== Rust tests ====
call cargo test --workspace || goto :fail

echo.
echo ==== Rust lint ====
call cargo clippy --workspace --all-targets -- -D warnings || goto :fail

echo.
echo All checks passed.
if "%QUIET%"=="0" pause
exit /b 0

:fail
echo.
echo [error] A check failed. See the output above.
if "%QUIET%"=="0" pause
exit /b 1
