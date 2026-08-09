$ErrorActionPreference = 'Stop'

$candidates = @(
  (Join-Path $env:APPDATA 'Utitlity-With\queue-worker-config.json'),
  (Join-Path $env:APPDATA 'Utility-With\queue-worker-config.json'),
  (Join-Path $env:APPDATA 'Utitlity-With\runtime-config.json'),
  (Join-Path $env:APPDATA 'Utility-With\runtime-config.json')
)

$removed = @()
$missing = @()

foreach ($path in $candidates) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
    $removed += $path
  } else {
    $missing += $path
  }
}

Write-Output "Queue worker reset complete"
if ($removed.Count -gt 0) {
  Write-Output "Removed:"
  $removed | ForEach-Object { Write-Output " - $_" }
} else {
  Write-Output "No persisted queue worker config files found"
}
