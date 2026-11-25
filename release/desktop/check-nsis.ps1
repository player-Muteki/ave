param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Desktop)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA ("AVE-QA-" + [guid]::NewGuid().ToString())
$setup = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList "/S /currentuser /D=$installDir" -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "NSIS exited with $($setup.ExitCode)" }
try {
    $exe = Join-Path $installDir "AVE.exe"
    if (!(Test-Path $exe)) { throw "Missing installed executable in $installDir" }
    $wsh = New-Object -ComObject WScript.Shell
    $links = Get-ChildItem (Join-Path $env:APPDATA "Microsoft/Windows/Start Menu/Programs") -Recurse -Filter '*.lnk' |
        Where-Object { $wsh.CreateShortcut($_.FullName).TargetPath -eq $exe }
    if (!$links) { throw "Missing current-user Start menu shortcut to $exe" }
    node (Join-Path $Desktop "e2e/packaged-app-smoke.js") --app $installDir
    if ($LASTEXITCODE -ne 0) { throw "Installed application smoke failed" }
} finally {
    $uninstaller = Get-ChildItem -Path $installDir -Filter "Uninstall*.exe" | Select-Object -First 1
    if (!$uninstaller) { throw "Uninstaller missing from $installDir" }
    $removed = Start-Process $uninstaller.FullName -ArgumentList "/S /currentuser" -Wait -PassThru
    if ($removed.ExitCode -ne 0) { throw "Uninstall failed: $($removed.ExitCode)" }
    for ($i = 0; $i -lt 30 -and (Test-Path $exe); $i++) { Start-Sleep 1 }
    if (Test-Path $exe) { throw "Installed executable still present after uninstall" }
}
