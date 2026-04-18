@echo off
rem sandbox から deploy/localllm.exe を起動するラッパー
rem 設計書: docs/workspace-separation.md
setlocal
set "SANDBOX_DIR=%~dp0"
set "EXE=%SANDBOX_DIR%..\deploy\localllm.exe"
if not exist "%EXE%" (
  echo [sandbox] localllm.exe not found. Run: npm run build:deploy
  exit /b 1
)
"%EXE%" %*
