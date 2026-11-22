$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DesktopDir  = $PSScriptRoot
$WebDistDir  = Join-Path $DesktopDir "web_dist"
$ReleaseDir  = Join-Path $ProjectRoot "release"

Write-Host "[1/4] Building production Vite bundle..." -ForegroundColor Cyan
Set-Location $ProjectRoot
npx vite build --config vite.vercel.config.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[2/4] Staging offline web_dist (including pdf.worker.mjs, CJK cmaps & standard_fonts)..." -ForegroundColor Cyan
if (Test-Path $WebDistDir) { Remove-Item -Recurse -Force $WebDistDir }
Copy-Item -Recurse -Force (Join-Path $ProjectRoot "dist") $WebDistDir

# Ensure offline PDF.js worker, CJK cmaps, and standard_fonts are bundled inside the .exe
$WorkerSrc = Join-Path $ProjectRoot "public\pdf.worker.mjs"
if (Test-Path $WorkerSrc) { Copy-Item -Force $WorkerSrc (Join-Path $WebDistDir "pdf.worker.mjs") }

$PdfJsRoot = Join-Path $ProjectRoot "node_modules\pdfjs-dist"
Copy-Item -Recurse -Force (Join-Path $PdfJsRoot "cmaps") (Join-Path $WebDistDir "cmaps")
Copy-Item -Recurse -Force (Join-Path $PdfJsRoot "standard_fonts") (Join-Path $WebDistDir "standard_fonts")

Write-Host "[3/4] Generating Adobe-style splash.png and app.ico..." -ForegroundColor Cyan
python (Join-Path $DesktopDir "make_assets.py")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[4/4] Packaging standalone PrintKit.exe via PyInstaller..." -ForegroundColor Cyan
if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Path $ReleaseDir | Out-Null }

Set-Location $DesktopDir
pyinstaller `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name "PrintKit" `
  --icon (Join-Path $DesktopDir "app.ico") `
  --splash (Join-Path $DesktopDir "splash.png") `
  --exclude-module PyQt5 `
  --exclude-module PyQt6 `
  --exclude-module PySide2 `
  --exclude-module PySide6 `
  --exclude-module qtpy `
  --exclude-module gi `
  --exclude-module gtk `
  --add-data "$WebDistDir;web_dist" `
  --distpath $ReleaseDir `
  --workpath (Join-Path $DesktopDir "build") `
  --specpath $DesktopDir `
  (Join-Path $DesktopDir "main.py")

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ExePath = Join-Path $ReleaseDir "PrintKit.exe"
$SizeMB = [Math]::Round((Get-Item $ExePath).Length / 1MB, 2)
Write-Host ""
Write-Host "DONE! Standalone EXE built successfully:" -ForegroundColor Green
Write-Host "  $ExePath ($SizeMB MB)" -ForegroundColor Yellow
