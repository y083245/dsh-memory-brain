@echo off
chcp 65001 >nul
rem Windows full-stack start; implementation lives in scripts\start-all.mjs.
rem start.bat (bridge guard) is intentionally left unchanged.
node "%~dp0scripts\start-all.mjs" %*
exit /b %errorlevel%
