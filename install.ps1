# midnight installer for Windows (x64). Per-user, no admin needed:
#   irm https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.ps1 | iex
# Uninstall:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.ps1))) -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without the progress bar

$repo = 'soliluqoy/midnight.app'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\midnight'
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'midnight.lnk'

function Stop-Midnight {
  Get-Process midnight -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

if ($Uninstall) {
  Stop-Midnight
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
  Write-Host 'midnight removed. Settings stay in %APPDATA%\midnight; sign-ins in ~\.midnight.server.'
  return
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'midnight needs 64-bit Windows.' }

$url = "https://github.com/$repo/releases/latest/download/midnight-win-x64.zip"
$tmp = Join-Path $env:TEMP "midnight-$([guid]::NewGuid().ToString('N')).zip"
Write-Host "Downloading midnight (about 180 MB)..."
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

Write-Host "Installing to $dest ..."
Stop-Midnight
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
if (Get-Command tar.exe -ErrorAction SilentlyContinue) { tar.exe -xf $tmp -C $dest } else { Expand-Archive -Path $tmp -DestinationPath $dest -Force }
Remove-Item $tmp -Force
if (-not (Test-Path (Join-Path $dest 'midnight.exe'))) { throw 'The download did not contain midnight.exe.' }

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $dest 'midnight.exe'
$s.WorkingDirectory = $dest
$s.Description = 'midnight: a desktop capsule that searches, reads and works in plain view'
$s.Save()

Start-Process (Join-Path $dest 'midnight.exe')
Write-Host ''
Write-Host 'midnight is installed and running: look for the pill above your taskbar.'
Write-Host 'Summon it with Ctrl+Alt+M. Start menu: "midnight". Sign in from its settings (gear icon).'
