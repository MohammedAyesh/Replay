@echo off
REM Double-click to start the analysis worker. Leave the window open.
REM
REM Reads REPLAY_API_BASE and ANALYSIS_WORKER_KEY from your user environment.
REM Set them once, in PowerShell, then open a new window:
REM
REM   [Environment]::SetEnvironmentVariable('REPLAY_API_BASE','https://replayjo.com','User')
REM   [Environment]::SetEnvironmentVariable('ANALYSIS_WORKER_KEY',(Read-Host 'key'),'User')
REM
REM Read-Host keeps the key out of your command history.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0analysis-worker.ps1"
pause
