# Replaces images that came out unsuitable (too old / wrong subject) and
# validates the JPEG signature of every image in public/images.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChargeSite/1.0'
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'public'))) { $root = (Get-Location).Path }

$exclude = 'logo|badge|emblem|diagram|map|race|racing|dtm|formula|wrc|rally|motorcycle|bus|truck|aircraft|locomotive|train|ship|boat|bicycle|taxi|cab|police|ambulance|fire|army|military|crashed|accident|wreck|damaged|classic|museum|film|disney|toy|model|miniature|scale|blueprint|homes and gardens|book|illustration|painting|poster'

function Get-Cands {
  param([string]$query, [int]$limit = 20, [int]$minW = 1300, [int]$minH = 520)
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
    # отсекаем снимки старше 2012 года
    $years = [regex]::Matches($t, '\b(19\d\d|20[0-1]\d)\b')
    foreach ($y in $years) { if ([int]$y.Value -lt 2012) { return } }
    $r = $ii.width / [Math]::Max(1, $ii.height)
    if ($r -lt 1.2 -or $r -gt 4.2) { return }
    [pscustomobject]@{ Title = $t; Url = $ii.thumburl; W = $ii.width; H = $ii.height }
  }
  return @($list | Where-Object { $_ -ne $null })
}

$tasks = @(
  @{ r = 'public/images/studio/body.jpg';      q = 'automotive paint booth body shop'; fb = 'car bodywork spray painting' },
  @{ r = 'public/images/studio/showroom.jpg';  q = 'car show hall exhibition hall';   fb = 'auto show exhibition' },
  @{ r = 'public/images/brands/rolls-royce.jpg'; q = 'Rolls-Royce Ghost 2022';       fb = 'Rolls-Royce Ghost' },
  @{ r = 'public/images/brands/bmw/bmw-x5.jpg'; q = 'BMW X5 G05 2021';             fb = 'BMW X5' },
  @{ r = 'public/images/brands/toyota.jpg';    q = 'Toyota Camry 2023';               fb = 'Toyota Camry' },
  @{ r = 'public/images/brands/tesla/tesla-3.jpg'; q = 'Tesla Model 3 2024';        fb = 'Tesla Model 3' },
  @{ r = 'public/images/studio/washing.jpg';   q = 'washing car water spray';        fb = 'car cleaning' },
  @{ r = 'public/images/studio/foam.jpg';      q = 'car wash foam snow';              fb = 'car wash' }
)

foreach ($t in $tasks) {
  $full = Join-Path $root ($t.r -replace '/', '\')
  $c = Get-Cands -query $t.q
  if ($c.Count -eq 0) { $c = Get-Cands -query $t.fb }
  if ($c.Count -eq 0) { Write-Host ("  MISS {0} (старый файл сохранён)" -f $t.r); continue }
  $pick = $c[0]
  try {
    $tmp = "$full.tmp"
    Invoke-WebRequest -Uri $pick.Url -OutFile $tmp -TimeoutSec 90 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    $magic = '{0:X2}{1:X2}' -f $bytes[0], $bytes[1]
    if ($magic -ne 'FFD8' -or $bytes.Length -lt 20000) {
      Remove-Item $tmp -Force
      Write-Host ("  BAD FILE {0}" -f $t.r)
      continue
    }
    Move-Item -Path $tmp -Destination $full -Force
    Write-Host ("  OK {0} <- {1} [{2}x{3}]" -f $t.r, $pick.Title, $pick.W, $pick.H)
  } catch {
    Write-Host ("  FAIL {0} :: {1}" -f $t.r, $_.Exception.Message)
  }
  Start-Sleep -Milliseconds (1600 + (Get-Random -Minimum 0 -Maximum 900))
}

# --- Валидация всех изображений ---
Write-Host ''
Write-Host 'VALIDATION:'
$bad = 0
Get-ChildItem (Join-Path $root 'public\images') -Recurse -File -Filter *.jpg | ForEach-Object {
  try {
    $b = [System.IO.File]::ReadAllBytes($_.FullName)
    $magic = '{0:X2}{1:X2}' -f $b[0], $b[1]
    if ($magic -ne 'FFD8' -or $b.Length -lt 20000) {
      Write-Host ("  BROKEN {0} ({1} bytes)" -f $_.FullName.Replace("$root\", ''), $b.Length)
      $bad++
    }
  } catch {
    Write-Host ("  BROKEN {0}" -f $_.FullName.Replace("$root\", ''))
    $bad++
  }
}
Write-Host ("  broken files: {0}" -f $bad)
Write-Host 'DONE'
