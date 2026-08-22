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

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# ExecutionTimeLimit of zero means "never kill it". The default is three days, after which
# Windows would stop a perfectly healthy worker and nothing would say why.

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "ClipToAction: downloads and transcribes saved reels." `
    -Force | Out-Null

Write-Output "Done. The worker starts when you log in, and restarts itself if it stops."
Write-Output "Start it now without logging out:  Start-ScheduledTask $TaskName"
Write-Output "The app shows you when it has gone quiet -- you should not need to look here."
