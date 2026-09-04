<#
  analysis-worker.ps1 - the GPU workstation's half of the analysis queue.

    powershell -ExecutionPolicy Bypass -File C:\Users\Public\replay-ops\analysis-worker.ps1 `
      -ApiBase https://<the app> -WorkerKey <ANALYSIS_WORKER_KEY>

  Leave the window open. It asks the app whether there is anything to analyse,
  runs the existing pipeline over whatever it is given, uploads the result, and
  goes back to asking. Nothing dials this machine; it only ever calls out. That
  is the whole reason the queue is shaped this way - this is a desktop behind a
  home connection, and the server cannot reach it.

  WHAT IT ACTUALLY RUNS

  analyze.ps1, unchanged, once per recording in the job. That script is proven,
  resumable and already writes analyze_status.json after every stage, which is
  what this one reads to report progress. Reimplementing the pipeline here would
  mean two versions of a six-hour job to keep in step.

  THE WORK DIRECTORY IS SHARED, AND THAT MATTERS

  analyze.ps1, chunk.ps1 and make_hourbundle.py all work inside .\match, and
  every stage skips when its output already exists. Within one recording that is
  the resume behaviour that makes a reboot survivable. Across two recordings it
  is a trap: hour two would silently reuse hour one's chunks and produce a
  bundle of the wrong football. So .\match\_current.txt records which recording
  the directory currently holds. Same slug, carry on where it left off; different
  slug, wipe and start clean.

  IF YOU KILL THIS WINDOW

  Nothing is lost and nothing is stuck. The job's heartbeat stops, the server
  gives it back to the queue after fifteen minutes, and the next run picks it up
  - resuming inside .\match if it is the same recording.
#>
param(
  [Parameter(Mandatory=$true)][string]$ApiBase,
  [Parameter(Mandatory=$true)][string]$WorkerKey,
  [string]$WorkerId = $env:COMPUTERNAME,
  [int]$PollSeconds = 60,
  [int]$HeartbeatSeconds = 30,
  [string]$Root = "C:\Users\Public\replay-ops"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
Set-Location $Root
$VERSION = "analysis-worker/1"
$ApiBase = $ApiBase.TrimEnd("/")
$WORK = Join-Path $Root "match"
$MARKER = Join-Path $WORK "_current.txt"
$STOPFLAG = Join-Path $Root "worker-stop.flag"

function Say($text, $colour = "Gray") { Write-Host "[$(Get-Date -Format HH:mm:ss)] $text" -ForegroundColor $colour }

# ---- start-up checks -------------------------------------------------------
# Every one of these fails six hours in if it is left to be discovered late.
# agent3 burned a day on exactly that, so they are checked before any work.
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
if (-not $curl) {
  Say "curl.exe is not on PATH. The bundle upload is multipart and needs it. Not starting." Red
  exit 1
}
foreach ($needed in @("analyze.ps1", "chunk.ps1", "make_hourbundle.py")) {
  if (-not (Test-Path (Join-Path $Root $needed))) {
    Say "$needed is missing from $Root. Not starting." Red
    exit 1
  }
}
try {
  Add-Type -Name Power -Namespace Win32 -MemberDefinition '
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);' -ErrorAction Stop
  [Win32.Power]::SetThreadExecutionState(0x80000001) | Out-Null
  Say "sleep suppressed while this window is open" DarkGray
} catch { Say "could not suppress sleep - set the power plan to 'never sleep'" Yellow }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Api([string]$method, [string]$path, $body) {
  $headers = @{ "x-worker-key" = $WorkerKey; "x-worker-id" = $WorkerId }
  $json = ($body | ConvertTo-Json -Depth 6 -Compress)
  return Invoke-RestMethod -Method $method -Uri "$ApiBase/api$path" -Headers $headers `
    -ContentType "application/json" -Body $json -TimeoutSec 60
}

function Slugify([string]$text) { return ($text -replace '[^A-Za-z0-9]', '_') }

