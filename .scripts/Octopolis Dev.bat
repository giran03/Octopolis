@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Octopolis - Dev Mode

rem Usage: ".scripts\Octopolis Dev.bat" [quiet]
set "QUIET=0"
if /i "%~1"=="quiet" set "QUIET=1"

where cargo >nul 2>&1
if errorlevel 1 (
  echo [error] Rust ^(cargo^) was not found in PATH. Install from https://rustup.rs
  goto :fail
)

if not exist "node_modules\" (
  echo Installing front-end packages...
  where bun >nul 2>&1 && (call bun install || goto :fail) || (call npm install || goto :fail)
)

where bun >nul 2>&1
if not errorlevel 1 (
  echo [info] Starting Octopolis dev with Bun...
  call bun run tauri dev
  goto :done
)

echo [info] Starting Octopolis dev with npm...
call npm run tauri dev

:done
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [error] Dev process exited with an error.
if "%QUIET%"=="0" pause
exit /b 1
