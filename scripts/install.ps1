# NetMount headless CLI installer (Windows).
#
#   irm https://raw.githubusercontent.com/2233admin/NetMount/feat/headless-cli/scripts/install.ps1 | iex
#
# Downloads the standalone CLI binary from the latest GitHub release that has CLI
# assets and adds it to your user PATH. The binary embeds the Bun runtime, so no
# bun/node is required. On first use the CLI fetches rclone + openlist into
# ~/.netmount/bin/ automatically. Mounting additionally needs WinFsp (winfsp.dev).
$ErrorActionPreference = 'Stop'
$repo = '2233admin/NetMount'

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = "netmount-windows-$arch.exe"

Write-Host "Resolving $asset from latest $repo release with CLI assets..."
$releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases" -Headers @{ 'User-Agent' = 'netmount-installer' }
$url = $null
foreach ($r in $releases) {
  $a = $r.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
  if ($a) { $url = $a.browser_download_url; break }
}
if (-not $url -and $arch -ne 'x64') {
  Write-Warning "No native windows-$arch build; falling back to x64 (runs under emulation)."
  $asset = 'netmount-windows-x64.exe'
  foreach ($r in $releases) {
    $a = $r.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
    if ($a) { $url = $a.browser_download_url; break }
  }
}
if (-not $url) { throw "No $asset found in any release. Has a cli-v* release been published yet?" }

$dir = Join-Path $env:LOCALAPPDATA 'Programs\netmount'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dest = Join-Path $dir 'netmount.exe'
Write-Host "Downloading $url"
Invoke-WebRequest $url -OutFile $dest

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "Added $dir to your user PATH (open a new shell to pick it up)."
}
Write-Host "Installed -> $dest"
Write-Host "Run:  netmount --help"