# ---- one recording ---------------------------------------------------------
function Invoke-OneRecording($job, $source, [int]$index, [int]$total) {
  $slug = if ($source.title) { Slugify $source.title } else { "rec$($source.recordingId)" }
  $zip = Join-Path $Root "idbundle_$slug.zip"

  New-Item -ItemType Directory -Force -Path $WORK | Out-Null
  $held = if (Test-Path $MARKER) { (Get-Content $MARKER -Raw).Trim() } else { "" }
  if ($held -ne $slug) {
    if ($held) { Say "  work directory holds '$held', clearing it for '$slug'" DarkGray }
    Get-ChildItem $WORK -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Set-Content -Path $MARKER -Value $slug -Encoding ASCII
  } else {
    Say "  resuming '$slug' where the last run left off" DarkGray
  }

  if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }

  $title = if ($source.title) { $source.title } else { "" }
  if (-not $title) { throw "Recording $($source.recordingId) has no Bunny title, so the hour cannot be fetched." }

  $outFile = Join-Path $env:TEMP "aw_$slug.out"
  $errFile = Join-Path $env:TEMP "aw_$slug.err"
  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  $statusFile = Join-Path $Root "analyze_status.json"
  Remove-Item $statusFile -Force -ErrorAction SilentlyContinue

  $proc = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-ExecutionPolicy","Bypass","-NoProfile","-NonInteractive","-File",
                    (Join-Path $Root "analyze.ps1"), "-Title", $title, "-Slug", $slug) `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile

  $lastBeat = [DateTime]::MinValue
  while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    if ((Get-Date) - $lastBeat -lt [TimeSpan]::FromSeconds($HeartbeatSeconds)) { continue }
    $lastBeat = Get-Date

    $stage = "analysing"; $pct = 0
    try {
      $st = Get-Content $statusFile -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($st.stage) { $stage = $st.stage }
      if ($null -ne $st.percent) { $pct = [double]$st.percent }
      if ($st.note) { $stage = "$stage - $($st.note)" }
    } catch { }

    # The job's progress is the recording it is on plus how far into it.
    $overall = (($index + ($pct / 100.0)) / [double]$total) * 100.0
    try {
      $beat = Api POST "/worker/analysis/$($job.id)/heartbeat" @{
        workerId = $WorkerId
        stage = "recording $($index + 1) of ${total}: $stage"
        progress = [math]::Round($overall, 1)
      }
      if ($beat.stop) {
        Say "  server says stop ($($beat.reason)). Killing the run." Yellow
        & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
        throw "STOPPED: $($beat.reason)"
      }
    } catch {
      if ("$_" -like "STOPPED:*") { throw }
      Say "  heartbeat failed (continuing): $_" DarkYellow
    }
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    $tail = (Get-Content $errFile -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
    throw "analyze.ps1 exited $($proc.ExitCode) for '$title'. $tail"
  }
  if (-not (Test-Path $zip)) { throw "analyze.ps1 finished but produced no $zip" }

  # Only the first recording starts at the kick-off the operator typed. The
  # ones after it are already in play from their first frame.
  $startSeconds = if ($index -eq 0) { [double]$job.matchStartSeconds } else { 0 }

  Say "  uploading $(Split-Path $zip -Leaf) ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB), start $startSeconds s" Cyan
  $response = & curl.exe -sS -X PUT `
    -H "x-worker-key: $WorkerKey" `
    -H "x-worker-id: $WorkerId" `
    -F "workerId=$WorkerId" `
    -F "recordingId=$($source.recordingId)" `
    -F "videoStartSeconds=$startSeconds" `
    -F "bundle=@$zip;type=application/zip" `
    "$ApiBase/api/worker/analysis/$($job.id)/bundle" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "curl failed uploading the bundle: $response" }
  if ("$response" -notmatch '"ok"\s*:\s*true') { throw "the server refused the bundle: $response" }
  Say "  stored for recording $($source.recordingId)" Green
}

# ---- the loop --------------------------------------------------------------
Say "worker '$WorkerId' -> $ApiBase" Cyan
Say "stop with Ctrl+C, or drop a file called worker-stop.flag in $Root" DarkGray

while ($true) {
  if (Test-Path $STOPFLAG) { Remove-Item $STOPFLAG -Force; Say "worker-stop.flag - exiting." Yellow; exit 0 }

  $job = $null
  try {
    $claim = Api POST "/worker/analysis/claim" @{ workerId = $WorkerId; version = $VERSION }
    $job = $claim.job
  } catch {
    Say "could not reach the queue: $_" DarkYellow
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  if (-not $job) {
    try { Api POST "/worker/analysis/ping" @{ workerId = $WorkerId; version = $VERSION } | Out-Null } catch { }
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  $sources = @($job.sources)
  Say "job #$($job.id): $($sources.Count) recording(s), kick-off $($job.matchStartSeconds)s" Cyan
  $failed = $null
  for ($i = 0; $i -lt $sources.Count; $i++) {
    Say " [$($i+1)/$($sources.Count)] $($sources[$i].title)" White
    try {
      Invoke-OneRecording $job $sources[$i] $i $sources.Count
    } catch {
      $failed = "$_"
      break
    }
  }

  try {
    if ($failed) {
      if ($failed -like "STOPPED:*") {
        Say "job #$($job.id) abandoned: $failed" Yellow
      } else {
        Say "job #$($job.id) failed: $failed" Red
        Api POST "/worker/analysis/$($job.id)/fail" @{ workerId = $WorkerId; error = $failed } | Out-Null
      }
    } else {
      Api POST "/worker/analysis/$($job.id)/complete" @{ workerId = $WorkerId } | Out-Null
      Say "job #$($job.id) done" Green
    }
  } catch {
    Say "could not report the outcome of job #$($job.id): $_" Red
  }
}
