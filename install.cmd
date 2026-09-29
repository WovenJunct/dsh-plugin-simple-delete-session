@echo off
rem ---------------------------------------------------------------------------
rem dsh-plugin-simple-delete-session — local install helper (Windows).
rem
rem   install.cmd            install into the "desktop" profile
rem   install.cmd web        install into the "web" profile
rem   install.cmd desktop C:\path\to\checkout
rem
rem It links this checkout into the chosen profile (dsh plugin add <path>), then
rem prints how to roll it back. Restart DSH afterwards; the log directory and
rem the confirmation dialog only appear once the profile has reloaded.
rem ---------------------------------------------------------------------------
setlocal

set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=desktop"

set "PLUGIN_DIR=%~2"
if "%PLUGIN_DIR%"=="" set "PLUGIN_DIR=%~dp0"
rem strip a trailing backslash so the path is spelled the same way in both uses
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo [1/2] checking syntax ^(node --check^)
node --check "%PLUGIN_DIR%\src\index.js" || goto :fail
node --check "%PLUGIN_DIR%\src\disk.js" || goto :fail
node --check "%PLUGIN_DIR%\lib\client.js" || goto :fail

echo [2/2] installing into profile "%PROFILE%"
dsh plugin --profile %PROFILE% add "%PLUGIN_DIR%" || goto :fail

echo.
echo Installed. Next steps:
echo   1. restart DSH ^(the host half registers its route at startup^);
echo   2. hard-refresh the browser ^(Ctrl+Shift+R^) so the client bundle reloads;
echo   3. open a session row's "..." menu and look for "Delete session".
echo.
echo To roll back:
echo   dsh plugin --profile %PROFILE% remove dsh-plugin-simple-delete-session
echo.
exit /b 0

:fail
echo.
echo Install failed. Make sure the "dsh" command is on PATH ^(or run
echo "dsh plugin --profile %PROFILE% add \"%PLUGIN_DIR%\"" yourself^)
echo and that Node.js is installed for the syntax check.
exit /b 1
