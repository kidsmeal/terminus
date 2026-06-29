$exePath = (Get-Command terminus -ErrorAction SilentlyContinue).Source
if (-not $exePath) {
    $exePath = Join-Path $PSScriptRoot "..\src-tauri\target\release\terminus.exe"
    if (-not (Test-Path $exePath)) {
        Write-Host "Could not find terminus.exe. Build first with: npm run tauri build"
        exit 1
    }
}
$exePath = (Resolve-Path $exePath).Path

# Right-click on folder background (inside a folder)
$bgKey = "HKCU:\Software\Classes\Directory\Background\shell\Terminus"
New-Item -Path $bgKey -Force | Out-Null
Set-ItemProperty -Path $bgKey -Name "(Default)" -Value "Start Terminus Here"
Set-ItemProperty -Path $bgKey -Name "Icon" -Value "`"$exePath`""
New-Item -Path "$bgKey\command" -Force | Out-Null
Set-ItemProperty -Path "$bgKey\command" -Name "(Default)" -Value "`"$exePath`" --cwd `"%V`""

# Right-click on a folder itself
$dirKey = "HKCU:\Software\Classes\Directory\shell\Terminus"
New-Item -Path $dirKey -Force | Out-Null
Set-ItemProperty -Path $dirKey -Name "(Default)" -Value "Start Terminus Here"
Set-ItemProperty -Path $dirKey -Name "Icon" -Value "`"$exePath`""
New-Item -Path "$dirKey\command" -Force | Out-Null
Set-ItemProperty -Path "$dirKey\command" -Name "(Default)" -Value "`"$exePath`" --cwd `"%V`""

Write-Host "Context menu registered for: $exePath"
Write-Host "Right-click any folder or folder background -> 'Show more options' -> 'Start Terminus Here'"
