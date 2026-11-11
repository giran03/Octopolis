@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
title Octopolis - Clean

rem Usage: ".scripts\Octopolis Clean.bat" [dry] [deep] [quiet]
rem The Rust build folder is target\ at the root (Cargo workspace).
set "DRY=0"
set "DEEP=0"
set "QUIET=0"
for %%A in (%*) do (
  if /i "%%~A"=="dry" set "DRY=1"
  if /i "%%~A"=="deep" set "DEEP=1"
  if /i "%%~A"=="quiet" set "QUIET=1"
)

echo.
if "%DRY%"=="1" (echo ==== Clean ^(dry run - nothing is deleted^) ====) else (echo ==== Clean ====)
echo.

call :remove_dir "dist"                        "front-end build output"
call :remove_dir "target\debug"                "debug build cache"
call :remove_dir "target\release\incremental"  "incremental compile data"
call :remove_dir "target\release\examples"     "example binaries"
call :remove_dir "target\release\bundle"       "installer working files - finished installer kept in release\"
call :remove_dir "target\tmp"                  "temporary build files"
call :remove_dir "src-tauri\gen"               "generated Tauri schemas"

if "%DEEP%"=="1" (
  call :remove_dir "target"                    "entire Rust build folder"
  call :remove_dir "node_modules"              "front-end packages"
)

for %%F in ("*.log" "*.tmp" "src-tauri\*.log" "src-tauri\*.tmp") do (
  if exist "%%~F" (
    if "%DRY%"=="1" (echo   would delete file: %%~F) else (del /f /q "%%~F" >nul 2>&1)
  )
)

echo.
if "%DRY%"=="1" (
  echo Dry run finished. Run without "dry" to remove these.
) else (
  echo Cleanup finished.
)
if "%QUIET%"=="0" pause
exit /b 0

:remove_dir
if not exist "%~1\" exit /b 0
if "%DRY%"=="1" (
  echo   would remove: %~1  - %~2
  exit /b 0
)
echo   removing: %~1  - %~2
rd /s /q "%~1" >nul 2>&1
if exist "%~1\" echo   [warning] could not remove everything in %~1 ^(a file may be in use^)
exit /b 0
