# Делает скриншоты страниц сайта в headless Chrome (для визуальной проверки).
# Использование:
#   powershell -ExecutionPolicy Bypass -File scripts/screenshots.ps1 -BaseUrl http://127.0.0.1:4173 -Routes /,/cars -OutDir shots
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1:4173',
  [string[]]$Routes = @('/', '/services', '/cars', '/works', '/about', '/contacts', '/cart', '/configure'),
  [string]$OutDir = '',
  [int]$Width = 1440,
  [int]$Height = 3200,
  [string]$Prefix = 'page',
  [switch]$Mobile
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$chrome = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Host 'Chrome/Edge не найден — скриншоты невозможны.'; exit 1 }

if (-not $OutDir) {
  $OutDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Детейлинг центр\shots'
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$profileDir = Join-Path $env:TEMP 'charge-shot-profile'
$w = $Width
$h = $Height
if ($Mobile) { $w = 390; $h = 2400 }

foreach ($route in $Routes) {
  $name = ($route -replace '[^A-Za-z0-9]', '-')
  if ([string]::IsNullOrWhiteSpace($name) -or $name -eq '-') { $name = 'root' }
  $file = Join-Path $OutDir ("{0}-{1}.png" -f $Prefix, $name.TrimStart('-'))
  $url = $BaseUrl + $route
  & $chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
    --force-device-scale-factor=1 --user-data-dir="$profileDir" `
    --window-size="$w,$h" --virtual-time-budget=25000 `
    --screenshot="$file" $url 2>$null | Out-Null
  if (Test-Path $file) {
    Write-Host ("  OK  {0,-16} {1,8:N0} KB  {2}" -f $route, ((Get-Item $file).Length / 1KB), (Split-Path $file -Leaf))
  } else {
    Write-Host ("  ERR {0}" -f $route)
  }
}
Write-Host ("Скриншоты: {0}" -f $OutDir)
