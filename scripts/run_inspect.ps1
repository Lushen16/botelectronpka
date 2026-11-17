$env:ELECTRON_RUN_AS_NODE = "1"
$electron = "runtime\electron-v44.7.2\electron.exe"
$script = "scripts\test_full_sharing_flow.cjs"
$outFile = "scripts\inspect_output.txt"
Start-Process -FilePath $electron -ArgumentList $script -RedirectStandardOutput $outFile -RedirectStandardError "scripts\inspect_err.txt" -Wait -NoNewWindow
if (Test-Path $outFile) {
    Get-Content $outFile
}
if (Test-Path "scripts\inspect_err.txt") {
    Get-Content "scripts\inspect_err.txt"
}
