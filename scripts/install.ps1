# Installs (or reinstalls) the latest kubedeck release on Windows.
# The repository is private, so this needs the GitHub CLI logged in with access to it:
#
#   gh api repos/cardoso010/kubedeck/contents/scripts/install.ps1 -H "Accept: application/vnd.github.raw" | powershell -NoProfile -Command -
#
# After that, the app updates itself.
$ErrorActionPreference = "Stop"
$repo = if ($env:KUBEDECK_REPO) { $env:KUBEDECK_REPO } else { "cardoso010/kubedeck" }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Install the GitHub CLI first: winget install GitHub.cli" }
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "Log in to GitHub first: gh auth login" }

$tag = gh release view --repo $repo --json tagName --jq .tagName
if ($LASTEXITCODE -ne 0) { throw "No release found in $repo (or no access to it)" }

$tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
try {
    Write-Host "Downloading kubedeck $tag..."
    gh release download $tag --repo $repo --pattern "kubedeck_*_windows_x86_64-setup.exe" --dir $tmp
    $installer = Get-ChildItem $tmp -Filter "*-setup.exe" | Select-Object -First 1
    # /S: silent per-user install, the same mode the in-app updater uses.
    Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait
    Write-Host "kubedeck $tag installed. Find it in the Start menu."
} finally {
    Remove-Item -Recurse -Force $tmp
}
