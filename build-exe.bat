@echo off
setlocal

rem build-exe.bat — exeビルド + 配布フォルダ更新までを一括で行う
rem
rem 旧版は `node build-exe.js` のみで dist/localllm.exe しか更新せず、
rem deploy/localllm.exe や sandbox/run.bat 経由の起動が古いまま、という罠だった。
rem 現在は `npm run build:deploy` に統一し、内部で build-exe.js を呼んでから
rem deploy/ まで同期する。

echo =========================================
echo Building Node.js Single Executable (SEA)
echo and updating deploy/ folder
echo =========================================

call npm run build:deploy
if errorlevel 1 (
  echo ERROR: Build failed.
  exit /b 1
)
echo.
echo Done. deploy/localllm.exe is up to date.
echo You can now run: sandbox\run.bat   or   deploy\install.bat
endlocal
