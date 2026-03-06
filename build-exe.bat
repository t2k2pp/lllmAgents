@echo off
setlocal

echo =========================================
echo Building Node.js Single Executable (SEA)
echo =========================================

node build-exe.js
if errorlevel 1 (
  echo ERROR: Build failed.
  exit /b 1
)
echo.
endlocal
