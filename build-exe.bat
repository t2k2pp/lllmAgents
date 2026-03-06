@echo off
setlocal

echo =========================================
echo Building Node.js Single Executable (SEA)
echo =========================================

set "DIST_DIR=dist"
set "APP_NAME=localllm"
set "EXE_NAME=%APP_NAME%.exe"
set "ENTRY_FILE=src\index.ts"
set "CJS_BUNDLE=%DIST_DIR%\%APP_NAME%.cjs"
set "SEA_CONFIG=%DIST_DIR%\sea-config.json"
set "SEA_BLOB=%DIST_DIR%\sea-prep.blob"

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

echo.
echo [1/5] Bundling application with esbuild...
call npx esbuild "%ENTRY_FILE%" --bundle --platform=node --format=cjs --outfile="%CJS_BUNDLE%"
if errorlevel 1 (
  echo ERROR: esbuild failed!
  exit /b 1
)

echo.
echo [2/5] Creating SEA configuration file...
node -e "require('fs').writeFileSync('%SEA_CONFIG:\=\\%', JSON.stringify({ main: '%CJS_BUNDLE:\=\\%', output: '%SEA_BLOB:\=\\%', disableExperimentalSEAWarning: true }));"

echo.
echo [3/5] Generating Node.js SEA blob...
node --experimental-sea-config "%SEA_CONFIG%"
if errorlevel 1 (
  echo ERROR: Generating blob failed!
  exit /b 1
)

echo.
echo [4/5] Copying node executable...
node -e "require('fs').copyFileSync(process.execPath, '%DIST_DIR:\=\\%\\\\%EXE_NAME%')"
if errorlevel 1 (
  echo ERROR: Copying node executable failed!
  exit /b 1
)

echo.
echo [5/5] Injecting blob into executable with postject...
set "FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
call npx postject "%DIST_DIR%\%EXE_NAME%" NODE_SEA_BLOB "%SEA_BLOB%" --sentinel-fuse "%FUSE%" --macho-segment-name NODE_SEA
if errorlevel 1 (
  echo ERROR: postject failed!
  exit /b 1
)

echo.
echo SUCCESS! Executable created at: %DIST_DIR%\%EXE_NAME%
echo.
endlocal
