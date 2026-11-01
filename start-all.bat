@echo off
chcp 65001 >nul
rem Windows 一键启动：真正的实现在 scripts\start-all.mjs。
rem 旧的 start.bat（桥接守护）保持原样，不在这里改动。
node "%~dp0scripts\start-all.mjs" %*
exit /b %errorlevel%
