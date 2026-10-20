# Targeted re-download for missing or mismatched images.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChargeSite/1.0'
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'public'))) { $root = (Get-Location).Path }
$exclude = 'logo|badge|emblem|diagram|map|scale model|sign|race|racing|dtm|formula|wrc|rally|motorcycle|bus|truck|aircraft|locomotive|train|ship|boat|bicycle|taxi|cab|police|ambulance|fire|army|military'

function Get-Cands {
  param([string]$query, [int]$limit = 20, [int]$minW = 1200, [int]$minH = 500)
  $q = [uri]::EscapeDataString("filetype:bitmap $query")
  $u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=$q&gsrnamespace=6&gsrlimit=$limit&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280"
  $content = $null
  for ($a = 1; $a -le 6; $a++) {
    try { $content = (Invoke-WebRequest -Uri $u -TimeoutSec 60 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }).Content; break }
    catch {
      $m = $_.Exception.Message
      if ($m -match '429' -and $a -lt 6) { Start-Sleep -Seconds ([int][Math]::Pow(2, $a)) }
      else { Write-Host "  API FAIL $query :: $m"; return @() }
    }
  }
  if (-not $content) { return @() }
  $j = $content | ConvertFrom-Json
  if (-not $j.query -or -not $j.query.pages) { return @() }
  $list = $j.query.pages.PSObject.Properties.Value | ForEach-Object {
    $t = $_.title
    if (-not $_.imageinfo) { return }
    $ii = $_.imageinfo
    if ($ii.mime -ne 'image/jpeg') { return }
    if ($ii.width -lt $minW -or $ii.height -lt $minH) { return }
    if ($t -match $exclude) { return }
    $r = $ii.width / [Math]::Max(1, $ii.height)
    if ($r -lt 1.15 -or $r -gt 4.5) { return }
    [pscustomobject]@{ Title = $t; Url = $ii.thumburl; W = $ii.width; H = $ii.height }
  }
  return @($list | Where-Object { $_ -ne $null })
}

function Save {
  param([string]$rel, [string]$query, [string]$fb = '')
  $full = Join-Path $root ($rel -replace '/', '\')
  if (Test-Path $full) { Remove-Item $full -Force }
  $c = Get-Cands -query $query
  if ($c.Count -eq 0 -and $fb) { $c = Get-Cands -query $fb }
  if ($c.Count -eq 0) { Write-Host "  STILL MISSING $rel ($query)"; return }
  $dir = Split-Path $full -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  try {
    Invoke-WebRequest -Uri $c[0].Url -OutFile $full -TimeoutSec 90 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }
    Write-Host ("  OK {0} <- {1}" -f $rel, $c[0].Title)
  } catch { Write-Host "  DL FAIL $rel :: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds (900 + (Get-Random -Minimum 0 -Maximum 700))
}

$tasks = @(
  @{ r='public/images/brands/audi/audi-a6.jpg';    q='Audi A6 C8 Avant';            fb='Audi A6 sedan' },
  @{ r='public/images/brands/audi/audi-etron.jpg'; q='Audi e-tron GT RS';           fb='Audi e-tron GT' },
  @{ r='public/images/brands/bentley/bentley-spur.jpg'; q='Bentley Flying Spur';     fb='Bentley Continental Flying Spur' },
  @{ r='public/images/brands/toyota.jpg';          q='Toyota Camry XV70';            fb='Toyota Land Cruiser 300' },
  @{ r='public/images/brands/tesla/tesla-x.jpg';   q='Tesla Model X';                fb='Tesla Model X 2021' },
  @{ r='public/images/studio/detailing.jpg';       q='AZ Auto Detailing';            fb='car detailing' },
  @{ r='public/images/brands/lexus/lexus-lx.jpg';  q='Lexus LX 570';                 fb='Lexus LX J300' },
  @{ r='public/images/brands/toyota/toyota-rav4.jpg'; q='Toyota RAV4 XA50';          fb='Toyota RAV4' },
  @{ r='public/images/brands/rolls-royce/rr-phantom.jpg'; q='Rolls-Royce Phantom VIII'; fb='Rolls-Royce Phantom VIII 2018' },
  @{ r='public/images/brands/volkswagen.jpg';      q='Volkswagen Golf Mk8';          fb='Volkswagen Golf 8' },
  @{ r='public/images/studio/hero.jpg';            q='Audi R8 black';                fb='Porsche 911 black' }
)
foreach ($t in $tasks) { Save -rel $t.r -query $t.q -fb $t.fb }
Write-Host "DONE"
