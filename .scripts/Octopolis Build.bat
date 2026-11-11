@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Octopolis - Build Installer

rem Usage: ".scripts\Octopolis Build.bat" [noclean] [quiet]
set "DO_CLEAN=1"
set "QUIET=0"
for %%A in (%*) do (
  if /i "%%~A"=="noclean" set "DO_CLEAN=0"
  if /i "%%~A"=="quiet" set "QUIET=1"
)

echo.
echo ==== Building Octopolis NSIS Installer ====
echo.

where cargo >nul 2>&1
if errorlevel 1 (
  echo [error] Rust ^(cargo^) was not found. Install it from https://rustup.rs and try again.
  goto :fail
)

if not exist "node_modules\" (
  echo Installing front-end packages...
  where bun >nul 2>&1 && (call bun install || goto :fail) || (call npm install || goto :fail)
)

echo Building the app and compressed NSIS installer...
where bun >nul 2>&1
if not errorlevel 1 (
  call bun run tauri build
) else (
  call npm run tauri build
)
if errorlevel 1 goto :fail

rem Cargo workspace: bundles land in the root target\ folder.
set "BUNDLE=target\release\bundle\nsis"
set "SETUP="
for /f "delims=" %%F in ('dir /b /o-d "%BUNDLE%\*-setup.exe" 2^>nul') do (
  if not defined SETUP set "SETUP=%%F"
)
if not defined SETUP (
  echo [error] Build finished but no NSIS installer was found in %BUNDLE%.
  goto :fail
)

if not exist "release\" mkdir "release"
copy /y "%BUNDLE%\%SETUP%" "release\%SETUP%" >nul
if errorlevel 1 (
  echo [error] Could not copy the installer to release\.
  goto :fail
)

for %%A in ("release\%SETUP%") do set "SIZE=%%~zA"
set /a SIZE_MB=%SIZE% / 1048576
echo.
echo Installer ready: release\%SETUP%  ^(about %SIZE_MB% MB^)

if "%DO_CLEAN%"=="1" (
  echo.
  echo Cleaning temporary build files...
  call "%~dp0Octopolis Clean.bat" quiet
)

echo.
echo Done.
if "%QUIET%"=="0" pause
exit /b 0

:fail
echo.
echo Build FAILED. Nothing was cleaned up, so you can inspect the output above.
if "%QUIET%"=="0" pause
exit /b 1
