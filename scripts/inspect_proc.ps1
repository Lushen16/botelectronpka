param([int]$pidToInspect)
$p = Get-Process -Id $pidToInspect -ErrorAction SilentlyContinue
if ($p) {
    Write-Output "PID: $($p.Id)"
    Write-Output "Name: $($p.ProcessName)"
    Write-Output "Path: $($p.Path)"
    Write-Output "CommandLine: $((Get-CimInstance Win32_Process -Filter "ProcessId = $pidToInspect").CommandLine)"
}
