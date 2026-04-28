#!/bin/bash

# build-exe.sh - build executable and update deploy/ folder
# Mac/Linux version of build-exe.bat

echo "========================================="
echo " Building Node.js Single Executable (SEA)"
echo " and updating deploy/ folder"
echo "========================================="

npm run build:deploy
if [ $? -ne 0 ]; then
  echo "ERROR: Build failed."
  exit 1
fi

echo ""
# Detect platform to show correct filename
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
  EXE_NAME="localllm.exe"
else
  EXE_NAME="localllm"
fi

echo "Done. deploy/${EXE_NAME} is up to date."
echo "You can now run: ./deploy/install.sh"
