@echo off
setlocal

rem build-exe.bat - build exe and update deploy/ folder
rem
rem The legacy version only ran `node build-exe.js` which updated dist/localllm.exe
rem but left deploy/localllm.exe stale - a silent footgun. This now calls
rem `npm run build:deploy` which builds the exe AND syncs deploy/ assets.

echo =========================================
echo  Building Node.js Single Executable (SEA)
echo  and updating deploy/ folder
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
