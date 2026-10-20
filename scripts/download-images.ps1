# Downloads real, brand-relevant images from Wikimedia Commons (open API, no key).
# Idempotent: skips files that already exist and look valid.
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChargeSite/1.0'
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'public'))) { $root = (Get-Location).Path }
$imgRoot = Join-Path $root 'public/images'

$exclude = 'logo|badge|emblem|diagram|map|scale model|sign|race|racing|dtm|formula|wrc|rally|motorcycle|bus|truck|aircraft|locomotive|train|ship|boat|bicycle|cat |dog |people|portrait|sculpture|drawing|painting|poster|cover of|book|magazine|food|architecture|building|flag|coin|stamp|plate of|table|chart|graph|sample of|test'

function Get-CommonsCandidates {
  param([string]$query, [int]$limit = 24, [int]$minW = 1200, [int]$minH = 500)
  $q = [uri]::EscapeDataString("filetype:bitmap $query")
  $u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=$q&gsrnamespace=6&gsrlimit=$limit&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280"
  $content = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      $content = (Invoke-WebRequest -Uri $u -TimeoutSec 60 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }).Content
      break
    } catch {
      $msg = $_.Exception.Message
      if ($msg -match '429' -and $attempt -lt 5) {
        $wait = [int]([Math]::Pow(2, $attempt))
        Write-Host ("  429 retry {0} in {1}s :: {2}" -f $attempt, $wait, $query)
        Start-Sleep -Seconds $wait
      } else {
        Write-Host ("  API FAIL: {0} :: {1}" -f $query, $msg)
        return @()
      }
    }
  }
  if (-not $content) { return @() }
  try {
    $j = $content | ConvertFrom-Json
    if (-not $j.query -or -not $j.query.pages) { return @() }
    $list = $j.query.pages.PSObject.Properties.Value | ForEach-Object {
      $t = $_.title
      if (-not $_.imageinfo) { return }
      $ii = $_.imageinfo
      if ($ii.mime -ne 'image/jpeg') { return }
      if ($ii.width -lt $minW -or $ii.height -lt $minH) { return }
      if ($t -match $exclude) { return }
      $ratio = $ii.width / [Math]::Max(1, $ii.height)
      if ($ratio -lt 1.15 -or $ratio -gt 4.5) { return }
      [pscustomobject]@{ Title = $t; Url = $ii.thumburl; W = $ii.width; H = $ii.height }
    }
    return @($list | Where-Object { $_ -ne $null })
  } catch {
    Write-Host ("  PARSE FAIL: {0} :: {1}" -f $query, $_.Exception.Message)
    return @()
  }
}

$script:downloaded = 0
$script:skipped = 0
$script:failed = 0
$manifest = [System.Collections.Generic.List[object]]::new()

