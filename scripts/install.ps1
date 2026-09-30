# Installs walrus.exe onto PATH (~\.local\bin) and puts a "Walrus CLI" shortcut on the Desktop.
# Run after `bun run build`:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'dist\walrus.exe'
if (-not (Test-Path $exe)) { throw "Build first: bun run build" }

$bin = Join-Path $HOME '.local\bin'
$home_ = Join-Path $HOME '.walrus'
New-Item -ItemType Directory -Force -Path $bin, $home_, (Join-Path $home_ 'skills'), (Join-Path $home_ 'agents') | Out-Null
Copy-Item $exe (Join-Path $bin 'walrus.exe') -Force
Copy-Item (Join-Path $root 'assets\walrus.ico') (Join-Path $home_ 'walrus.ico') -Force
"installed $(Join-Path $bin 'walrus.exe')"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
  "added $bin to user PATH (open a new terminal)"
}

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$sc = $ws.CreateShortcut((Join-Path $desktop 'Walrus CLI.lnk'))
$wt = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
if (Test-Path $wt) {
  $sc.TargetPath = $wt
  $sc.Arguments = "--title Walrus -d `"$HOME`" `"$(Join-Path $bin 'walrus.exe')`""
} else {
  $sc.TargetPath = Join-Path $bin 'walrus.exe'
}
$sc.WorkingDirectory = $HOME
$sc.IconLocation = Join-Path $home_ 'walrus.ico'
$sc.Description = 'Walrus - local agent CLI for Ollama'
$sc.Save()
"shortcut $(Join-Path $desktop 'Walrus CLI.lnk')"
