# Wrapper for the Windows Scheduled Task. Runs the term check and only shows
# a popup when there is something worth interrupting for:
#   exit 0 -> nothing new, stay silent
#   exit 1 -> needs attention (usually: session expired, log in again)
#   exit 2 -> new courses appeared
#
# Deliberately does NOT redirect node's stderr. In Windows PowerShell 5.1,
# `2>&1` on a native command wraps each stderr line in an ErrorRecord, and the
# MCP server writes its startup banner to stderr — which would throw before
# anything useful happened.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$reports = Join-Path $root 'reports'
if (-not (Test-Path $reports)) {
    New-Item -ItemType Directory -Force $reports | Out-Null
}
$log = Join-Path $reports 'task.log'

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
& node (Join-Path $root 'scripts\fall-check.mjs') | Out-Null
$code = $LASTEXITCODE

Add-Content -Path $log -Encoding utf8 -Value "[$stamp] exit=$code"

if ($code -eq 0) { exit 0 }

$report = Join-Path $reports ("fall-check-{0}.md" -f (Get-Date -Format 'yyyy-MM-dd'))
if ($code -eq 2) {
    $message = "Your new myCourses term has appeared.`n`nReport:`n$report"
    $icon = [System.Windows.Forms.MessageBoxIcon]::Information
} else {
    $message = "The myCourses check needs attention - most likely the session expired.`n`nFix:`n  cd $root`n  node dist/cli.js login`n`nReport:`n$report"
    $icon = [System.Windows.Forms.MessageBoxIcon]::Warning
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
    $message,
    'myCourses term check',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    $icon
) | Out-Null

exit $code
