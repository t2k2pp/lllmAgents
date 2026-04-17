@echo off
rem sandbox から deploy/ 配布版を起動するラッパー
rem 設計書: docs/workspace-separation.md
setlocal
set "SANDBOX_DIR=%~dp0"
set "DEPLOY_DIR=%SANDBOX_DIR%..\deploy"
if not exist "%DEPLOY_DIR%\index.js" (
  echo [sandbox] deploy/index.js not found. Run: npm run sync:deploy
  exit /b 1
)
node "%DEPLOY_DIR%\index.js" %*
