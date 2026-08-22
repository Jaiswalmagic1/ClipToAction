# Makes the PC worker start by itself when you log in, and restart itself if it dies.
#
# Why a scheduled task and not a Startup shortcut: a shortcut runs the program once and
# gives up if it ever crashes. This restarts it, and runs it with no window in the way.
#
# It is deliberately tied to logging in rather than to the machine booting, because the
# worker needs your profile to find its own folder and its .env.
#
#   Install:    powershell -ExecutionPolicy Bypass -File autostart.ps1
#   Remove:     powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove
#   Check:      Get-ScheduledTask ClipToActionWorker
#
# No administrator rights are needed: the task runs as you, doing what you could do
# yourself.

param([switch]$Remove)

$TaskName = "ClipToActionWorker"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python   = Join-Path $Here ".venv\Scripts\pythonw.exe"
$Script   = Join-Path $Here "worker.py"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed. The worker will no longer start on its own."
    } else {
        Write-Output "Nothing to remove -- it was not set up."
    }
    return
}

# Fail loudly and specifically. A task that points at a missing file registers happily and
# then does nothing every day, which is the exact silent failure this whole feature exists
# to prevent.
if (-not (Test-Path $Python)) {
    throw "No virtual environment at $Python. Run the Setup steps in README.md first."
}
if (-not (Test-Path $Script)) {
    throw "worker.py is not next to this script. Run it from the worker-pc folder."
}
if (-not (Test-Path (Join-Path $Here ".env"))) {
    throw "No .env here. Copy .env.example to .env and fill in API_BASE and SERVICE_TOKEN."
}

# pythonw.exe, not python.exe: same interpreter, no console window. -u keeps output
# unbuffered so that anything written while debugging appears immediately.
$Action = New-ScheduledTaskAction -Execute $Python -Argument "-u `"$Script`"" -WorkingDirectory $Here

# TWO triggers, and both are needed. Each was arrived at by watching this fail.
#
#   1. At logon  -- starts it the moment you sign in, with no waiting.
#   2. Every five minutes, for ever -- this is what brings it back when it dies.
#
# Two things that look like they would do job 2 and do not:
#
#   "Restart on failure" (RestartCount/RestartInterval below). Tested 2026-08-22: the
#   worker was killed, the task recorded a failure result of 0xFFFFFFFF, and Windows did
#   not restart it. It is left set because it costs nothing, but nothing relies on it.
#
#   A repetition attached to the LOGON trigger. A trigger's repetition only starts running
#   once that trigger fires, and a logon trigger does not fire again while you are already
#   logged in -- so it sat there with no next run time at all, and the worker stayed dead.
#   Tested the same day. The repeat has to be its own trigger.
#
# MultipleInstances IgnoreNew is what makes a five-minute retry safe: when the worker is
# already running the attempt is quietly dropped, so a healthy worker is never disturbed
# and a dead one is back within five minutes.
$AtLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$KeepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$Trigger = @($AtLogon, $KeepAlive)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# ExecutionTimeLimit of zero means "never kill it". The default is three days, after which
# Windows would stop a perfectly healthy worker and nothing would say why.

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "ClipToAction: downloads and transcribes saved reels." `
    -Force | Out-Null

$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
if (-not $next) {
    throw "Registered, but the scheduler has no next run planned -- the keep-alive is not armed. Do not trust this; report it."
}

Write-Output "Done. The worker starts when you log in, and is back within five minutes if it stops."
Write-Output "Next automatic check: $next"
Write-Output "Start it now without logging out:  Start-ScheduledTask $TaskName"
Write-Output "The app shows you when it has gone quiet -- you should not need to look here."
