@echo off
chcp 65001 >nul
rem Windows 一键停止：真正的实现在 scripts\stop-all.mjs。
rem 用法：stop-all.bat [--all] [--rag]
node "%~dp0scripts\stop-all.mjs" %*
exit /b %errorlevel%
