@echo off
REM Double-click this to start the analysis worker. Leave the window open.
REM Put ANALYSIS_WORKER_KEY and the app URL in the two lines below.
set APIBASE=https://REPLACE-ME
set WORKERKEY=REPLACE-ME
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0analysis-worker.ps1" -ApiBase "%APIBASE%" -WorkerKey "%WORKERKEY%"
pause