function Save-Image {
  param([string]$outRel, [string]$query, [string]$fallbackQuery = '', [string]$tag = '')
  $outFull = Join-Path $root ($outRel -replace '/', '\')
  if ((Test-Path $outFull) -and -not $Force) {
    $len = (Get-Item $outFull).Length
    if ($len -gt 3000) { $script:skipped++; return $true }
  }
  $cands = Get-CommonsCandidates -query $query
  if ($cands.Count -eq 0 -and $fallbackQuery) { $cands = Get-CommonsCandidates -query $fallbackQuery }
  if ($cands.Count -eq 0) {
    Write-Host ("  NO IMAGE: {0} ({1})" -f $outRel, $query)
    $script:failed++
    $manifest.Add([pscustomobject]@{ file = $outRel; query = $query; status = 'missing' }) | Out-Null
    return $false
  }
  $c = $cands[0]
  try {
    $dir = Split-Path $outFull -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Invoke-WebRequest -Uri $c.Url -OutFile $outFull -TimeoutSec 90 -UseBasicParsing -Headers @{ 'User-Agent' = $ua }
    $len = (Get-Item $outFull).Length
    if ($len -lt 3000) { Remove-Item $outFull -Force; throw "too small ($len bytes)" }
    $script:downloaded++
    Write-Host ("  OK {0}  <- {1} [{2}x{3}]" -f $outRel, $c.Title, $c.W, $c.H)
    $manifest.Add([pscustomobject]@{ file = $outRel; title = $c.Title; query = $query; status = 'ok' }) | Out-Null
    return $true
  } catch {
    Write-Host ("  DL FAIL {0} :: {1}" -f $outRel, $_.Exception.Message)
    $script:failed++
    $manifest.Add([pscustomobject]@{ file = $outRel; query = $query; status = 'error' }) | Out-Null
    return $false
  } finally {
    Start-Sleep -Milliseconds (1200 + (Get-Random -Minimum 0 -Maximum 800))
  }
}

# ---------- Brands ----------
$brands = @(
  @{ slug='bmw';          cover='BMW 3 Series G20 sedan';        models=@(
      @{s='bmw-3';    q='BMW 3 Series G20 sedan'},
      @{s='bmw-5';    q='BMW 5 Series G30 sedan'},
      @{s='bmw-x5';   q='BMW X5 G05 SUV'},
      @{s='bmw-m4';   q='BMW M4 F82 coupe'} ) },
  @{ slug='mercedes';     cover='Mercedes-Benz C-Class W205';     models=@(
      @{s='mb-c';     q='Mercedes-Benz C-Class W205 sedan'},
      @{s='mb-e';     q='Mercedes-Benz E-Class W213 sedan'},
      @{s='mb-glc';   q='Mercedes-Benz GLC X253'},
      @{s='mb-amggt'; q='Mercedes-AMG GT C190'} ) },
  @{ slug='porsche';      cover='Porsche 911 Carrera 992';        models=@(
      @{s='porsche-911';    q='Porsche 911 Carrera 992'},
      @{s='porsche-cayenne';q='Porsche Cayenne'},
      @{s='porsche-taycan'; q='Porsche Taycan'},
      @{s='porsche-panamera';q='Porsche Panamera'} ) },
  @{ slug='audi';         cover='Audi A6 C8';                     models=@(
      @{s='audi-a6';    q='Audi A6 C8 sedan'},
      @{s='audi-q7';    q='Audi Q7 4M SUV'},
      @{s='audi-rs6';   q='Audi RS6 Avant C8'},
      @{s='audi-etron'; q='Audi e-tron GT'} ) },
  @{ slug='lamborghini';  cover='Lamborghini Huracan';            models=@(
      @{s='lambo-huracan';   q='Lamborghini Huracan'},
      @{s='lambo-aventador'; q='Lamborghini Aventador'},
      @{s='lambo-urus';      q='Lamborghini Urus'} ) },
  @{ slug='ferrari';      cover='Ferrari Roma';                   models=@(
      @{s='ferrari-roma'; q='Ferrari Roma'},
      @{s='ferrari-f8';   q='Ferrari F8 Tributo'},
      @{s='ferrari-sf90'; q='Ferrari SF90 Stradale'},
      @{s='ferrari-296';  q='Ferrari 296 GTB'} ) },
  @{ slug='bentley';      cover='Bentley Continental GT';         models=@(
      @{s='bentley-continental'; q='Bentley Continental GT'},
      @{s='bentley-bentayga';    q='Bentley Bentayga'},
      @{s='bentley-spur';        q='Bentley Flying Spur'} ) },
  @{ slug='rolls-royce';  cover='Rolls-Royce Ghost';              models=@(
      @{s='rr-ghost';   q='Rolls-Royce Ghost'},
      @{s='rr-phantom'; q='Rolls-Royce Phantom'},
      @{s='rr-cullinan';q='Rolls-Royce Cullinan'} ) },
  @{ slug='lexus';        cover='Lexus RX';                       models=@(
      @{s='lexus-rx'; q='Lexus RX'},
      @{s='lexus-lx'; q='Lexus LX'},
      @{s='lexus-es'; q='Lexus ES'} ) },
  @{ slug='toyota';       cover='Toyota Camry';                   models=@(
      @{s='toyota-camry';       q='Toyota Camry'},
      @{s='toyota-landcruiser'; q='Toyota Land Cruiser 300'},
      @{s='toyota-supra';       q='Toyota Supra A90'},
      @{s='toyota-rav4';        q='Toyota RAV4'} ) },
  @{ slug='volkswagen';   cover='Volkswagen Golf GTI';            models=@(
      @{s='vw-golf';   q='Volkswagen Golf GTI'},
      @{s='vw-passat'; q='Volkswagen Passat B8'},
      @{s='vw-tiguan'; q='Volkswagen Tiguan'},
      @{s='vw-touareg';q='Volkswagen Touareg'} ) },
  @{ slug='tesla';        cover='Tesla Model S';                  models=@(
      @{s='tesla-s'; q='Tesla Model S'},
      @{s='tesla-3'; q='Tesla Model 3'},
      @{s='tesla-x'; q='Tesla Model X'},
      @{s='tesla-y'; q='Tesla Model Y'} ) },
  @{ slug='range-rover';  cover='Range Rover Sport';              models=@(
      @{s='rr-sport'; q='Range Rover Sport'},
      @{s='rr-evoque';q='Range Rover Evoque'},
      @{s='rr-velar'; q='Range Rover Velar'},
      @{s='rr-vogue'; q='Range Rover L405'} ) },
  @{ slug='mclaren';      cover='McLaren 720S';                   models=@(
      @{s='mclaren-720s';   q='McLaren 720S'},
      @{s='mclaren-gt';     q='McLaren GT'},
      @{s='mclaren-artura'; q='McLaren Artura'} ) }
)

foreach ($b in $brands) {
  Save-Image -outRel ("public/images/brands/{0}.jpg" -f $b.slug) -query $b.cover -tag 'brand'
  foreach ($m in $b.models) {
    Save-Image -outRel ("public/images/brands/{0}/{1}.jpg" -f $b.slug, $m.s) -query $m.q -tag 'model'
  }
}

# ---------- Studio / process ----------
$studio = @(
  @{ f='studio/detailing';  q='AZ Auto Detailing';                 fb='car detailing' },
  @{ f='studio/washing';    q='Mobile Wash partner washing a car'; fb='car wash' },
  @{ f='studio/ceramic';    q='Ceramic Coating on Performance Car';fb='ceramic coating car' },
  @{ f='studio/interior';   q='Leather car interior (Unsplash)';   fb='car interior leather' },
  @{ f='studio/wheel';      q='Jaguar XJ Dynamic alloy wheel';     fb='alloy wheel car' },
  @{ f='studio/body';       q='Car body repair, Yalberton';        fb='car body repair' },
  @{ f='studio/foam';       q='Fundraiser Car Wash DVIDS93954';    fb='car wash foam' },
  @{ f='studio/headlight';  q='Vintage car headlight (Unsplash)';  fb='car headlight' },
  @{ f='studio/showroom';   q='car showroom';                      fb='car dealership' },
  @{ f='studio/hero';       q='black sports car';                  fb='sports car night' }
)
foreach ($s in $studio) {
  Save-Image -outRel ("public/images/{0}.jpg" -f $s.f) -query $s.q -fallbackQuery $s.fb -tag 'studio'
}

$manifestPath = Join-Path $root 'scripts/assets-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Out-File -FilePath $manifestPath -Encoding UTF8
Write-Host ""
Write-Host ("SUMMARY: downloaded={0} skipped={1} failed={2}" -f $script:downloaded, $script:skipped, $script:failed)
Write-Host ("MANIFEST: {0}" -f $manifestPath)
