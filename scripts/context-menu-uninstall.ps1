Remove-Item -Path "HKCU:\Software\Classes\Directory\Background\shell\Terminus" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\Directory\shell\Terminus" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Context menu entries removed."
