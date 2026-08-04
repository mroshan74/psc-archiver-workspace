<#
Clones (if missing) or fast-forward-pulls (if present) every repo listed in
repos.json, next to this script. Never merges or overwrites local work --
a repo with diverging/uncommitted changes is left alone and flagged.

Usage: .\sync.ps1
#>

$root = $PSScriptRoot
$manifestPath = Join-Path $root 'repos.json'

if (-not (Test-Path $manifestPath)) {
    Write-Error "repos.json not found next to sync.ps1 at $manifestPath"
    exit 1
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$results = @()

foreach ($repo in $manifest.repos) {
    $name = $repo.name
    $url = $repo.url
    $branch = $repo.branch
    $path = Join-Path $root $name
    $gitDir = Join-Path $path '.git'

    if (-not (Test-Path $gitDir)) {
        Write-Host "[$name] cloning ($branch)..." -ForegroundColor Cyan
        git clone --branch $branch $url $path
        if ($LASTEXITCODE -eq 0) {
            $results += [pscustomobject]@{ Repo = $name; Status = 'cloned' }
        } else {
            $results += [pscustomobject]@{ Repo = $name; Status = 'CLONE FAILED' }
        }
        continue
    }

    Write-Host "[$name] pulling (--ff-only)..." -ForegroundColor Cyan
    git -C $path pull --ff-only
    if ($LASTEXITCODE -eq 0) {
        $results += [pscustomobject]@{ Repo = $name; Status = 'up to date / fast-forwarded' }
    } else {
        $results += [pscustomobject]@{ Repo = $name; Status = 'NEEDS MANUAL ATTENTION (diverged or local changes conflict)' }
    }
}

Write-Host ""
Write-Host "=== sync summary ===" -ForegroundColor Yellow
$results | Format-Table -AutoSize

if ($results | Where-Object { $_.Status -match 'FAILED|ATTENTION' }) {
    exit 1
}
exit 0
