try {
    $proc = Get-Process -Name PokeAlliance_dx -ErrorAction Stop
    Write-Output "PID: $($proc.Id)"
    $modules = $proc.Modules
    Write-Output "Total modules: $($modules.Count)"
    foreach ($m in $modules) {
        Write-Output "MODULE: $($m.FileName)"
    }
} catch {
    Write-Output "Error: $_"
}
