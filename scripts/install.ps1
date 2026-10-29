# Installs (or reinstalls) the latest kubedeck release on Windows.
#
#   irm https://raw.githubusercontent.com/cardoso010/kubedeck/main/scripts/install.ps1 | iex
#
# Downloads go through a logged-in GitHub CLI when there is one (needed for a private fork),
# otherwise anonymously. After that, the app updates itself.
$ErrorActionPreference = "Stop"
$repo = if ($env:KUBEDECK_REPO) { $env:KUBEDECK_REPO } else { "cardoso010/kubedeck" }

$useGh = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh auth status *> $null
    $useGh = $LASTEXITCODE -eq 0
}
if ($useGh) {
    $tag = gh release view --repo $repo --json tagName --jq .tagName
    if ($LASTEXITCODE -ne 0) { throw "No release found in $repo (or no access to it)" }
} else {
    try { $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name }
    catch { throw "No release found in $repo (if it is private, log in with: gh auth login)" }
}
$asset = "kubedeck_$($tag.TrimStart('v'))_windows_x86_64-setup.exe"

$tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
try {
    Write-Host "Downloading kubedeck $tag..."
    $installer = Join-Path $tmp $asset
    if ($useGh) {
        gh release download $tag --repo $repo --pattern $asset --dir $tmp
    } else {
        Invoke-WebRequest "https://github.com/$repo/releases/download/$tag/$asset" -OutFile $installer -UseBasicParsing
    }
    # /S: silent per-user install, the same mode the in-app updater uses.
    Start-Process -FilePath $installer -ArgumentList "/S" -Wait
    Write-Host "kubedeck $tag installed. Find it in the Start menu."
} finally {
    Remove-Item -Recurse -Force $tmp
}
