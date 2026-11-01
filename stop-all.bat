@echo off
chcp 65001 >nul
rem Windows full-stack stop; implementation lives in scripts\stop-all.mjs.
rem Usage: stop-all.bat [--all] [--rag]
node "%~dp0scripts\stop-all.mjs" %*
exit /b %errorlevel%
