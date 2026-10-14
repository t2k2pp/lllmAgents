@echo off
setlocal

rem localllm installer (Windows)
rem  - copy localllm.exe to %LOCALAPPDATA%\localllm\
rem  - copy skills/ to %USERPROFILE%\.localllm\skills\
rem  - copy agents/ next to the exe: %LOCALAPPDATA%\localllm\agents\
rem  - add %LOCALAPPDATA%\localllm to the user PATH (no-op if already present)
rem    so that `localllm` starts from any folder, like Claude Code.
rem
rem Keep this file ASCII-only with CRLF line endings: cmd.exe mis-parses
rem LF or multibyte (UTF-8) lines and silently runs fragments of them.

set "SRC_DIR=%~dp0"
set "INSTALL_DIR=%LOCALAPPDATA%\localllm"
set "SKILLS_SRC=%SRC_DIR%skills"
set "SKILLS_DST=%USERPROFILE%\.localllm\skills"
set "AGENTS_SRC=%SRC_DIR%agents"
set "AGENTS_DST=%INSTALL_DIR%\agents"

echo =========================================
echo  localllm installer
echo =========================================
echo Install dir: %INSTALL_DIR%
echo Skills dir : %SKILLS_DST%
echo Agents dir : %AGENTS_DST%
echo.

if not exist "%SRC_DIR%localllm.exe" (
  echo [ERROR] localllm.exe not found in %SRC_DIR%
  exit /b 1
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%SRC_DIR%localllm.exe" "%INSTALL_DIR%\localllm.exe" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy localllm.exe. Close any running localllm and retry.
  exit /b 1
)
echo [OK] copied localllm.exe

if exist "%SKILLS_SRC%" (
  if not exist "%USERPROFILE%\.localllm" mkdir "%USERPROFILE%\.localllm"
  if not exist "%SKILLS_DST%" mkdir "%SKILLS_DST%"
  xcopy /E /I /Y /Q "%SKILLS_SRC%" "%SKILLS_DST%" >nul
  echo [OK] copied skills to %SKILLS_DST%
) else (
  echo [WARN] skills folder not found, skipped
)

if exist "%AGENTS_SRC%" (
  if not exist "%AGENTS_DST%" mkdir "%AGENTS_DST%"
  xcopy /E /I /Y /Q "%AGENTS_SRC%" "%AGENTS_DST%" >nul
  echo [OK] copied agents to %AGENTS_DST%
) else (
  echo [WARN] agents folder not found, sub-agents will be unavailable
)

rem Add to the user PATH. Read and write the raw (unexpanded) value so that
rem existing %VAR% entries survive.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:INSTALL_DIR; if (-not $d) { Write-Host '[ERROR] INSTALL_DIR is empty'; exit 1 }; $k=Get-Item 'HKCU:\Environment'; $p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $parts=@($p -split ';' | Where-Object { $_ -ne '' }); if ($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $d.TrimEnd('\') }) { Write-Host '[OK] PATH already contains' $d; exit 0 }; Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value (($parts + $d) -join ';') -Type ExpandString; Write-Host '[OK] added to user PATH:' $d"
if errorlevel 1 (
  echo [WARN] failed to update PATH. Add %INSTALL_DIR% to your user PATH manually.
)

rem Writing the registry alone does not notify anyone. setx always broadcasts
rem WM_SETTINGCHANGE, so Explorer and terminals started from it afterwards see
rem the new PATH without a sign-out. It also records the install location.
setx LOCALLLM_INSTALL_DIR "%INSTALL_DIR%" >nul

echo.
echo =========================================
echo  Done
echo =========================================
echo Open a NEW terminal and run: localllm --setup
echo.
echo NOTE: localllm.exe is not code-signed. On first run Windows
echo SmartScreen may show "Windows protected your PC".
echo Click "More info" then "Run anyway" to start.
echo =========================================
endlocal
