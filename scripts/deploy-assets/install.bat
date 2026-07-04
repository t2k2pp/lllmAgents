@echo off
setlocal enabledelayedexpansion

rem localllm インストーラ (Windows)
rem  - localllm.exe を %LOCALAPPDATA%\localllm\ にコピー
rem  - skills/ を %USERPROFILE%\.localllm\skills\ にコピー
rem  - PATH 追加は手順表示のみ（自動で環境変数に触らない）

set "SRC_DIR=%~dp0"
set "INSTALL_DIR=%LOCALAPPDATA%\localllm"
set "SKILLS_SRC=%SRC_DIR%skills"
set "SKILLS_DST=%USERPROFILE%\.localllm\skills"

echo =========================================
echo  localllm installer
echo =========================================
echo Install dir: %INSTALL_DIR%
echo Skills dir : %SKILLS_DST%
echo.

if not exist "%SRC_DIR%localllm.exe" (
  echo [ERROR] localllm.exe not found in %SRC_DIR%
  exit /b 1
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%SRC_DIR%localllm.exe" "%INSTALL_DIR%\localllm.exe" >nul
if errorlevel 1 (
  echo [ERROR] failed to copy localllm.exe
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

echo.
echo =========================================
echo  Next step: add to PATH
echo =========================================
echo Run this in an Admin PowerShell to add the install dir to user PATH:
echo.
echo   [Environment]::SetEnvironmentVariable(
echo     'Path',
echo     [Environment]::GetEnvironmentVariable('Path','User') + ';%INSTALL_DIR%',
echo     'User')
echo.
echo Or add manually: Control Panel -^> User Accounts -^> Change env variables
echo.
echo Then restart your terminal and run: localllm --setup
echo.
echo NOTE: localllm.exe is not code-signed. On first run Windows
echo SmartScreen may show "Windows protected your PC".
echo Click "More info" then "Run anyway" to start.
echo =========================================
endlocal
