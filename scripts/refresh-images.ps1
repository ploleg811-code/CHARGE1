# Targeted refresh of weak/odd images with better modern car photography.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChargeSite/1.0'
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'public'))) { $root = (Get-Location).Path }
$exclude = 'logo|badge|emblem|diagram|map|race|racing|dtm|formula|wrc|rally|motorcycle|bus|truck|aircraft|locomotive|train|ship|boat|bicycle|taxi|cab|police|ambulance|fire|army|military|crashed|accident|wreck|damaged|classic|vintage|1930|1940|1950|1960|1970|1980|museum|film|disney|ambulance|toy|model|miniature|scale|blueprint|diagram'

function Get-Cands {
  param([string]$query, [int]$limit = 18, [int]$minW = 1300, [int]$minH = 520)
  $q = [uri]::EscapeDataString("filetype:bitmap $query")
  $u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=$q&gsrnamespace=6&gsrlimit=$limit&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280"
  $content = $null
  for ($a = 1; $a -le 7; $a++) {
    try { $content = (Invoke-WebRequest -Uri $u -TimeoutSec 60 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }).Content; break }
    catch {
      $m = $_.Exception.Message
      if ($m -match '429' -and $a -lt 7) { Start-Sleep -Seconds ([int][Math]::Pow(2, $a)) }
      else { Write-Host ("  API FAIL {0}" -f $query); return @() }
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
    if ($r -lt 1.2 -or $r -gt 4.2) { return }
    [pscustomobject]@{ Title = $t; Url = $ii.thumburl; W = $ii.width; H = $ii.height }
  }
  return @($list | Where-Object { $_ -ne $null })
}

$tasks = @(
  @{ r = 'public/images/studio/detailing.jpg';    q = 'car polishing buffer machine';     fb = 'car detailing' },
  @{ r = 'public/images/studio/showroom.jpg';    q = 'modern car showroom interior';   fb = 'car dealership showroom' },
  @{ r = 'public/images/studio/body.jpg';         q = 'car body repair workshop paint'; fb = 'auto body shop' },
  @{ r = 'public/images/studio/foam.jpg';         q = 'modern car wash foam';           fb = 'car washing foam' },
  @{ r = 'public/images/studio/washing.jpg';      q = 'car wash hand polishing';        fb = 'washing car' },
  @{ r = 'public/images/brands/lexus.jpg';        q = 'Lexus RX 2021';                  fb = 'Lexus RX' },
  @{ r = 'public/images/brands/lexus/lexus-lx.jpg'; q = 'Lexus LX 600';                fb = 'Lexus LX' },
  @{ r = 'public/images/brands/lexus/lexus-rx.jpg'; q = 'Lexus RX 450h';               fb = 'Lexus RX' },
  @{ r = 'public/images/brands/mercedes.jpg';     q = 'Mercedes-Benz E-Class 2021';     fb = 'Mercedes-Benz E-Class' },
  @{ r = 'public/images/brands/toyota.jpg';       q = 'Toyota Camry 2022';              fb = 'Toyota Camry' },
  @{ r = 'public/images/brands/toyota/toyota-rav4.jpg'; q = 'Toyota RAV4 Adventure';  fb = 'Toyota RAV4' },
  @{ r = 'public/images/brands/volkswagen.jpg';  q = 'Volkswagen Golf GTI 2022';        fb = 'Volkswagen Golf' },
  @{ r = 'public/images/brands/rolls-royce.jpg';  q = 'Rolls-Royce Ghost 2021';          fb = 'Rolls-Royce Ghost' },
  @{ r = 'public/images/brands/range-rover.jpg';  q = 'Range Rover Velar 2021';          fb = 'Range Rover Velar' },
  @{ r = 'public/images/brands/bentley.jpg';      q = 'Bentley Continental GT 2021';     fb = 'Bentley Continental GT' },
  @{ r = 'public/images/brands/mclaren/mclaren-gt.jpg'; q = 'McLaren GT 2021';         fb = 'McLaren GT' },
  @{ r = 'public/images/brands/bmw/bmw-x5.jpg';   q = 'BMW X5 2023';                    fb = 'BMW X5' },
  @{ r = 'public/images/brands/tesla/tesla-3.jpg'; q = 'Tesla Model 3 2023';            fb = 'Tesla Model 3' }
)

foreach ($t in $tasks) {
  $full = Join-Path $root ($t.r -replace '/', '\')
  $c = Get-Cands -query $t.q
  if ($c.Count -eq 0) { $c = Get-Cands -query $t.fb }
  if ($c.Count -eq 0) { Write-Host ("  MISS {0}" -f $t.r); continue }
  $pick = $c[0]
  try {
    Invoke-WebRequest -Uri $pick.Url -OutFile $full -TimeoutSec 90 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $magic = '{0:X2}{1:X2}' -f $bytes[0], $bytes[1]
    if ($magic -ne 'FFD8') { Remove-Item $full -Force; Write-Host ("  BAD MAGIC {0}" -f $t.r); continue }
    Write-Host ("  OK {0} <- {1} [{2}x{3}]" -f $t.r, $pick.Title, $pick.W, $pick.H)
  } catch {
    Write-Host ("  FAIL {0} :: {1}" -f $t.r, $_.Exception.Message)
  }
  Start-Sleep -Milliseconds (1500 + (Get-Random -Minimum 0 -Maximum 900))
}
Write-Host 'REFRESH DONE'
