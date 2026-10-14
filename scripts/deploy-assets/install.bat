@echo off
setlocal enabledelayedexpansion

rem localllm インストーラ (Windows)
rem  - localllm.exe を %LOCALAPPDATA%\localllm\ にコピー
rem  - skills/ を %USERPROFILE%\.localllm\skills\ にコピー
rem  - agents/ を実行ファイル隣接の %LOCALAPPDATA%\localllm\agents\ にコピー
rem  - %LOCALAPPDATA%\localllm をユーザー PATH に追加（既にあれば何もしない）
rem    Claude Code と同様、どのフォルダのターミナルからでも localllm で起動できるようにする

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

if exist "%AGENTS_SRC%" (
  if not exist "%AGENTS_DST%" mkdir "%AGENTS_DST%"
  xcopy /E /I /Y /Q "%AGENTS_SRC%" "%AGENTS_DST%" >nul
  echo [OK] copied agents to %AGENTS_DST%
) else (
  echo [WARN] agents folder not found, sub-agents will be unavailable
)

rem ユーザー PATH への追加。%VAR% 参照を壊さないよう未展開のまま読み書きする。
rem 末尾の SetEnvironmentVariable(存在しない変数の削除) は、変更を新しいターミナルへ
rem 通知 (WM_SETTINGCHANGE) させるためだけに呼ぶ。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:INSTALL_DIR; $k=Get-Item 'HKCU:\Environment'; $p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $parts=@($p -split ';' | Where-Object { $_ -ne '' }); if ($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $d.TrimEnd('\') }) { Write-Host '[OK] PATH already contains' $d; exit 0 }; Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value (($parts + $d) -join ';') -Type ExpandString; [Environment]::SetEnvironmentVariable('LOCALLLM_PATH_NOTIFY',$null,'User'); Write-Host '[OK] added to user PATH:' $d"
if errorlevel 1 (
  echo [WARN] failed to update PATH. Add %INSTALL_DIR% to your user PATH manually.
)

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
